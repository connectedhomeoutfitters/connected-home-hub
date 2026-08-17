'use strict';
// Which terms & conditions an estimate carries, and — more importantly — which ones it
// CARRIED when the customer signed.
//
// Three layers, checked in order:
//   1. estimates.terms_snapshot — the exact text presented, frozen at send. Once this
//      exists it always wins. Editing a template afterwards must never change what a
//      customer already agreed to, or the signed record is worthless as evidence.
//   2. the chosen terms_templates row, or the org's default template.
//   3. config/estimateTerms.js — the built-in text, which also handles
//      company_settings.terms_override for orgs that never adopt templates.
//
// Layer 3 is why nothing changes for an existing tenant until they choose to use this.

const estimateTerms = require('../config/estimateTerms');

async function listTemplates(db, orgId, { includeInactive = false } = {}) {
  const [rows] = await db.execute(
    `SELECT id, name, body, is_default, active
       FROM terms_templates
      WHERE org_id = ?${includeInactive ? '' : ' AND active = 1'}
      ORDER BY is_default DESC, name`,
    [orgId]
  );
  return rows;
}

async function getTemplate(db, orgId, id) {
  if (!id) return null;
  const [[row]] = await db.execute(
    'SELECT id, name, body, is_default, active FROM terms_templates WHERE id = ? AND org_id = ?',
    [id, orgId]
  );
  return row || null;
}

async function defaultTemplate(db, orgId) {
  const [[row]] = await db.execute(
    `SELECT id, name, body FROM terms_templates
      WHERE org_id = ? AND active = 1
      ORDER BY is_default DESC, id
      LIMIT 1`,
    [orgId]
  );
  return row || null;
}

// The HTML to show the customer. `company` comes from services/companySettings.js.
//
// A template body is tenant-authored, so it goes through the same escaping the built-in
// applies to terms_override — it reaches the page through `<%- terms %>`, and rendering it
// raw would let an org admin inject script into their own customers' estimate pages.
async function renderTermsFor(db, orgId, estimate, company) {
  if (estimate && estimate.terms_snapshot && String(estimate.terms_snapshot).trim()) {
    return { html: wrap(company.company_name, estimate.terms_snapshot), source: 'snapshot' };
  }

  const tpl = estimate && estimate.terms_template_id
    ? await getTemplate(db, orgId, estimate.terms_template_id)
    : await defaultTemplate(db, orgId);

  if (tpl && String(tpl.body).trim()) {
    return { html: wrap(company.company_name, tpl.body), source: 'template', templateId: tpl.id };
  }

  return { html: estimateTerms(company.company_name, company.terms_override), source: 'builtin' };
}

// The plain text to freeze onto an estimate when it is sent. Returns null when the org is
// still on the built-in terms — there is nothing tenant-specific worth snapshotting, and
// config/estimateTerms.js reproduces it deterministically from the company name.
async function snapshotBodyFor(db, orgId, templateId) {
  const tpl = templateId ? await getTemplate(db, orgId, templateId) : await defaultTemplate(db, orgId);
  return tpl && String(tpl.body).trim() ? String(tpl.body).trim() : null;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Mirrors the override branch of config/estimateTerms.js so template-based terms and
// override-based terms look identical to the customer.
function wrap(companyName, body) {
  const co = (companyName && String(companyName).trim()) || 'Your Company';
  return `<h5>${escapeHtml(co)}</h5>
<h6 class="mt-3">Estimate Terms &amp; Conditions</h6>
<div style="white-space: pre-wrap;">${escapeHtml(String(body).trim())}</div>`;
}

module.exports = { listTemplates, getTemplate, defaultTemplate, renderTermsFor, snapshotBodyFor };
