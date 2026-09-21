'use strict';
// Recording a Square payment against our own rows, from either of the two places we learn
// about one: the synchronous CreatePayment response in routes/portal.js, and the
// payment.updated webhook in routes/webhooks.js. Both hand us the Square payment object
// and the org it belongs to; this settles it exactly once.
//
// Square differs from Stripe here: CreatePayment normally returns the payment already
// COMPLETED, so the invoice can be marked paid in the same request. The webhook then
// arrives seconds later saying the same thing, and is harmless because the invoice latch
// in services/invoicePayment.js only fires on the transition.
//
// Webhook events are NOT ordered: seen on the sandbox, payment.created (status APPROVED)
// landed AFTER the synchronous COMPLETED settle and, before the guard below, dragged the
// payments row back to 'pending' while the invoice stayed paid. So a row that has reached
// 'succeeded' keeps it — a later, staler status can never regress it.

const scopedDb = require('../config/scopedDb');
const { latchInvoicePaid, afterInvoicePaid } = require('./invoicePayment');

// Square payment.status: APPROVED, PENDING, COMPLETED, CANCELED, FAILED.
function mapPaymentStatus(s) {
  if (s === 'COMPLETED') return 'succeeded';
  if (s === 'CANCELED' || s === 'FAILED') return 'failed';
  return 'pending';
}

function cardDetails(payment) {
  const card = payment.card_details?.card || {};
  return {
    cardBrand: card.card_brand ? card.card_brand.toLowerCase() : null,
    cardLast4: card.last_4 || null,
    receiptUrl: payment.receipt_url || null,
  };
}

// Updates our payments row from Square's payment object and, on COMPLETED, marks the
// invoice paid. Returns { firstTime } — true only when this call flipped the invoice.
async function settleSquarePayment(orgId, payment) {
  const sdb = scopedDb(orgId);
  const status = mapPaymentStatus(payment.status);
  const { cardBrand, cardLast4, receiptUrl } = cardDetails(payment);

  const conn = await sdb.getConnection();
  let firstTime = false, invoiceId = null;
  try {
    await conn.beginTransaction();
    const [[row]] = await conn.execute(
      'SELECT id, invoice_id, status FROM payments WHERE square_payment_id = ? AND org_id = ? FOR UPDATE',
      [payment.id, orgId]
    );
    if (!row) {
      await conn.rollback();
      return { firstTime: false, known: false };
    }
    invoiceId = row.invoice_id;
    await conn.execute(
      `UPDATE payments
          SET status = IF(status = 'succeeded', status, ?),
              card_brand = COALESCE(?, card_brand), card_last4 = COALESCE(?, card_last4),
              receipt_url = COALESCE(?, receipt_url)
        WHERE id = ? AND org_id = ?`,
      [status, cardBrand, cardLast4, receiptUrl, row.id, orgId]
    );
    if (status === 'succeeded') firstTime = await latchInvoicePaid(conn, orgId, invoiceId);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  if (firstTime) await afterInvoicePaid(sdb, orgId, invoiceId, { via: 'square' });
  return { firstTime, known: true, status };
}

module.exports = { settleSquarePayment, mapPaymentStatus };
