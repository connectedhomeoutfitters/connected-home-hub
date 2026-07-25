const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const [[{ c: newLeads }]] = await db.execute("SELECT COUNT(*) AS c FROM leads WHERE status = 'new'");
    const [[{ c: draftConsultations }]] = await db.execute("SELECT COUNT(*) AS c FROM consultations WHERE status = 'scheduled'");
    const [[{ c: sentEstimates, total: sentEstimatesTotal }]] = await db.execute(
      "SELECT COUNT(*) AS c, COALESCE(SUM(total), 0) AS total FROM estimates WHERE status = 'sent'"
    );
    const [[{ c: pendingInvoices, total: pendingInvoicesTotal }]] = await db.execute(
      "SELECT COUNT(*) AS c, COALESCE(SUM(amount), 0) AS total FROM invoices WHERE status = 'pending'"
    );
    const [[{ c: totalCustomers }]] = await db.execute('SELECT COUNT(*) AS c FROM customers');
    const [[{ c: openJobs }]] = await db.execute("SELECT COUNT(*) AS c FROM jobs WHERE status IN ('pending', 'in_progress')");

    const [recentLeads] = await db.execute(
      "SELECT id, name, email, created_at FROM leads WHERE status = 'new' ORDER BY created_at DESC LIMIT 5"
    );
    const [recentEstimates] = await db.execute(
      `SELECT e.id, e.title, e.total, e.sent_at, c.name AS customer_name FROM estimates e
       JOIN customers c ON c.id = e.customer_id WHERE e.status = 'sent' ORDER BY e.sent_at DESC LIMIT 5`
    );
    const [recentConsultations] = await db.execute(
      `SELECT co.id, c.name AS customer_name, co.created_at FROM consultations co
       JOIN customers c ON c.id = co.customer_id WHERE co.status = 'scheduled' ORDER BY co.created_at DESC LIMIT 5`
    );

    res.render('dashboard', {
      pageScript: null,
      stats: {
        newLeads, draftConsultations, sentEstimates, sentEstimatesTotal,
        pendingInvoices, pendingInvoicesTotal, totalCustomers, openJobs,
      },
      recentLeads, recentEstimates, recentConsultations,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
