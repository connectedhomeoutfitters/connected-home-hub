const express = require('express');
const router = express.Router();
const { requireAuth } = require('../../middleware/auth');
const { createInvoice, remainingBalanceForEstimate } = require('../../services/invoicing');
const { consumeForJob } = require('../../services/inventory');
const { sendMail } = require('../../services/mailer');
const jobStepMessages = require('../../config/jobStepMessages');
const activity = require('../../services/activityLog');

// Payment picture for a job's estimate: how much is invoiced, paid, and still outstanding
// (pending invoices). Used on the job page so staff know whether it's fully collected
// before closing the project out.
async function paymentStatusForEstimate(db, orgId, estimateId) {
  const [[row]] = await db.execute(
    `SELECT COALESCE(SUM(CASE WHEN status='paid' THEN amount ELSE 0 END),0) AS paid,
            COALESCE(SUM(CASE WHEN status='pending' THEN amount ELSE 0 END),0) AS outstanding,
            COUNT(*) AS invoice_count
     FROM invoices WHERE estimate_id = ? AND org_id = ? AND status <> 'void'`,
    [estimateId, orgId]
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
  const [jrows] = await req.db.execute(
    'SELECT * FROM jobs WHERE id = ? AND org_id = ?',
    [jobId, req.orgId]
  );
  const job = jrows[0];
  if (!job || job.type !== 'install' || !job.estimate_id) return null;
  const [erows] = await req.db.execute(
    'SELECT * FROM estimates WHERE id = ? AND org_id = ?',
    [job.estimate_id, req.orgId]
  );
  const estimate = erows[0];
  if (!estimate || estimate.status !== 'accepted') return null;

  const conn = await req.db.getConnection();
  let invoiceId = null;
  try {
    await conn.beginTransaction();
    await consumeForJob(conn, { orgId: req.orgId, estimateId: estimate.id, jobId, userId: req.user.id });
    const remaining = await remainingBalanceForEstimate(conn, req.orgId, estimate.id);
    if (remaining > 0.005) {
      invoiceId = await createInvoice(conn, {
        org_id: req.orgId,
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
    const [jobs] = await req.db.execute(
      `SELECT j.*, c.name AS customer_name, u.name AS assigned_name FROM jobs j
       JOIN customers c ON c.id = j.customer_id AND c.org_id = j.org_id
       LEFT JOIN users u ON u.id = j.assigned_to AND u.org_id = j.org_id
       WHERE j.org_id = ? ${showAll ? '' : "AND j.status IN ('pending', 'in_progress')"}
       ORDER BY FIELD(j.status, 'in_progress', 'pending', 'done', 'cancelled'),
         (j.scheduled_at IS NULL), j.scheduled_at, (j.due_date IS NULL), j.due_date`,
      [req.orgId]
    );
    // Only the count: the picker searches server-side, so the form no longer needs the
    // list — this is purely for the "no customers yet" empty state.
    const [[{ n: customerCount }]] = await req.db.execute(
      'SELECT COUNT(*) AS n FROM customers WHERE org_id = ?',
      [req.orgId]
    );
    const [staff] = await req.db.execute(
      'SELECT id, name FROM users WHERE org_id = ? ORDER BY name',
      [req.orgId]
    );
    res.render('admin/jobs', { pageScript: 'customer-picker.js', jobs, customerCount, staff, showAll });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { type, title, customer_id, due_date, assigned_to, notes } = req.body;
    // Guard against a forged customer_id attaching a job to another tenant's customer.
    const [[customer]] = await req.db.execute(
      'SELECT id FROM customers WHERE id = ? AND org_id = ?',
      [customer_id, req.orgId]
    );
    if (!customer) return res.status(404).render('error', { message: 'Customer not found' });

    await req.db.execute(
      `INSERT INTO jobs (org_id, type, title, customer_id, due_date, assigned_to, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.orgId, type || 'other', title, customer_id, due_date || null, assigned_to || null, notes || null]
    );
    res.redirect(`${res.locals.basePath}/admin/jobs`);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/edit', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(
      `SELECT j.*, c.name AS customer_name, c.email AS customer_email FROM jobs j
       JOIN customers c ON c.id = j.customer_id AND c.org_id = j.org_id
       WHERE j.id = ? AND j.org_id = ?`,
      [req.params.id, req.orgId]
    );
    const job = rows[0];
    if (!job) return res.status(404).render('error', { message: 'Job not found' });
    const [staff] = await req.db.execute(
      'SELECT id, name FROM users WHERE org_id = ? ORDER BY name',
      [req.orgId]
    );
    const [subcontractors] = await req.db.execute(
      'SELECT id, name, trade FROM subcontractors WHERE org_id = ? AND active = 1 ORDER BY name',
      [req.orgId]
    );

    // Close-out context: payment status (if tied to an estimate) + the customer's active
    // warranties (what will be emailed on close-out).
    const payment = job.estimate_id
      ? await paymentStatusForEstimate(req.db, req.orgId, job.estimate_id)
      : null;
    const [warranties] = await req.db.execute(
      `SELECT item, provider, start_date, expires_on FROM warranties
       WHERE customer_id = ? AND org_id = ? AND active = 1 ORDER BY (expires_on IS NULL), expires_on`,
      [job.customer_id, req.orgId]
    );

    res.render('admin/job-edit', {
      pageScript: null, job, staff, subcontractors, payment, warranties,
      stepMessage: jobStepMessages[job.type] || null,
      closed: req.query.closed === '1',
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id', async (req, res, next) => {
  try {
    const { title, status, due_date, scheduled_at, assigned_to, subcontractor_id, notes } = req.body;
    await req.db.execute(
      // Re-arm the pre-visit reminder whenever the appointment time actually moves: a
      // customer told "Tuesday 9am" must hear about Thursday. Only on a real change, so
      // saving an unrelated field (notes, assignee) doesn't re-send a reminder already
      // delivered for the same time. See services/visitReminders.js.
      // reminder_sent_at is assigned FIRST on purpose. MySQL evaluates SET assignments
      // left to right, and a later clause reads the NEW value of an earlier one — so
      // comparing against scheduled_at after assigning it would always match and never
      // re-arm. Reading it before the assignment compares old against new correctly.
      // <=> is the null-safe equality, so unscheduled-to-unscheduled counts as unchanged.
      `UPDATE jobs
          SET reminder_sent_at = CASE WHEN scheduled_at <=> ? THEN reminder_sent_at ELSE NULL END,
              title=?, status=?, due_date=?, scheduled_at=?, assigned_to=?, subcontractor_id=?, notes=?
         WHERE id=? AND org_id=?`,
      [scheduled_at ? scheduled_at.replace('T', ' ') + ':00' : null,
        title, status, due_date || null, scheduled_at ? scheduled_at.replace('T', ' ') + ':00' : null,
        assigned_to || null, subcontractor_id || null, notes || null,
        req.params.id, req.orgId]
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
    await req.db.execute(
      'UPDATE jobs SET status = ? WHERE id = ? AND org_id = ?',
      [req.body.status, req.params.id, req.orgId]
    );
    if (req.body.status === 'done') {
      const invoiceId = await onInstallJobDone(req, req.params.id);
      if (invoiceId) return res.redirect(`${res.locals.basePath}/admin/invoices/${invoiceId}?created=1`);
    }
    res.redirect(`${res.locals.basePath}/admin/jobs${req.query.all === '1' ? '?all=1' : ''}`);
  } catch (err) {
    next(err);
  }
});

// Close out a completed job/step: stamp closed_at and send the customer the communication
// that fits this step (config/jobStepMessages.js) — e.g. "consultation complete, preparing
// your estimate" for a consultation, warranty documentation for an install. Steps with no
// configured message still close out but send no email. Deliberate staff action (they
// confirm it's done first). Idempotent — a job already closed just redirects back.
router.post('/:id/close-out', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(
      `SELECT j.*, c.name AS customer_name, c.email AS customer_email FROM jobs j
       JOIN customers c ON c.id = j.customer_id AND c.org_id = j.org_id
       WHERE j.id = ? AND j.org_id = ?`,
      [req.params.id, req.orgId]
    );
    const job = rows[0];
    if (!job) return res.status(404).render('error', { message: 'Job not found' });
    if (job.status !== 'done') {
      return res.status(409).render('error', { message: 'Only a completed (done) job can be closed out.' });
    }
    if (job.closed_at) return res.redirect(`${res.locals.basePath}/admin/jobs/${job.id}/edit?closed=1`);

    await req.db.execute(
      'UPDATE jobs SET closed_at = NOW() WHERE id = ? AND org_id = ?',
      [job.id, req.orgId]
    );

    // Send the step-appropriate customer email, if this job type has one configured.
    const step = jobStepMessages[job.type];
    let notified = false;
    if (step && step.template && job.customer_email) {
      const data = { customerName: job.customer_name, projectTitle: job.title };
      if (step.includeWarranties) {
        const [warranties] = await req.db.execute(
          `SELECT item, provider, type, start_date, expires_on, coverage_notes FROM warranties
           WHERE customer_id = ? AND org_id = ? AND active = 1 ORDER BY (expires_on IS NULL), expires_on`,
          [job.customer_id, req.orgId]
        );
        data.warranties = warranties;
      }
      await sendMail({ orgId: req.orgId, to: job.customer_email, subject: step.subject, template: step.template, data });
      notified = true;
    }

    await activity.log({
      ...activity.staff(req), action: 'job.closed', entityType: 'job', entityId: job.id,
      customerId: job.customer_id,
      detail: `Step "${job.title}" (${job.type.replace('_', ' ')}) closed out${notified ? ' — customer notified' : ''}`,
    });

    res.redirect(`${res.locals.basePath}/admin/jobs/${job.id}/edit?closed=1`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
