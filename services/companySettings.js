// Loads a tenant's company_settings row with sensible fallbacks, so the estimate PDF and
// Terms & Conditions show the configured business name/address/tax ID instead of
// hardcoded values. Falls back to the legal name if a field is unset, so nothing breaks
// before Settings → Company is filled in.
//
// Was a single always-id=1 row; migration 030 made it one row per org, keyed by
// UNIQUE(org_id). See docs/adr/0001-multi-tenancy.md.
const scopedDb = require('../config/scopedDb');

const DEFAULT_NAME = 'Connected Home Outfitters LLC';

async function getCompany(orgId) {
  const db = scopedDb(orgId);
  const [rows] = await db.execute('SELECT * FROM company_settings WHERE org_id = ?', [orgId]);
  const s = rows[0] || {};
  const trimmed = (v) => (v && String(v).trim()) || null;
  return {
    company_name: trimmed(s.company_name) || DEFAULT_NAME,
    tax_id: trimmed(s.tax_id),
    address: trimmed(s.address),
    phone: trimmed(s.phone),
    email: trimmed(s.email),
    default_tax_percent: s.default_tax_percent != null ? s.default_tax_percent : 0,
  };
}

module.exports = { getCompany, DEFAULT_NAME };
