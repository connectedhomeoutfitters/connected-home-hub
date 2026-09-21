'use strict';
// Settings → Payments → Square: connect / disconnect a tenant's own Square account.
// docs/adr/0003-payment-providers.md. Mirrors routes/admin/stripeConnect.js step for step;
// the differences are Square's, not ours:
//
//   - the OAuth exchange returns per-merchant ACCESS + REFRESH tokens, which we must keep
//     (sealed — services/secretBox.js) and renew (services/squareAccounts.js), where
//     Stripe returns an account id we use with our own key;
//   - every payment is taken at a LOCATION, so we also pick one after connecting.
//
// Mounted at /admin/settings/payments/square.

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requireAuth, requireAdmin } = require('../../middleware/auth');
const squareApi = require('../../services/squareApi');
const squareAccounts = require('../../services/squareAccounts');
const secretBox = require('../../services/secretBox');
const activity = require('../../services/activityLog');

// Connecting or disconnecting decides where customer money lands — admins only, matching
// the gate on refunds and the rest of Settings.
router.use(requireAuth, requireAdmin);

function settingsUrl(res, qs = '') {
  return `${res.locals.basePath}/admin/settings/payments${qs}`;
}

// Kick off OAuth. `state` is a one-time random value stored on the org and checked on the
// way back, so a forged callback can't bind someone else's Square account to this tenant.
router.post('/connect', async (req, res, next) => {
  try {
    if (!squareAccounts.isConfigured()) return res.redirect(settingsUrl(res, '?error=square_not_configured'));

    const state = crypto.randomBytes(24).toString('hex');
    await req.db.execute('UPDATE orgs SET square_oauth_state = ? WHERE id = ?', [state, req.orgId]);
    res.redirect(squareApi.authorizeUrl({ state }));
  } catch (err) {
    next(err);
  }
});

// OAuth return leg. Exchanges the code for the merchant's tokens, then reads the business
// name and locations so Settings can show something better than a bare merchant id.
router.get('/callback', async (req, res, next) => {
  try {
    if (req.query.error) {
      console.warn('Square OAuth denied:', req.query.error, req.query.error_description || '');
      return res.redirect(settingsUrl(res, '?error=denied'));
    }

    const [[stateRow]] = await req.db.execute('SELECT square_oauth_state FROM orgs WHERE id = ?', [req.orgId]);
    const expected = stateRow?.square_oauth_state;

    // Single-use: clear it before doing anything else, so a replayed callback fails even
    // if the exchange below is slow.
    await req.db.execute('UPDATE orgs SET square_oauth_state = NULL WHERE id = ?', [req.orgId]);

    const provided = String(req.query.state || '');
    if (!expected || !provided || expected.length !== provided.length ||
        !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided))) {
      console.warn(`Square OAuth callback with bad state for org ${req.orgId}`);
      return res.redirect(settingsUrl(res, '?error=bad_state'));
    }
    if (!req.query.code) return res.redirect(settingsUrl(res, '?error=no_code'));

    const tok = await squareApi.obtainToken(String(req.query.code));
    const merchantId = tok.merchant_id;
    if (!merchantId || !tok.access_token) return res.redirect(settingsUrl(res, '?error=no_account'));

    // UNIQUE(square_merchant_id) stops the same Square account being bound to two
    // tenants, which would cross-post one contractor's payments into another's books.
    const [[clash]] = await req.db.execute(
      'SELECT id FROM orgs WHERE square_merchant_id = ? AND id <> ?',
      [merchantId, req.orgId]
    );
    if (clash) {
      console.warn(`Square merchant ${merchantId} already bound to org ${clash.id}`);
      return res.redirect(settingsUrl(res, '?error=already_linked'));
    }

    // Best-effort display details. A failure here must not fail the connection itself.
    let merchantName = null, locations = [];
    try {
      const m = await squareApi.getMerchant(tok.access_token, merchantId);
      merchantName = m?.business_name || null;
      locations = await squareApi.listLocations(tok.access_token);
    } catch (err) {
      console.error('Square merchant/location lookup failed (connection kept):', err.message);
    }
    // One active location is the common case — use it. Several: leave unset and let the
    // admin choose on the settings page; payments stay paused until they do.
    const loc = locations.length === 1 ? locations[0] : null;

    await req.db.execute(
      `UPDATE orgs SET square_merchant_id = ?, square_merchant_name = ?,
         square_location_id = ?, square_location_name = ?,
         square_access_token = ?, square_refresh_token = ?, square_token_expires_at = ?,
         square_connected_at = NOW(), payment_provider = 'square'
       WHERE id = ?`,
      [
        merchantId, merchantName,
        loc ? loc.id : null, loc ? loc.name : null,
        secretBox.seal(tok.access_token),
        tok.refresh_token ? secretBox.seal(tok.refresh_token) : null,
        tok.expires_at ? new Date(tok.expires_at) : null,
        req.orgId,
      ]
    );

    await activity.log({
      ...activity.staff(req), action: 'square.connected', entityType: 'org', entityId: req.orgId,
      detail: `Connected Square account ${merchantId}${merchantName ? ` (${merchantName})` : ''}`,
    });

    res.redirect(settingsUrl(res, loc ? '?connected=square' : '?connected=square&pick_location=1'));
  } catch (err) {
    if (err.name === 'SquareError') {
      console.error('Square OAuth exchange failed:', err.message);
      return res.redirect(settingsUrl(res, `?error=${encodeURIComponent(err.message.slice(0, 120))}`));
    }
    next(err);
  }
});

