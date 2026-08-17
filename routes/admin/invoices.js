const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requireAuth } = require('../../middleware/auth');
const { sendMail } = require('../../services/mailer');
const { createInvoice } = require('../../services/invoicing');
const { getCompany } = require('../../services/companySettings');
const activity = require('../../services/activityLog');
const { recordManualPayment, labelFor } = require('../../services/manualPayment');

router.use(requireAuth);

const TOKEN_TTL_DAYS = 30;

router.get('/', async (req, res, next) => {
  try {
    const [invoices] = await req.db.execute(
      `SELECT i.*, c.name AS customer_name FROM invoices i
       JOIN customers c ON c.id = i.customer_id AND c.org_id = i.org_id
       WHERE i.org_id = ?
       ORDER BY i.created_at DESC`,
      [req.orgId]
    );
    res.render('admin/invoices', { pageScript: null, invoices });
  } catch (err) {
    next(err);
  }
});

// New standalone/final invoice (deposit invoices are created automatically on estimate
// acceptance, so they're not offered here).
router.get('/new', async (req, res, next) => {
  try {
    const [customers] = await req.db.execute(
      'SELECT id, name, email FROM customers WHERE org_id = ? ORDER BY name',
      [req.orgId]
    );
    res.render('admin/invoice-form', {
      pageScript: null, customers, error: null,
      preset: { customer_id: req.query.customer_id || '', type: 'standalone', amount: '', description: '', due_date: '' },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  const { customer_id, type, amount, description, due_date } = req.body;
  const rerender = async (error) => {
    const [customers] = await req.db.execute(
      'SELECT id, name, email FROM customers WHERE org_id = ? ORDER BY name',
      [req.orgId]
    );
    res.status(400).render('admin/invoice-form', {
      pageScript: null, customers, error,
      preset: { customer_id, type, amount, description, due_date },
    });
  };
  try {
    const amt = parseFloat(amount);
    if (!customer_id) return rerender('Please choose a customer.');
    if (!['final', 'standalone'].includes(type)) return rerender('Invalid invoice type.');
    if (isNaN(amt) || amt <= 0) return rerender('Enter an amount greater than zero.');

    // The customer must belong to this org — a forged customer_id would otherwise bill
    // against another tenant's customer.
    const [[customer]] = await req.db.execute(
      'SELECT id FROM customers WHERE id = ? AND org_id = ?',
      [customer_id, req.orgId]
    );
    if (!customer) return rerender('Please choose a customer.');

    const invoiceId = await createInvoice(req.db, {
      org_id: req.orgId,
      customer_id, type, amount: amt,
      description: (description || '').trim() || null,
      due_date: due_date || null,
    });
    await activity.log({
      ...activity.staff(req), action: 'invoice.created', entityType: 'invoice', entityId: invoiceId,
      customerId: Number(customer_id), detail: `${type} invoice ($${amt.toFixed(2)}) created`,
    });
    res.redirect(`${res.locals.basePath}/admin/invoices/${invoiceId}`);
  } catch (err) {
    next(err);
  }
});

// Invoice detail — status, the customer pay link once sent, and payments/refunds against it.
router.get('/:id', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(
      `SELECT i.*, c.name AS customer_name, c.email AS customer_email, c.id AS customer_id,
              e.title AS estimate_title
       FROM invoices i
       JOIN customers c ON c.id = i.customer_id AND c.org_id = i.org_id
       LEFT JOIN estimates e ON e.id = i.estimate_id AND e.org_id = i.org_id
       WHERE i.id = ? AND i.org_id = ?`,
      [req.params.id, req.orgId]
    );
    const invoice = rows[0];
    if (!invoice) return res.status(404).render('error', { message: 'Invoice not found' });

    const [payments] = await req.db.execute(
      `SELECT id, amount, amount_refunded, status, method, reference, received_at,
              card_brand, card_last4, created_at
       FROM payments WHERE invoice_id = ? AND org_id = ? ORDER BY created_at DESC`,
      [invoice.id, req.orgId]
    );
    // Most recent still-valid pay link, if the invoice has been sent.
    const [tokens] = await req.db.execute(
      `SELECT token FROM access_tokens
       WHERE resource_type = 'invoice' AND resource_id = ? AND org_id = ? AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [invoice.id, req.orgId]
    );
    const payToken = tokens[0]?.token || null;

    // What is still owed, net of refunds — pre-fills the record-payment amount and lets a
    // part payment leave the invoice open.
    const paid = payments
      .filter(p => p.status === 'succeeded')
      .reduce((t, p) => t + Number(p.amount) - Number(p.amount_refunded), 0);
    const outstanding = Math.max(0, Number(invoice.amount) - paid);

    res.render('admin/invoice-detail', {
      pageScript: null, invoice, payments, payToken,
      saved: req.query.sent === '1',
      autoCreated: req.query.created === '1',
      recorded: req.query.recorded || null,
      outstanding,
      methodLabel: labelFor,
      today: new Date().toISOString().slice(0, 10),
    });
  } catch (err) {
    next(err);
  }
});

// Send (or resend) the invoice: mint an access token, email the pay link, mark sent.
router.post('/:id/send', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(
      `SELECT i.*, c.name AS customer_name, c.email AS customer_email
       FROM invoices i JOIN customers c ON c.id = i.customer_id AND c.org_id = i.org_id
       WHERE i.id = ? AND i.org_id = ?`,
      [req.params.id, req.orgId]
    );
    const invoice = rows[0];
    if (!invoice) return res.status(404).render('error', { message: 'Invoice not found' });
    if (invoice.status !== 'pending') {
      return res.status(409).render('error', { message: `A ${invoice.status} invoice can't be sent.` });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
    await req.db.execute(
      'INSERT INTO access_tokens (org_id, token, resource_type, resource_id, expires_at) VALUES (?, ?, ?, ?, ?)',
      [req.orgId, token, 'invoice', invoice.id, expiresAt]
    );
    await req.db.execute(
      'UPDATE invoices SET sent_at = NOW() WHERE id = ? AND org_id = ?',
      [invoice.id, req.orgId]
    );

    const basePath = process.env.BASE_PATH || '';
    const payUrl = `${process.env.BASE_URL || ''}${basePath}/i/${token}`;
    const company = await getCompany(req.orgId);
    await sendMail({
      orgId: req.orgId,
      to: invoice.customer_email,
      subject: `Your invoice — ${company.company_name}`,
      template: 'invoice-sent',
      data: {
        customerName: invoice.customer_name,
        amount: invoice.amount,
        invoiceType: invoice.type,
        description: invoice.description,
        payUrl,
      },
    });

    await activity.log({
      ...activity.staff(req), action: 'invoice.sent', entityType: 'invoice', entityId: invoice.id,
      customerId: invoice.customer_id, detail: `${invoice.type} invoice ($${invoice.amount}) sent to ${invoice.customer_email}`,
    });

    res.redirect(`${res.locals.basePath}/admin/invoices/${invoice.id}?sent=1`);
  } catch (err) {
    next(err);
  }
});

// Void a pending invoice (e.g. created in error). Paid invoices are refunded via the
// Payments section instead, never voided.
router.post('/:id/void', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(
      'SELECT status FROM invoices WHERE id = ? AND org_id = ?',
      [req.params.id, req.orgId]
    );
    if (!rows[0]) return res.status(404).render('error', { message: 'Invoice not found' });
    if (rows[0].status !== 'pending') {
      return res.status(409).render('error', { message: `A ${rows[0].status} invoice can't be voided.` });
    }
    await req.db.execute(
      "UPDATE invoices SET status = 'void' WHERE id = ? AND org_id = ?",
      [req.params.id, req.orgId]
    );
    res.redirect(`${res.locals.basePath}/admin/invoices/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

// Record a payment taken outside Stripe — cash, cheque, bank transfer, Venmo and the
// like. Everything that makes an invoice "paid" (the idempotency latch, the activity log,
// the receipt, the push into the tenant's Ledger books) lives in the service, shared in
// spirit with the Stripe webhook so the two cannot drift.
router.post('/:id/record-payment', async (req, res, next) => {
  try {
    const result = await recordManualPayment(req.db, req.orgId, {
      invoiceId: req.params.id,
      amount: req.body.amount,
      method: req.body.method,
      reference: req.body.reference,
      // <input type="date"> gives a bare date; store it as a time so it sorts with the
      // card payments, which carry a real timestamp.
      receivedAt: req.body.received_at ? `${req.body.received_at} 12:00:00` : null,
      userId: req.user.id,
      sendReceipt: req.body.send_receipt === '1',
    });
    const flag = result.invoicePaid ? 'paid' : 'partial';
    res.redirect(`${res.locals.basePath}/admin/invoices/${req.params.id}?recorded=${flag}`);
  } catch (err) {
    if (err.status) return res.status(err.status).render('error', { message: err.message });
    next(err);
  }
});

module.exports = router;
