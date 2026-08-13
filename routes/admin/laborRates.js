const express = require('express');
const router = express.Router();
const { requireAuth } = require('../../middleware/auth');

router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const [laborRates] = await req.db.execute(
      'SELECT * FROM labor_rates WHERE org_id = ? ORDER BY active DESC, name',
      [req.orgId]
    );
    res.render('admin/labor-rates', { pageScript: null, laborRates });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, hourly_rate, notes } = req.body;
    await req.db.execute(
      'INSERT INTO labor_rates (org_id, name, hourly_rate, notes) VALUES (?, ?, ?, ?)',
      [req.orgId, name, hourly_rate || 0, notes || null]
    );
    res.redirect(`${res.locals.basePath}/admin/labor-rates`);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/edit', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(
      'SELECT * FROM labor_rates WHERE id = ? AND org_id = ?',
      [req.params.id, req.orgId]
    );
    if (!rows[0]) return res.status(404).render('error', { message: 'Labor rate not found' });
    res.render('admin/labor-rates-edit', { pageScript: null, laborRate: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.post('/:id', async (req, res, next) => {
  try {
    const { name, hourly_rate, notes } = req.body;
    await req.db.execute(
      'UPDATE labor_rates SET name=?, hourly_rate=?, notes=? WHERE id=? AND org_id=?',
      [name, hourly_rate || 0, notes || null, req.params.id, req.orgId]
    );
    res.redirect(`${res.locals.basePath}/admin/labor-rates`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/toggle-active', async (req, res, next) => {
  try {
    await req.db.execute(
      'UPDATE labor_rates SET active = NOT active WHERE id = ? AND org_id = ?',
      [req.params.id, req.orgId]
    );
    res.redirect(`${res.locals.basePath}/admin/labor-rates`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
