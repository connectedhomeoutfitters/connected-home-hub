const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../config/db');
const scopedDb = require('../config/scopedDb');
const stripe = require('../config/stripe');
const { setEntitlement } = require('../services/orgProvisioning');
const { paymentContext } = require('../services/stripeAccounts');
const { pushPaidInvoice } = require('../services/ledgerSync');
const { sendMail } = require('../services/mailer');
const { getCompany } = require('../services/companySettings');
const { reconcileRefunds } = require('../services/paymentsSync');
const activity = require('../services/activityLog');

// Webhooks arrive with no session, so there is no req.db here. Each handler resolves its
// own tenant first — from the row the event refers to — and then works through a scoped
// handle. The unscoped lookups below are deliberate and are the only ones in this file.
// See docs/adr/0001-multi-tenancy.md.

// Two Stripe webhook endpoints point at this one URL, and each has its OWN signing secret:
//
//   STRIPE_WEBHOOK_SECRET          — the account endpoint: events on the platform account,
//                                    i.e. Connected Home Outfitters' own charges (org 1).
//   STRIPE_CONNECT_WEBHOOK_SECRET  — the Connect endpoint: events on CONNECTED accounts,
//                                    i.e. every other tenant's charges. These arrive with
//                                    `event.account` set.
//
// Two endpoints are required rather than one, because a webhook's `connect` flag is
// IMMUTABLE after creation — an existing account-only endpoint can't be upgraded to also
// deliver connected-account events. So we try each secret in turn. Every event is still
// fully signature-verified; we just don't know which endpoint delivered it until one
// secret validates. An unset Connect secret simply means Connect events aren't expected yet.
function verifyStripeEvent(rawBody, signature) {
  const secrets = [
    process.env.STRIPE_WEBHOOK_SECRET,
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET,
  ].filter(Boolean);

  let lastError = null;
  for (const secret of secrets) {
    try {
      return { event: stripe.webhooks.constructEvent(rawBody, signature, secret), error: null };
    } catch (err) {
      lastError = err;
    }
  }
  return { event: null, error: lastError || new Error('No webhook signing secret configured') };
}

