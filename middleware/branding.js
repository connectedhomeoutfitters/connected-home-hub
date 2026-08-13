'use strict';
// Puts the current tenant's identity (logo, accent colour, company name) on res.locals so
// the nav, portal header, and <head> can render it. Phase 2 of
// docs/adr/0001-multi-tenancy.md.
//
// Every page render needs this, so it's cached in-process for a short TTL rather than
// costing a query per request. The cache is busted explicitly when Settings → Company is
// saved, so an admin sees their change immediately; the TTL only matters for the other
// PM2 process(es) in a future clustered setup, and 60s of staleness on a logo is fine.

const { getCompany, DEFAULT_ACCENT } = require('../services/companySettings');

const TTL_MS = 60 * 1000;
const cache = new Map(); // orgId -> { value, expires }

async function brandingFor(orgId) {
  const hit = cache.get(orgId);
  if (hit && hit.expires > Date.now()) return hit.value;

  const company = await getCompany(orgId);
  const value = {
    companyName: company.company_name,
    logoPath: company.logo_path,
    accent: company.accent_color,
  };
  cache.set(orgId, { value, expires: Date.now() + TTL_MS });
  return value;
}

function bustBranding(orgId) {
  cache.delete(orgId);
}

// Anonymous requests (login page, landing, token-gated pages before resolveToken runs)
// get the built-in default, which is what CHO looked like before this existed.
const DEFAULTS = {
  companyName: null,
  logoPath: `${process.env.BASE_PATH || ''}/img/logo.png`,
  accent: DEFAULT_ACCENT,
};

async function branding(req, res, next) {
  res.locals.branding = DEFAULTS;
  if (!req.orgId) return next();
  try {
    res.locals.branding = await brandingFor(req.orgId);
  } catch (err) {
    // Branding must never take a page down — fall back to the default look.
    console.error('branding lookup failed:', err.message);
  }
  next();
}

module.exports = branding;
module.exports.branding = branding;
module.exports.bustBranding = bustBranding;
module.exports.brandingFor = brandingFor;
