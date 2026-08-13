'use strict';
// Resolves which tenant this request belongs to and hands routes a scoped database
// handle. See docs/adr/0001-multi-tenancy.md.
//
// Hub has four ways a request can arrive, and each learns its org differently:
//
//   staff Passport session   → req.user.org_id (loaded by deserializeUser)
//   customer portal session  → req.session.orgId, stamped at magic-link verify
//   subcontractor session    → req.session.orgId, stamped at magic-link verify
//   /e/:token, /i/:token     → no session at all; the token row carries org_id, so
//                              middleware/customerAccess.js calls attachOrg() once
//                              it has resolved the token.
//
// Anything with an org gets `req.db` — a scoped handle that refuses queries which
// don't constrain org_id. Requests without one (login page, static, webhooks) get
// req.db = null and must use config/db directly and deliberately.

const scopedDb = require('../config/scopedDb');

function attachOrg(req, orgId) {
  if (!Number.isInteger(orgId) || orgId <= 0) {
    throw new Error(`attachOrg: expected a positive integer orgId, got ${JSON.stringify(orgId)}`);
  }
  req.orgId = orgId;
  req.db = scopedDb(orgId);
  if (req.res) req.res.locals.orgId = orgId;
  return req.db;
}

function orgContext(req, res, next) {
  req.orgId = null;
  req.db = null;
  res.locals.orgId = null;

  const orgId = req.user?.org_id ?? req.session?.orgId ?? null;
  if (orgId) attachOrg(req, Number(orgId));

  next();
}

module.exports = orgContext;
module.exports.orgContext = orgContext;
module.exports.attachOrg = attachOrg;
