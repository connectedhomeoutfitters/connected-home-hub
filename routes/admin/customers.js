const express = require('express');
const router = express.Router();
const { requireAuth } = require('../../middleware/auth');
const { pageParams, pager } = require('../../services/pagination');

router.use(requireAuth);

// Guard against a literal path being swallowed by GET /:id below — Express matches in
// declaration order, and an :id that isn't a number is never a real customer.
router.param('id', (req, res, next, id) => {
  if (!/^\d+$/.test(id)) return res.status(404).render('error', { message: 'Not found' });
  next();
});

// Sortable columns, as a whitelist. User input must NEVER reach ORDER BY as a string —
// it isn't parameterisable, so the only safe form is choosing from a fixed map.
const SORTS = {
  recent:  { sql: 'c.created_at DESC', label: 'Recently added' },
  oldest:  { sql: 'c.created_at ASC',  label: 'Oldest first' },
  name:    { sql: 'c.name ASC',        label: 'Name (A–Z)' },
  name_desc: { sql: 'c.name DESC',     label: 'Name (Z–A)' },
  activity: { sql: 'last_activity DESC', label: 'Recent activity' },
  value:   { sql: 'total_paid DESC',   label: 'Highest value' },
};
const PER_PAGE = 50;

// MUST be declared before GET /:id.
// Feeds the shared customer picker (views/partials/customer-picker.ejs). Capped and
// server-filtered so a tenant with 10,000 customers doesn't ship 10,000 <option> tags into
// every estimate/job/warranty form.
router.get('/search', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const params = [req.orgId];
    let clause = '';
    if (q) {
      clause = 'AND (name LIKE ? OR email LIKE ? OR phone LIKE ?)';
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    const [rows] = await req.db.execute(
      `SELECT id, name, email, phone FROM customers
        WHERE org_id = ? ${clause}
        ORDER BY name LIMIT 20`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const sortKey = SORTS[req.query.sort] ? req.query.sort : 'recent';
    const { page, perPage, limit, offset } = pageParams(req, PER_PAGE);

    // org_id is spelled LITERALLY in both statements below, never folded into the
    // interpolated part. test/queryScoping.test.js reads the SQL statically, so a scoping
    // clause hidden inside a ${} is invisible to the guard that exists to catch exactly
    // this mistake — keep the tenant constraint where the sweep can see it.
    const params = [req.orgId];
    let extra = '';
    if (q) {
      extra = 'AND (c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR c.address LIKE ?)';
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }

    const [[{ total }]] = await req.db.execute(
      `SELECT COUNT(*) AS total FROM customers c WHERE c.org_id = ? ${extra}`, params
    );

    // Correlated subqueries rather than joins: a customer with 12 invoices and 3 estimates
    // would otherwise fan out into 36 rows and break both the count and the paging.
    // LIMIT/OFFSET are interpolated as integers (already coerced above) because MySQL
    // won't take them as placeholders in a prepared statement.
    const [customers] = await req.db.execute(
      `SELECT c.*,
              (SELECT COALESCE(SUM(p.amount - p.amount_refunded), 0)
                 FROM payments p JOIN invoices i ON i.id = p.invoice_id AND i.org_id = p.org_id
                WHERE i.customer_id = c.id AND p.org_id = c.org_id AND p.status = 'succeeded'
              ) AS total_paid,
              (SELECT MAX(j.updated_at) FROM jobs j
                WHERE j.customer_id = c.id AND j.org_id = c.org_id) AS last_activity,
              (SELECT COUNT(*) FROM estimates e
                WHERE e.customer_id = c.id AND e.org_id = c.org_id) AS estimate_count
         FROM customers c
        WHERE c.org_id = ? ${extra}
        ORDER BY ${SORTS[sortKey].sql}
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    res.render('admin/customers', {
      pageScript: 'page-customers.js', customers,
      q, sortKey, SORTS, pager: pager({ page, perPage, total }),
    });
  } catch (err) {
    next(err);
  }
});

// MUST stay above GET /:id. Until now there was no add-customer form at all — the list
// page carried a TODO and customers could only arrive by converting a lead, which is no
// use to a contractor typing in an existing book of business.
router.get('/new', async (req, res, next) => {
  try {
    const [builders] = await req.db.execute(
      'SELECT id, name FROM builders WHERE org_id = ? AND active = 1 ORDER BY name',
      [req.orgId]
    );
    res.render('admin/customer-edit', {
      pageScript: null, builders, returnTo: null,
      customer: { name: '', email: '', phone: '', address: '', notes: '', builder_id: null },
    });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, email, phone, address, notes, builder_id } = req.body;
    // A forged builder_id would attach this customer to another tenant's builder.
    let builderId = null;
    if (builder_id) {
      const [[b]] = await req.db.execute(
        'SELECT id FROM builders WHERE id = ? AND org_id = ?', [builder_id, req.orgId]
      );
      builderId = b ? b.id : null;
    }
    const [ins] = await req.db.execute(
      'INSERT INTO customers (org_id, name, email, phone, address, notes, builder_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [req.orgId, name, email, phone || null, address || null, notes || null, builderId]
    );
    // Land on the new customer rather than the list: the next thing staff want is one of
    // the quick actions on that customer, not to hunt for the row they just created.
    res.redirect(`${res.locals.basePath}/admin/customers/${ins.insertId}`);
  } catch (err) {
    next(err);
  }
});

const LEAD_STATUS = {
  new: { label: 'New', badge: 'primary' },
  contacted: { label: 'Contacted', badge: 'info' },
  scheduled: { label: 'Scheduled', badge: 'secondary' },
  converted: { label: 'Converted', badge: 'success' },
  lost: { label: 'Lost', badge: 'dark' },
};
const CONSULTATION_STATUS = {
  scheduled: { label: 'Scheduled', badge: 'secondary' },
  completed: { label: 'Completed', badge: 'success' },
  on_hold: { label: 'On Hold', badge: 'warning' },
  cancelled: { label: 'Cancelled', badge: 'dark' },
};
const ESTIMATE_STATUS = {
  draft: { label: 'Draft', badge: 'secondary' },
  sent: { label: 'Sent', badge: 'info' },
  accepted: { label: 'Accepted', badge: 'success' },
  declined: { label: 'Declined', badge: 'dark' },
  expired: { label: 'Expired', badge: 'dark' },
};
const INVOICE_STATUS = {
  pending: { label: 'Pending', badge: 'secondary' },
  paid: { label: 'Paid', badge: 'success' },
  void: { label: 'Void', badge: 'dark' },
};
const JOB_STATUS = {
  pending: { label: 'Pending', badge: 'secondary' },
  in_progress: { label: 'In Progress', badge: 'info' },
  done: { label: 'Done', badge: 'success' },
  cancelled: { label: 'Cancelled', badge: 'dark' },
};

// Unified customer history — merges leads/consultations/estimates/invoices/jobs into a
// single chronological timeline, rather than staff having to check five separate list
// pages to piece together one customer's story. Each row becomes one timeline entry
// (using whichever timestamp is most meaningful for when that thing actually happened,
// not necessarily created_at), except estimates/invoices which can contribute a second
// entry for their own "sent"/"accepted"/"paid" milestone when that timestamp is set —
// there's no generic status-history/audit table to draw a full transition log from, so
// this is the richest view obtainable from the current schema.
router.get('/:id', async (req, res, next) => {
  try {
    const [customerRows] = await req.db.execute(
      `SELECT c.*, b.name AS builder_name FROM customers c
       LEFT JOIN builders b ON b.id = c.builder_id AND b.org_id = c.org_id
       WHERE c.id = ? AND c.org_id = ?`,
      [req.params.id, req.orgId]
    );
    const customer = customerRows[0];
    if (!customer) return res.status(404).render('error', { message: 'Customer not found' });

    const scoped = [req.params.id, req.orgId];
    const [leads] = await req.db.execute('SELECT * FROM leads WHERE customer_id = ? AND org_id = ?', scoped);
    const [consultations] = await req.db.execute('SELECT * FROM consultations WHERE customer_id = ? AND org_id = ?', scoped);
    const [estimates] = await req.db.execute('SELECT * FROM estimates WHERE customer_id = ? AND org_id = ?', scoped);
    const [invoices] = await req.db.execute('SELECT * FROM invoices WHERE customer_id = ? AND org_id = ?', scoped);
    const [jobs] = await req.db.execute('SELECT * FROM jobs WHERE customer_id = ? AND org_id = ?', scoped);
    const [warranties] = await req.db.execute('SELECT * FROM warranties WHERE customer_id = ? AND org_id = ?', scoped);
    const [documents] = await req.db.execute(
      `SELECT d.*, j.title AS job_title, u.name AS uploaded_by_name FROM documents d
       LEFT JOIN jobs j ON j.id = d.job_id AND j.org_id = d.org_id
       LEFT JOIN users u ON u.id = d.uploaded_by AND u.org_id = d.org_id
       WHERE d.customer_id = ? AND d.org_id = ? ORDER BY d.created_at DESC`,
      scoped
    );

    const events = [];

    for (const l of leads) {
      const s = LEAD_STATUS[l.status] || { label: l.status, badge: 'secondary' };
      events.push({
        date: l.created_at, icon: 'bi-person-plus', type: 'Lead',
        title: `Lead received${l.source === 'manual' ? ' (manual entry)' : ''}`,
        statusLabel: s.label, statusBadge: s.badge, link: '/admin/leads',
      });
    }

    for (const co of consultations) {
      const s = CONSULTATION_STATUS[co.status] || { label: co.status, badge: 'secondary' };
      events.push({
        date: co.consultation_date || co.created_at, icon: 'bi-clipboard-check', type: 'Consultation',
        title: co.consultation_date ? `Consultation — ${co.consultation_date}` : 'Consultation scheduled',
        statusLabel: s.label, statusBadge: s.badge, link: `/admin/consultations/${co.id}/edit`,
      });
    }

    for (const e of estimates) {
      const s = ESTIMATE_STATUS[e.status] || { label: e.status, badge: 'secondary' };
      const link = `/admin/estimates/${e.id}/edit`;
      events.push({
        date: e.sent_at || e.created_at, icon: 'bi-file-earmark-text', type: 'Estimate',
        title: `Estimate ${e.sent_at ? 'sent' : 'created'} — ${e.title} ($${e.total})`,
        statusLabel: s.label, statusBadge: s.badge, link,
      });
      if (e.accepted_at) {
        events.push({
          date: e.accepted_at, icon: 'bi-file-earmark-check', type: 'Estimate',
          title: `Estimate accepted — ${e.title}`,
          statusLabel: 'Accepted', statusBadge: 'success', link,
        });
      }
    }

    for (const inv of invoices) {
      const s = INVOICE_STATUS[inv.status] || { label: inv.status, badge: 'secondary' };
      const link = '/admin/invoices';
      events.push({
        date: inv.sent_at || inv.created_at, icon: 'bi-receipt', type: 'Invoice',
        title: `Invoice ${inv.sent_at ? 'sent' : 'created'} — ${inv.type} ($${inv.amount})`,
        statusLabel: s.label, statusBadge: s.badge, link,
      });
      if (inv.paid_at) {
        events.push({
          date: inv.paid_at, icon: 'bi-cash-coin', type: 'Invoice',
          title: `Invoice paid — ${inv.type} ($${inv.amount})`,
          statusLabel: 'Paid', statusBadge: 'success', link,
        });
      }
    }

    for (const j of jobs) {
      const s = JOB_STATUS[j.status] || { label: j.status, badge: 'secondary' };
      events.push({
        date: j.created_at, icon: 'bi-list-check', type: 'Job',
        title: `Job — ${j.title}`,
        statusLabel: s.label, statusBadge: s.badge, link: `/admin/jobs/${j.id}/edit`,
      });
    }

    const todayMid = new Date(); todayMid.setHours(0, 0, 0, 0);
    for (const w of warranties) {
      let statusLabel = 'Active', statusBadge = 'success';
      if (!w.active) { statusLabel = 'Inactive'; statusBadge = 'secondary'; }
      else if (w.expires_on) {
        const days = Math.round((new Date(w.expires_on).setHours(0, 0, 0, 0) - todayMid) / 86400000);
        if (days < 0) { statusLabel = 'Expired'; statusBadge = 'danger'; }
        else if (days <= 30) { statusLabel = `Expires in ${days}d`; statusBadge = 'warning'; }
      }
      events.push({
        date: w.start_date || w.created_at, icon: 'bi-shield-check', type: 'Warranty',
        title: `Warranty — ${w.item}${w.expires_on ? ' (expires ' + new Date(w.expires_on).toLocaleDateString() + ')' : ''}`,
        statusLabel, statusBadge, link: `/admin/warranties/${w.id}/edit`,
      });
    }

    events.sort((a, b) => new Date(b.date) - new Date(a.date));

    res.render('admin/customer-detail', { customer, events, documents, jobs });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/edit', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(
      'SELECT * FROM customers WHERE id = ? AND org_id = ?',
      [req.params.id, req.orgId]
    );
    const customer = rows[0];
    if (!customer) return res.status(404).render('error', { message: 'Customer not found' });
    const [builders] = await req.db.execute(
      'SELECT id, name FROM builders WHERE org_id = ? AND active = 1 ORDER BY name',
      [req.orgId]
    );
    res.render('admin/customer-edit', { pageScript: null, customer, builders, returnTo: req.query.returnTo || null });
  } catch (err) {
    next(err);
  }
});

// Lets staff correct a lead-sourced typo (wrong address/phone/email) after conversion —
// customers previously had no way to be edited once created.
router.post('/:id', async (req, res, next) => {
  try {
    const { name, email, phone, address, notes, builder_id } = req.body;
    await req.db.execute(
      'UPDATE customers SET name = ?, email = ?, phone = ?, address = ?, builder_id = ?, notes = ? WHERE id = ? AND org_id = ?',
      [name, email, phone || null, address || null, builder_id || null, notes || null, req.params.id, req.orgId]
    );
    res.redirect(req.body.return_to || `${res.locals.basePath}/admin/customers`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
