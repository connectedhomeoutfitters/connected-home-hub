const express = require('express');
const router = express.Router();
const db = require('../../config/db');
const { requireAuth } = require('../../middleware/auth');

router.use(requireAuth);

// If markup is enabled, retail_price is derived from cost + markup% rather than trusting
// whatever the form submitted for it — keeps the two from drifting out of sync.
function resolveRetailPrice({ vendor_cost, markup_percent, markup_enabled, retail_price }) {
  if (markup_enabled && markup_percent != null && markup_percent !== '') {
    return (Number(vendor_cost) * (1 + Number(markup_percent) / 100)).toFixed(2);
  }
  return Number(retail_price || 0).toFixed(2);
}

router.get('/', async (req, res, next) => {
  try {
    const [products] = await db.execute(
      'SELECT * FROM products ORDER BY active DESC, category, name'
    );
    res.render('admin/products', { pageScript: null, products });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { category, vendor, product_line, name, description, part_number, vendor_cost,
      markup_percent, taxable, unit_of_measure, reference_url } = req.body;
    const markup_enabled = req.body.markup_enabled === 'on';
    const retail_price = resolveRetailPrice({
      vendor_cost, markup_percent, markup_enabled, retail_price: req.body.retail_price,
    });

    await db.execute(
      `INSERT INTO products
        (category, vendor, product_line, name, description, part_number, vendor_cost,
         markup_percent, markup_enabled, retail_price, taxable, unit_of_measure, reference_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [category, vendor || null, product_line || null, name, description || null,
        part_number || null, vendor_cost || 0, markup_percent || null, markup_enabled,
        retail_price, taxable === 'on', unit_of_measure || 'Each', reference_url || null]
    );
    res.redirect(`${res.locals.basePath}/admin/products`);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/edit', async (req, res, next) => {
  try {
    const [rows] = await db.execute('SELECT * FROM products WHERE id = ?', [req.params.id]);
    if (!rows[0]) return res.status(404).render('error', { message: 'Product not found' });
    res.render('admin/products-edit', { pageScript: null, product: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.post('/:id', async (req, res, next) => {
  try {
    const { category, vendor, product_line, name, description, part_number, vendor_cost,
      markup_percent, taxable, unit_of_measure, reference_url } = req.body;
    const markup_enabled = req.body.markup_enabled === 'on';
    const retail_price = resolveRetailPrice({
      vendor_cost, markup_percent, markup_enabled, retail_price: req.body.retail_price,
    });

    await db.execute(
      `UPDATE products SET category=?, vendor=?, product_line=?, name=?, description=?,
        part_number=?, vendor_cost=?, markup_percent=?, markup_enabled=?, retail_price=?,
        taxable=?, unit_of_measure=?, reference_url=? WHERE id=?`,
      [category, vendor || null, product_line || null, name, description || null,
        part_number || null, vendor_cost || 0, markup_percent || null, markup_enabled,
        retail_price, taxable === 'on', unit_of_measure || 'Each', reference_url || null,
        req.params.id]
    );
    res.redirect(`${res.locals.basePath}/admin/products`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/toggle-active', async (req, res, next) => {
  try {
    await db.execute('UPDATE products SET active = NOT active WHERE id = ?', [req.params.id]);
    res.redirect(`${res.locals.basePath}/admin/products`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
