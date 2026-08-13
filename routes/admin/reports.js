const express = require('express');
const router = express.Router();
const { requireAuth } = require('../../middleware/auth');

router.use(requireAuth);

// Business reporting drawn entirely from existing tables — no new schema. Each query is
// simple/aggregate; the derived ratios (win rate, conversion, month-fill) are computed in
// JS so the SQL stays readable.
router.get('/', async (req, res, next) => {
  try {
    // --- Revenue (net = succeeded charges minus refunds) ---
    const [[rev]] = await req.db.execute(
      `SELECT COALESCE(SUM(CASE WHEN status='succeeded' THEN amount ELSE 0 END),0) AS gross,
              COALESCE(SUM(amount_refunded),0) AS refunded
       FROM payments WHERE org_id = ?`,
      [req.orgId]
    );
    const netRevenue = Number(rev.gross) - Number(rev.refunded);

    // Net revenue by month, last 12 months. Fill gaps in JS so every month shows.
    const [monthRows] = await req.db.execute(
      `SELECT DATE_FORMAT(created_at,'%Y-%m') AS ym,
              SUM(CASE WHEN status='succeeded' THEN amount ELSE 0 END) - SUM(amount_refunded) AS net
       FROM payments
       WHERE org_id = ?
         AND created_at >= DATE_SUB(DATE_FORMAT(CURDATE(),'%Y-%m-01'), INTERVAL 11 MONTH)
       GROUP BY ym`,
      [req.orgId]
    );
    const byMonthMap = Object.fromEntries(monthRows.map((r) => [r.ym, Number(r.net) || 0]));
    const months = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      months.push({ ym, label: d.toLocaleString('en-US', { month: 'short' }), net: byMonthMap[ym] || 0 });
    }
    const maxMonth = Math.max(1, ...months.map((m) => m.net));

    // --- Outstanding A/R (unpaid invoices) ---
    const [[ar]] = await req.db.execute(
      "SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS total FROM invoices WHERE org_id = ? AND status='pending'",
      [req.orgId]
    );

    // --- Estimate pipeline (count + value by status) ---
    const [estRows] = await req.db.execute(
      'SELECT status, COUNT(*) AS c, COALESCE(SUM(total),0) AS total FROM estimates WHERE org_id = ? GROUP BY status',
      [req.orgId]
    );
    const est = Object.fromEntries(estRows.map((r) => [r.status, { c: r.c, total: Number(r.total) }]));
    const openPipeline = (est.draft?.total || 0) + (est.sent?.total || 0);
    const decided = (est.accepted?.c || 0) + (est.declined?.c || 0) + (est.expired?.c || 0);
    const winRate = decided > 0 ? Math.round(((est.accepted?.c || 0) / decided) * 100) : null;

    // --- Revenue mix by invoice type (paid, net) ---
    const [mixRows] = await req.db.execute(
      `SELECT i.type, COUNT(*) AS c,
              COALESCE(SUM(p.amount),0) - COALESCE(SUM(p.amount_refunded),0) AS net
       FROM payments p JOIN invoices i ON i.id = p.invoice_id AND i.org_id = p.org_id
       WHERE p.org_id = ? AND p.status='succeeded' GROUP BY i.type`,
      [req.orgId]
    );

    // --- Lead funnel ---
    const [leadRows] = await req.db.execute(
      'SELECT status, COUNT(*) AS c FROM leads WHERE org_id = ? GROUP BY status',
      [req.orgId]
    );
    const leadByStatus = Object.fromEntries(leadRows.map((r) => [r.status, r.c]));
    const totalLeads = leadRows.reduce((s, r) => s + r.c, 0);
    const convertedLeads = leadByStatus.converted || 0;
    const leadConversion = totalLeads > 0 ? Math.round((convertedLeads / totalLeads) * 100) : null;

    res.render('admin/reports', {
      pageScript: null,
      netRevenue, refunded: Number(rev.refunded),
      months, maxMonth,
      ar,
      est, estRows, openPipeline, winRate,
      mixRows,
      leadByStatus, totalLeads, leadConversion,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
