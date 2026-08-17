const express = require('express');
const router = express.Router();
const { requireAuth } = require('../../middleware/auth');
const { pageParams, pager } = require('../../services/pagination');

router.use(requireAuth);

// Activity feed for this tenant, optionally scoped to one customer via ?customer_id
// (linked from the customer detail page).
//
// This was capped at the most recent 200 with no way to see past them — an append-only
// audit log that silently hides its own history is not much of an audit log. Now paged, so
// the whole record is reachable.
router.get('/', async (req, res, next) => {
  try {
    const params = [req.orgId];
    let clause = '';
    if (req.query.customer_id) {
      clause = 'AND a.customer_id = ?';
      params.push(req.query.customer_id);
    }
    const { page, perPage, limit, offset } = pageParams(req);
    const [[{ total }]] = await req.db.execute(
      `SELECT COUNT(*) AS total FROM activity_log a WHERE a.org_id = ? ${clause}`,
      params
    );
    const [rows] = await req.db.execute(
      `SELECT a.*, c.name AS customer_name FROM activity_log a
       LEFT JOIN customers c ON c.id = a.customer_id AND c.org_id = a.org_id
       WHERE a.org_id = ? ${clause} ORDER BY a.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
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

    res.render('admin/activity', {
      pageScript: null, rows, customer, pager: pager({ page, perPage, total }),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
