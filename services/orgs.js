// services/orgs.js — tenant lookup helpers.
//
// `orgs` is a global (non-tenant) table, so it is read through the plain pool rather than
// a scoped handle — there is no org context to scope by when the whole point is to find
// out which orgs exist. See docs/adr/0001-multi-tenancy.md.
const db = require('../config/db');
const scopedDb = require('../config/scopedDb');

async function listActiveOrgs() {
  const [rows] = await db.execute(
    "SELECT id, name, slug, stripe_account_id FROM orgs WHERE status = 'active' ORDER BY id"
  );
  return rows;
}

async function getOrg(orgId) {
  const [rows] = await db.execute('SELECT * FROM orgs WHERE id = ?', [orgId]);
  return rows[0] || null;
}

// Runs `fn(scopedHandle, org)` once per active tenant. Used by the nightly/hourly cron
// jobs, which are the only code paths that legitimately sweep every org. A failure in one
// tenant is logged and skipped so it can't stop the sweep for everyone else.
async function forEachActiveOrg(fn, label = 'org sweep') {
  const orgs = await listActiveOrgs();
  let total = 0;
  for (const org of orgs) {
    try {
      total += (await fn(scopedDb(org.id), org)) || 0;
    } catch (err) {
      console.error(`${label} failed for org ${org.id} (${org.slug}):`, err.message);
    }
  }
  return total;
}

module.exports = { listActiveOrgs, getOrg, forEachActiveOrg };