// Choose (or change) the location payments are taken at.
router.post('/location', async (req, res, next) => {
  try {
    const org = await squareAccounts.getOrgSquare(req.orgId);
    if (!squareAccounts.isConnected(org)) return res.redirect(settingsUrl(res));
    const token = await squareAccounts.accessTokenFor(org);
    const locations = await squareApi.listLocations(token);
    const chosen = locations.find((l) => l.id === String(req.body.location_id || ''));
    if (!chosen) return res.redirect(settingsUrl(res, '?error=bad_location'));

    await req.db.execute(
      'UPDATE orgs SET square_location_id = ?, square_location_name = ? WHERE id = ?',
      [chosen.id, chosen.name, req.orgId]
    );
    res.redirect(settingsUrl(res, '?location=1'));
  } catch (err) {
    next(err);
  }
});

// Unlink. Revokes our authorisation at Square (best-effort — the seller can also do it
// from their own dashboard) and clears every token we held. Existing payment/refund rows
// stay intact so history and reporting still resolve. If this was the active provider,
// payments pause until Stripe is connected or Square is reconnected — never a silent
// fallback to somewhere else.
router.post('/disconnect', async (req, res, next) => {
  try {
    const org = await squareAccounts.getOrgSquare(req.orgId);
    if (!squareAccounts.isConnected(org)) return res.redirect(settingsUrl(res));

    try {
      await squareApi.revokeMerchant(org.square_merchant_id);
    } catch (err) {
      console.error('Square revoke failed (tokens cleared anyway):', err.message);
    }

    await req.db.execute(
      `UPDATE orgs SET square_merchant_id = NULL, square_merchant_name = NULL,
         square_location_id = NULL, square_location_name = NULL,
         square_access_token = NULL, square_refresh_token = NULL,
         square_token_expires_at = NULL, square_connected_at = NULL,
         payment_provider = 'stripe'
       WHERE id = ?`,
      [req.orgId]
    );
    await activity.log({
      ...activity.staff(req), action: 'square.disconnected', entityType: 'org', entityId: req.orgId,
      detail: `Disconnected Square account ${org.square_merchant_id}`,
    });
    res.redirect(settingsUrl(res, '?disconnected=square'));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
