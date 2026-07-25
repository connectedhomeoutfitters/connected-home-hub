const express = require('express');
const router = express.Router();
const db = require('../../config/db');
const { requireAuth } = require('../../middleware/auth');

router.use(requireAuth);

// Global activity feed (most recent 200), optionally scoped to one customer via
// ?customer_id (linked from the customer detail page).
router.get('/', async (req, res, next) => {
  try {
    const params = [];
    let clause = '';
    if (req.query.customer_id) {
      clause = 'WHERE a.customer_id = ?';
      params.push(req.query.customer_id);
    }
    const [rows] = await db.execute(
      `SELECT a.*, c.name AS customer_name FROM activity_log a
       LEFT JOIN customers c ON c.id = a.customer_id
       ${clause} ORDER BY a.created_at DESC LIMIT 200`,
      params
    );

    let customer = null;
    if (req.query.customer_id) {
      const [cr] = await db.execute('SELECT id, name FROM customers WHERE id = ?', [req.query.customer_id]);
      customer = cr[0] || null;
    }

    res.render('admin/activity', { pageScript: null, rows, customer });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
