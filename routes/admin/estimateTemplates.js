const express = require('express');
const router = express.Router();
const db = require('../../config/db');
const { requireAuth } = require('../../middleware/auth');
const { lineItemsFromBody } = require('../../services/lineItems');
const { parseFlatPrice } = require('../../services/estimatePricing');
const { computeCosting } = require('../../services/estimateCosting');
const { getCompany } = require('../../services/companySettings');

router.use(requireAuth);

async function loadCatalog() {
  const [products] = await db.execute(
    'SELECT id, category, name, retail_price, vendor_cost FROM products WHERE active = 1 ORDER BY category, name'
  );
  const [laborRates] = await db.execute(
    'SELECT id, name, hourly_rate FROM labor_rates WHERE active = 1 ORDER BY name'
  );
  const [subcontractors] = await db.execute(
    'SELECT id, name, trade, hourly_rate FROM subcontractors WHERE active = 1 ORDER BY name'
  );
  return { products, laborRates, subcontractors };
}

router.get('/', async (req, res, next) => {
  try {
    const [templates] = await db.execute(
      `SELECT t.*, (SELECT COUNT(*) FROM estimate_template_items i WHERE i.template_id = t.id) AS item_count
       FROM estimate_templates t ORDER BY t.active DESC, t.name`
    );
    res.render('admin/estimate-templates', { pageScript: null, templates });
  } catch (err) {
    next(err);
  }
});

router.get('/new', async (req, res, next) => {
  try {
    const { products, laborRates, subcontractors } = await loadCatalog();
    const company = await getCompany();
    res.render('admin/estimate-template-form', {
      pageScript: 'page-estimate-form.js', isNew: true,
      template: { name: '', title: '', description: '', deposit_percent: 50, tax_percent: company.default_tax_percent, flat_price: null },
      items: [], costing: computeCosting([], null), products, laborRates, subcontractors,
    });
  } catch (err) {
    next(err);
  }
});

async function saveItems(conn, templateId, items) {
  await conn.execute('DELETE FROM estimate_template_items WHERE template_id = ?', [templateId]);
  for (let i = 0; i < items.length; i++) {
    await conn.execute(
      `INSERT INTO estimate_template_items
        (template_id, product_id, labor_rate_id, subcontractor_id, description, quantity, unit_price, unit_cost, hide_price, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [templateId, items[i].product_id, items[i].labor_rate_id, items[i].subcontractor_id, items[i].description,
        items[i].quantity, items[i].unit_price, items[i].unit_cost, items[i].hide_price, i]
    );
  }
}

router.post('/', async (req, res, next) => {
  const conn = await db.getConnection();
  try {
    const items = lineItemsFromBody(req.body);
    const flatPrice = parseFlatPrice(req.body.flat_price);
    await conn.beginTransaction();
    const [result] = await conn.execute(
      'INSERT INTO estimate_templates (name, title, description, deposit_percent, tax_percent, flat_price) VALUES (?, ?, ?, ?, ?, ?)',
      [req.body.name, req.body.title || req.body.name, req.body.description || null,
        parseFloat(req.body.deposit_percent) || 50, req.body.tax_percent === '' ? null : parseFloat(req.body.tax_percent),
        flatPrice != null ? flatPrice.toFixed(2) : null]
    );
    await saveItems(conn, result.insertId, items);
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
    const [rows] = await db.execute('SELECT * FROM estimate_templates WHERE id = ?', [req.params.id]);
    const template = rows[0];
    if (!template) return res.status(404).render('error', { message: 'Template not found' });
    const [items] = await db.execute(
      'SELECT * FROM estimate_template_items WHERE template_id = ? ORDER BY sort_order',
      [req.params.id]
    );
    const { products, laborRates, subcontractors } = await loadCatalog();
    res.render('admin/estimate-template-form', {
      pageScript: 'page-estimate-form.js', isNew: false, template, items,
      costing: computeCosting(items, template.flat_price), products, laborRates, subcontractors,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id', async (req, res, next) => {
  const conn = await db.getConnection();
  try {
    const items = lineItemsFromBody(req.body);
    const flatPrice = parseFlatPrice(req.body.flat_price);
    await conn.beginTransaction();
    await conn.execute(
      'UPDATE estimate_templates SET name=?, title=?, description=?, deposit_percent=?, tax_percent=?, flat_price=? WHERE id=?',
      [req.body.name, req.body.title || req.body.name, req.body.description || null,
        parseFloat(req.body.deposit_percent) || 50, req.body.tax_percent === '' ? null : parseFloat(req.body.tax_percent),
        flatPrice != null ? flatPrice.toFixed(2) : null, req.params.id]
    );
    await saveItems(conn, req.params.id, items);
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
    await db.execute('UPDATE estimate_templates SET active = NOT active WHERE id = ?', [req.params.id]);
    res.redirect(`${res.locals.basePath}/admin/estimate-templates`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
