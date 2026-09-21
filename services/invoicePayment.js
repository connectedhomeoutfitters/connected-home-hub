'use strict';
// The one place an invoice becomes paid.
//
// Three things can pay an invoice — a Stripe webhook, a Square payment (synchronous
// response or its webhook), and staff recording cash — and they must agree on the same
// three consequences or the books drift: the `status <> 'paid'` latch (so a redelivered
// event can't send a second receipt), the activity-log entry, and the push into the
// tenant's Connected Home Ledger books. Before Square this was copied between
// routes/webhooks.js and services/manualPayment.js; now they all call here.

const activity = require('./activityLog');
const { getCompany } = require('./companySettings');
const { sendMail } = require('./mailer');
const { pushPaidInvoice } = require('./ledgerSync');

// Flip the invoice to paid inside the caller's transaction. Returns true only on the
// transition — that return value IS the idempotency latch every caller gates on.
async function latchInvoicePaid(conn, orgId, invoiceId) {
  const [upd] = await conn.execute(
    "UPDATE invoices SET status = 'paid', paid_at = NOW() WHERE id = ? AND org_id = ? AND status <> 'paid'",
    [invoiceId, orgId]
  );
  return upd.affectedRows === 1;
}

// Everything that follows a first-time transition to paid. Never throws: a payment that
// has already been taken must not be un-taken by a mail or logging failure.
//
// `sdb` is an org-scoped handle (req.db or scopedDb(orgId)).
async function afterInvoicePaid(sdb, orgId, invoiceId, { via = 'system', sendReceipt = true } = {}) {
  let invoice;
  try {
    const [rows] = await sdb.execute(
      `SELECT i.*, c.name AS customer_name, c.email AS customer_email FROM invoices i
         JOIN customers c ON c.id = i.customer_id AND c.org_id = i.org_id
        WHERE i.id = ? AND i.org_id = ?`,
      [invoiceId, orgId]
    );
    invoice = rows[0];
  } catch (err) {
    console.error('afterInvoicePaid: invoice lookup failed:', err.message);
  }
  if (!invoice) return;

  await activity.log({
    orgId, actorType: 'system', action: 'invoice.paid', entityType: 'invoice', entityId: invoice.id,
    customerId: invoice.customer_id,
    detail: `Payment of $${invoice.amount} received (${invoice.type}) via ${via}`,
  });
  if (sendReceipt && invoice.customer_email) await sendPaymentReceipt(orgId, invoice);

  // Post the income into the tenant's Ledger books. Deliberately NOT awaited: Ledger being
  // slow or down must not delay or fail reconciling a payment here. It swallows its own
  // errors, and an unsynced invoice is recoverable via ledgerSync.backfillOrg().
  pushPaidInvoice(orgId, invoice.id);
}

async function sendPaymentReceipt(orgId, invoice) {
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
    console.error('payment receipt failed:', err.message);
  }
}

module.exports = { latchInvoicePaid, afterInvoicePaid, sendPaymentReceipt };
