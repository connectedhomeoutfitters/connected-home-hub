const express = require('express');
const router = express.Router();
const db = require('../../config/db');
const { requireAuth } = require('../../middleware/auth');
const { createInvoice, remainingBalanceForEstimate } = require('../../services/invoicing');
const { consumeForJob } = require('../../services/inventory');
const activity = require('../../services/activityLog');

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
    res.render('admin/job-edit', { pageScript: null, job, staff, subcontractors });
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

module.exports = router;
