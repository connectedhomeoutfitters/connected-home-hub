const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requireAuth } = require('../../middleware/auth');
const { sendMail } = require('../../services/mailer');
const { generateEstimatePdf } = require('../../services/estimatePdf');
const { getCompany } = require('../../services/companySettings');
const { listTemplates, snapshotBodyFor } = require('../../services/terms');
const { lineItemsFromBody } = require('../../services/lineItems');
const { computeEstimateTotals, parseFlatPrice } = require('../../services/estimatePricing');
const { computeCosting } = require('../../services/estimateCosting');
const { createInvoice, remainingBalanceForEstimate } = require('../../services/invoicing');
const activity = require('../../services/activityLog');

router.use(requireAuth);

const TOKEN_TTL_DAYS = 30;
// How long a sent estimate stays open before the daily cron marks it expired
// (see services/estimateExpiry.js). Re-sending an expired estimate resets the clock.
const ESTIMATE_VALID_DAYS = 30;

// lineItemsFromBody moved to services/lineItems.js (shared with the template builder).
// Money math moved to services/estimatePricing.js; profitability to services/estimateCosting.js.
// Every query below runs through req.db, the tenant-scoped handle built by
// middleware/orgContext.js — see docs/adr/0001-multi-tenancy.md.

router.get('/', async (req, res, next) => {
  try {
    const [estimates] = await req.db.execute(
      `SELECT e.*, c.name AS customer_name FROM estimates e
       JOIN customers c ON c.id = e.customer_id AND c.org_id = e.org_id
       WHERE e.org_id = ?
       ORDER BY e.created_at DESC`,
      [req.orgId]
    );
    const [customers] = await req.db.execute(
      'SELECT id, name FROM customers WHERE org_id = ? ORDER BY name',
      [req.orgId]
    );
    res.render('admin/estimates', { pageScript: null, estimates, customers });
  } catch (err) {
    next(err);
  }
});

// Retail value of the taxable-goods lines (product lines whose catalog product is taxable).
// Used as the sales-tax base for flat-price packages only — itemized estimates tax the
// whole subtotal (see services/estimatePricing.js).
async function taxableGoodsBase(conn, orgId, items) {
  const productIds = [...new Set(items.filter((i) => i.product_id).map((i) => i.product_id))];
  if (!productIds.length) return 0;
  const [rows] = await conn.execute(
    `SELECT id FROM products
     WHERE org_id = ? AND taxable = 1 AND id IN (${productIds.map(() => '?').join(',')})`,
    [orgId, ...productIds]
  );
  const taxable = new Set(rows.map((r) => r.id));
  return items.reduce(
    (sum, i) => sum + (i.product_id && taxable.has(i.product_id) ? i.quantity * i.unit_price : 0),
    0
  );
}

async function loadCatalogForForm(db, orgId) {
  const [products] = await db.execute(
    'SELECT id, category, name, retail_price, vendor_cost, taxable FROM products WHERE org_id = ? AND active = 1 ORDER BY category, name',
    [orgId]
  );
  const [laborRates] = await db.execute(
    'SELECT id, name, hourly_rate FROM labor_rates WHERE org_id = ? AND active = 1 ORDER BY name',
    [orgId]
  );
  const [subcontractors] = await db.execute(
    'SELECT id, name, trade, hourly_rate FROM subcontractors WHERE org_id = ? AND active = 1 ORDER BY name',
    [orgId]
  );
  return { products, laborRates, subcontractors };
}

