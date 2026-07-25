const express = require('express');
const router = express.Router();
const db = require('../../config/db');
const { requireAuth } = require('../../middleware/auth');

router.use(requireAuth);

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
    res.render('admin/job-edit', { pageScript: null, job, staff });
  } catch (err) {
    next(err);
  }
});

router.post('/:id', async (req, res, next) => {
  try {
    const { title, status, due_date, scheduled_at, assigned_to, notes } = req.body;
    await db.execute(
      `UPDATE jobs SET title=?, status=?, due_date=?, scheduled_at=?, assigned_to=?, notes=? WHERE id=?`,
      [title, status, due_date || null, scheduled_at ? scheduled_at.replace('T', ' ') + ':00' : null,
        assigned_to || null, notes || null, req.params.id]
    );
    res.redirect(`${res.locals.basePath}/admin/jobs`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/status', async (req, res, next) => {
  try {
    await db.execute('UPDATE jobs SET status = ? WHERE id = ?', [req.body.status, req.params.id]);
    res.redirect(`${res.locals.basePath}/admin/jobs${req.query.all === '1' ? '?all=1' : ''}`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
