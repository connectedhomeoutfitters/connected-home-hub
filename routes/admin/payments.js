const express = require('express');
const router = express.Router();
const stripe = require('../../config/stripe');
const { requireAuth, requireAdmin } = require('../../middleware/auth');
const { reconcileRefunds } = require('../../services/paymentsSync');
const { paymentContext } = require('../../services/stripeAccounts');
const { sendMail } = require('../../services/mailer');
const { getCompany } = require('../../services/companySettings');
const activity = require('../../services/activityLog');

router.use(requireAuth);

// Shared WHERE builder for the list + CSV export + summary, so all three stay in sync.
// The org filter is seeded here rather than added per-caller, so no query built from this
// helper can ever be un-scoped.
// Filters: status (of the payment), invoice type (deposit/final/standalone), a from/to
// date range on the payment date, and a free-text search over customer name/email.
function buildFilters(query, orgId) {
  const where = ['p.org_id = ?'];
  const params = [orgId];
  if (query.status && ['pending', 'succeeded', 'failed'].includes(query.status)) {
    where.push('p.status = ?');
    params.push(query.status);
  }
  if (query.type && ['deposit', 'final', 'standalone'].includes(query.type)) {
    where.push('i.type = ?');
    params.push(query.type);
  }
  if (query.from) {
    where.push('p.created_at >= ?');
    params.push(`${query.from} 00:00:00`);
  }
  if (query.to) {
    where.push('p.created_at <= ?');
    params.push(`${query.to} 23:59:59`);
  }
  if (query.q) {
    where.push('(c.name LIKE ? OR c.email LIKE ?)');
    params.push(`%${query.q}%`, `%${query.q}%`);
  }
  return { clause: `WHERE ${where.join(' AND ')}`, params };
}

const LIST_SQL = (clause) => `
  SELECT p.*, i.type AS invoice_type, i.status AS invoice_status,
         c.name AS customer_name, c.email AS customer_email
  FROM payments p
  JOIN invoices i ON i.id = p.invoice_id AND i.org_id = p.org_id
  JOIN customers c ON c.id = i.customer_id AND c.org_id = i.org_id
  ${clause}
  ORDER BY p.created_at DESC`;

// Payments list + sales-journal summary. Summary tiles reflect the current filter, so
// e.g. filtering to a month gives that month's collected/refunded/net at a glance.
router.get('/', async (req, res, next) => {
  try {
    const { clause, params } = buildFilters(req.query, req.orgId);
    const [payments] = await req.db.execute(LIST_SQL(clause), params);

    // Totals over the filtered set. gross = successfully collected; refunded = money
    // returned; net = what the business actually kept.
    const [[summary]] = await req.db.execute(
      `SELECT
         COALESCE(SUM(CASE WHEN p.status = 'succeeded' THEN p.amount ELSE 0 END), 0) AS gross,
         COALESCE(SUM(p.amount_refunded), 0) AS refunded,
         COUNT(CASE WHEN p.status = 'succeeded' THEN 1 END) AS succeeded_count,
         COUNT(CASE WHEN p.status = 'pending' THEN 1 END) AS pending_count
       FROM payments p
       JOIN invoices i ON i.id = p.invoice_id AND i.org_id = p.org_id
       JOIN customers c ON c.id = i.customer_id AND c.org_id = i.org_id
       ${clause}`,
      params
    );
    summary.net = Number(summary.gross) - Number(summary.refunded);

    res.render('admin/payments', {
      pageScript: null,
      payments,
      summary,
      filters: req.query,
    });
  } catch (err) {
    next(err);
  }
});

// Sales-journal CSV export of the filtered set — one row per payment, for handing to
// accounting / importing into a spreadsheet. Honors the same query filters as the list.
router.get('/export.csv', async (req, res, next) => {
  try {
    const { clause, params } = buildFilters(req.query, req.orgId);
    const [payments] = await req.db.execute(LIST_SQL(clause), params);

    const esc = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['Date', 'Customer', 'Email', 'Invoice Type', 'Payment Status',
      'Amount', 'Refunded', 'Net', 'Card', 'Stripe Payment Intent'];
    const lines = [header.join(',')];
    for (const p of payments) {
      const net = Number(p.amount) - Number(p.amount_refunded);
      const card = p.card_brand ? `${p.card_brand} ****${p.card_last4 || ''}` : '';
      lines.push([
        esc(new Date(p.created_at).toISOString().slice(0, 10)),
        esc(p.customer_name), esc(p.customer_email), esc(p.invoice_type),
        esc(p.status), esc(Number(p.amount).toFixed(2)),
        esc(Number(p.amount_refunded).toFixed(2)), esc(net.toFixed(2)),
        esc(card), esc(p.stripe_payment_intent_id),
      ].join(','));
    }

    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', `attachment; filename="sales-journal-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(lines.join('\n'));
  } catch (err) {
    next(err);
  }
});

// Payment detail — invoice/customer context, Stripe identifiers + receipt link, refund
// history, and (admins only) the refund form.
router.get('/:id', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(
      `SELECT p.*, i.type AS invoice_type, i.status AS invoice_status, i.id AS invoice_id,
              c.name AS customer_name, c.email AS customer_email, c.id AS customer_id
       FROM payments p
       JOIN invoices i ON i.id = p.invoice_id AND i.org_id = p.org_id
       JOIN customers c ON c.id = i.customer_id AND c.org_id = i.org_id
       WHERE p.id = ? AND p.org_id = ?`,
      [req.params.id, req.orgId]
    );
    const payment = rows[0];
    if (!payment) return res.status(404).render('error', { message: 'Payment not found' });

    const [refunds] = await req.db.execute(
      `SELECT r.*, u.name AS created_by_name FROM refunds r
       LEFT JOIN users u ON u.id = r.created_by AND u.org_id = r.org_id
       WHERE r.payment_id = ? AND r.org_id = ? ORDER BY r.created_at DESC`,
      [payment.id, req.orgId]
    );

    const refundable = Number(payment.amount) - Number(payment.amount_refunded);
    res.render('admin/payment-detail', {
      pageScript: null,
      payment,
      refunds,
      refundable,
      error: req.query.error || null,
      saved: req.query.refunded === '1',
    });
  } catch (err) {
    next(err);
  }
});

