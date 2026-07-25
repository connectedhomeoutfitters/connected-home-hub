const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../config/db');
const stripe = require('../config/stripe');
const { resolveToken } = require('../middleware/customerAccess');
const { createDepositInvoice } = require('./admin/estimates');
const { sendMail } = require('../services/mailer');
const { generateEstimatePdf } = require('../services/estimatePdf');
const estimateTerms = require('../config/estimateTerms');
const activity = require('../services/activityLog');

const TOKEN_TTL_DAYS = 30;

// Customer view of an estimate — accept it, or pay the deposit if already accepted.
router.get('/e/:token', resolveToken('estimate'), async (req, res, next) => {
  try {
    const [rows] = await db.execute('SELECT * FROM estimates WHERE id = ?', [req.resourceId]);
    const [items] = await db.execute(
      'SELECT * FROM estimate_line_items WHERE estimate_id = ? ORDER BY sort_order',
      [req.resourceId]
    );
    if (!rows[0]) return res.status(404).render('portal/expired');
    res.render('portal/estimate', {
      estimate: rows[0],
      items,
      token: req.params.token,
      pageScript: null,
      terms: estimateTerms,
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

// Records acceptance (checkbox + typed e-signature name + timestamp + IP + browser —
// see CLAUDE.md "lightweight click-to-accept"), creates the deposit invoice + its own
// access token, and emails the customer the pay link. The webhook, not this route, is
// the source of truth for whether the deposit actually gets paid — this just gets the
// invoice in front of them.
router.post('/e/:token/accept', resolveToken('estimate'), async (req, res, next) => {
  const conn = await db.getConnection();
  try {
    const [rows] = await conn.execute(
      `SELECT e.*, c.name AS customer_name, c.email AS customer_email FROM estimates e
       JOIN customers c ON c.id = e.customer_id WHERE e.id = ?`,
      [req.resourceId]
    );
    const estimate = rows[0];
    if (!estimate) return res.status(404).render('portal/expired');

    if (estimate.status !== 'sent') {
      return res.redirect(`${res.locals.basePath}/e/${req.params.token}`);
    }

    const signatureName = (req.body.signature_name || '').trim();
    if (req.body.agree_terms !== 'on' || !signatureName) {
      const [items] = await conn.execute(
        'SELECT * FROM estimate_line_items WHERE estimate_id = ? ORDER BY sort_order',
        [req.resourceId]
      );
      return res.status(400).render('portal/estimate', {
        estimate, items, token: req.params.token, pageScript: null, terms: estimateTerms,
        signatureName,
        error: !signatureName
          ? 'Please type your name to sign electronically before accepting.'
          : 'Please check the box to agree to the terms before accepting.',
      });
    }

    await conn.beginTransaction();
    await conn.execute(
      `UPDATE estimates SET status = 'accepted', accepted_at = NOW(), accepted_ip = ?,
        signature_name = ?, accepted_user_agent = ? WHERE id = ?`,
      [req.ip, signatureName, req.headers['user-agent'] || null, estimate.id]
    );
    const invoiceId = await createDepositInvoice(conn, estimate);

    const invoiceToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
    await conn.execute(
      'INSERT INTO access_tokens (token, resource_type, resource_id, expires_at) VALUES (?, ?, ?, ?)',
      [invoiceToken, 'invoice', invoiceId, expiresAt]
    );

    // No staff session exists in this customer-facing route, so this can't default to
    // "whoever's doing it" the way estimate-send's follow-up job does — left
    // unassigned for staff to claim from the Jobs list.
    await conn.execute(
      `INSERT INTO jobs (type, title, customer_id, estimate_id, status)
       VALUES ('install', ?, ?, ?, 'pending')`,
      [`Install: ${estimate.title}`, estimate.customer_id, estimate.id]
    );

    await conn.commit();

    await activity.log({
      actorType: 'customer', actorId: estimate.customer_id, actorName: estimate.customer_name,
      action: 'estimate.accepted', entityType: 'estimate', entityId: estimate.id, customerId: estimate.customer_id,
      detail: `Accepted estimate "${estimate.title}" (signed: ${signatureName})`,
    });
    await activity.log({
      actorType: 'customer', actorId: estimate.customer_id, actorName: estimate.customer_name,
      action: 'invoice.created', entityType: 'invoice', entityId: invoiceId, customerId: estimate.customer_id,
      detail: `Deposit invoice ($${estimate.deposit_amount}) created on acceptance`,
    });

    const basePath = process.env.BASE_PATH || '';
    const payUrl = `${process.env.BASE_URL || ''}${basePath}/i/${invoiceToken}`;
    await sendMail({
      to: estimate.customer_email,
      subject: 'Your deposit invoice — Connected Home Outfitters',
      template: 'deposit-invoice',
      data: { customerName: estimate.customer_name, amount: estimate.deposit_amount, payUrl },
    });

    res.redirect(`${res.locals.basePath}/i/${invoiceToken}`);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// Customer declines the estimate. Sets status + declined_at and cancels the outstanding
// "follow up" job staff created when it was sent (no point chasing a declined estimate).
router.post('/e/:token/decline', resolveToken('estimate'), async (req, res, next) => {
  const conn = await db.getConnection();
  try {
    const [rows] = await conn.execute('SELECT * FROM estimates WHERE id = ?', [req.resourceId]);
    const estimate = rows[0];
    if (!estimate) return res.status(404).render('portal/expired');
    // Only a still-open (sent) estimate can be declined; ignore double-submits.
    if (estimate.status !== 'sent') {
      return res.redirect(`${res.locals.basePath}/e/${req.params.token}`);
    }

    await conn.beginTransaction();
    await conn.execute(
      "UPDATE estimates SET status = 'declined', declined_at = NOW() WHERE id = ?",
      [estimate.id]
    );
    await conn.execute(
      "UPDATE jobs SET status = 'cancelled' WHERE estimate_id = ? AND type = 'estimate_followup' AND status IN ('pending', 'in_progress')",
      [estimate.id]
    );
    await conn.commit();

    await activity.log({
      actorType: 'customer', actorId: estimate.customer_id,
      action: 'estimate.declined', entityType: 'estimate', entityId: estimate.id, customerId: estimate.customer_id,
      detail: `Declined estimate "${estimate.title}"`,
    });

    res.redirect(`${res.locals.basePath}/e/${req.params.token}`);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// PDF version of the estimate, accessible with the same customer token as the web view.
router.get('/e/:token/pdf', resolveToken('estimate'), async (req, res, next) => {
  try {
    const [rows] = await db.execute(
      `SELECT e.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
        c.address AS customer_address FROM estimates e
       JOIN customers c ON c.id = e.customer_id WHERE e.id = ?`,
      [req.resourceId]
    );
    const estimate = rows[0];
    if (!estimate) return res.status(404).render('portal/expired');
    const [items] = await db.execute(
      'SELECT * FROM estimate_line_items WHERE estimate_id = ? ORDER BY sort_order',
      [req.resourceId]
    );
    const pdf = await generateEstimatePdf({
      estimate, items,
      customer: { name: estimate.customer_name, email: estimate.customer_email, phone: estimate.customer_phone, address: estimate.customer_address },
    });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="estimate-${estimate.id}.pdf"`);
    res.send(pdf);
  } catch (err) {
    next(err);
  }
});

// Customer view of an invoice (deposit or final) with a Stripe payment button.
router.get('/i/:token', resolveToken('invoice'), async (req, res, next) => {
  try {
    const [rows] = await db.execute(
      `SELECT i.*, c.name AS customer_name, c.email AS customer_email
       FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = ?`,
      [req.resourceId]
    );
    if (!rows[0]) return res.status(404).render('portal/expired');
    res.render('portal/invoice', {
      invoice: rows[0],
      token: req.params.token,
      stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
      pageScript: 'page-pay.js',
    });
  } catch (err) {
    next(err);
  }
});

// Shown after a payment attempt — Stripe's Payment Element redirects here via
// return_url (see public/js/page-pay.js). The webhook is the source of truth for
// whether it actually succeeded, so if the invoice isn't marked paid yet (still
// processing, failed, or the webhook simply hasn't landed yet), send them back to the
// pay page rather than showing a false "you're all set" message.
router.get('/i/:token/next-steps', resolveToken('invoice'), async (req, res, next) => {
  try {
    const [rows] = await db.execute('SELECT * FROM invoices WHERE id = ?', [req.resourceId]);
    const invoice = rows[0];
    if (!invoice) return res.status(404).render('portal/expired');
    if (invoice.status !== 'paid') {
      return res.redirect(`${res.locals.basePath}/i/${req.params.token}`);
    }
    res.render('portal/next-steps', { invoice, pageScript: null });
  } catch (err) {
    next(err);
  }
});

// Creates a Stripe PaymentIntent for the invoice behind this token. Frontend confirms it
// with Stripe.js (Payment Element); the webhook is the source of truth for marking it paid.
router.post('/i/:token/pay', resolveToken('invoice'), async (req, res, next) => {
  try {
    const [rows] = await db.execute('SELECT * FROM invoices WHERE id = ?', [req.resourceId]);
    const invoice = rows[0];
    if (!invoice || invoice.status !== 'pending') {
      return res.status(400).json({ error: 'Invoice is not payable' });
    }

    const intent = await stripe.paymentIntents.create({
      amount: Math.round(invoice.amount * 100),
      currency: 'usd',
      // source: 'cho-hub' keeps this distinguishable from GYMR subscription charges
      // in Stripe's dashboard/reports/reconciliation, since both share one account.
      metadata: { source: 'cho-hub', invoice_id: String(invoice.id), type: invoice.type },
      statement_descriptor_suffix: 'CHO JOB',
    });

    await db.execute(
      'INSERT INTO payments (invoice_id, stripe_payment_intent_id, amount, status) VALUES (?, ?, ?, ?)',
      [invoice.id, intent.id, invoice.amount, 'pending']
    );

    res.json({ clientSecret: intent.client_secret });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
