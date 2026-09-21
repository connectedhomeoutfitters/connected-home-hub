'use strict';
// Which Square account a tenant's money moves through — the Square counterpart of
// services/stripeAccounts.js. docs/adr/0003-payment-providers.md.
//
// The shape differs from Stripe in one way that matters: Square gives us a per-merchant
// ACCESS TOKEN (30-day) plus a REFRESH TOKEN, rather than an account id we use with our
// own key. So we hold the tenant's tokens — sealed with services/secretBox.js, never in
// plaintext — and renew them before they lapse. A tenant that hasn't connected has no
// token and cannot take payment; there is no platform fallback (we have no Square account
// of our own to fall back to, and we wouldn't want one for the same reason as Stripe).

const db = require('../config/db');
const secretBox = require('./secretBox');
const squareApi = require('./squareApi');
const { forEachActiveOrg } = require('./orgs');

// Renew when this close to expiry. The daily cron uses the same window, so a token is
// normally renewed by the cron days before any request would have to do it inline.
const REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function isConfigured() {
  return squareApi.config().configured && secretBox.isConfigured();
}

// Unscoped on purpose: `orgs` is the tenant table itself, and the webhook path resolves an
// org with no session in hand.
async function getOrgSquare(orgId) {
  const [rows] = await db.execute(
    `SELECT id, name, payment_provider, square_merchant_id, square_merchant_name,
            square_location_id, square_location_name, square_access_token,
            square_refresh_token, square_token_expires_at, square_connected_at
       FROM orgs WHERE id = ?`,
    [orgId]
  );
  return rows[0] || null;
}

function isConnected(org) {
  return !!(org && org.square_merchant_id && org.square_access_token);
}

function canAcceptPayments(org) {
  return isConnected(org) && !!org.square_location_id && isConfigured();
}

async function storeTokens(orgId, tok) {
  await db.execute(
    `UPDATE orgs SET square_access_token = ?, square_refresh_token = ?,
       square_token_expires_at = ? WHERE id = ?`,
    [
      secretBox.seal(tok.access_token),
      tok.refresh_token ? secretBox.seal(tok.refresh_token) : null,
      tok.expires_at ? new Date(tok.expires_at) : null,
      orgId,
    ]
  );
}

// The decrypted access token for an org, renewing it first if it's near expiry. Returns
// null when the org isn't connected. A failed renewal falls back to the existing token —
// it may well still work, and the cron will retry tomorrow.
async function accessTokenFor(org) {
  if (!isConnected(org)) return null;
  const expires = org.square_token_expires_at ? new Date(org.square_token_expires_at).getTime() : 0;
  if (org.square_refresh_token && expires && expires - Date.now() < REFRESH_WINDOW_MS) {
    try {
      const tok = await squareApi.refreshToken(secretBox.open(org.square_refresh_token));
      await storeTokens(org.id, tok);
      return tok.access_token;
    } catch (err) {
      console.error(`squareAccounts: token refresh failed for org ${org.id}:`, err.message);
    }
  }
  return secretBox.open(org.square_access_token);
}

// Everything a request handler needs to charge on behalf of an org via Square.
async function squareContext(orgId) {
  const org = await getOrgSquare(orgId);
  const cfg = squareApi.config();
  const canAccept = canAcceptPayments(org);
  return {
    org,
    canAccept,
    accessToken: canAccept ? await accessTokenFor(org) : null,
    locationId: org?.square_location_id || null,
    merchantId: org?.square_merchant_id || null,
    applicationId: cfg.applicationId,
    sdkUrl: cfg.sdk,
    env: cfg.env,
  };
}

// Resolve an org from a webhook's `merchant_id`.
async function orgBySquareMerchant(merchantId) {
  if (!merchantId) return null;
  const [rows] = await db.execute('SELECT * FROM orgs WHERE square_merchant_id = ?', [merchantId]);
  return rows[0] || null;
}

// Daily cron: renew every connected tenant's token that lapses within the window. Each
// org is independent — one failure is logged and the sweep continues.
async function refreshExpiringTokens() {
  if (!isConfigured()) return { refreshed: 0, failed: 0 };
  let refreshed = 0, failed = 0;
  await forEachActiveOrg(async (_sdb, o) => {
    const org = await getOrgSquare(o.id);
    if (!isConnected(org) || !org.square_refresh_token) return;
    const expires = org.square_token_expires_at ? new Date(org.square_token_expires_at).getTime() : 0;
    if (expires && expires - Date.now() > REFRESH_WINDOW_MS) return;
    try {
      const tok = await squareApi.refreshToken(secretBox.open(org.square_refresh_token));
      await storeTokens(org.id, tok);
      refreshed++;
    } catch (err) {
      failed++;
      console.error(`squareAccounts: cron refresh failed for org ${org.id}:`, err.message);
    }
  }, 'square token refresh');
  if (refreshed || failed) console.log(`Square token refresh: ${refreshed} renewed, ${failed} failed`);
  return { refreshed, failed };
}

module.exports = {
  isConfigured, getOrgSquare, isConnected, canAcceptPayments, accessTokenFor,
  squareContext, orgBySquareMerchant, storeTokens, refreshExpiringTokens,
};