// Stripe requires the raw, unparsed body to verify the webhook signature.
router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const { event, error } = verifyStripeEvent(req.body, req.headers['stripe-signature']);
  if (!event) {
    console.error('Webhook signature verification failed:', error.message);
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }

  // This webhook endpoint only gets registered for events CHO Hub cares about, but Stripe
  // fires payment_intent.succeeded for every PaymentIntent on the account — including
  // ConnectedHomeLedger's SaaS subscription charges, since both share one Stripe account.
  // Only act on PaymentIntents this app created (tagged in routes/portal.js).
  if (event.type === 'payment_intent.succeeded' && event.data.object.metadata?.source === 'cho-hub') {
    const intent = event.data.object;

    // Which tenant does this belong to? New PaymentIntents carry org_id in metadata;
    // fall back to looking the payment row up by intent id for any created before that
    // was added. Either way the payments row is authoritative.
    const [payRows] = await db.execute(
      'SELECT id, org_id FROM payments WHERE stripe_payment_intent_id = ?',
      [intent.id]
    );
    const orgId = payRows[0]?.org_id ?? (intent.metadata?.org_id ? Number(intent.metadata.org_id) : null);
    if (!orgId) {
      console.error('payment_intent.succeeded for an unknown payment:', intent.id);
      return res.json({ received: true });
    }

    // Cross-check against the delivering account. A Connect event carries `event.account`;
    // a platform-account event has none. If they disagree with what our own row says, the
    // routing is misconfigured somewhere and we must NOT reconcile — marking the wrong
    // tenant's invoice paid is worse than not marking it at all.
    const { org: stripeOrg } = await paymentContext(orgId);
    const expectedAccount = stripeOrg && !stripeOrg.uses_platform_stripe
      ? stripeOrg.stripe_account_id : null;
    if ((event.account || null) !== expectedAccount) {
      console.error(
        `Webhook account mismatch for payment intent ${intent.id}: event.account=` +
        `${event.account || '(platform)'} but org ${orgId} expects ${expectedAccount || '(platform)'}`
      );
      return res.json({ received: true, ignored: 'account_mismatch' });
    }

    const sdb = scopedDb(orgId);

    // Pull the charge so the Payments section can show "Visa ••••4242" + a receipt link
    // and the refund flow has a charge id cached — best-effort, a lookup failure must not
    // block marking the invoice paid.
    let chargeId = intent.latest_charge || null;
    let cardBrand = null, cardLast4 = null, receiptUrl = null;
    if (chargeId) {
      try {
        // Scoped to the org's Stripe account — a connected tenant's charge isn't visible
        // on the platform account, so an unscoped retrieve would 404.
        //
        // NOTE the empty params object: the SDK signature is retrieve(id, params, options),
        // NOT retrieve(id, options). Passing options second sends { stripeAccount } as a
        // QUERY PARAM and Stripe rejects it with "Received unknown parameter:
        // stripeAccount". create(params, options) takes options second, which is why the
        // charge-creation path worked and this one didn't.
        const { options } = await paymentContext(orgId);
        const charge = await stripe.charges.retrieve(chargeId, {}, options);
        cardBrand = charge.payment_method_details?.card?.brand || null;
        cardLast4 = charge.payment_method_details?.card?.last4 || null;
        receiptUrl = charge.receipt_url || null;
      } catch (err) {
        console.error('Charge lookup failed (payment still reconciled):', err.message);
      }
    }

    const conn = await sdb.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute(
        `UPDATE payments SET status = 'succeeded', stripe_charge_id = ?, card_brand = ?,
           card_last4 = ?, receipt_url = ? WHERE stripe_payment_intent_id = ? AND org_id = ?`,
        [chargeId, cardBrand, cardLast4, receiptUrl, intent.id, orgId]
      );
      // `AND status <> 'paid'` makes this the idempotency latch for the whole handler:
      // affectedRows is 1 only on the transition to paid, so a redelivered event (Stripe
      // retries, or two endpoints pointing at this URL) can't send the customer a second
      // receipt or log a duplicate activity entry. The payments UPDATE above is naturally
      // idempotent, so it stays unconditional.
      const [invUpdate] = await conn.execute(
        "UPDATE invoices SET status = 'paid', paid_at = NOW() WHERE id = ? AND org_id = ? AND status <> 'paid'",
        [intent.metadata.invoice_id, orgId]
      );
      await conn.commit();

      const firstTime = invUpdate.affectedRows === 1;
      if (!firstTime) {
        console.log(`payment_intent.succeeded for already-paid invoice ${intent.metadata.invoice_id} — skipping receipt`);
      }

      const [invoiceRows] = firstTime ? await conn.execute(
        `SELECT i.*, c.name AS customer_name, c.email AS customer_email FROM invoices i
         JOIN customers c ON c.id = i.customer_id AND c.org_id = i.org_id
         WHERE i.id = ? AND i.org_id = ?`,
        [intent.metadata.invoice_id, orgId]
      ) : [[]];
      const invoice = invoiceRows[0];
      if (invoice) {
        await activity.log({
          orgId, actorType: 'system', action: 'invoice.paid', entityType: 'invoice', entityId: invoice.id,
          customerId: invoice.customer_id, detail: `Payment of $${invoice.amount} received (${invoice.type})`,
        });
        const company = await getCompany(orgId);
        await sendMail({
          orgId,
          to: invoice.customer_email,
          subject: `Payment received — ${company.company_name}`,
          template: 'payment-receipt',
          data: { customerName: invoice.customer_name, amount: invoice.amount, invoiceType: invoice.type },
        });

        // Post the income into the tenant's Connected Home Ledger books. Deliberately NOT
        // awaited: Ledger being slow or down must not delay (or fail) reconciling a
        // payment here. It swallows its own errors, and an unsynced invoice is
        // recoverable via ledgerSync.backfillOrg(). Sits inside the `firstTime` branch, so
        // it inherits the same idempotency latch as the receipt email.
        pushPaidInvoice(orgId, invoice.id);
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
  // shared account) it returns null and we ignore it. That same lookup is what resolves
  // the tenant. Idempotent, so re-delivery and the admin route both landing here is
  // harmless.
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

// Lead intake from a tenant's WordPress site. For Connected Home Outfitters this is the
// "FreeConsultForm" Elementor Pro form on /free-smart-home-consultation-form/, hooked via
// a custom elementor_pro/forms/new_record mu-plugin (see choProject's CLAUDE.md
// "Relationship to Connected Home Hub" section for the WordPress-side half). Auth is a
// shared secret rather than a signature scheme, since this is a low-stakes internal
// integration (unlike Stripe's webhook, nothing here moves money).
//
// The secret now identifies the tenant: each org gets its own orgs.lead_webhook_secret.
// The legacy LEAD_WEBHOOK_SECRET env var still resolves to org 1 so CHO's existing
// WordPress plugin keeps working without being re-keyed.
async function orgFromLeadSecret(secret) {
  if (!secret) return null;
  const [rows] = await db.execute(
    "SELECT id FROM orgs WHERE lead_webhook_secret = ? AND status = 'active'",
    [secret]
  );
  if (rows[0]) return rows[0].id;
  if (process.env.LEAD_WEBHOOK_SECRET && secret === process.env.LEAD_WEBHOOK_SECRET) return 1;
  return null;
}

// Entitlement push from Connected Home Ledger. Ledger owns billing, so when a
// subscription changes there (upgrade, downgrade, cancel, payment failure) it tells Hub,
// and Hub flips the org's status. Without this a cancelled customer would keep full
// access until their next SSO handshake.
//
// Auth is the same shared secret used to sign SSO tokens — a timing-safe compare rather
// than `!==`, since unlike the lead webhook this one is reachable from the internet and
// controls access. Suspending never deletes anything: the org's data stays put so a
// customer who resubscribes finds it waiting.
router.post('/ledger-entitlement', express.json(), async (req, res) => {
  const secret = process.env.LEDGER_SSO_SECRET;
  const provided = req.headers['x-ledger-secret'];
  if (!secret || typeof provided !== 'string') return res.status(401).json({ error: 'Unauthorized' });

  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { workspace_id: workspaceId, hub_entitled: hubEntitled, plan } = req.body || {};
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id is required' });

  try {
    const orgId = await setEntitlement(workspaceId, { hubEntitled: !!hubEntitled, plan });
    // A workspace Hub has never seen isn't an error — the customer simply hasn't clicked
    // through yet, and the SSO handshake will provision them with current entitlement.
    if (!orgId) return res.json({ received: true, matched: false });
    console.log(`Ledger entitlement: workspace ${workspaceId} -> org ${orgId}, entitled=${!!hubEntitled}, plan=${plan || 'none'}`);
    res.json({ received: true, matched: true, org_id: orgId });
  } catch (err) {
    console.error('Failed to apply Ledger entitlement:', err);
    res.status(500).json({ error: 'Failed to apply entitlement' });
  }
});

router.post('/lead-intake', express.json(), async (req, res) => {
  const orgId = await orgFromLeadSecret(req.headers['x-cho-hub-secret']);
  if (!orgId) return res.status(401).json({ error: 'Invalid secret' });

  const { name, email, phone, property_address, home_size, home_type, interests,
    budget, timeline, additional_details, form_id, raw_fields } = req.body;
  if (!name || !email) {
    return res.status(400).json({ error: 'name and email are required' });
  }

  try {
    await scopedDb(orgId).execute(
      `INSERT INTO leads
        (org_id, name, email, phone, property_address, home_size, home_type, interests, budget,
         timeline, additional_details, source, raw_payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [orgId, name, email, phone || null, property_address || null, home_size || null,
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
// Exported for test/stripeWebhookAuth.test.js — this decides whether a payment event is
// trusted, so it's worth covering directly rather than only through the route.
module.exports.verifyStripeEvent = verifyStripeEvent;
