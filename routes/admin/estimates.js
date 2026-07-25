const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../../config/db');
const { requireAuth } = require('../../middleware/auth');
const { sendMail } = require('../../services/mailer');
const { generateEstimatePdf } = require('../../services/estimatePdf');
const { createInvoice, remainingBalanceForEstimate } = require('../../services/invoicing');

router.use(requireAuth);

const TOKEN_TTL_DAYS = 30;
// How long a sent estimate stays open before the daily cron marks it expired
// (see services/estimateExpiry.js). Re-sending an expired estimate resets the clock.
const ESTIMATE_VALID_DAYS = 30;

function normalizeArray(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

// Line items arrive as parallel arrays (line_description[], line_quantity[],
// line_unit_price[]) from the dynamic add/remove-row form — zipped back together here,
// blank rows dropped. Named distinctly from the estimate's own "description" field —
// same-named inputs merge into one array on submit, which silently corrupted both
// fields the first time this used plain "description"/"quantity"/"unit_price".
function lineItemsFromBody(body) {
  const descriptions = normalizeArray(body.line_description);
  const quantities = normalizeArray(body.line_quantity);
  const unitPrices = normalizeArray(body.line_unit_price);
  const items = [];
  for (let i = 0; i < descriptions.length; i++) {
    const description = (descriptions[i] || '').trim();
    if (!description) continue;
    items.push({
      description,
      quantity: parseFloat(quantities[i]) || 0,
      unit_price: parseFloat(unitPrices[i]) || 0,
    });
  }
  return items;
}

router.get('/', async (req, res, next) => {
  try {
    const [estimates] = await db.execute(
      `SELECT e.*, c.name AS customer_name FROM estimates e
       JOIN customers c ON c.id = e.customer_id
       ORDER BY e.created_at DESC`
    );
    const [customers] = await db.execute('SELECT id, name FROM customers ORDER BY name');
    res.render('admin/estimates', { pageScript: null, estimates, customers });
  } catch (err) {
    next(err);
  }
});

async function loadCatalogForForm() {
  const [products] = await db.execute(
    'SELECT id, category, name, retail_price FROM products WHERE active = 1 ORDER BY category, name'
  );
  const [laborRates] = await db.execute(
    'SELECT id, name, hourly_rate FROM labor_rates WHERE active = 1 ORDER BY name'
  );
  return { products, laborRates };
}

router.get('/new', async (req, res, next) => {
  try {
    const [customerRows] = await db.execute('SELECT * FROM customers WHERE id = ?', [req.query.customer_id]);
    if (!customerRows[0]) return res.status(404).render('error', { message: 'Customer not found' });

    let consultation = null;
    if (req.query.consultation_id) {
      const [consultationRows] = await db.execute('SELECT * FROM consultations WHERE id = ?', [req.query.consultation_id]);
      consultation = consultationRows[0] || null;
    }

    const { products, laborRates } = await loadCatalogForForm();
    const [settingsRows] = await db.execute('SELECT default_tax_percent FROM company_settings WHERE id = 1');
    const defaultTaxPercent = settingsRows[0]?.default_tax_percent ?? 0;

    res.render('admin/estimate-form', {
      pageScript: 'page-estimate-form.js',
      isNew: true,
      estimate: {
        title: consultation?.recommended_package || '',
        description: consultation?.consultant_notes || '',
        consultation_id: consultation?.id || null,
        deposit_percent: 50,
        tax_percent: defaultTaxPercent,
      },
      items: [],
      customer: customerRows[0],
      consultation,
      products,
      laborRates,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  const conn = await db.getConnection();
  try {
    const items = lineItemsFromBody(req.body);
    const subtotal = items.reduce((sum, i) => sum + i.quantity * i.unit_price, 0);
    const taxPercent = parseFloat(req.body.tax_percent) || 0;
    const tax = subtotal * (taxPercent / 100);
    const depositPercent = parseFloat(req.body.deposit_percent) || 50;
    const total = subtotal + tax;
    const depositAmount = total * (depositPercent / 100);

    await conn.beginTransaction();
    const [result] = await conn.execute(
      `INSERT INTO estimates
        (customer_id, consultation_id, title, description, subtotal, tax_percent, tax, total,
         deposit_percent, deposit_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.body.customer_id, req.body.consultation_id || null, req.body.title, req.body.description || null,
        subtotal.toFixed(2), taxPercent, tax.toFixed(2), total.toFixed(2),
        depositPercent, depositAmount.toFixed(2)]
    );
    const estimateId = result.insertId;
    for (let i = 0; i < items.length; i++) {
      await conn.execute(
        'INSERT INTO estimate_line_items (estimate_id, description, quantity, unit_price, sort_order) VALUES (?, ?, ?, ?, ?)',
        [estimateId, items[i].description, items[i].quantity, items[i].unit_price, i]
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
    const [estimateRows] = await db.execute(
      `SELECT e.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
        c.address AS customer_address FROM estimates e
       JOIN customers c ON c.id = e.customer_id WHERE e.id = ?`,
      [req.params.id]
    );
    const estimate = estimateRows[0];
    if (!estimate) return res.status(404).render('error', { message: 'Estimate not found' });

    const [items] = await db.execute(
      'SELECT * FROM estimate_line_items WHERE estimate_id = ? ORDER BY sort_order',
      [req.params.id]
    );
    const { products, laborRates } = await loadCatalogForForm();

    let consultation = null;
    if (estimate.consultation_id) {
      const [consultationRows] = await db.execute('SELECT * FROM consultations WHERE id = ?', [estimate.consultation_id]);
      consultation = consultationRows[0] || null;
    }

    res.render('admin/estimate-form', {
      pageScript: 'page-estimate-form.js',
      isNew: false,
      estimate,
      items,
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
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id', async (req, res, next) => {
  const conn = await db.getConnection();
  try {
    // Once a customer has accepted (e-signed) or declined an estimate, its line items and
    // totals are the agreed record — editing them would silently change what was signed.
    const [statusRows] = await conn.execute('SELECT status FROM estimates WHERE id = ?', [req.params.id]);
    if (statusRows[0] && ['accepted', 'declined'].includes(statusRows[0].status)) {
      conn.release();
      return res.status(409).render('error', {
        message: `This estimate has been ${statusRows[0].status} and can no longer be edited. Create a new estimate if changes are needed.`,
      });
    }

    const items = lineItemsFromBody(req.body);
    const subtotal = items.reduce((sum, i) => sum + i.quantity * i.unit_price, 0);
    const taxPercent = parseFloat(req.body.tax_percent) || 0;
    const tax = subtotal * (taxPercent / 100);
    const depositPercent = parseFloat(req.body.deposit_percent) || 50;
    const total = subtotal + tax;
    const depositAmount = total * (depositPercent / 100);

    await conn.beginTransaction();
    await conn.execute(
      `UPDATE estimates SET title=?, description=?, subtotal=?, tax_percent=?, tax=?,
        total=?, deposit_percent=?, deposit_amount=? WHERE id=?`,
      [req.body.title, req.body.description || null, subtotal.toFixed(2), taxPercent,
        tax.toFixed(2), total.toFixed(2), depositPercent, depositAmount.toFixed(2), req.params.id]
    );
    await conn.execute('DELETE FROM estimate_line_items WHERE estimate_id = ?', [req.params.id]);
    for (let i = 0; i < items.length; i++) {
      await conn.execute(
        'INSERT INTO estimate_line_items (estimate_id, description, quantity, unit_price, sort_order) VALUES (?, ?, ?, ?, ?)',
        [req.params.id, items[i].description, items[i].quantity, items[i].unit_price, i]
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

async function loadEstimateWithCustomer(id) {
  const [rows] = await db.execute(
    `SELECT e.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
      c.address AS customer_address FROM estimates e
     JOIN customers c ON c.id = e.customer_id WHERE e.id = ?`,
    [id]
  );
  return rows[0];
}

router.get('/:id/pdf', async (req, res, next) => {
  try {
    const estimate = await loadEstimateWithCustomer(req.params.id);
    if (!estimate) return res.status(404).render('error', { message: 'Estimate not found' });
    const [items] = await db.execute(
      'SELECT * FROM estimate_line_items WHERE estimate_id = ? ORDER BY sort_order',
      [req.params.id]
    );
    const pdf = await generateEstimatePdf({
      estimate,
      items,
      customer: { name: estimate.customer_name, email: estimate.customer_email, phone: estimate.customer_phone, address: estimate.customer_address },
    });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="estimate-${estimate.id}.pdf"`);
    res.send(pdf);
  } catch (err) {
    next(err);
  }
});

// Generates a customer access token, emails the viewable link (with the PDF attached),
// and marks the estimate sent.
router.post('/:id/send', async (req, res, next) => {
  try {
    const estimate = await loadEstimateWithCustomer(req.params.id);
    if (!estimate) return res.status(404).render('error', { message: 'Estimate not found' });
    if (['accepted', 'declined'].includes(estimate.status)) {
      return res.status(409).render('error', {
        message: `This estimate has already been ${estimate.status} and can't be re-sent.`,
      });
    }
    const [items] = await db.execute(
      'SELECT * FROM estimate_line_items WHERE estimate_id = ? ORDER BY sort_order',
      [req.params.id]
    );

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
    await db.execute(
      'INSERT INTO access_tokens (token, resource_type, resource_id, expires_at) VALUES (?, ?, ?, ?)',
      [token, 'estimate', estimate.id, expiresAt]
    );
    await db.execute(
      "UPDATE estimates SET status = 'sent', sent_at = NOW(), expires_at = DATE_ADD(NOW(), INTERVAL ? DAY) WHERE id = ?",
      [ESTIMATE_VALID_DAYS, estimate.id]
    );

    const basePath = process.env.BASE_PATH || '';
    const viewUrl = `${process.env.BASE_URL || ''}${basePath}/e/${token}`;
    const pdf = await generateEstimatePdf({
      estimate,
      items,
      customer: { name: estimate.customer_name, email: estimate.customer_email, phone: estimate.customer_phone, address: estimate.customer_address },
    });

    await sendMail({
      to: estimate.customer_email,
      subject: `Your estimate from Connected Home Outfitters — ${estimate.title}`,
      template: 'estimate-sent',
      data: { customerName: estimate.customer_name, estimateTitle: estimate.title, total: estimate.total, viewUrl },
      attachments: [{ filename: `estimate-${estimate.id}.pdf`, content: pdf }],
    });

    // Reminder to follow up if the customer hasn't responded in a few days.
    const followUpDue = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await db.execute(
      `INSERT INTO jobs (type, title, customer_id, estimate_id, assigned_to, due_date)
       VALUES ('estimate_followup', ?, ?, ?, ?, ?)`,
      [`Follow up: ${estimate.title}`, estimate.customer_id, estimate.id, req.user.id, followUpDue]
    );

    res.redirect(`${res.locals.basePath}/admin/estimates/${estimate.id}/edit`);
  } catch (err) {
    next(err);
  }
});

// Marks an estimate accepted and creates the deposit invoice. Called once the customer
// accepts via their portal link (see routes/portal.js), not directly from the admin UI.
async function createDepositInvoice(conn, estimate) {
  const depositAmount = estimate.total * (estimate.deposit_percent / 100);
  return createInvoice(conn, {
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
  const conn = await db.getConnection();
  try {
    const [rows] = await conn.execute('SELECT * FROM estimates WHERE id = ?', [req.params.id]);
    const estimate = rows[0];
    if (!estimate) { conn.release(); return res.status(404).render('error', { message: 'Estimate not found' }); }
    if (estimate.status !== 'accepted') {
      conn.release();
      return res.status(409).render('error', { message: 'A final invoice can only be billed on an accepted estimate.' });
    }

    const remaining = await remainingBalanceForEstimate(conn, estimate.id);
    if (remaining <= 0.005) {
      conn.release();
      return res.status(409).render('error', { message: 'This estimate is already fully invoiced — nothing left to bill.' });
    }

    await conn.beginTransaction();
    const invoiceId = await createInvoice(conn, {
      estimate_id: estimate.id,
      customer_id: estimate.customer_id,
      type: 'final',
      amount: remaining,
      description: `Final balance — ${estimate.title}`,
    });
    await conn.commit();
    res.redirect(`${res.locals.basePath}/admin/invoices/${invoiceId}`);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
module.exports.createDepositInvoice = createDepositInvoice;
