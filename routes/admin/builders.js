const express = require('express');
const router = express.Router();
const { requireAuth } = require('../../middleware/auth');
const { pageParams, pager } = require('../../services/pagination');

router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    // Each builder with a count of referred customers, so the list conveys referral volume.
    const { page, perPage, limit, offset } = pageParams(req);
    const [[{ total }]] = await req.db.execute(
      'SELECT COUNT(*) AS total FROM builders WHERE org_id = ?', [req.orgId]
    );
    const [builders] = await req.db.execute(
      `SELECT b.*, (SELECT COUNT(*) FROM customers c
                    WHERE c.builder_id = b.id AND c.org_id = b.org_id) AS customer_count
       FROM builders b WHERE b.org_id = ? ORDER BY b.active DESC, b.name
       LIMIT ${limit} OFFSET ${offset}`,
      [req.orgId]
    );
    res.render('admin/builders', {
      pageScript: null, builders, pager: pager({ page, perPage, total }),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, contact_name, phone, email, address, notes } = req.body;
    await req.db.execute(
      'INSERT INTO builders (org_id, name, contact_name, phone, email, address, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [req.orgId, name, contact_name || null, phone || null, email || null, address || null, notes || null]
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
    const [rows] = await req.db.execute(
      'SELECT * FROM builders WHERE id = ? AND org_id = ?',
      [req.params.id, req.orgId]
    );
    const builder = rows[0];
    if (!builder) return res.status(404).render('error', { message: 'Builder not found' });

    const [customers] = await req.db.execute(
      `SELECT c.id, c.name, c.email,
              COALESCE((SELECT SUM(p.amount) - SUM(p.amount_refunded) FROM payments p
                        JOIN invoices i ON i.id = p.invoice_id AND i.org_id = p.org_id
                        WHERE i.customer_id = c.id AND p.org_id = c.org_id
                          AND p.status = 'succeeded'), 0) AS revenue
       FROM customers c WHERE c.builder_id = ? AND c.org_id = ? ORDER BY c.name`,
      [req.params.id, req.orgId]
    );
    const totalRevenue = customers.reduce((s, c) => s + Number(c.revenue), 0);
    res.render('admin/builder-detail', { pageScript: null, builder, customers, totalRevenue });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/edit', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(
      'SELECT * FROM builders WHERE id = ? AND org_id = ?',
      [req.params.id, req.orgId]
    );
    if (!rows[0]) return res.status(404).render('error', { message: 'Builder not found' });
    res.render('admin/builder-edit', { pageScript: null, builder: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.post('/:id', async (req, res, next) => {
  try {
    const { name, contact_name, phone, email, address, notes } = req.body;
    await req.db.execute(
      'UPDATE builders SET name=?, contact_name=?, phone=?, email=?, address=?, notes=? WHERE id=? AND org_id=?',
      [name, contact_name || null, phone || null, email || null, address || null, notes || null, req.params.id, req.orgId]
    );
    res.redirect(`${res.locals.basePath}/admin/builders/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/toggle-active', async (req, res, next) => {
  try {
    await req.db.execute(
      'UPDATE builders SET active = NOT active WHERE id = ? AND org_id = ?',
      [req.params.id, req.orgId]
    );
    res.redirect(`${res.locals.basePath}/admin/builders`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
