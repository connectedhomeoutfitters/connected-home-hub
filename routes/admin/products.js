const express = require('express');
const router = express.Router();
const db = require('../../config/db');
const { requireAuth } = require('../../middleware/auth');
const { adjustStock } = require('../../services/inventory');

router.use(requireAuth);

// Distinct existing categories, for the <datalist> on the product forms — staff pick an
// existing one or type a brand-new value (the routes save whatever's submitted, so a new
// category just works). Includes inactive products so a category doesn't vanish when its
// last product is deactivated.
async function loadCategories() {
  const [rows] = await db.execute(
    "SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category <> '' ORDER BY category"
  );
  return rows.map((r) => r.category);
}

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
    const lowOnly = req.query.low === '1';
    const [products] = await db.execute(
      `SELECT * FROM products
       ${lowOnly ? 'WHERE track_inventory = 1 AND reorder_level IS NOT NULL AND stock_qty <= reorder_level' : ''}
       ORDER BY active DESC, category, name`
    );
    const [[low]] = await db.execute(
      'SELECT COUNT(*) AS c FROM products WHERE track_inventory = 1 AND reorder_level IS NOT NULL AND stock_qty <= reorder_level'
    );
    res.render('admin/products', { pageScript: 'page-products.js', products, lowOnly, lowCount: low.c, categories: await loadCategories() });
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
    const [movements] = await db.execute(
      `SELECT sm.*, u.name AS by_name FROM stock_movements sm
       LEFT JOIN users u ON u.id = sm.created_by
       WHERE sm.product_id = ? ORDER BY sm.created_at DESC LIMIT 30`,
      [req.params.id]
    );
    res.render('admin/products-edit', { pageScript: null, product: rows[0], movements, categories: await loadCategories() });
  } catch (err) {
    next(err);
  }
});

// Manual stock change — "receive" adds the entered quantity; "set" adjusts to an absolute
// count (recorded as an 'adjust' movement for the difference).
router.post('/:id/stock', async (req, res, next) => {
  try {
    const [rows] = await db.execute('SELECT id, stock_qty FROM products WHERE id = ?', [req.params.id]);
    const product = rows[0];
    if (!product) return res.status(404).render('error', { message: 'Product not found' });

    const qty = parseInt(req.body.qty, 10);
    if (isNaN(qty)) return res.redirect(`${res.locals.basePath}/admin/products/${req.params.id}/edit`);

    if (req.body.mode === 'set') {
      const delta = qty - product.stock_qty;
      if (delta !== 0) {
        await adjustStock(db, { productId: product.id, delta, reason: 'adjust', note: (req.body.note || '').trim() || null, userId: req.user.id });
      }
    } else {
      await adjustStock(db, { productId: product.id, delta: qty, reason: 'receive', note: (req.body.note || '').trim() || null, userId: req.user.id });
    }
    res.redirect(`${res.locals.basePath}/admin/products/${req.params.id}/edit`);
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
        taxable=?, unit_of_measure=?, reference_url=?, track_inventory=?, reorder_level=? WHERE id=?`,
      [category, vendor || null, product_line || null, name, description || null,
        part_number || null, vendor_cost || 0, markup_percent || null, markup_enabled,
        retail_price, taxable === 'on', unit_of_measure || 'Each', reference_url || null,
        req.body.track_inventory === 'on', req.body.reorder_level || null,
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
