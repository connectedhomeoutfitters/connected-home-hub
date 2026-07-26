// Loads the single company_settings row (id=1) with sensible fallbacks, so the estimate
// PDF and Terms & Conditions show the configured business name/address/tax ID instead of
// hardcoded values. Falls back to the legal name if a field is unset, so nothing breaks
// before Settings → Company is filled in.
const db = require('../config/db');

const DEFAULT_NAME = 'Connected Home Outfitters LLC';

async function getCompany() {
  const [rows] = await db.execute('SELECT * FROM company_settings WHERE id = 1');
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
