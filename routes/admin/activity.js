const express = require('express');
const router = express.Router();
const { requireAuth } = require('../../middleware/auth');

router.use(requireAuth);

// Activity feed for this tenant (most recent 200), optionally scoped to one customer via
// ?customer_id (linked from the customer detail page).
router.get('/', async (req, res, next) => {
  try {
    const params = [req.orgId];
    let clause = '';
    if (req.query.customer_id) {
      clause = 'AND a.customer_id = ?';
      params.push(req.query.customer_id);
    }
    const [rows] = await req.db.execute(
      `SELECT a.*, c.name AS customer_name FROM activity_log a
       LEFT JOIN customers c ON c.id = a.customer_id AND c.org_id = a.org_id
       WHERE a.org_id = ? ${clause} ORDER BY a.created_at DESC LIMIT 200`,
      params
    );

    let customer = null;
    if (req.query.customer_id) {
      const [cr] = await req.db.execute(
        'SELECT id, name FROM customers WHERE id = ? AND org_id = ?',
        [req.query.customer_id, req.orgId]
      );
      customer = cr[0] || null;
    }

    res.render('admin/activity', { pageScript: null, rows, customer });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
