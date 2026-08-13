const express = require('express');
const router = express.Router();
const { requireAuth } = require('../../middleware/auth');
const { lineItemsFromBody } = require('../../services/lineItems');
const { parseFlatPrice } = require('../../services/estimatePricing');
const { computeCosting } = require('../../services/estimateCosting');
const { getCompany } = require('../../services/companySettings');

router.use(requireAuth);

async function loadCatalog(db, orgId) {
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

router.get('/', async (req, res, next) => {
  try {
    const [templates] = await req.db.execute(
      `SELECT t.*, (SELECT COUNT(*) FROM estimate_template_items i
                    WHERE i.template_id = t.id AND i.org_id = t.org_id) AS item_count
       FROM estimate_templates t WHERE t.org_id = ? ORDER BY t.active DESC, t.name`,
      [req.orgId]
    );
    res.render('admin/estimate-templates', { pageScript: null, templates });
  } catch (err) {
    next(err);
  }
});

router.get('/new', async (req, res, next) => {
  try {
    const { products, laborRates, subcontractors } = await loadCatalog(req.db, req.orgId);
    const company = await getCompany(req.orgId);
    res.render('admin/estimate-template-form', {
      pageScript: 'page-estimate-form.js', isNew: true,
      template: { name: '', title: '', description: '', deposit_percent: 50, tax_percent: company.default_tax_percent, flat_price: null },
      items: [], costing: computeCosting([], null), products, laborRates, subcontractors,
    });
  } catch (err) {
    next(err);
  }
});

async function saveItems(conn, orgId, templateId, items) {
  await conn.execute(
    'DELETE FROM estimate_template_items WHERE template_id = ? AND org_id = ?',
    [templateId, orgId]
  );
  for (let i = 0; i < items.length; i++) {
    await conn.execute(
      `INSERT INTO estimate_template_items
        (org_id, template_id, product_id, labor_rate_id, subcontractor_id, description, quantity, unit_price, unit_cost, hide_price, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [orgId, templateId, items[i].product_id, items[i].labor_rate_id, items[i].subcontractor_id, items[i].description,
        items[i].quantity, items[i].unit_price, items[i].unit_cost, items[i].hide_price, i]
    );
  }
}

router.post('/', async (req, res, next) => {
  const conn = await req.db.getConnection();
  try {
    const items = lineItemsFromBody(req.body);
    const flatPrice = parseFlatPrice(req.body.flat_price);
    await conn.beginTransaction();
    const [result] = await conn.execute(
      'INSERT INTO estimate_templates (org_id, name, title, description, deposit_percent, tax_percent, flat_price) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [req.orgId, req.body.name, req.body.title || req.body.name, req.body.description || null,
        parseFloat(req.body.deposit_percent) || 50, req.body.tax_percent === '' ? null : parseFloat(req.body.tax_percent),
        flatPrice != null ? flatPrice.toFixed(2) : null]
    );
    await saveItems(conn, req.orgId, result.insertId, items);
    await conn.commit();
    res.redirect(`${res.locals.basePath}/admin/estimate-templates`);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.get('/:id/edit', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(
      'SELECT * FROM estimate_templates WHERE id = ? AND org_id = ?',
      [req.params.id, req.orgId]
    );
    const template = rows[0];
    if (!template) return res.status(404).render('error', { message: 'Template not found' });
    const [items] = await req.db.execute(
      'SELECT * FROM estimate_template_items WHERE template_id = ? AND org_id = ? ORDER BY sort_order',
      [req.params.id, req.orgId]
    );
    const { products, laborRates, subcontractors } = await loadCatalog(req.db, req.orgId);
    res.render('admin/estimate-template-form', {
      pageScript: 'page-estimate-form.js', isNew: false, template, items,
      costing: computeCosting(items, template.flat_price), products, laborRates, subcontractors,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id', async (req, res, next) => {
  const conn = await req.db.getConnection();
  try {
    const items = lineItemsFromBody(req.body);
    const flatPrice = parseFlatPrice(req.body.flat_price);
    await conn.beginTransaction();
    await conn.execute(
      'UPDATE estimate_templates SET name=?, title=?, description=?, deposit_percent=?, tax_percent=?, flat_price=? WHERE id=? AND org_id=?',
      [req.body.name, req.body.title || req.body.name, req.body.description || null,
        parseFloat(req.body.deposit_percent) || 50, req.body.tax_percent === '' ? null : parseFloat(req.body.tax_percent),
        flatPrice != null ? flatPrice.toFixed(2) : null, req.params.id, req.orgId]
    );
    await saveItems(conn, req.orgId, req.params.id, items);
    await conn.commit();
    res.redirect(`${res.locals.basePath}/admin/estimate-templates`);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.post('/:id/toggle-active', async (req, res, next) => {
  try {
    await req.db.execute(
      'UPDATE estimate_templates SET active = NOT active WHERE id = ? AND org_id = ?',
      [req.params.id, req.orgId]
    );
    res.redirect(`${res.locals.basePath}/admin/estimate-templates`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
