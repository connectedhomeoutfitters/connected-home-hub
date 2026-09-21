// Reconciles our refund records to the processor's truth for a single payment.
//
// Both entry points into a refund — the admin "Issue refund" route and the processor's
// refund webhook — call this. It re-reads the payment's refunds from the processor (the
// authoritative set) and upserts each into our `refunds` table, so it doesn't matter
// which path runs first or whether it runs twice: amount_refunded is always recomputed as
// SUM(succeeded refunds), never incremented. Mirrors the wider "the processor is the
// source of truth" rule the payment-success path already follows.
//
// Two processors, one reconciliation. Stripe lists refunds by charge; Square's payment
// object carries `refund_ids`, each fetched individually. Everything after the fetch —
// upsert, total, invoice status — is shared in applyRefundTotals().
//
// Multi-tenancy: the opening lookup is deliberately UNSCOPED. A webhook arrives with no
// org context — a processor id is the only handle we have, and finding our payment row
// is precisely what tells us which org it belongs to (a charge that isn't ours at all,
// e.g. a ConnectedHomeLedger charge on the shared account, returns null and is ignored).
// Everything after that point runs through a handle scoped to payment.org_id.
const db = require('../config/db');
const scopedDb = require('../config/scopedDb');
const stripe = require('../config/stripe');
const { paymentContext } = require('./stripeAccounts');
const squareAccounts = require('./squareAccounts');
const squareApi = require('./squareApi');
const activity = require('./activityLog');
const { sendMail } = require('./mailer');
const { getCompany } = require('./companySettings');

// Stripe refund.status can also be 'requires_action'; anything we don't model as a
// terminal state is treated as still-pending (won't count toward amount_refunded).
function mapRefundStatus(s) {
  return ['succeeded', 'failed', 'canceled', 'pending'].includes(s) ? s : 'pending';
}

// Square refund.status: PENDING, COMPLETED, REJECTED, FAILED.
function mapSquareRefundStatus(s) {
  if (s === 'COMPLETED') return 'succeeded';
  if (s === 'REJECTED' || s === 'FAILED') return 'failed';
  return 'pending';
}

// Finds our payment by whichever processor id we were handed. Returns the row or null.
async function findPayment({ chargeId, paymentIntentId, squarePaymentId }) {
  if (chargeId) {
    const [r] = await db.execute('SELECT * FROM payments WHERE stripe_charge_id = ?', [chargeId]);
    if (r[0]) return r[0];
  }
  if (paymentIntentId) {
    const [r] = await db.execute('SELECT * FROM payments WHERE stripe_payment_intent_id = ?', [paymentIntentId]);
    if (r[0]) return r[0];
  }
  if (squarePaymentId) {
    const [r] = await db.execute('SELECT * FROM payments WHERE square_payment_id = ?', [squarePaymentId]);
    if (r[0]) return r[0];
  }
  return null;
}

// The processor's current refunds for this payment, normalised to
// { provider, id, amount, reason, status }.
async function fetchRefunds(payment, orgId, { chargeId }) {
  if (payment.provider === 'square') {
    const ctx = await squareAccounts.squareContext(orgId);
    if (!ctx.accessToken) throw new Error(`org ${orgId} has no Square access token to reconcile with`);
    const sq = await squareApi.getPayment(ctx.accessToken, payment.square_payment_id);
    const out = [];
    for (const rid of sq.refund_ids || []) {
      const r = await squareApi.getRefund(ctx.accessToken, rid);
      out.push({
        provider: 'square', id: r.id, amount: Number(r.amount_money?.amount || 0) / 100,
        reason: r.reason ? String(r.reason).slice(0, 50) : null, status: mapSquareRefundStatus(r.status),
      });
    }
    return { refunds: out, chargeId: null };
  }

  const sdb = scopedDb(orgId);
  const cid = chargeId || payment.stripe_charge_id;
  if (!cid) return null;
  if (!payment.stripe_charge_id) {
    await sdb.execute(
      'UPDATE payments SET stripe_charge_id = ? WHERE id = ? AND org_id = ?',
      [cid, payment.id, orgId]
    );
  }
  // The charge lives on whichever Stripe account this org bills through — for a connected
  // tenant it isn't visible on the platform account at all, so the lookup must be scoped
  // or it 404s. See services/stripeAccounts.js.
  const { options } = await paymentContext(orgId);
  const list = await stripe.refunds.list({ charge: cid, limit: 100 }, options);
  return {
    refunds: list.data.map((r) => ({
      provider: 'stripe', id: r.id, amount: r.amount / 100, reason: r.reason || null,
      status: mapRefundStatus(r.status),
    })),
    chargeId: cid,
  };
}

