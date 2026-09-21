const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const stripe = require('../config/stripe');
const { resolveToken } = require('../middleware/customerAccess');
const { createDepositInvoice } = require('./admin/estimates');
const { sendMail } = require('../services/mailer');
const { generateEstimatePdf } = require('../services/estimatePdf');
const { renderTermsFor } = require('../services/terms');
const { getCompany } = require('../services/companySettings');
const { paymentContextFor } = require('../services/paymentProvider');
const squareApi = require('../services/squareApi');
const { settleSquarePayment } = require('../services/squarePayments');
const { lineItemsForInvoice } = require('../services/invoicing');
const activity = require('../services/activityLog');

const TOKEN_TTL_DAYS = 30;

// These routes have no session — resolveToken() resolves the access token and calls
// attachOrg() from the token row's org_id, so req.db/req.orgId are set by the time any
// handler below runs. See middleware/customerAccess.js.

// Customer view of an estimate — accept it, or pay the deposit if already accepted.
router.get('/e/:token', resolveToken('estimate'), async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(
      'SELECT * FROM estimates WHERE id = ? AND org_id = ?',
      [req.resourceId, req.orgId]
    );
    const [items] = await req.db.execute(
      'SELECT * FROM estimate_line_items WHERE estimate_id = ? AND org_id = ? ORDER BY sort_order',
      [req.resourceId, req.orgId]
    );
    if (!rows[0]) return res.status(404).render('portal/expired');
    const company = await getCompany(req.orgId);
    res.render('portal/estimate', {
      estimate: rows[0],
      items,
      token: req.params.token,
      pageScript: null,
      terms: (await renderTermsFor(req.db, req.orgId, rows[0], company)).html,
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
  const conn = await req.db.getConnection();
  try {
    const [rows] = await conn.execute(
      `SELECT e.*, c.name AS customer_name, c.email AS customer_email FROM estimates e
       JOIN customers c ON c.id = e.customer_id AND c.org_id = e.org_id
       WHERE e.id = ? AND e.org_id = ?`,
      [req.resourceId, req.orgId]
    );
    const estimate = rows[0];
    if (!estimate) { conn.release(); return res.status(404).render('portal/expired'); }

    if (estimate.status !== 'sent') {
      conn.release();
      return res.redirect(`${res.locals.basePath}/e/${req.params.token}`);
    }

    const signatureName = (req.body.signature_name || '').trim();
    if (req.body.agree_terms !== 'on' || !signatureName) {
      const [items] = await conn.execute(
        'SELECT * FROM estimate_line_items WHERE estimate_id = ? AND org_id = ? ORDER BY sort_order',
        [req.resourceId, req.orgId]
      );
      const company = await getCompany(req.orgId);
      conn.release();
      return res.status(400).render('portal/estimate', {
        estimate, items, token: req.params.token, pageScript: null, terms: (await renderTermsFor(req.db, req.orgId, estimate, company)).html,
        signatureName,
        error: !signatureName
          ? 'Please type your name to sign electronically before accepting.'
          : 'Please check the box to agree to the terms before accepting.',
      });
    }

    await conn.beginTransaction();
    await conn.execute(
      `UPDATE estimates SET status = 'accepted', accepted_at = NOW(), accepted_ip = ?,
        signature_name = ?, accepted_user_agent = ? WHERE id = ? AND org_id = ?`,
      [req.ip, signatureName, req.headers['user-agent'] || null, estimate.id, req.orgId]
    );
    const invoiceId = await createDepositInvoice(conn, estimate);

    const invoiceToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
    await conn.execute(
      'INSERT INTO access_tokens (org_id, token, resource_type, resource_id, expires_at) VALUES (?, ?, ?, ?, ?)',
      [req.orgId, invoiceToken, 'invoice', invoiceId, expiresAt]
    );

    // No staff session exists in this customer-facing route, so this can't default to
    // "whoever's doing it" the way estimate-send's follow-up job does — left
    // unassigned for staff to claim from the Jobs list.
    await conn.execute(
      `INSERT INTO jobs (org_id, type, title, customer_id, estimate_id, status)
       VALUES (?, 'install', ?, ?, ?, 'pending')`,
      [req.orgId, `Install: ${estimate.title}`, estimate.customer_id, estimate.id]
    );

    await conn.commit();

    await activity.log({
      orgId: req.orgId,
      actorType: 'customer', actorId: estimate.customer_id, actorName: estimate.customer_name,
      action: 'estimate.accepted', entityType: 'estimate', entityId: estimate.id, customerId: estimate.customer_id,
      detail: `Accepted estimate "${estimate.title}" (signed: ${signatureName})`,
    });
    await activity.log({
      orgId: req.orgId,
      actorType: 'customer', actorId: estimate.customer_id, actorName: estimate.customer_name,
      action: 'invoice.created', entityType: 'invoice', entityId: invoiceId, customerId: estimate.customer_id,
      detail: `Deposit invoice ($${estimate.deposit_amount}) created on acceptance`,
    });

    const basePath = process.env.BASE_PATH || '';
    const payUrl = `${process.env.BASE_URL || ''}${basePath}/i/${invoiceToken}`;
    const company = await getCompany(req.orgId);
    await sendMail({
      orgId: req.orgId,
      to: estimate.customer_email,
      subject: `Your deposit invoice — ${company.company_name}`,
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
  const conn = await req.db.getConnection();
  try {
    const [rows] = await conn.execute(
      'SELECT * FROM estimates WHERE id = ? AND org_id = ?',
      [req.resourceId, req.orgId]
    );
    const estimate = rows[0];
    if (!estimate) { conn.release(); return res.status(404).render('portal/expired'); }
    // Only a still-open (sent) estimate can be declined; ignore double-submits.
    if (estimate.status !== 'sent') {
      conn.release();
      return res.redirect(`${res.locals.basePath}/e/${req.params.token}`);
    }

    await conn.beginTransaction();
    await conn.execute(
      "UPDATE estimates SET status = 'declined', declined_at = NOW() WHERE id = ? AND org_id = ?",
      [estimate.id, req.orgId]
    );
    await conn.execute(
      `UPDATE jobs SET status = 'cancelled'
       WHERE estimate_id = ? AND org_id = ? AND type = 'estimate_followup'
         AND status IN ('pending', 'in_progress')`,
      [estimate.id, req.orgId]
    );
    await conn.commit();

    await activity.log({
      orgId: req.orgId,
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
    const [rows] = await req.db.execute(
      `SELECT e.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
        c.address AS customer_address FROM estimates e
       JOIN customers c ON c.id = e.customer_id AND c.org_id = e.org_id
       WHERE e.id = ? AND e.org_id = ?`,
      [req.resourceId, req.orgId]
    );
    const estimate = rows[0];
    if (!estimate) return res.status(404).render('portal/expired');
    const [items] = await req.db.execute(
      'SELECT * FROM estimate_line_items WHERE estimate_id = ? AND org_id = ? ORDER BY sort_order',
      [req.resourceId, req.orgId]
    );
    const pdf = await generateEstimatePdf({
      estimate, items,
      customer: { name: estimate.customer_name, email: estimate.customer_email, phone: estimate.customer_phone, address: estimate.customer_address },
      company: await getCompany(req.orgId),
    });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="estimate-${estimate.id}.pdf"`);
    res.send(pdf);
  } catch (err) {
    next(err);
  }
});

// Customer view of an invoice (deposit or final) with a card payment form — Stripe's
// Payment Element or Square's Web Payments card, whichever the business takes payment
// through (services/paymentProvider.js).
router.get('/i/:token', resolveToken('invoice'), async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(
      `SELECT i.*, c.name AS customer_name, c.email AS customer_email
       FROM invoices i JOIN customers c ON c.id = i.customer_id AND c.org_id = i.org_id
       WHERE i.id = ? AND i.org_id = ?`,
      [req.resourceId, req.orgId]
    );
    if (!rows[0]) return res.status(404).render('portal/expired');
    const ctx = await paymentContextFor(req.orgId);
    res.render('portal/invoice', {
      invoice: rows[0],
      token: req.params.token,
      provider: ctx.provider,
      // Stripe.js needs the connected account id alongside the PLATFORM publishable key —
      // Connect has no per-tenant publishable key. Null for the platform org.
      stripePublishableKey: ctx.provider === 'stripe' ? ctx.publishableKey : null,
      stripeAccount: ctx.provider === 'stripe' ? ctx.stripeAccount : null,
      // Square's card form is initialised client-side with the (public) application id
      // and the seller's location; the access token never leaves the server.
      square: ctx.provider === 'square'
        ? { applicationId: ctx.applicationId, locationId: ctx.locationId, sdkUrl: ctx.sdkUrl }
        : null,
      paymentsEnabled: ctx.canAccept,
      pageScript: ctx.provider === 'square' ? 'page-pay-square.js' : 'page-pay.js',
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
    const [rows] = await req.db.execute(
      'SELECT * FROM invoices WHERE id = ? AND org_id = ?',
      [req.resourceId, req.orgId]
    );
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

// Takes payment for the invoice behind this token.
//
//   Stripe: creates a PaymentIntent and returns its client secret; the browser confirms it
//           with the Payment Element, and the webhook is the source of truth for marking
//           the invoice paid.
//   Square: the browser has already tokenised the card (Web Payments SDK) and posts the
//           token as `sourceId`; we call CreatePayment, which normally returns COMPLETED
//           synchronously, and settle the invoice in the same request. The payment.updated
//           webhook then lands on the same idempotent settle path.
router.post('/i/:token/pay', resolveToken('invoice'), async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(
      'SELECT * FROM invoices WHERE id = ? AND org_id = ?',
      [req.resourceId, req.orgId]
    );
    const invoice = rows[0];
    if (!invoice || invoice.status !== 'pending') {
      return res.status(400).json({ error: 'Invoice is not payable' });
    }

    // Which processor, and which account, does this tenant's money go to? Org 1
    // (Connected Home Outfitters) charges the platform Stripe account directly as it
    // always has; every other tenant charges their OWN connected Stripe or Square account,
    // so we never take custody of their revenue. See services/paymentProvider.js.
    const ctx = await paymentContextFor(req.orgId);
    if (!ctx.canAccept) {
      // Fail loudly rather than quietly banking someone else's money into our account.
      return res.status(503).json({
        error: 'This business has not finished setting up payments yet. Please contact them directly.',
      });
    }

    if (ctx.provider === 'square') return await paySquare(req, res, invoice, ctx);

    const intent = await stripe.paymentIntents.create({
      amount: Math.round(invoice.amount * 100),
      currency: 'usd',
      // source: 'cho-hub' keeps platform-account charges distinguishable from GYMR
      // subscription charges, since those share one account. org_id lets the webhook
      // resolve the tenant without a DB lookup.
      metadata: {
        source: 'cho-hub', org_id: String(req.orgId),
        invoice_id: String(invoice.id), type: invoice.type,
      },
      statement_descriptor_suffix: 'CHO JOB',
    }, ctx.options);

    await req.db.execute(
      `INSERT INTO payments (org_id, invoice_id, provider, stripe_payment_intent_id, amount, status)
       VALUES (?, ?, 'stripe', ?, ?, 'pending')`,
      [req.orgId, invoice.id, intent.id, invoice.amount]
    );

    res.json({ clientSecret: intent.client_secret });
  } catch (err) {
    next(err);
  }
});

async function paySquare(req, res, invoice, ctx) {
  const sourceId = typeof req.body?.sourceId === 'string' ? req.body.sourceId.trim() : '';
  if (!sourceId) return res.status(400).json({ error: 'Card details were not received. Please try again.' });

  // Our own row first, then the charge. Square requires an idempotency key per
  // CreatePayment; a fresh UUID per attempt means a customer who retries after a decline
  // gets a genuinely new attempt, while Square itself dedups any retransmit of one attempt.
  const [ins] = await req.db.execute(
    `INSERT INTO payments (org_id, invoice_id, provider, amount, status)
     VALUES (?, ?, 'square', ?, 'pending')`,
    [req.orgId, invoice.id, invoice.amount]
  );
  const paymentRowId = ins.insertId;

  let payment;
  try {
    payment = await squareApi.createPayment(ctx.accessToken, {
      source_id: sourceId,
      idempotency_key: crypto.randomUUID(),
      amount_money: squareApi.money(invoice.amount),
      location_id: ctx.locationId,
      // What the seller sees against this payment in their Square dashboard.
      reference_id: `invoice-${invoice.id}`,
      note: `${invoice.type} invoice #${invoice.id}`.slice(0, 500),
    });
  } catch (err) {
    await req.db.execute(
      "UPDATE payments SET status = 'failed' WHERE id = ? AND org_id = ?",
      [paymentRowId, req.orgId]
    );
    if (err.name === 'SquareError') {
      console.error(`Square CreatePayment failed for invoice ${invoice.id}:`, err.message);
      // Square's detail strings are written for the cardholder ("Card declined", "CVV
      // incorrect"), so they can be shown as-is.
      const detail = err.errors?.[0]?.detail || 'The payment could not be completed.';
      return res.status(402).json({ error: detail });
    }
    throw err;
  }

  await req.db.execute(
    'UPDATE payments SET square_payment_id = ? WHERE id = ? AND org_id = ?',
    [payment.id, paymentRowId, req.orgId]
  );
  const result = await settleSquarePayment(req.orgId, payment);

  if (result.status === 'succeeded') {
    return res.json({ status: 'completed', nextStepsUrl: `${res.locals.basePath}/i/${req.params.token}/next-steps` });
  }
  if (result.status === 'failed') {
    return res.status(402).json({ error: 'The payment was declined.' });
  }
  // APPROVED/PENDING: the webhook will finish it. Tell the customer honestly.
  return res.json({ status: 'pending' });
}

module.exports = router;
