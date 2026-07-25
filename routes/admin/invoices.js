const express = require('express');
const router = express.Router();
const db = require('../../config/db');
const { requireAuth } = require('../../middleware/auth');

router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const [invoices] = await db.execute(
      `SELECT i.*, c.name AS customer_name FROM invoices i
       JOIN customers c ON c.id = i.customer_id
       ORDER BY i.created_at DESC`
    );
    res.render('admin/invoices', { pageScript: 'page-invoices.js', invoices });
  } catch (err) {
    next(err);
  }
});

// TODO: create standalone/final invoice, generate customer access token + send email

module.exports = router;
