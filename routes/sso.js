'use strict';
// GET /sso/ledger?t=<token> — Connected Home Ledger single sign-on.
// Phase 3 of docs/adr/0001-multi-tenancy.md.
//
// This does NOT introduce a fourth principal type. It's a second way to establish the
// ordinary staff Passport session (req.login), so serializeUser/deserializeUser and every
// requireAuth check are untouched — which is what let this land without the {type,id}
// rework the subcontractor portal originally implied.

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../config/db');
const { verifyToken } = require('../services/ledgerSso');
const { findOrCreateOrg, findOrCreateUser } = require('../services/orgProvisioning');

// A handoff token is a bearer credential; rate-limit the endpoint so a leaked-token
// guessing attempt (or a redirect loop) can't hammer it.
const ssoLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });

function deny(res, status, message, detail) {
  return res.status(status).render('sso-error', {
    portalBranded: true, bodyClass: 'portal-page', pageScript: null,
    message, detail: detail || null,
  });
}

// Tokens live ~60s, so anything older than an hour can't be replayed anyway. Pruned here
// rather than on a cron — the table only grows on successful sign-ins.
async function pruneUsedTokens() {
  try {
    await db.execute('DELETE FROM sso_used_tokens WHERE used_at < DATE_SUB(NOW(), INTERVAL 1 HOUR)');
  } catch (err) {
    console.error('sso_used_tokens prune failed:', err.message);
  }
}

router.get('/ledger', ssoLimiter, async (req, res, next) => {
  try {
    const secret = process.env.LEDGER_SSO_SECRET;
    if (!secret) {
      console.error('SSO attempted but LEDGER_SSO_SECRET is not set');
      return deny(res, 503, 'Single sign-on is not configured on this server.');
    }

    const result = verifyToken(req.query.t, secret);
    if (!result.ok) {
      // Deliberately vague to the user; the reason goes to the log, not the page.
      console.warn('SSO token rejected:', result.reason);
      return deny(
        res, 400,
        'That sign-in link is not valid.',
        result.reason === 'expired'
          ? 'Sign-in links expire after a minute. Head back to Connected Home Ledger and click through again.'
          : 'Head back to Connected Home Ledger and click through again.'
      );
    }
    const payload = result.payload;

    // Single-use. The PRIMARY KEY on jti is what makes this atomic — a concurrent replay
    // loses the insert rather than racing a SELECT-then-INSERT.
    try {
      await db.execute('INSERT INTO sso_used_tokens (jti) VALUES (?)', [payload.jti]);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return deny(res, 400, 'That sign-in link has already been used.',
          'Head back to Connected Home Ledger and click through again.');
      }
      throw err;
    }

    const org = await findOrCreateOrg(payload);
    if (!org) {
      return deny(res, 403, 'CHO Hub isn’t included in your current plan.',
        'Add it from your Connected Home Ledger account, then click through again.');
    }
    if (org.status !== 'active') {
      return deny(res, 403, 'This workspace’s CHO Hub access is currently inactive.',
        'Your data is safe. Reactivate from Connected Home Ledger to get back in.');
    }

    const { user, reason } = await findOrCreateUser(org, payload);
    if (!user) {
      if (reason === 'deactivated') {
        return deny(res, 403, 'This staff account has been deactivated.',
          'An administrator on your team can re-enable it in CHO Hub under Settings → Users.');
      }
      return deny(res, 403, 'Could not sign you in to CHO Hub.');
    }

    await pruneUsedTokens();

    // Regenerate before establishing the session (fixation guard), matching the customer
    // and subcontractor magic-link flows.
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.login(user, (loginErr) => {
        if (loginErr) return next(loginErr);
        res.redirect(`${res.locals.basePath}/`);
      });
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
