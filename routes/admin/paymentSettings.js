'use strict';
// Settings → Payments: the one page showing both processors and which is live.
// docs/adr/0003-payment-providers.md.
//
// The connect/disconnect legs live with their provider — routes/admin/stripeConnect.js and
// routes/admin/squareConnect.js — so each stays a faithful copy of that processor's OAuth
// flow. This router owns what's common: rendering the page and flipping the switch.
// Mounted at /admin/settings/payments, ahead of stripeConnect on the same path.

const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../../middleware/auth');
const { getOrgStripe } = require('../../services/stripeAccounts');
const squareAccounts = require('../../services/squareAccounts');
const squareApi = require('../../services/squareApi');
const activity = require('../../services/activityLog');

router.use(requireAuth, requireAdmin);

router.get('/', async (req, res, next) => {
  try {
    const stripeOrg = await getOrgStripe(req.orgId);
    const squareOrg = await squareAccounts.getOrgSquare(req.orgId);
    const squareConnected = squareAccounts.isConnected(squareOrg);

    // The location list is only fetched when there's a choice to make (or the admin asked
    // to change it), so the settings page doesn't hit Square on every load.
    let locations = null;
    if (squareConnected && (!squareOrg.square_location_id || req.query.change_location === '1')) {
      try {
        locations = await squareApi.listLocations(await squareAccounts.accessTokenFor(squareOrg));
      } catch (err) {
        console.error('Square location list failed:', err.message);
        locations = [];
      }
    }

    res.render('admin/settings-payments', {
      pageScript: null,
      provider: stripeOrg?.payment_provider || 'stripe',
      stripe: {
        org: stripeOrg,
        configured: !!process.env.STRIPE_CONNECT_CLIENT_ID,
        connected: !!stripeOrg?.stripe_account_id,
        isPlatform: !!stripeOrg?.uses_platform_stripe,
      },
      square: {
        org: squareOrg,
        configured: squareAccounts.isConfigured(),
        connected: squareConnected,
        hasLocation: !!squareOrg?.square_location_id,
        locations,
        env: squareApi.env(),
      },
      error: req.query.error || null,
      connected: req.query.connected || null,        // '1' (Stripe, legacy) | 'square'
      disconnected: req.query.disconnected || null,  // '1' | 'square'
      locationSaved: req.query.location === '1',
      providerSaved: req.query.provider === '1',
    });
  } catch (err) {
    next(err);
  }
});

// Flip which connected processor takes payments. Refuses a provider that isn't actually
// ready — the switch must never point at nowhere.
router.post('/provider', async (req, res, next) => {
  try {
    const choice = String(req.body.provider || '');
    const stripeOrg = await getOrgStripe(req.orgId);
    const squareOrg = await squareAccounts.getOrgSquare(req.orgId);

    const ready = choice === 'stripe'
      ? !!(stripeOrg?.stripe_account_id || stripeOrg?.uses_platform_stripe)
      : choice === 'square' && squareAccounts.canAcceptPayments(squareOrg);
    if (!ready) return res.redirect(`${res.locals.basePath}/admin/settings/payments?error=provider_not_ready`);

    if ((stripeOrg?.payment_provider || 'stripe') !== choice) {
      await req.db.execute('UPDATE orgs SET payment_provider = ? WHERE id = ?', [choice, req.orgId]);
      await activity.log({
        ...activity.staff(req), action: 'payments.provider_changed', entityType: 'org', entityId: req.orgId,
        detail: `Card payments now taken through ${choice === 'square' ? 'Square' : 'Stripe'}`,
      });
    }
    res.redirect(`${res.locals.basePath}/admin/settings/payments?provider=1`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
