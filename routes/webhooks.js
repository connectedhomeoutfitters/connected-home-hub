const express = require('express');
const router = express.Router();
const db = require('../config/db');
const stripe = require('../config/stripe');
const { sendMail } = require('../services/mailer');
const { reconcileRefunds } = require('../services/paymentsSync');

// Stripe requires the raw, unparsed body to verify the webhook signature.
router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // This webhook endpoint only gets registered for events CHO Hub cares about, but Stripe
  // fires payment_intent.succeeded for every PaymentIntent on the account — including
  // ConnectedHomeLedger's SaaS subscription charges, since both share one Stripe account.
  // Only act on PaymentIntents this app created (tagged in routes/portal.js).
  if (event.type === 'payment_intent.succeeded' && event.data.object.metadata?.source === 'cho-hub') {
    const intent = event.data.object;

    // Pull the charge so the Payments section can show "Visa ••••4242" + a receipt link
    // and the refund flow has a charge id cached — best-effort, a lookup failure must not
    // block marking the invoice paid.
    let chargeId = intent.latest_charge || null;
    let cardBrand = null, cardLast4 = null, receiptUrl = null;
    if (chargeId) {
      try {
        const charge = await stripe.charges.retrieve(chargeId);
        cardBrand = charge.payment_method_details?.card?.brand || null;
        cardLast4 = charge.payment_method_details?.card?.last4 || null;
        receiptUrl = charge.receipt_url || null;
      } catch (err) {
        console.error('Charge lookup failed (payment still reconciled):', err.message);
      }
    }

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute(
        `UPDATE payments SET status = 'succeeded', stripe_charge_id = ?, card_brand = ?,
           card_last4 = ?, receipt_url = ? WHERE stripe_payment_intent_id = ?`,
        [chargeId, cardBrand, cardLast4, receiptUrl, intent.id]
      );
      await conn.execute(
        "UPDATE invoices SET status = 'paid', paid_at = NOW() WHERE id = ?",
        [intent.metadata.invoice_id]
      );
      await conn.commit();

      const [invoiceRows] = await conn.execute(
        `SELECT i.*, c.name AS customer_name, c.email AS customer_email FROM invoices i
         JOIN customers c ON c.id = i.customer_id WHERE i.id = ?`,
        [intent.metadata.invoice_id]
      );
      const invoice = invoiceRows[0];
      if (invoice) {
        await sendMail({
          to: invoice.customer_email,
          subject: 'Payment received — Connected Home Outfitters',
          template: 'payment-receipt',
          data: { customerName: invoice.customer_name, amount: invoice.amount, invoiceType: invoice.type },
        });
      }
    } catch (err) {
      await conn.rollback();
      console.error('Failed to reconcile payment:', err);
    } finally {
      conn.release();
    }
  }

  // Refunds — whether issued from this app's admin UI or straight from the Stripe
  // dashboard. The charge object doesn't carry our PaymentIntent's metadata.source, so
  // instead of a metadata check reconcileRefunds() looks the charge up in our own
  // payments table: if it isn't one of ours (e.g. a ConnectedHomeLedger charge on the
  // shared account) it returns null and we ignore it. Idempotent, so re-delivery and the
  // admin route both landing here is harmless.
  if (event.type === 'charge.refunded') {
    const charge = event.data.object;
    try {
      await reconcileRefunds({ chargeId: charge.id, paymentIntentId: charge.payment_intent });
    } catch (err) {
      console.error('Failed to reconcile refund:', err.message);
    }
  }

  res.json({ received: true });
});

// Lead intake from choProject's WordPress site — the "FreeConsultForm" Elementor Pro
// form on /free-smart-home-consultation-form/, hooked via a custom
// elementor_pro/forms/new_record mu-plugin (see choProject's CLAUDE.md "Relationship
// to Connected Home Hub" section for the WordPress-side half). Auth is a shared secret
// rather than a signature scheme, since this is a low-stakes internal integration
// (unlike Stripe's webhook, nothing here moves money).
router.post('/lead-intake', express.json(), async (req, res) => {
  if (req.headers['x-cho-hub-secret'] !== process.env.LEAD_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Invalid secret' });
  }

  const { name, email, phone, property_address, home_size, home_type, interests,
    budget, timeline, additional_details, form_id, raw_fields } = req.body;
  if (!name || !email) {
    return res.status(400).json({ error: 'name and email are required' });
  }

  try {
    await db.execute(
      `INSERT INTO leads
        (name, email, phone, property_address, home_size, home_type, interests, budget,
         timeline, additional_details, source, raw_payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, email, phone || null, property_address || null, home_size || null,
        home_type || null, interests ? JSON.stringify(interests) : null, budget || null,
        timeline || null, additional_details || null, 'website',
        JSON.stringify({ form_id, raw_fields })]
    );
    res.json({ received: true });
  } catch (err) {
    console.error('Failed to save lead:', err);
    res.status(500).json({ error: 'Failed to save lead' });
  }
});

module.exports = router;
