'use strict';
// Recurring services: turning a pattern into visits, and completed visits into one monthly
// invoice. See docs/adr/0002-recurring-services.md.
//
// Two scheduled passes, both of which must be safe to run twice:
//
//   generateVisits  materialises upcoming visits as `jobs` rows. Idempotent because
//                   jobs has UNIQUE(recurring_service_id, visit_date) — the database
//                   refuses a duplicate rather than the code remembering not to make one.
//
//   billMonth       rolls the month's COMPLETED visits into a single itemised invoice.
//                   Idempotent because a visit already referenced by an
//                   invoice_line_items row (on a non-void invoice) is skipped.
//
// Billing is always in arrears: a visit that never happened never reaches an invoice, so
// skips need no credit, refund or proration. That property is why this is as small as it
// is, and it is worth protecting.

const { createInvoice } = require('./invoicing');
const activity = require('./activityLog');

// ── date helpers ────────────────────────────────────────────────────────────
// Local-date arithmetic on YYYY-MM-DD strings. Deliberately not Date-with-time: a visit is
// a calendar day, and pushing times through timezones is how a Monday visit becomes Sunday
// on a server in another zone (the same trap noted for the calendar grid in CLAUDE.md).

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseYmd = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

function addMonthsClamped(d, n) {
  const x = new Date(d.getFullYear(), d.getMonth() + n, 1);
  // Clamp so a 31st series does not skip February. The 31st becomes the 28th/29th and the
  // NEXT month returns to 31 — stepping from the clamped date instead would drift the
  // whole series earlier and permanently.
  const lastDay = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate();
  x.setDate(Math.min(d.getDate(), lastDay));
  return x;
}

// Every visit date the pattern produces between `from` and `until`, inclusive.
function visitDatesFor(service, from, until) {
  const start = parseYmd(service.start_date);
  const end = service.end_date ? parseYmd(service.end_date) : null;
  const dates = [];

  if (service.cadence === 'monthly') {
    // Always step N months from START, never from the previous result. Stepping from the
    // previous date lets February's clamp (31 -> 28) drag the whole series earlier and
    // permanently; anchoring on start_date means it returns to the 31st in March.
    let n = 0;
    let cur = start;
    while (cur <= until && n < 600) {
      if (cur >= from && (!end || cur <= end)) dates.push(ymd(cur));
      cur = addMonthsClamped(start, ++n);
    }
    return dates;
  }

  const step = service.cadence === 'biweekly' ? 14 : 7;
  // Anchor on the requested weekday if given, else on the start date's own weekday. The
  // anchor is always derived from start_date so the rhythm of a biweekly series is stable
  // no matter when the generator happens to run.
  let cur = new Date(start);
  if (service.day_of_week != null) {
    const delta = (Number(service.day_of_week) - start.getDay() + 7) % 7;
    cur = addDays(start, delta);
  }
  let guard = 0;
  while (cur <= until && guard++ < 600) {
    if (cur >= from && (!end || cur <= end)) dates.push(ymd(cur));
    cur = addDays(cur, step);
  }
  return dates;
}

// ── generation ──────────────────────────────────────────────────────────────

/**
 * Create job rows for every visit due within `horizonDays`.
 * Returns the number of visits created.
 */
async function generateVisits(db, orgId, { horizonDays = 45, today = new Date() } = {}) {
  const [services] = await db.execute(
    `SELECT * FROM recurring_services
      WHERE org_id = ? AND status = 'active'`,
    [orgId]
  );

  const from = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const until = addDays(from, horizonDays);
  let created = 0;

  for (const svc of services) {
    // A paused series stops producing visits until its pause expires. Existing visits are
    // left alone — pausing is "stop scheduling more", not "cancel what is booked".
    if (svc.paused_until && parseYmd(svc.paused_until) > from) continue;

    for (const date of visitDatesFor(svc, from, until)) {
      try {
        await db.execute(
          `INSERT INTO jobs (org_id, type, title, customer_id, recurring_service_id, visit_date,
                             status, scheduled_at, due_date)
           VALUES (?, 'service', ?, ?, ?, ?, 'pending', ?, ?)`,
          [orgId, svc.title, svc.customer_id, svc.id, date, `${date} 09:00:00`, date]
        );
        created++;
      } catch (err) {
        // The unique index is the idempotency guarantee — a visit that already exists is
        // the expected case on every run after the first, not an error.
        if (err.code !== 'ER_DUP_ENTRY') throw err;
      }
    }
  }
  return created;
}