// Upserts the processor's refunds, recomputes amount_refunded and settles the invoice
// status. Returns { payment, orgId, totalRefunded, fullyRefunded }.
//
// Also the ONE place the customer is told about a refund. A refund's status can land as
// succeeded on the admin route's synchronous response (Stripe, usually) or only later via
// the processor's webhook (Square answers PENDING first) — so the notification is keyed to
// the TRANSITION into succeeded as observed here, whichever path observes it, and fires
// exactly once per refund.
async function applyRefundTotals(payment, orgId, refunds) {
  const sdb = scopedDb(orgId);
  const conn = await sdb.getConnection();
  let newlySucceeded = [];
  let fullyRefunded = false;
  try {
    await conn.beginTransaction();
    // What we already knew, so the transition can be detected after the upsert.
    const [priorRows] = await conn.execute(
      'SELECT stripe_refund_id, square_refund_id, status FROM refunds WHERE payment_id = ? AND org_id = ?',
      [payment.id, orgId]
    );
    const prior = new Map(priorRows.map((r) => [r.stripe_refund_id || r.square_refund_id, r.status]));
    newlySucceeded = refunds.filter((r) => r.status === 'succeeded' && prior.get(r.id) !== 'succeeded');

    for (const r of refunds) {
      // Column list deliberately omits note/created_by — a refund first recorded by the
      // admin route keeps the staff note and who issued it; reconciliation only ever
      // touches the processor-derived fields.
      const idCol = r.provider === 'square' ? 'square_refund_id' : 'stripe_refund_id';
      await conn.execute(
        `INSERT INTO refunds (org_id, payment_id, provider, ${idCol}, amount, reason, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE amount = VALUES(amount), reason = VALUES(reason), status = VALUES(status)`,
        [orgId, payment.id, r.provider, r.id, r.amount, r.reason, r.status]
      );
    }

    const [[{ total }]] = await conn.execute(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM refunds WHERE payment_id = ? AND org_id = ? AND status = 'succeeded'",
      [payment.id, orgId]
    );
    await conn.execute(
      'UPDATE payments SET amount_refunded = ? WHERE id = ? AND org_id = ?',
      [total, payment.id, orgId]
    );

    // A fully-refunded invoice reads 'refunded'; a partial refund leaves it 'paid'.
    // If a refund is later reversed/failed and the total drops back below the amount,
    // flip 'refunded' back to 'paid'.
    const [[inv]] = await conn.execute(
      'SELECT * FROM invoices WHERE id = ? AND org_id = ?',
      [payment.invoice_id, orgId]
    );
    fullyRefunded = Number(total) >= Number(payment.amount);
    if (inv) {
      let newStatus = inv.status;
      if (fullyRefunded) newStatus = 'refunded';
      else if (inv.status === 'refunded') newStatus = 'paid';
      if (newStatus !== inv.status) {
        await conn.execute(
          'UPDATE invoices SET status = ? WHERE id = ? AND org_id = ?',
          [newStatus, inv.id, orgId]
        );
      }
    }

    await conn.commit();
    for (const r of newlySucceeded) await notifyRefundSucceeded(sdb, orgId, payment, r, fullyRefunded);
    return { payment, orgId, totalRefunded: Number(total), fullyRefunded };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Activity entry + customer email for one refund that has just succeeded. Attributed to
// the staff member who issued it when our row knows (the admin route wrote created_by),
// otherwise to the system (issued from the processor's own dashboard). Never throws: a
// mail failure must not undo a refund that has already happened.
async function notifyRefundSucceeded(sdb, orgId, payment, refund, fullyRefunded) {
  try {
    const idCol = refund.provider === 'square' ? 'square_refund_id' : 'stripe_refund_id';
    const [[row]] = await sdb.execute(
      `SELECT r.created_by, u.name AS created_by_name,
              c.id AS customer_id, c.name AS customer_name, c.email AS customer_email, i.type AS invoice_type
         FROM refunds r
         JOIN payments p ON p.id = r.payment_id AND p.org_id = r.org_id
         JOIN invoices i ON i.id = p.invoice_id AND i.org_id = p.org_id
         JOIN customers c ON c.id = i.customer_id AND c.org_id = i.org_id
         LEFT JOIN users u ON u.id = r.created_by AND u.org_id = r.org_id
        WHERE r.${idCol} = ? AND r.org_id = ?`,
      [refund.id, orgId]
    );
    if (!row) return;
    const amount = Number(refund.amount);
    await activity.log({
      orgId,
      actorType: row.created_by ? 'staff' : 'system',
      actorId: row.created_by || null,
      actorName: row.created_by_name || null,
      action: 'refund.issued', entityType: 'payment', entityId: payment.id,
      customerId: row.customer_id,
      detail: `Refunded $${amount.toFixed(2)} to ${row.customer_name}${fullyRefunded ? ' (full)' : ''} via ${refund.provider}`,
    });
    if (!row.customer_email) return;
    const company = await getCompany(orgId);
    await sendMail({
      orgId,
      to: row.customer_email,
      subject: `Refund issued — ${company.company_name}`,
      template: 'refund-issued',
      data: {
        customerName: row.customer_name,
        amount: amount.toFixed(2),
        invoiceType: row.invoice_type,
        fullyRefunded,
      },
    });
  } catch (err) {
    console.error('refund notification failed:', err.message);
  }
}

// Entry point. Pass whichever ids you have: { chargeId, paymentIntentId } for Stripe,
// { squarePaymentId } for Square. Returns null if the payment isn't one of ours.
async function reconcileRefunds(ids) {
  const payment = await findPayment(ids);
  if (!payment) return null;
  const orgId = payment.org_id;
  const fetched = await fetchRefunds(payment, orgId, ids);
  if (!fetched) return null;
  return applyRefundTotals(payment, orgId, fetched.refunds);
}

module.exports = { reconcileRefunds, mapRefundStatus, mapSquareRefundStatus };
