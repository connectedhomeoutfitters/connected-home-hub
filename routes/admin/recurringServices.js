'use strict';
// Recurring services — the seasonal mowing contract, the quarterly pest treatment, the
// weekly pool clean. See docs/adr/0002-recurring-services.md.
//
// A series only describes the PATTERN. The visits it produces are ordinary jobs, edited on
// the jobs pages like any other work, which is why there is no visit-editing UI here:
// rescheduling a visit is moving a job, and skipping one is cancelling a job.

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../../middleware/auth');
const { generateVisits, billMonth } = require('../../services/recurringServices');
const activity = require('../../services/activityLog');

router.use(requireAuth);

// Defence in depth against the route-ordering trap above: an :id that isn't a number is
// never a real service, it's a literal path segment that fell through to a wildcard route.
// 404 rather than letting it reach a query as a bogus id.
router.param('id', (req, res, next, id) => {
  if (!/^\d+$/.test(id)) return res.status(404).render('error', { message: 'Not found' });
  next();
});

const CADENCES = ['weekly', 'biweekly', 'monthly'];

// The month that just ended — the default target for billing, matching the cron.
const lastMonth = (now = new Date()) => new Date(now.getFullYear(), now.getMonth() - 1, 1);
const monthInputValue = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

async function customersFor(req) {
  const [rows] = await req.db.execute(
    'SELECT id, name FROM customers WHERE org_id = ? ORDER BY name',
    [req.orgId]
  );
  return rows;
}

router.get('/', async (req, res, next) => {
  try {
    const [services] = await req.db.execute(
      `SELECT rs.*, c.name AS customer_name,
              (SELECT COUNT(*) FROM jobs j
                WHERE j.recurring_service_id = rs.id AND j.org_id = rs.org_id
                  AND j.status = 'pending') AS upcoming
         FROM recurring_services rs
         JOIN customers c ON c.id = rs.customer_id AND c.org_id = rs.org_id
        WHERE rs.org_id = ?
        ORDER BY rs.status, c.name`,
      [req.orgId]
    );
    res.render('admin/recurring-list', {
      pageScript: null, services, DAYS,
      defaultBillMonth: monthInputValue(lastMonth()),
      generated: req.query.generated || null,
      billed: req.query.billed || null,
    });
  } catch (err) { next(err); }
});

router.get('/new', async (req, res, next) => {
  try {
    res.render('admin/recurring-form', {
      pageScript: null, isNew: true, DAYS, CADENCES, error: null,
      customers: await customersFor(req),
      service: {
        customer_id: req.query.customer_id || '',
        title: '', unit_price: '', cadence: 'weekly', day_of_week: 1,
        start_date: new Date().toISOString().slice(0, 10),
        end_date: '', notes: '', status: 'active', paused_until: null,
      },
    });
  } catch (err) { next(err); }
});

router.get('/:id/edit', async (req, res, next) => {
  try {
    const [[service]] = await req.db.execute(
      'SELECT * FROM recurring_services WHERE id = ? AND org_id = ?',
      [req.params.id, req.orgId]
    );
    if (!service) return res.status(404).render('error', { message: 'Service not found' });

    // Its visits, so staff can see what the pattern actually produced and click through to
    // reschedule or cancel one.
    const [visits] = await req.db.execute(
      `SELECT id, visit_date, status, scheduled_at FROM jobs
        WHERE recurring_service_id = ? AND org_id = ?
        ORDER BY visit_date DESC LIMIT 30`,
      [service.id, req.orgId]
    );
    res.render('admin/recurring-form', {
      pageScript: null, isNew: false, DAYS, CADENCES, error: null,
      customers: await customersFor(req), service, visits,
    });
  } catch (err) { next(err); }
});

function parseBody(body) {
  const cadence = CADENCES.includes(body.cadence) ? body.cadence : 'weekly';
  return {
    customer_id: body.customer_id,
    title: String(body.title || '').trim().slice(0, 200),
    unit_price: Number(body.unit_price) || 0,
    cadence,
    // Only meaningful for weekly/biweekly; monthly repeats on start_date's day.
    day_of_week: cadence === 'monthly' ? null : Number(body.day_of_week),
    start_date: body.start_date || null,
    end_date: body.end_date || null,
    notes: String(body.notes || '').trim() || null,
  };
}

