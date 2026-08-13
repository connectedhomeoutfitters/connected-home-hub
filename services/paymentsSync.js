// Reconciles our refund records to Stripe's truth for a single payment.
//
// Both entry points into a refund — the admin "Issue refund" route and the
// charge.refunded webhook — call this. It re-lists the charge's refunds from Stripe
// (the authoritative set) and upserts each into our `refunds` table, so it doesn't
// matter which path runs first or whether it runs twice: amount_refunded is always
// recomputed as SUM(succeeded refunds), never incremented. Mirrors the wider
// "webhook/Stripe is the source of truth" rule the payment-success path already follows.
//
// Multi-tenancy: the opening lookup is deliberately UNSCOPED. A webhook arrives with no
// org context — a Stripe charge id is the only handle we have, and finding our payment
// row is precisely what tells us which org it belongs to (a charge that isn't ours at all,
// e.g. a ConnectedHomeLedger charge on the shared account, returns null and is ignored).
// Everything after that point runs through a handle scoped to payment.org_id.
const db = require('../config/db');
const scopedDb = require('../config/scopedDb');
const stripe = require('../config/stripe');

// Stripe refund.status can also be 'requires_action'; anything we don't model as a
// terminal state is treated as still-pending (won't count toward amount_refunded).
function mapRefundStatus(s) {
  return ['succeeded', 'failed', 'canceled', 'pending'].includes(s) ? s : 'pending';
}

// Finds our payment by charge id (preferred) or payment-intent id (fallback for rows
// created before we started caching stripe_charge_id), backfills the charge id, then
// syncs refunds. Returns { payment, orgId, totalRefunded, fullyRefunded } or null if the
// charge isn't one of ours.
async function reconcileRefunds({ chargeId, paymentIntentId }) {
  let payment;
  if (chargeId) {
    const [r] = await db.execute('SELECT * FROM payments WHERE stripe_charge_id = ?', [chargeId]);
    payment = r[0];
  }
  if (!payment && paymentIntentId) {
    const [r] = await db.execute('SELECT * FROM payments WHERE stripe_payment_intent_id = ?', [paymentIntentId]);
    payment = r[0];
  }
  if (!payment) return null;

  // From here on every statement is scoped to the tenant that owns this payment.
  const orgId = payment.org_id;
  const sdb = scopedDb(orgId);

  const cid = chargeId || payment.stripe_charge_id;
  if (!cid) return null;
  if (!payment.stripe_charge_id) {
    await sdb.execute(
      'UPDATE payments SET stripe_charge_id = ? WHERE id = ? AND org_id = ?',
      [cid, payment.id, orgId]
    );
  }

  const list = await stripe.refunds.list({ charge: cid, limit: 100 });

  const conn = await sdb.getConnection();
  try {
    await conn.beginTransaction();
    for (const r of list.data) {
      // Column list deliberately omits note/created_by — a refund first recorded by the
      // admin route keeps the staff note and who issued it; the webhook only ever
      // touches the Stripe-derived fields.
      await conn.execute(
        `INSERT INTO refunds (org_id, payment_id, stripe_refund_id, amount, reason, status)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE amount = VALUES(amount), reason = VALUES(reason), status = VALUES(status)`,
        [orgId, payment.id, r.id, r.amount / 100, r.reason || null, mapRefundStatus(r.status)]
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
    const fullyRefunded = Number(total) >= Number(payment.amount);
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
    return { payment, orgId, totalRefunded: Number(total), fullyRefunded };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { reconcileRefunds, mapRefundStatus };
