'use strict';
// Recording a payment that did not come through Stripe — cash, cheque, bank transfer,
// Venmo / Cash App / Zelle.
//
// This deliberately mirrors the payment_intent.succeeded handler in routes/webhooks.js
// rather than inventing a second way to mark an invoice paid. The two must agree on three
// things or the books drift:
//
//   1. the `AND status <> 'paid'` latch, so a double submit cannot double-send a receipt
//      or double-log the activity entry;
//   2. writing the activity log;
//   3. calling pushPaidInvoice, so the income reaches the tenant's Connected Home Ledger
//      books. Cash revenue that never reaches the books is the failure this whole feature
//      exists to prevent.
//
// The one behaviour the webhook does not need: PARTIAL payments. A Stripe PaymentIntent is
// always for the invoice total, but somebody can hand over $50 against a $90 invoice, so
// the invoice only flips to paid once the recorded total actually covers it.

const activity = require('./activityLog');
const { getCompany } = require('./companySettings');
const { sendMail } = require('./mailer');
const { pushPaidInvoice } = require('./ledgerSync');

const METHODS = ['cash', 'check', 'bank_transfer', 'other'];

// Card payments are Stripe's job. Allowing 'card' here would let staff mark an invoice
// paid with no money having moved and no charge to reconcile against.
function isOfflineMethod(method) {
  return METHODS.includes(method);
}

/**
 * Record an offline payment against an invoice.
 *
 * @param {object} db      an org-scoped handle (req.db)
 * @param {number} orgId
 * @param {object} input   { invoiceId, amount, method, reference, receivedAt, userId, sendReceipt }
 * @returns {object} { paymentId, invoicePaid, totalPaid, outstanding }
 */
async function recordManualPayment(db, orgId, input) {
  const { invoiceId, method, reference = null, receivedAt = null, userId = null, sendReceipt = true } = input;
  const amount = Number(input.amount);

  if (!isOfflineMethod(method)) {
    throw Object.assign(new Error('Choose how the payment was received.'), { status: 400 });
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw Object.assign(new Error('Enter a payment amount greater than zero.'), { status: 400 });
  }

  const [[invoice]] = await db.execute(
    `SELECT i.*, c.name AS customer_name, c.email AS customer_email
       FROM invoices i
       JOIN customers c ON c.id = i.customer_id AND c.org_id = i.org_id
      WHERE i.id = ? AND i.org_id = ?`,
    [invoiceId, orgId]
  );
  if (!invoice) throw Object.assign(new Error('Invoice not found'), { status: 404 });
  // A void invoice is one that should not have existed. Recording money against it would
  // put revenue in the books with nothing to attribute it to.
  if (invoice.status === 'void') {
    throw Object.assign(new Error('This invoice is void — un-void it before recording a payment.'), { status: 409 });
  }

  const conn = await db.getConnection();
  let paymentId, firstTime = false, totalPaid = 0;
  try {
    await conn.beginTransaction();

    const [ins] = await conn.execute(
      `INSERT INTO payments (org_id, invoice_id, method, reference, received_at, recorded_by,
                             stripe_payment_intent_id, amount, amount_refunded, status)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 0, 'succeeded')`,
      [orgId, invoiceId, method, reference || null, receivedAt || null, userId, amount.toFixed(2)]
    );
    paymentId = ins.insertId;

    // Net of refunds, and across card and offline alike — a customer may well pay half by
    // card and hand over the rest in cash.
    const [[sum]] = await conn.execute(
      `SELECT COALESCE(SUM(amount - amount_refunded), 0) AS paid
         FROM payments
        WHERE invoice_id = ? AND org_id = ? AND status = 'succeeded'`,
      [invoiceId, orgId]
    );
    totalPaid = Number(sum.paid);

    if (totalPaid + 0.005 >= Number(invoice.amount)) {
      const [upd] = await conn.execute(
        "UPDATE invoices SET status = 'paid', paid_at = NOW() WHERE id = ? AND org_id = ? AND status <> 'paid'",
        [invoiceId, orgId]
      );
      firstTime = upd.affectedRows === 1;
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  // Everything below is after-effects: none of it may undo a recorded payment, so each
  // failure is swallowed rather than thrown, exactly as the webhook treats them.
  await activity.log({
    orgId,
    actorType: 'staff',
    actorId: userId,
    action: 'invoice.payment_recorded',
    entityType: 'invoice',
    entityId: invoiceId,
    customerId: invoice.customer_id,
    detail: `${labelFor(method)} payment of $${amount.toFixed(2)} recorded${reference ? ` (${reference})` : ''}`,
  });

  if (firstTime) {
    if (sendReceipt && invoice.customer_email) {
      try {
        const company = await getCompany(orgId);
        await sendMail({
          orgId,
          to: invoice.customer_email,
          subject: `Payment received — ${company.company_name}`,
          template: 'payment-receipt',
          data: { customerName: invoice.customer_name, amount: invoice.amount, invoiceType: invoice.type },
        });
      } catch (err) {
        console.error('manual payment receipt failed:', err.message);
      }
    }
    // The whole point. Not awaited, for the same reason the webhook does not await it:
    // Ledger being down must never fail a payment that has already been taken.
    pushPaidInvoice(orgId, invoiceId);
  }

  return {
    paymentId,
    invoicePaid: firstTime || invoice.status === 'paid',
    totalPaid,
    outstanding: Math.max(0, Number(invoice.amount) - totalPaid),
  };
}

function labelFor(method) {
  return {
    card: 'Card', cash: 'Cash', check: 'Cheque',
    bank_transfer: 'Bank transfer', other: 'Other',
  }[method] || method;
}

module.exports = { recordManualPayment, isOfflineMethod, labelFor, METHODS };
