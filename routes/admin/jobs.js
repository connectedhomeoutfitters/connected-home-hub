const express = require('express');
const router = express.Router();
const db = require('../../config/db');
const { requireAuth } = require('../../middleware/auth');
const { createInvoice, remainingBalanceForEstimate } = require('../../services/invoicing');
const { consumeForJob } = require('../../services/inventory');
const { sendMail } = require('../../services/mailer');
const activity = require('../../services/activityLog');

// Payment picture for a job's estimate: how much is invoiced, paid, and still outstanding
// (pending invoices). Used on the job page so staff know whether it's fully collected
// before closing the project out.
async function paymentStatusForEstimate(estimateId) {
  const [[row]] = await db.execute(
    `SELECT COALESCE(SUM(CASE WHEN status='paid' THEN amount ELSE 0 END),0) AS paid,
            COALESCE(SUM(CASE WHEN status='pending' THEN amount ELSE 0 END),0) AS outstanding,
            COUNT(*) AS invoice_count
     FROM invoices WHERE estimate_id = ? AND status <> 'void'`,
    [estimateId]
  );
  return {
    paid: Number(row.paid),
    outstanding: Number(row.outstanding),
    invoiceCount: row.invoice_count,
    fullyPaid: row.invoice_count > 0 && Number(row.outstanding) <= 0.005,
  };
}

router.use(requireAuth);

