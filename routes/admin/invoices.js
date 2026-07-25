const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../../config/db');
const { requireAuth } = require('../../middleware/auth');
const { sendMail } = require('../../services/mailer');
const { createInvoice } = require('../../services/invoicing');
const activity = require('../../services/activityLog');

router.use(requireAuth);

const TOKEN_TTL_DAYS = 30;

router.get('/', async (req, res, next) => {
  try {
    const [invoices] = await db.execute(
      `SELECT i.*, c.name AS customer_name FROM invoices i
       JOIN customers c ON c.id = i.customer_id
       ORDER BY i.created_at DESC`
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
    const [customers] = await db.execute('SELECT id, name, email FROM customers ORDER BY name');
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
    const [customers] = await db.execute('SELECT id, name, email FROM customers ORDER BY name');
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

    const invoiceId = await createInvoice(db, {
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
    const [rows] = await db.execute(
      `SELECT i.*, c.name AS customer_name, c.email AS customer_email, c.id AS customer_id,
              e.title AS estimate_title
       FROM invoices i
       JOIN customers c ON c.id = i.customer_id
       LEFT JOIN estimates e ON e.id = i.estimate_id
       WHERE i.id = ?`,
      [req.params.id]
    );
    const invoice = rows[0];
    if (!invoice) return res.status(404).render('error', { message: 'Invoice not found' });

    const [payments] = await db.execute(
      `SELECT id, amount, amount_refunded, status, card_brand, card_last4, created_at
       FROM payments WHERE invoice_id = ? ORDER BY created_at DESC`,
      [invoice.id]
    );
    // Most recent still-valid pay link, if the invoice has been sent.
    const [tokens] = await db.execute(
      `SELECT token FROM access_tokens
       WHERE resource_type = 'invoice' AND resource_id = ? AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [invoice.id]
    );
    const payToken = tokens[0]?.token || null;

    res.render('admin/invoice-detail', {
      pageScript: null, invoice, payments, payToken,
      saved: req.query.sent === '1',
    });
  } catch (err) {
    next(err);
  }
});

// Send (or resend) the invoice: mint an access token, email the pay link, mark sent.
router.post('/:id/send', async (req, res, next) => {
  try {
    const [rows] = await db.execute(
      `SELECT i.*, c.name AS customer_name, c.email AS customer_email
       FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = ?`,
      [req.params.id]
    );
    const invoice = rows[0];
    if (!invoice) return res.status(404).render('error', { message: 'Invoice not found' });
    if (invoice.status !== 'pending') {
      return res.status(409).render('error', { message: `A ${invoice.status} invoice can't be sent.` });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
    await db.execute(
      'INSERT INTO access_tokens (token, resource_type, resource_id, expires_at) VALUES (?, ?, ?, ?)',
      [token, 'invoice', invoice.id, expiresAt]
    );
    await db.execute('UPDATE invoices SET sent_at = NOW() WHERE id = ?', [invoice.id]);

    const basePath = process.env.BASE_PATH || '';
    const payUrl = `${process.env.BASE_URL || ''}${basePath}/i/${token}`;
    await sendMail({
      to: invoice.customer_email,
      subject: 'Your invoice — Connected Home Outfitters',
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
    const [rows] = await db.execute('SELECT status FROM invoices WHERE id = ?', [req.params.id]);
    if (!rows[0]) return res.status(404).render('error', { message: 'Invoice not found' });
    if (rows[0].status !== 'pending') {
      return res.status(409).render('error', { message: `A ${rows[0].status} invoice can't be voided.` });
    }
    await db.execute("UPDATE invoices SET status = 'void' WHERE id = ?", [req.params.id]);
    res.redirect(`${res.locals.basePath}/admin/invoices/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