// ── billing ─────────────────────────────────────────────────────────────────

/**
 * Roll a month's completed, unbilled visits into one invoice per customer.
 * `month` is 1-12. Returns [{ customerId, invoiceId, visits, total }].
 */
async function billMonth(db, orgId, year, month, { userId = null } = {}) {
  const first = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const last = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  // Only visits that actually HAPPENED, and only those not already on a live invoice.
  // The NOT EXISTS is the second idempotency latch: re-running the biller finds nothing.
  // A void invoice does not count, so voiding one correctly frees its visits to be rebilled.
  const [visits] = await db.execute(
    `SELECT j.id, j.customer_id, j.visit_date, j.title, rs.unit_price, rs.id AS service_id
       FROM jobs j
       JOIN recurring_services rs ON rs.id = j.recurring_service_id AND rs.org_id = j.org_id
      WHERE j.org_id = ?
        AND j.type = 'service'
        AND j.status = 'done'
        AND j.visit_date BETWEEN ? AND ?
        AND NOT EXISTS (
          SELECT 1 FROM invoice_line_items ili
            JOIN invoices i ON i.id = ili.invoice_id AND i.org_id = ili.org_id
           WHERE ili.org_id = j.org_id AND ili.job_id = j.id AND i.status <> 'void'
        )
      ORDER BY j.customer_id, j.visit_date`,
    [orgId, first, last]
  );

  const byCustomer = new Map();
  for (const v of visits) {
    if (!byCustomer.has(v.customer_id)) byCustomer.set(v.customer_id, []);
    byCustomer.get(v.customer_id).push(v);
  }

  const monthName = new Date(year, month - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const results = [];

  for (const [customerId, rows] of byCustomer) {
    const lines = rows.map((v) => ({
      description: `${v.title} — ${parseYmd(v.visit_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
      quantity: 1,
      unit_price: Number(v.unit_price),
      job_id: v.id,
    }));

    // Nothing billable (every visit priced at zero) is not worth an invoice.
    const total = lines.reduce((t, l) => t + l.unit_price, 0);
    if (total <= 0) continue;

    const invoiceId = await createInvoice(db, {
      org_id: orgId,
      customer_id: customerId,
      type: 'standalone',
      description: `${monthName} — recurring service`,
      amount: total,
      lines,
    });

    await activity.log({
      orgId, actorType: userId ? 'staff' : 'system', actorId: userId,
      action: 'invoice.created', entityType: 'invoice', entityId: invoiceId,
      customerId,
      detail: `${monthName} recurring service invoice — ${lines.length} visit(s), $${total.toFixed(2)}`,
    });

    results.push({ customerId, invoiceId, visits: lines.length, total });
  }
  return results;
}

// ── scheduled sweeps ────────────────────────────────────────────────────────
// Both sweep every active tenant via forEachActiveOrg, per the convention in
// docs/adr/0001-multi-tenancy.md: a recurring service belongs to an org, so these must be
// org-scoped rather than global. A failure in one tenant is logged and skipped so it
// cannot stop the sweep for everyone else.

const { forEachActiveOrg } = require('./orgs');

async function generateVisitsForAllOrgs() {
  return forEachActiveOrg(
    (scoped, org) => generateVisits(scoped, org.id),
    'recurring visit generation'
  );
}

// Bills the month that just ended. Runs on the 1st: billing the current month partway
// through would invoice a customer for half of it and leave the rest to a second invoice.
async function billPreviousMonthForAllOrgs(now = new Date()) {
  const target = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return forEachActiveOrg(
    async (scoped, org) => {
      const results = await billMonth(scoped, org.id, target.getFullYear(), target.getMonth() + 1);
      return results.length;
    },
    'recurring monthly billing'
  );
}

module.exports = {
  generateVisits, billMonth, visitDatesFor, addMonthsClamped,
  generateVisitsForAllOrgs, billPreviousMonthForAllOrgs,
};