// Issue a refund back to Stripe. Admin-only (moves money out). Supports partial refunds
// (blank amount = refund the remaining balance). Records the refund with the staff note
// + who issued it, then reconcileRefunds() re-syncs totals/invoice status from Stripe.
router.post('/:id/refund', requireAdmin, async (req, res, next) => {
  const back = (err) => res.redirect(`${res.locals.basePath}/admin/payments/${req.params.id}${err ? `?error=${encodeURIComponent(err)}` : '?refunded=1'}`);
  try {
    const [rows] = await req.db.execute(
      'SELECT * FROM payments WHERE id = ? AND org_id = ?',
      [req.params.id, req.orgId]
    );
    const payment = rows[0];
    if (!payment) return res.status(404).render('error', { message: 'Payment not found' });
    if (payment.status !== 'succeeded') return back('Only a succeeded payment can be refunded.');

    const remaining = Number(payment.amount) - Number(payment.amount_refunded);
    if (remaining <= 0) return back('This payment has already been fully refunded.');

    // Blank amount => refund the full remaining balance.
    let amount = remaining;
    if (req.body.amount !== undefined && String(req.body.amount).trim() !== '') {
      amount = parseFloat(req.body.amount);
      if (isNaN(amount) || amount <= 0) return back('Enter a valid refund amount.');
      if (amount > remaining + 0.001) return back(`Refund can't exceed the remaining $${remaining.toFixed(2)}.`);
    }

    // Every Stripe call below must target the account this org bills through — for a
    // connected tenant the charge doesn't exist on the platform account at all.
    const { options } = await paymentContext(req.orgId);

    // Need the charge id to refund. Prefer the cached one; fall back to the PaymentIntent.
    let chargeId = payment.stripe_charge_id;
    if (!chargeId) {
      const intent = await stripe.paymentIntents.retrieve(payment.stripe_payment_intent_id, options);
      chargeId = intent.latest_charge;
      if (chargeId) {
        await req.db.execute(
          'UPDATE payments SET stripe_charge_id = ? WHERE id = ? AND org_id = ?',
          [chargeId, payment.id, req.orgId]
        );
      }
    }
    if (!chargeId) return back('No Stripe charge found for this payment.');

    const validReasons = ['duplicate', 'fraudulent', 'requested_by_customer'];
    const reason = validReasons.includes(req.body.reason) ? req.body.reason : undefined;
    const note = (req.body.note || '').trim() || null;

    const refund = await stripe.refunds.create({
      charge: chargeId,
      amount: Math.round(amount * 100),
      ...(reason ? { reason } : {}),
      metadata: {
        source: 'cho-hub', org_id: String(req.orgId),
        payment_id: String(payment.id), issued_by: String(req.user.id),
      },
    }, options);

    // Record our side first (captures note + who issued it), then reconcile totals from
    // Stripe's authoritative refund list.
    await req.db.execute(
      `INSERT INTO refunds (org_id, payment_id, stripe_refund_id, amount, reason, note, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE note = VALUES(note), created_by = VALUES(created_by)`,
      [req.orgId, payment.id, refund.id, amount, reason || null, note,
        ['succeeded', 'failed', 'canceled', 'pending'].includes(refund.status) ? refund.status : 'pending',
        req.user.id]
    );
    const result = await reconcileRefunds({ chargeId });

    // Notify the customer, matching the auto-sent payment receipt. Non-blocking: a mail
    // failure never undoes a completed Stripe refund.
    if (refund.status === 'succeeded') {
      const [[info]] = await req.db.execute(
        `SELECT c.id AS customer_id, c.name AS customer_name, c.email AS customer_email, i.type AS invoice_type
         FROM payments p
         JOIN invoices i ON i.id = p.invoice_id AND i.org_id = p.org_id
         JOIN customers c ON c.id = i.customer_id AND c.org_id = i.org_id
         WHERE p.id = ? AND p.org_id = ?`,
        [payment.id, req.orgId]
      );
      if (info) {
        await activity.log({
          ...activity.staff(req), action: 'refund.issued', entityType: 'payment', entityId: payment.id,
          customerId: info.customer_id, detail: `Refunded $${amount.toFixed(2)} to ${info.customer_name}${result && result.fullyRefunded ? ' (full)' : ''}`,
        });
        const company = await getCompany(req.orgId);
        await sendMail({
          orgId: req.orgId,
          to: info.customer_email,
          subject: `Refund issued — ${company.company_name}`,
          template: 'refund-issued',
          data: {
            customerName: info.customer_name,
            amount: amount.toFixed(2),
            invoiceType: info.invoice_type,
            fullyRefunded: result ? result.fullyRefunded : false,
          },
        });
      }
    }

    return back(null);
  } catch (err) {
    // Stripe throws for e.g. already-refunded charges — surface the message rather than 500.
    if (err.type && err.raw) return back(err.raw.message || 'Stripe refused the refund.');
    next(err);
  }
});

module.exports = router;