router.get('/new', async (req, res, next) => {
  try {
    const [customerRows] = await req.db.execute(
      'SELECT * FROM customers WHERE id = ? AND org_id = ?',
      [req.query.customer_id, req.orgId]
    );
    if (!customerRows[0]) return res.status(404).render('error', { message: 'Customer not found' });

    let consultation = null;
    if (req.query.consultation_id) {
      const [consultationRows] = await req.db.execute(
        'SELECT * FROM consultations WHERE id = ? AND org_id = ?',
        [req.query.consultation_id, req.orgId]
      );
      consultation = consultationRows[0] || null;
    }

    const { products, laborRates, subcontractors } = await loadCatalogForForm(req.db, req.orgId);
    const [settingsRows] = await req.db.execute(
      'SELECT default_tax_percent FROM company_settings WHERE org_id = ?',
      [req.orgId]
    );
    const defaultTaxPercent = settingsRows[0]?.default_tax_percent ?? 0;

    // Templates for the "Start from template" picker, and pre-fill if one is chosen.
    const [templates] = await req.db.execute(
      'SELECT id, name FROM estimate_templates WHERE org_id = ? AND active = 1 ORDER BY name',
      [req.orgId]
    );
    let tpl = null;
    let items = [];
    if (req.query.template_id) {
      const [tRows] = await req.db.execute(
        'SELECT * FROM estimate_templates WHERE id = ? AND org_id = ?',
        [req.query.template_id, req.orgId]
      );
      tpl = tRows[0] || null;
      if (tpl) {
        const [tItems] = await req.db.execute(
          `SELECT product_id, labor_rate_id, subcontractor_id, description, quantity, unit_price, unit_cost, hide_price
           FROM estimate_template_items WHERE template_id = ? AND org_id = ? ORDER BY sort_order`,
          [tpl.id, req.orgId]
        );
        items = tItems;
      }
    }

    res.render('admin/estimate-form', {
      pageScript: 'page-estimate-form.js',
      isNew: true,
      estimate: {
        title: tpl?.title || consultation?.recommended_package || '',
        description: tpl?.description || consultation?.consultant_notes || '',
        consultation_id: consultation?.id || null,
        deposit_percent: tpl ? tpl.deposit_percent : 50,
        tax_percent: tpl && tpl.tax_percent != null ? tpl.tax_percent : defaultTaxPercent,
        flat_price: tpl ? tpl.flat_price : null,
      },
      items,
      costing: computeCosting(items, tpl ? tpl.flat_price : null),
      customer: customerRows[0],
      consultation,
      products,
      laborRates,
      subcontractors,
      templates,
      selectedTemplateId: tpl ? tpl.id : null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  const conn = await req.db.getConnection();
  try {
    const items = lineItemsFromBody(req.body);
    const taxPercent = parseFloat(req.body.tax_percent) || 0;
    const depositPercent = parseFloat(req.body.deposit_percent) || 50;
    const flatPrice = parseFlatPrice(req.body.flat_price);
    const taxableBase = flatPrice != null ? await taxableGoodsBase(conn, req.orgId, items) : 0;
    const { subtotal, tax, total, depositAmount } = computeEstimateTotals(items, taxPercent, depositPercent, flatPrice, taxableBase);

    // The customer must belong to this org — otherwise a forged customer_id in the form
    // body would attach a new estimate to another tenant's customer.
    const [[customer]] = await conn.execute(
      'SELECT id FROM customers WHERE id = ? AND org_id = ?',
      [req.body.customer_id, req.orgId]
    );
    if (!customer) { conn.release(); return res.status(404).render('error', { message: 'Customer not found' }); }

    await conn.beginTransaction();
    const [result] = await conn.execute(
      `INSERT INTO estimates
        (org_id, customer_id, consultation_id, title, description, subtotal, tax_percent, tax, total,
         flat_price, deposit_percent, deposit_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.orgId, req.body.customer_id, req.body.consultation_id || null, req.body.title, req.body.description || null,
        subtotal.toFixed(2), taxPercent, tax.toFixed(2), total.toFixed(2),
        flatPrice != null ? flatPrice.toFixed(2) : null, depositPercent, depositAmount.toFixed(2)]
    );
    const estimateId = result.insertId;
    for (let i = 0; i < items.length; i++) {
      await conn.execute(
        `INSERT INTO estimate_line_items
          (org_id, estimate_id, product_id, labor_rate_id, subcontractor_id, description, quantity, unit_price, unit_cost, hide_price, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [req.orgId, estimateId, items[i].product_id, items[i].labor_rate_id, items[i].subcontractor_id, items[i].description,
          items[i].quantity, items[i].unit_price, items[i].unit_cost, items[i].hide_price, i]
      );
    }
    await conn.commit();
    res.redirect(`${res.locals.basePath}/admin/estimates/${estimateId}/edit`);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.get('/:id/edit', async (req, res, next) => {
  try {
    const [estimateRows] = await req.db.execute(
      `SELECT e.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
        c.address AS customer_address FROM estimates e
       JOIN customers c ON c.id = e.customer_id AND c.org_id = e.org_id
       WHERE e.id = ? AND e.org_id = ?`,
      [req.params.id, req.orgId]
    );
    const estimate = estimateRows[0];
    if (!estimate) return res.status(404).render('error', { message: 'Estimate not found' });

    // Line items carry their own unit_cost snapshot (see migration 028), so costing needs
    // no live join — product_id/labor_rate_id/subcontractor_id restore the Source dropdown.
    const [items] = await req.db.execute(
      'SELECT * FROM estimate_line_items WHERE estimate_id = ? AND org_id = ? ORDER BY sort_order',
      [req.params.id, req.orgId]
    );
    const { products, laborRates, subcontractors } = await loadCatalogForForm(req.db, req.orgId);

    let consultation = null;
    if (estimate.consultation_id) {
      const [consultationRows] = await req.db.execute(
        'SELECT * FROM consultations WHERE id = ? AND org_id = ?',
        [estimate.consultation_id, req.orgId]
      );
      consultation = consultationRows[0] || null;
    }

    res.render('admin/estimate-form', {
      pageScript: 'page-estimate-form.js',
      isNew: false,
      estimate,
      items,
      costing: computeCosting(items, estimate.flat_price),
      customer: {
        id: estimate.customer_id,
        name: estimate.customer_name,
        email: estimate.customer_email,
        phone: estimate.customer_phone,
        address: estimate.customer_address,
      },
      consultation,
      products,
      laborRates,
      subcontractors,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id', async (req, res, next) => {
  const conn = await req.db.getConnection();
  try {
    // Once a customer has accepted (e-signed) or declined an estimate, its line items and
    // totals are the agreed record — editing them would silently change what was signed.
    const [statusRows] = await conn.execute(
      'SELECT status FROM estimates WHERE id = ? AND org_id = ?',
      [req.params.id, req.orgId]
    );
    if (statusRows[0] && ['accepted', 'declined'].includes(statusRows[0].status)) {
      conn.release();
      return res.status(409).render('error', {
        message: `This estimate has been ${statusRows[0].status} and can no longer be edited. Create a new estimate if changes are needed.`,
      });
    }

    const items = lineItemsFromBody(req.body);
    const taxPercent = parseFloat(req.body.tax_percent) || 0;
    const depositPercent = parseFloat(req.body.deposit_percent) || 50;
    const flatPrice = parseFlatPrice(req.body.flat_price);
    const taxableBase = flatPrice != null ? await taxableGoodsBase(conn, req.orgId, items) : 0;
    const { subtotal, tax, total, depositAmount } = computeEstimateTotals(items, taxPercent, depositPercent, flatPrice, taxableBase);

    await conn.beginTransaction();
    await conn.execute(
      `UPDATE estimates SET title=?, description=?, subtotal=?, tax_percent=?, tax=?,
        total=?, flat_price=?, deposit_percent=?, deposit_amount=? WHERE id=? AND org_id=?`,
      [req.body.title, req.body.description || null, subtotal.toFixed(2), taxPercent,
        tax.toFixed(2), total.toFixed(2), flatPrice != null ? flatPrice.toFixed(2) : null,
        depositPercent, depositAmount.toFixed(2), req.params.id, req.orgId]
    );
    await conn.execute(
      'DELETE FROM estimate_line_items WHERE estimate_id = ? AND org_id = ?',
      [req.params.id, req.orgId]
    );
    for (let i = 0; i < items.length; i++) {
      await conn.execute(
        `INSERT INTO estimate_line_items
          (org_id, estimate_id, product_id, labor_rate_id, subcontractor_id, description, quantity, unit_price, unit_cost, hide_price, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [req.orgId, req.params.id, items[i].product_id, items[i].labor_rate_id, items[i].subcontractor_id, items[i].description,
          items[i].quantity, items[i].unit_price, items[i].unit_cost, items[i].hide_price, i]
      );
    }
    await conn.commit();
    res.redirect(`${res.locals.basePath}/admin/estimates/${req.params.id}/edit`);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

async function loadEstimateWithCustomer(db, orgId, id) {
  const [rows] = await db.execute(
    `SELECT e.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
      c.address AS customer_address FROM estimates e
     JOIN customers c ON c.id = e.customer_id AND c.org_id = e.org_id
     WHERE e.id = ? AND e.org_id = ?`,
    [id, orgId]
  );
  return rows[0];
}

router.get('/:id/pdf', async (req, res, next) => {
  try {
    const estimate = await loadEstimateWithCustomer(req.db, req.orgId, req.params.id);
    if (!estimate) return res.status(404).render('error', { message: 'Estimate not found' });
    const [items] = await req.db.execute(
      'SELECT * FROM estimate_line_items WHERE estimate_id = ? AND org_id = ? ORDER BY sort_order',
      [req.params.id, req.orgId]
    );
    const pdf = await generateEstimatePdf({
      estimate,
      items,
      customer: { name: estimate.customer_name, email: estimate.customer_email, phone: estimate.customer_phone, address: estimate.customer_address },
      company: await getCompany(req.orgId),
    });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="estimate-${estimate.id}.pdf"`);
    res.send(pdf);
  } catch (err) {
    next(err);
  }
});

// Material list — the product-linked lines on an estimate, for ordering/pulling stock.
// Custom/labor lines are excluded (they're not physical materials). Same product bought
// on several lines is aggregated into one row.
router.get('/:id/materials', async (req, res, next) => {
  try {
    const estimate = await loadEstimateWithCustomer(req.db, req.orgId, req.params.id);
    if (!estimate) return res.status(404).render('error', { message: 'Estimate not found' });
    const [rows] = await req.db.execute(
      `SELECT COALESCE(p.name, eli.description) AS name, p.category, p.vendor,
              SUM(eli.quantity) AS quantity, p.vendor_cost,
              SUM(eli.quantity * p.vendor_cost) AS ext_cost
       FROM estimate_line_items eli
       JOIN products p ON p.id = eli.product_id AND p.org_id = eli.org_id
       WHERE eli.estimate_id = ? AND eli.org_id = ?
       GROUP BY eli.product_id, p.name, p.category, p.vendor, p.vendor_cost
       ORDER BY p.category, p.name`,
      [req.params.id, req.orgId]
    );
    const totalCost = rows.reduce((s, r) => s + Number(r.ext_cost || 0), 0);
    res.render('admin/estimate-materials', { pageScript: null, estimate, materials: rows, totalCost });
  } catch (err) {
    next(err);
  }
});

// Generates a customer access token, emails the viewable link (with the PDF attached),
// and marks the estimate sent.
router.post('/:id/send', async (req, res, next) => {
  try {
    const estimate = await loadEstimateWithCustomer(req.db, req.orgId, req.params.id);
    if (!estimate) return res.status(404).render('error', { message: 'Estimate not found' });
    if (['accepted', 'declined'].includes(estimate.status)) {
      return res.status(409).render('error', {
        message: `This estimate has already been ${estimate.status} and can't be re-sent.`,
      });
    }
    const [items] = await req.db.execute(
      'SELECT * FROM estimate_line_items WHERE estimate_id = ? AND org_id = ? ORDER BY sort_order',
      [req.params.id, req.orgId]
    );

    // Null when the org is still on the built-in terms — config/estimateTerms.js
    // reproduces those deterministically from the company name, so there is nothing
    // tenant-specific worth freezing.
    const termsSnapshot = await snapshotBodyFor(req.db, req.orgId, estimate.terms_template_id);

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
    await req.db.execute(
      'INSERT INTO access_tokens (org_id, token, resource_type, resource_id, expires_at) VALUES (?, ?, ?, ?, ?)',
      [req.orgId, token, 'estimate', estimate.id, expiresAt]
    );
    await req.db.execute(
      // terms_snapshot is written here and never again: editing a template afterwards
      // must not change an offer already sitting in a customer's inbox, and must not
      // change what a signed estimate says they agreed to. Re-sending re-freezes, which
      // is correct — that is a new offer.
      `UPDATE estimates SET status = 'sent', sent_at = NOW(), terms_snapshot = ?,
         expires_at = DATE_ADD(NOW(), INTERVAL ? DAY) WHERE id = ? AND org_id = ?`,
      [termsSnapshot, ESTIMATE_VALID_DAYS, estimate.id, req.orgId]
    );

    const basePath = process.env.BASE_PATH || '';
    const viewUrl = `${process.env.BASE_URL || ''}${basePath}/e/${token}`;
    const company = await getCompany(req.orgId);
    const pdf = await generateEstimatePdf({
      estimate,
      items,
      customer: { name: estimate.customer_name, email: estimate.customer_email, phone: estimate.customer_phone, address: estimate.customer_address },
      company,
    });

    await sendMail({
      orgId: req.orgId,
      to: estimate.customer_email,
      subject: `Your estimate from ${company.company_name} — ${estimate.title}`,
      template: 'estimate-sent',
      data: { customerName: estimate.customer_name, estimateTitle: estimate.title, total: estimate.total, viewUrl },
      attachments: [{ filename: `estimate-${estimate.id}.pdf`, content: pdf }],
    });

    // Reminder to follow up if the customer hasn't responded in a few days.
    const followUpDue = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await req.db.execute(
      `INSERT INTO jobs (org_id, type, title, customer_id, estimate_id, assigned_to, due_date)
       VALUES (?, 'estimate_followup', ?, ?, ?, ?, ?)`,
      [req.orgId, `Follow up: ${estimate.title}`, estimate.customer_id, estimate.id, req.user.id, followUpDue]
    );

    await activity.log({
      ...activity.staff(req), action: 'estimate.sent', entityType: 'estimate', entityId: estimate.id,
      customerId: estimate.customer_id, detail: `Estimate "${estimate.title}" ($${estimate.total}) sent to ${estimate.customer_email}`,
    });

    res.redirect(`${res.locals.basePath}/admin/estimates/${estimate.id}/edit`);
  } catch (err) {
    next(err);
  }
});

// Marks an estimate accepted and creates the deposit invoice. Called once the customer
// accepts via their portal link (see routes/portal.js), not directly from the admin UI.
// org_id comes off the estimate row itself, since the caller is a token-gated customer
// route with no staff session.
async function createDepositInvoice(conn, estimate) {
  const depositAmount = estimate.total * (estimate.deposit_percent / 100);
  return createInvoice(conn, {
    org_id: estimate.org_id,
    estimate_id: estimate.id,
    customer_id: estimate.customer_id,
    type: 'deposit',
    amount: depositAmount,
    description: `Deposit (${estimate.deposit_percent}%) — ${estimate.title}`,
  });
}

// "Bill final balance" — creates a `final` invoice for whatever's left on an accepted
// estimate (total minus the deposit / any prior invoice). Staff land on the new invoice's
// page to review and then Send it. This is the piece that closes the loop after the job's
// done; reachable from the estimate page and from its install job.
router.post('/:id/final-invoice', async (req, res, next) => {
  const conn = await req.db.getConnection();
  try {
    const [rows] = await conn.execute(
      'SELECT * FROM estimates WHERE id = ? AND org_id = ?',
      [req.params.id, req.orgId]
    );
    const estimate = rows[0];
    if (!estimate) { conn.release(); return res.status(404).render('error', { message: 'Estimate not found' }); }
    if (estimate.status !== 'accepted') {
      conn.release();
      return res.status(409).render('error', { message: 'A final invoice can only be billed on an accepted estimate.' });
    }

    const remaining = await remainingBalanceForEstimate(conn, req.orgId, estimate.id);
    if (remaining <= 0.005) {
      conn.release();
      return res.status(409).render('error', { message: 'This estimate is already fully invoiced — nothing left to bill.' });
    }

    await conn.beginTransaction();
    const invoiceId = await createInvoice(conn, {
      org_id: req.orgId,
      estimate_id: estimate.id,
      customer_id: estimate.customer_id,
      type: 'final',
      amount: remaining,
      description: `Final balance — ${estimate.title}`,
    });
    await conn.commit();
    await activity.log({
      ...activity.staff(req), action: 'invoice.created', entityType: 'invoice', entityId: invoiceId,
      customerId: estimate.customer_id, detail: `Final invoice ($${remaining.toFixed(2)}) created from estimate "${estimate.title}"`,
    });
    res.redirect(`${res.locals.basePath}/admin/invoices/${invoiceId}`);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Save an existing estimate's line items + title/deposit as a reusable template. Lands on
// the new template's edit page so staff can name/tweak it.
router.post('/:id/save-as-template', async (req, res, next) => {
  const conn = await req.db.getConnection();
  try {
    const [rows] = await conn.execute(
      'SELECT * FROM estimates WHERE id = ? AND org_id = ?',
      [req.params.id, req.orgId]
    );
    const estimate = rows[0];
    if (!estimate) { conn.release(); return res.status(404).render('error', { message: 'Estimate not found' }); }
    const [items] = await conn.execute(
      `SELECT product_id, labor_rate_id, subcontractor_id, description, quantity, unit_price, unit_cost, hide_price, sort_order
       FROM estimate_line_items WHERE estimate_id = ? AND org_id = ? ORDER BY sort_order`,
      [estimate.id, req.orgId]
    );

    await conn.beginTransaction();
    const [result] = await conn.execute(
      'INSERT INTO estimate_templates (org_id, name, title, description, deposit_percent, tax_percent, flat_price) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [req.orgId, estimate.title, estimate.title, estimate.description || null, estimate.deposit_percent, estimate.tax_percent, estimate.flat_price]
    );
    const templateId = result.insertId;
    for (const it of items) {
      await conn.execute(
        `INSERT INTO estimate_template_items
          (org_id, template_id, product_id, labor_rate_id, subcontractor_id, description, quantity, unit_price, unit_cost, hide_price, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [req.orgId, templateId, it.product_id, it.labor_rate_id, it.subcontractor_id, it.description,
          it.quantity, it.unit_price, it.unit_cost, it.hide_price, it.sort_order]
      );
    }
    await conn.commit();
    res.redirect(`${res.locals.basePath}/admin/estimate-templates/${templateId}/edit`);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
module.exports.createDepositInvoice = createDepositInvoice;
