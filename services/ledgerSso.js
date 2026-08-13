'use strict';
// Signed handoff tokens for Connected Home Ledger → CHO Hub SSO.
// Phase 3 of docs/adr/0001-multi-tenancy.md.
//
// THIS FILE IS MIRRORED IN LEDGER at N:\gymrProject\services\hubSso.js — Ledger signs,
// Hub verifies. Keep the two byte-identical apart from the header comment; a change to
// the payload shape or the signing string must land in both at once or every handoff
// breaks.
//
// Deliberately dependency-free (HMAC-SHA256 over a base64url JSON payload) rather than a
// JWT library: this is a two-party, same-owner handshake with a shared secret, and both
// apps' briefs favour not adding dependencies for small jobs.
//
//   token = b64url(payloadJSON) + '.' + b64url(HMAC-SHA256(secret, b64url(payloadJSON)))
//
// The token is a bearer credential valid for ~60s. It rides in a URL, so it WILL end up in
// browser history and possibly a referrer header — hence the short TTL and the single-use
// jti check on the Hub side (sso_used_tokens).

const crypto = require('crypto');

const TOKEN_VERSION = 1;
const DEFAULT_TTL_SECONDS = 60;

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const unb64url = (str) => Buffer.from(
  String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64'
);

function sign(body, secret) {
  return b64url(crypto.createHmac('sha256', secret).update(body).digest());
}

/**
 * Build a handoff token. Called by Ledger.
 * @param {object} claims - ledgerUserId, workspaceId, workspaceName, email, name, plan, hubEntitled
 * @param {string} secret - LEDGER_SSO_SECRET, shared with Hub
 * @param {number} [ttlSeconds]
 */
function createToken(claims, secret, ttlSeconds = DEFAULT_TTL_SECONDS) {
  if (!secret) throw new Error('ledgerSso: signing secret is required');
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: TOKEN_VERSION,
    jti: crypto.randomBytes(16).toString('hex'),
    iat: now,
    exp: now + ttlSeconds,
    ledgerUserId: claims.ledgerUserId,
    workspaceId: claims.workspaceId,
    workspaceName: claims.workspaceName || null,
    email: (claims.email || '').toLowerCase(),
    name: claims.name || null,
    plan: claims.plan || null,
    // Entitlement policy lives in Ledger, which owns billing — Hub just honours this.
    hubEntitled: !!claims.hubEntitled,
  };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body, secret)}`;
}

/**
 * Verify and decode a handoff token. Called by Hub.
 * Returns { ok: true, payload } or { ok: false, reason }.
 * Does NOT check single-use — that's a DB concern (see routes/sso.js).
 */
function verifyToken(token, secret, { now = Math.floor(Date.now() / 1000) } = {}) {
  if (!secret) return { ok: false, reason: 'no_secret_configured' };
  if (typeof token !== 'string' || !token.includes('.')) return { ok: false, reason: 'malformed' };

  const idx = token.indexOf('.');
  const body = token.slice(0, idx);
  const providedSig = token.slice(idx + 1);
  if (!body || !providedSig) return { ok: false, reason: 'malformed' };

  // Timing-safe compare; timingSafeEqual throws on length mismatch, so guard that first.
  const expectedSig = sign(body, secret);
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload;
  try {
    payload = JSON.parse(unb64url(body).toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (payload.v !== TOKEN_VERSION) return { ok: false, reason: 'bad_version' };
  if (typeof payload.exp !== 'number' || payload.exp < now) return { ok: false, reason: 'expired' };
  // Guard against a wildly future-dated token (clock skew or a forged iat).
  if (typeof payload.iat !== 'number' || payload.iat > now + 300) return { ok: false, reason: 'not_yet_valid' };
  if (!payload.jti) return { ok: false, reason: 'malformed' };
  if (!payload.workspaceId) return { ok: false, reason: 'missing_workspace' };
  if (!payload.email) return { ok: false, reason: 'missing_email' };

  return { ok: true, payload };
}

module.exports = { createToken, verifyToken, TOKEN_VERSION, DEFAULT_TTL_SECONDS };
