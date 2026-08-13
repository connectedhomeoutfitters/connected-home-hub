const express = require('express');
const router = express.Router();

// Public landing for anyone not signed in as staff — explains what CHO Hub is and offers
// the two entry points (staff login / customer portal). Logged-in staff fall through to
// the dashboard handler below.
router.get('/', (req, res, next) => {
  if (req.isAuthenticated()) return next();
  return res.render('landing', {
    portalBranded: true, bodyClass: 'portal-page landing-page', pageScript: null,
  });
});

router.get('/', async (req, res, next) => {
  try {
    const org = [req.orgId];
    const [[{ c: newLeads }]] = await req.db.execute(
      "SELECT COUNT(*) AS c FROM leads WHERE org_id = ? AND status = 'new'", org);
    const [[{ c: draftConsultations }]] = await req.db.execute(
      "SELECT COUNT(*) AS c FROM consultations WHERE org_id = ? AND status = 'scheduled'", org);
    const [[{ c: sentEstimates, total: sentEstimatesTotal }]] = await req.db.execute(
      "SELECT COUNT(*) AS c, COALESCE(SUM(total), 0) AS total FROM estimates WHERE org_id = ? AND status = 'sent'", org);
    const [[{ c: pendingInvoices, total: pendingInvoicesTotal }]] = await req.db.execute(
      "SELECT COUNT(*) AS c, COALESCE(SUM(amount), 0) AS total FROM invoices WHERE org_id = ? AND status = 'pending'", org);
    const [[{ c: totalCustomers }]] = await req.db.execute(
      'SELECT COUNT(*) AS c FROM customers WHERE org_id = ?', org);
    const [[{ c: openJobs }]] = await req.db.execute(
      "SELECT COUNT(*) AS c FROM jobs WHERE org_id = ? AND status IN ('pending', 'in_progress')", org);

    const [recentLeads] = await req.db.execute(
      "SELECT id, name, email, created_at FROM leads WHERE org_id = ? AND status = 'new' ORDER BY created_at DESC LIMIT 5",
      org
    );
    const [recentEstimates] = await req.db.execute(
      `SELECT e.id, e.title, e.total, e.sent_at, c.name AS customer_name FROM estimates e
       JOIN customers c ON c.id = e.customer_id AND c.org_id = e.org_id
       WHERE e.org_id = ? AND e.status = 'sent' ORDER BY e.sent_at DESC LIMIT 5`,
      org
    );
    const [recentConsultations] = await req.db.execute(
      `SELECT co.id, c.name AS customer_name, co.created_at FROM consultations co
       JOIN customers c ON c.id = co.customer_id AND c.org_id = co.org_id
       WHERE co.org_id = ? AND co.status = 'scheduled' ORDER BY co.created_at DESC LIMIT 5`,
      org
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
