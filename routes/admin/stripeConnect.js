'use strict';
// Settings → Payments: connect / disconnect a tenant's own Stripe account.
// Phase 4 of docs/adr/0001-multi-tenancy.md.
//
// Standard OAuth flow: the contractor authorises our platform against their EXISTING
// Stripe account (most already have one), we store only the returned account id, and from
// then on their customers' payments settle to them. We never see or store their API keys.

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const stripe = require('../../config/stripe');
const { requireAuth, requireAdmin } = require('../../middleware/auth');
const { getOrgStripe, fetchAccountName } = require('../../services/stripeAccounts');
const activity = require('../../services/activityLog');

// Connecting or disconnecting decides where customer money lands — admins only, matching
// the gate on refunds and the rest of Settings.
router.use(requireAuth, requireAdmin);

const CONNECT_AUTHORIZE_URL = 'https://connect.stripe.com/oauth/authorize';

function settingsUrl(res, qs = '') {
  return `${res.locals.basePath}/admin/settings/payments${qs}`;
}

router.get('/', async (req, res, next) => {
  try {
    const org = await getOrgStripe(req.orgId);
    res.render('admin/settings-payments', {
      pageScript: null,
      org,
      configured: !!process.env.STRIPE_CONNECT_CLIENT_ID,
      connected: !!org?.stripe_account_id,
      isPlatform: !!org?.uses_platform_stripe,
      error: req.query.error || null,
      saved: req.query.connected === '1',
      disconnected: req.query.disconnected === '1',
    });
  } catch (err) {
    next(err);
  }
});

// Kick off OAuth. `state` is a one-time random value stored on the org and checked on the
// way back, so a forged callback can't bind someone else's Stripe account to this tenant.
router.post('/connect', async (req, res, next) => {
  try {
    const clientId = process.env.STRIPE_CONNECT_CLIENT_ID;
    if (!clientId) return res.redirect(settingsUrl(res, '?error=not_configured'));

    const org = await getOrgStripe(req.orgId);
    if (org?.uses_platform_stripe) return res.redirect(settingsUrl(res, '?error=platform_org'));

    const state = crypto.randomBytes(24).toString('hex');
    await req.db.execute('UPDATE orgs SET stripe_oauth_state = ? WHERE id = ?', [state, req.orgId]);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      scope: 'read_write',
      state,
      redirect_uri: `${(process.env.BASE_URL || '').replace(/\/$/, '')}${process.env.BASE_PATH || ''}/admin/settings/payments/callback`,
    });
    res.redirect(`${CONNECT_AUTHORIZE_URL}?${params.toString()}`);
  } catch (err) {
    next(err);
  }
});

// OAuth return leg. Exchanges the code for the connected account id.
router.get('/callback', async (req, res, next) => {
  try {
    if (req.query.error) {
      console.warn('Stripe Connect denied:', req.query.error, req.query.error_description || '');
      return res.redirect(settingsUrl(res, '?error=denied'));
    }

    const org = await getOrgStripe(req.orgId);
    const [[stateRow]] = await req.db.execute('SELECT stripe_oauth_state FROM orgs WHERE id = ?', [req.orgId]);
    const expected = stateRow?.stripe_oauth_state;

    // Single-use: clear it before doing anything else, so a replayed callback fails even
    // if the exchange below is slow.
    await req.db.execute('UPDATE orgs SET stripe_oauth_state = NULL WHERE id = ?', [req.orgId]);

    const provided = String(req.query.state || '');
    if (!expected || !provided || expected.length !== provided.length ||
        !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided))) {
      console.warn(`Stripe Connect callback with bad state for org ${req.orgId}`);
      return res.redirect(settingsUrl(res, '?error=bad_state'));
    }
    if (!req.query.code) return res.redirect(settingsUrl(res, '?error=no_code'));

    const token = await stripe.oauth.token({
      grant_type: 'authorization_code',
      code: String(req.query.code),
    });
    const accountId = token.stripe_user_id;
    if (!accountId) return res.redirect(settingsUrl(res, '?error=no_account'));

    // UNIQUE(stripe_account_id) stops the same Stripe account being bound to two tenants,
    // which would cross-post one contractor's payments into another's books.
    const [[clash]] = await req.db.execute(
      'SELECT id FROM orgs WHERE stripe_account_id = ? AND id <> ?',
      [accountId, req.orgId]
    );
    if (clash) {
      console.warn(`Stripe account ${accountId} already bound to org ${clash.id}`);
      return res.redirect(settingsUrl(res, '?error=already_linked'));
    }

    const name = await fetchAccountName(accountId);
    await req.db.execute(
      `UPDATE orgs SET stripe_account_id = ?, stripe_account_name = ?,
         stripe_connected_at = NOW() WHERE id = ?`,
      [accountId, name, req.orgId]
    );

    await activity.log({
      ...activity.staff(req), action: 'stripe.connected', entityType: 'org', entityId: req.orgId,
      detail: `Connected Stripe account ${accountId}${name ? ` (${name})` : ''}`,
    });

    res.redirect(settingsUrl(res, '?connected=1'));
  } catch (err) {
    // Stripe surfaces a readable message for an expired/reused code — show it rather than 500.
    if (err.type) {
      console.error('Stripe Connect exchange failed:', err.message);
      return res.redirect(settingsUrl(res, `?error=${encodeURIComponent(err.message.slice(0, 120))}`));
    }
    next(err);
  }
});

// Unlink. Deliberately only clears OUR reference — it does not deauthorize or touch their
// Stripe account, and it leaves existing payment/refund records intact so history and
// reporting still resolve. New payments simply stop until they reconnect.
router.post('/disconnect', async (req, res, next) => {
  try {
    const org = await getOrgStripe(req.orgId);
    if (!org?.stripe_account_id) return res.redirect(settingsUrl(res));

    await req.db.execute(
      `UPDATE orgs SET stripe_account_id = NULL, stripe_account_name = NULL,
         stripe_connected_at = NULL WHERE id = ?`,
      [req.orgId]
    );
    await activity.log({
      ...activity.staff(req), action: 'stripe.disconnected', entityType: 'org', entityId: req.orgId,
      detail: `Disconnected Stripe account ${org.stripe_account_id}`,
    });
    res.redirect(settingsUrl(res, '?disconnected=1'));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
