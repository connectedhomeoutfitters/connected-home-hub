const express = require('express');
const router = express.Router();
const db = require('../../config/db');
const { requireAuth } = require('../../middleware/auth');

router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    // Each builder with a count of referred customers, so the list conveys referral volume.
    const [builders] = await db.execute(
      `SELECT b.*, (SELECT COUNT(*) FROM customers c WHERE c.builder_id = b.id) AS customer_count
       FROM builders b ORDER BY b.active DESC, b.name`
    );
    res.render('admin/builders', { pageScript: null, builders });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, contact_name, phone, email, address, notes } = req.body;
    await db.execute(
      'INSERT INTO builders (name, contact_name, phone, email, address, notes) VALUES (?, ?, ?, ?, ?, ?)',
      [name, contact_name || null, phone || null, email || null, address || null, notes || null]
    );
    res.redirect(`${res.locals.basePath}/admin/builders`);
  } catch (err) {
    next(err);
  }
});

// Detail — the builder's referred customers plus the revenue (net paid) those customers
// have generated, so staff can see which builders are worth nurturing.
router.get('/:id', async (req, res, next) => {
  try {
    const [rows] = await db.execute('SELECT * FROM builders WHERE id = ?', [req.params.id]);
    const builder = rows[0];
    if (!builder) return res.status(404).render('error', { message: 'Builder not found' });

    const [customers] = await db.execute(
      `SELECT c.id, c.name, c.email,
              COALESCE((SELECT SUM(p.amount) - SUM(p.amount_refunded) FROM payments p
                        JOIN invoices i ON i.id = p.invoice_id
                        WHERE i.customer_id = c.id AND p.status = 'succeeded'), 0) AS revenue
       FROM customers c WHERE c.builder_id = ? ORDER BY c.name`,
      [req.params.id]
    );
    const totalRevenue = customers.reduce((s, c) => s + Number(c.revenue), 0);
    res.render('admin/builder-detail', { pageScript: null, builder, customers, totalRevenue });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/edit', async (req, res, next) => {
  try {
    const [rows] = await db.execute('SELECT * FROM builders WHERE id = ?', [req.params.id]);
    if (!rows[0]) return res.status(404).render('error', { message: 'Builder not found' });
    res.render('admin/builder-edit', { pageScript: null, builder: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.post('/:id', async (req, res, next) => {
  try {
    const { name, contact_name, phone, email, address, notes } = req.body;
    await db.execute(
      'UPDATE builders SET name=?, contact_name=?, phone=?, email=?, address=?, notes=? WHERE id=?',
      [name, contact_name || null, phone || null, email || null, address || null, notes || null, req.params.id]
    );
    res.redirect(`${res.locals.basePath}/admin/builders/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/toggle-active', async (req, res, next) => {
  try {
    await db.execute('UPDATE builders SET active = NOT active WHERE id = ?', [req.params.id]);
    res.redirect(`${res.locals.basePath}/admin/builders`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