// When an install job tied to an accepted estimate is marked done: (1) consume the
// estimate's tracked products from inventory, and (2) bill the remaining balance. Both are
// idempotent (consumeForJob skips if already consumed; remainingBalanceForEstimate nets
// out invoices already raised), so re-marking a job done won't double-consume or
// double-bill. Returns the new invoice id (staff get redirected there) or null.
async function onInstallJobDone(req, jobId) {
  const [jrows] = await db.execute('SELECT * FROM jobs WHERE id = ?', [jobId]);
  const job = jrows[0];
  if (!job || job.type !== 'install' || !job.estimate_id) return null;
  const [erows] = await db.execute('SELECT * FROM estimates WHERE id = ?', [job.estimate_id]);
  const estimate = erows[0];
  if (!estimate || estimate.status !== 'accepted') return null;

  const conn = await db.getConnection();
  let invoiceId = null;
  try {
    await conn.beginTransaction();
    await consumeForJob(conn, { estimateId: estimate.id, jobId, userId: req.user.id });
    const remaining = await remainingBalanceForEstimate(conn, estimate.id);
    if (remaining > 0.005) {
      invoiceId = await createInvoice(conn, {
        estimate_id: estimate.id, customer_id: estimate.customer_id, type: 'final',
        amount: remaining, description: `Final balance — ${estimate.title}`,
      });
    }
    await conn.commit();
    if (invoiceId) {
      await activity.log({
        ...activity.staff(req), action: 'invoice.created', entityType: 'invoice', entityId: invoiceId,
        customerId: estimate.customer_id, detail: `Final invoice ($${remaining.toFixed(2)}) auto-created on job completion`,
      });
    }
    return invoiceId;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

router.get('/', async (req, res, next) => {
  try {
    const showAll = req.query.all === '1';
    const [jobs] = await db.execute(
      `SELECT j.*, c.name AS customer_name, u.name AS assigned_name FROM jobs j
       JOIN customers c ON c.id = j.customer_id
       LEFT JOIN users u ON u.id = j.assigned_to
       ${showAll ? '' : "WHERE j.status IN ('pending', 'in_progress')"}
       ORDER BY FIELD(j.status, 'in_progress', 'pending', 'done', 'cancelled'),
         (j.scheduled_at IS NULL), j.scheduled_at, (j.due_date IS NULL), j.due_date`
    );
    const [customers] = await db.execute('SELECT id, name FROM customers ORDER BY name');
    const [staff] = await db.execute("SELECT id, name FROM users ORDER BY name");
    res.render('admin/jobs', { pageScript: null, jobs, customers, staff, showAll });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { type, title, customer_id, due_date, assigned_to, notes } = req.body;
    await db.execute(
      `INSERT INTO jobs (type, title, customer_id, due_date, assigned_to, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [type || 'other', title, customer_id, due_date || null, assigned_to || null, notes || null]
    );
    res.redirect(`${res.locals.basePath}/admin/jobs`);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/edit', async (req, res, next) => {
  try {
    const [rows] = await db.execute(
      `SELECT j.*, c.name AS customer_name FROM jobs j JOIN customers c ON c.id = j.customer_id WHERE j.id = ?`,
      [req.params.id]
    );
    const job = rows[0];
    if (!job) return res.status(404).render('error', { message: 'Job not found' });
    const [staff] = await db.execute('SELECT id, name FROM users ORDER BY name');
    const [subcontractors] = await db.execute("SELECT id, name, trade FROM subcontractors WHERE active = 1 ORDER BY name");

    // Close-out context: payment status (if tied to an estimate) + the customer's active
    // warranties (what will be emailed on close-out).
    const payment = job.estimate_id ? await paymentStatusForEstimate(job.estimate_id) : null;
    const [warranties] = await db.execute(
      `SELECT item, provider, start_date, expires_on FROM warranties
       WHERE customer_id = ? AND active = 1 ORDER BY (expires_on IS NULL), expires_on`,
      [job.customer_id]
    );

    res.render('admin/job-edit', {
      pageScript: null, job, staff, subcontractors, payment, warranties,
      closed: req.query.closed === '1',
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id', async (req, res, next) => {
  try {
    const { title, status, due_date, scheduled_at, assigned_to, subcontractor_id, notes } = req.body;
    await db.execute(
      `UPDATE jobs SET title=?, status=?, due_date=?, scheduled_at=?, assigned_to=?, subcontractor_id=?, notes=? WHERE id=?`,
      [title, status, due_date || null, scheduled_at ? scheduled_at.replace('T', ' ') + ':00' : null,
        assigned_to || null, subcontractor_id || null, notes || null, req.params.id]
    );
    if (status === 'done') {
      const invoiceId = await onInstallJobDone(req, req.params.id);
      if (invoiceId) return res.redirect(`${res.locals.basePath}/admin/invoices/${invoiceId}?created=1`);
    }
    res.redirect(`${res.locals.basePath}/admin/jobs`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/status', async (req, res, next) => {
  try {
    await db.execute('UPDATE jobs SET status = ? WHERE id = ?', [req.body.status, req.params.id]);
    if (req.body.status === 'done') {
      const invoiceId = await onInstallJobDone(req, req.params.id);
      if (invoiceId) return res.redirect(`${res.locals.basePath}/admin/invoices/${invoiceId}?created=1`);
    }
    res.redirect(`${res.locals.basePath}/admin/jobs${req.query.all === '1' ? '?all=1' : ''}`);
  } catch (err) {
    next(err);
  }
});

// Close out a completed project: stamp closed_at and email the customer their warranty
// documentation. Deliberate staff action (they confirm it's done + paid first). Idempotent
// — a job already closed just redirects back.
router.post('/:id/close-out', async (req, res, next) => {
  try {
    const [rows] = await db.execute(
      `SELECT j.*, c.name AS customer_name, c.email AS customer_email FROM jobs j
       JOIN customers c ON c.id = j.customer_id WHERE j.id = ?`,
      [req.params.id]
    );
    const job = rows[0];
    if (!job) return res.status(404).render('error', { message: 'Job not found' });
    if (job.status !== 'done') {
      return res.status(409).render('error', { message: 'Only a completed (done) job can be closed out.' });
    }
    if (job.closed_at) return res.redirect(`${res.locals.basePath}/admin/jobs/${job.id}/edit?closed=1`);

    await db.execute('UPDATE jobs SET closed_at = NOW() WHERE id = ?', [job.id]);

    const [warranties] = await db.execute(
      `SELECT item, provider, type, start_date, expires_on, coverage_notes FROM warranties
       WHERE customer_id = ? AND active = 1 ORDER BY (expires_on IS NULL), expires_on`,
      [job.customer_id]
    );
    if (job.customer_email) {
      await sendMail({
        to: job.customer_email,
        subject: 'Your project is complete — Connected Home Outfitters',
        template: 'warranty-summary',
        data: { customerName: job.customer_name, projectTitle: job.title, warranties },
      });
    }

    await activity.log({
      ...activity.staff(req), action: 'job.closed', entityType: 'job', entityId: job.id,
      customerId: job.customer_id, detail: `Project "${job.title}" closed out (warranty docs sent)`,
    });

    res.redirect(`${res.locals.basePath}/admin/jobs/${job.id}/edit?closed=1`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