router.post('/', async (req, res, next) => {
  try {
    const f = parseBody(req.body);
    if (!f.customer_id || !f.title || !f.start_date) {
      return res.status(400).render('admin/recurring-form', {
        pageScript: null, isNew: true, DAYS, CADENCES,
        customers: await customersFor(req),
        service: { ...f, status: 'active', paused_until: null },
        error: 'Choose a customer, give it a name, and set a start date.',
      });
    }
    // The customer must belong to this org — org_id on the new row alone would not stop a
    // forged customer_id attaching a series to another tenant's customer.
    const [[customer]] = await req.db.execute(
      'SELECT id FROM customers WHERE id = ? AND org_id = ?', [f.customer_id, req.orgId]
    );
    if (!customer) return res.status(400).render('error', { message: 'Unknown customer.' });

    const [ins] = await req.db.execute(
      `INSERT INTO recurring_services
         (org_id, customer_id, title, unit_price, cadence, day_of_week, start_date, end_date, notes, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      [req.orgId, f.customer_id, f.title, f.unit_price.toFixed(2), f.cadence,
        f.day_of_week, f.start_date, f.end_date, f.notes]
    );
    await activity.log({
      ...activity.staff(req), action: 'recurring.created',
      entityType: 'recurring_service', entityId: ins.insertId, customerId: Number(f.customer_id),
      detail: `${f.title} — ${f.cadence} at $${f.unit_price.toFixed(2)}`,
    });
    res.redirect(`${res.locals.basePath}/admin/recurring/${ins.insertId}/edit`);
  } catch (err) { next(err); }
});

// Manual runs. The nightly generator and the month-end biller do this on their own; these
// exist so staff can pull visits forward or close a month early without waiting for cron.
//
// These MUST be declared before POST /:id. Express matches in declaration order, so with
// /:id first, "/generate" matched it as id='generate' and ran the UPDATE — which failed
// only because MariaDB rejected the string as a DECIMAL. A literal route that looks like an
// id has to come first.
router.post('/generate', async (req, res, next) => {
  try {
    const created = await generateVisits(req.db, req.orgId);
    res.redirect(`${res.locals.basePath}/admin/recurring?generated=${created}`);
  } catch (err) { next(err); }
});

router.post('/bill', async (req, res, next) => {
  try {
    // The form sends a YYYY-MM month input; fall back to last month if it's missing or
    // malformed. Billing the CURRENT month mid-month would invoice a customer for half of
    // it and leave the rest to a second invoice, which is why last month is the default.
    const target = lastMonth();
    const m = /^(\d{4})-(\d{2})$/.exec(String(req.body.month_input || ''));
    const year = m ? Number(m[1]) : target.getFullYear();
    const month = m ? Number(m[2]) : target.getMonth() + 1;
    if (month < 1 || month > 12) return res.status(400).render('error', { message: 'Bad month.' });
    const results = await billMonth(req.db, req.orgId, year, month, { userId: req.user.id });
    res.redirect(`${res.locals.basePath}/admin/recurring?billed=${results.length}`);
  } catch (err) { next(err); }
});

router.post('/:id', async (req, res, next) => {
  try {
    const f = parseBody(req.body);
    await req.db.execute(
      `UPDATE recurring_services
          SET title=?, unit_price=?, cadence=?, day_of_week=?, start_date=?, end_date=?, notes=?
        WHERE id=? AND org_id=?`,
      [f.title, f.unit_price.toFixed(2), f.cadence, f.day_of_week,
        f.start_date, f.end_date, f.notes, req.params.id, req.orgId]
    );
    res.redirect(`${res.locals.basePath}/admin/recurring/${req.params.id}/edit`);
  } catch (err) { next(err); }
});

// Pause / resume / end. Pausing stops FUTURE visits being generated; visits already on the
// calendar stay, because "stop scheduling more" and "cancel what is booked" are different
// decisions and staff may want only the first.
router.post('/:id/status', async (req, res, next) => {
  try {
    const { status, paused_until } = req.body;
    if (!['active', 'paused', 'ended'].includes(status)) {
      return res.status(400).render('error', { message: 'Unknown status.' });
    }
    await req.db.execute(
      'UPDATE recurring_services SET status = ?, paused_until = ? WHERE id = ? AND org_id = ?',
      [status, status === 'paused' ? (paused_until || null) : null, req.params.id, req.orgId]
    );
    await activity.log({
      ...activity.staff(req), action: `recurring.${status}`,
      entityType: 'recurring_service', entityId: Number(req.params.id),
      detail: status === 'paused' && paused_until ? `Paused until ${paused_until}` : `Set ${status}`,
    });
    res.redirect(`${res.locals.basePath}/admin/recurring/${req.params.id}/edit`);
  } catch (err) { next(err); }
});

module.exports = router;
