const express = require('express');
const router = express.Router();
const db = require('../../config/db');
const { requireAuth } = require('../../middleware/auth');

router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const [laborRates] = await db.execute(
      'SELECT * FROM labor_rates ORDER BY active DESC, name'
    );
    res.render('admin/labor-rates', { pageScript: null, laborRates });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, hourly_rate, notes } = req.body;
    await db.execute(
      'INSERT INTO labor_rates (name, hourly_rate, notes) VALUES (?, ?, ?)',
      [name, hourly_rate || 0, notes || null]
    );
    res.redirect(`${res.locals.basePath}/admin/labor-rates`);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/edit', async (req, res, next) => {
  try {
    const [rows] = await db.execute('SELECT * FROM labor_rates WHERE id = ?', [req.params.id]);
    if (!rows[0]) return res.status(404).render('error', { message: 'Labor rate not found' });
    res.render('admin/labor-rates-edit', { pageScript: null, laborRate: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.post('/:id', async (req, res, next) => {
  try {
    const { name, hourly_rate, notes } = req.body;
    await db.execute(
      'UPDATE labor_rates SET name=?, hourly_rate=?, notes=? WHERE id=?',
      [name, hourly_rate || 0, notes || null, req.params.id]
    );
    res.redirect(`${res.locals.basePath}/admin/labor-rates`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/toggle-active', async (req, res, next) => {
  try {
    await db.execute('UPDATE labor_rates SET active = NOT active WHERE id = ?', [req.params.id]);
    res.redirect(`${res.locals.basePath}/admin/labor-rates`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
