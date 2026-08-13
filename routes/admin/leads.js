const express = require('express');
const router = express.Router();
const { requireAuth } = require('../../middleware/auth');
const leadOptions = require('../../config/leadOptions');

router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const [leads] = await req.db.execute(
      `SELECT l.*, c.name AS customer_name FROM leads l
       LEFT JOIN customers c ON c.id = l.customer_id AND c.org_id = l.org_id
       WHERE l.org_id = ?
       ORDER BY FIELD(l.status, 'new','contacted','scheduled','converted','lost'), l.created_at DESC`,
      [req.orgId]
    );
    res.render('admin/leads', { pageScript: null, leads, opts: leadOptions });
  } catch (err) {
    next(err);
  }
});

// Manual entry — for testing, or a lead that came in by phone/walk-in rather than the
// website form. source='manual' distinguishes these from real webhook-sourced leads.
router.post('/', async (req, res, next) => {
  try {
    const { name, email, phone, property_address, home_size, home_type, budget, timeline, additional_details } = req.body;
    await req.db.execute(
      `INSERT INTO leads (org_id, name, email, phone, property_address, home_size, home_type, budget, timeline, additional_details, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')`,
      [req.orgId, name, email, phone || null, property_address || null, home_size || null,
        home_type || null, budget || null, timeline || null, additional_details || null]
    );
    res.redirect(`${res.locals.basePath}/admin/leads`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/status', async (req, res, next) => {
  try {
    const { status } = req.body;
    await req.db.execute(
      'UPDATE leads SET status = ? WHERE id = ? AND org_id = ?',
      [status, req.params.id, req.orgId]
    );
    res.redirect(`${res.locals.basePath}/admin/leads`);
  } catch (err) {
    next(err);
  }
});

// Creates a customer from this lead's info and links it back — the lead itself stays
// around as a record of where the customer came from, rather than being deleted.
router.post('/:id/convert', async (req, res, next) => {
  const conn = await req.db.getConnection();
  try {
    const [rows] = await conn.execute(
      'SELECT * FROM leads WHERE id = ? AND org_id = ?',
      [req.params.id, req.orgId]
    );
    const lead = rows[0];
    if (!lead) { conn.release(); return res.status(404).render('error', { message: 'Lead not found' }); }

    await conn.beginTransaction();
    const [result] = await conn.execute(
      'INSERT INTO customers (org_id, name, email, phone, address) VALUES (?, ?, ?, ?, ?)',
      [req.orgId, lead.name, lead.email, lead.phone || null, lead.property_address || null]
    );
    await conn.execute(
      "UPDATE leads SET status = 'converted', customer_id = ? WHERE id = ? AND org_id = ?",
      [result.insertId, lead.id, req.orgId]
    );
    await conn.commit();
    // Next step in the workflow is scheduling the consultation (date/time/duration +
    // calendar invite), not the customer list — /new already prefills from this lead
    // via mapLeadToConsultation since lead.customer_id now points here.
    res.redirect(`${res.locals.basePath}/admin/consultations/new?customer_id=${result.insertId}`);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
