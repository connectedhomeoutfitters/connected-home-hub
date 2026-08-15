// Loads a tenant's company_settings row with sensible fallbacks, so the estimate PDF,
// Terms & Conditions, emails and page chrome show the configured business identity
// instead of hardcoded Connected Home Outfitters values.
//
// Was a single always-id=1 row; migration 030 made it one row per org keyed by
// UNIQUE(org_id), and 034 added the branding fields. See docs/adr/0001-multi-tenancy.md.
const path = require('path');
const scopedDb = require('../config/scopedDb');

// Last-resort only. Any org that has not filled in Settings -> Company should fall back
// to its OWN name (see getCompany), never to another tenant's — this string exists purely
// so something renders if even the orgs row has no name.
const DEFAULT_NAME = 'Your Company';
const DEFAULT_ACCENT = '#0799D6'; // matches :root --cho-accent in app.css / portal.css

const BASE_PATH = process.env.BASE_PATH || '';
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');

// Where an uploaded logo lives on disk. Org-keyed by nature, so no id collision.
const LOGO_ROOT = path.join(__dirname, '..', 'uploads', 'logos');
const logoDir = (orgId) => path.join(LOGO_ROOT, String(orgId));

// Guard against a malformed value reaching a stylesheet — anything that isn't a plain
// hex colour is ignored rather than interpolated into CSS.
function safeAccent(value) {
  return /^#[0-9a-fA-F]{6}$/.test(String(value || '')) ? String(value) : null;
}

async function getCompany(orgId) {
  const db = scopedDb(orgId);
  // Joined to orgs so an org with no settings row still falls back to its own name.
  // Provisioning seeds company_name now, but orgs created before that (and the throwaway
  // test tenants) have no row, and rendering a rival contractor's name on their customer
  // documents is the worst possible default.
  const [rows] = await db.execute(
    `SELECT cs.*, o.name AS org_name
       FROM orgs o
       LEFT JOIN company_settings cs ON cs.org_id = o.id
      WHERE o.id = ?`,
    [orgId]
  );
  const s = rows[0] || {};
  const trimmed = (v) => (v && String(v).trim()) || null;

  // A tenant with no uploaded logo falls back to the built-in asset, which keeps CHO
  // looking exactly as it did before this migration.
  const logoPath = s.logo_filename
    ? `${BASE_PATH}/branding/${orgId}/logo`
    : `${BASE_PATH}/img/logo.png`;

  return {
    org_id: orgId,
    company_name: trimmed(s.company_name) || trimmed(s.org_name) || DEFAULT_NAME,
    tax_id: trimmed(s.tax_id),
    address: trimmed(s.address),
    phone: trimmed(s.phone),
    email: trimmed(s.email),
    website: trimmed(s.website),
    license_number: trimmed(s.license_number),
    email_reply_to: trimmed(s.email_reply_to) || trimmed(s.email),
    terms_override: trimmed(s.terms_override),
    default_tax_percent: s.default_tax_percent != null ? s.default_tax_percent : 0,

    accent_color: safeAccent(s.accent_color) || DEFAULT_ACCENT,
    logo_filename: trimmed(s.logo_filename),
    // Relative for pages, absolute for anything rendered outside the browser session
    // (email clients and the PDF have no notion of basePath).
    logo_path: logoPath,
    logo_url: `${BASE_URL}${logoPath}`,
    // Null when the tenant hasn't uploaded one — callers fall back to the bundled asset.
    logo_file: s.logo_filename ? path.join(logoDir(orgId), s.logo_filename) : null,
  };
}

module.exports = { getCompany, DEFAULT_NAME, DEFAULT_ACCENT, LOGO_ROOT, logoDir, safeAccent };
