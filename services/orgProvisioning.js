'use strict';
// Turns a Connected Home Ledger business workspace into a CHO Hub tenant.
// Phase 3 of docs/adr/0001-multi-tenancy.md.
//
// Runs at SSO time, before any org context exists, so it uses the unscoped pool
// deliberately — it is the code that *decides* which org a request belongs to.

const db = require('../config/db');
const scopedDb = require('../config/scopedDb');

// Ledger workspace names are free text ("Dave's Low Voltage"); turn one into a URL-safe
// slug and de-duplicate it, since orgs.slug is UNIQUE.
function slugify(name) {
  const base = String(name || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || 'org';
}

async function uniqueSlug(name) {
  const base = slugify(name);
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const [rows] = await db.execute('SELECT id FROM orgs WHERE slug = ?', [candidate]);
    if (!rows.length) return candidate;
  }
  // Pathological collision — fall back to something guaranteed free.
  return `${base}-${Date.now().toString(36)}`;
}

// Entitlement is a cached mirror of Ledger's answer. `hubEntitled` false doesn't delete
// anything — the org stays intact and simply can't be signed into, so a lapsed customer
// who resubscribes finds their data waiting.
function entitlementFields(payload) {
  return {
    status: payload.hubEntitled ? 'active' : 'suspended',
    ledger_plan: payload.plan || null,
  };
}

// A contractor onboarded into Hub by hand (staff account created in Settings → Users)
// who LATER connects through Ledger has an org that no workspace points at yet. Without
// this, their first SSO click provisions a second, empty org and their catalog/customers
// appear to have vanished — which is exactly what happened to CHO itself when SSO shipped
// (see migration 033).
//
// So before creating anything, look for an unlinked org whose ACTIVE ADMIN matches the
// email Ledger has already verified, and adopt it. Requiring admin+active+exact-email, and
// refusing when more than one org matches, keeps this from being a way to walk into
// somebody else's tenant.
async function findAdoptableOrg(email) {
  const [rows] = await db.execute(
    `SELECT o.* FROM orgs o
       JOIN users u ON u.org_id = o.id
      WHERE o.ledger_workspace_id IS NULL
        AND u.email = ? AND u.role = 'admin' AND u.active = 1
      GROUP BY o.id`,
    [email.toLowerCase()]
  );
  if (rows.length === 1) return rows[0];
  if (rows.length > 1) {
    // Ambiguous — don't guess which tenant they meant. Fall through to creating a new org
    // and let a human merge; logged loudly because it should be vanishingly rare.
    console.warn(
      `[orgProvisioning] ${rows.length} unlinked orgs have an active admin ${email} ` +
      `(ids ${rows.map((r) => r.id).join(', ')}); not adopting any.`
    );
  }
  return null;
}

/**
 * Find (or create) the org for a Ledger workspace, and refresh its cached entitlement.
 * Returns the org row, or null if the customer isn't entitled to Hub.
 */
async function findOrCreateOrg(payload) {
  const { status, ledger_plan } = entitlementFields(payload);

  const [existing] = await db.execute(
    'SELECT * FROM orgs WHERE ledger_workspace_id = ?',
    [payload.workspaceId]
  );

  if (existing[0]) {
    const org = existing[0];
    await db.execute(
      `UPDATE orgs SET status = ?, ledger_plan = ?, ledger_user_id = ?,
         entitlement_checked_at = NOW() WHERE id = ?`,
      [status, ledger_plan, payload.ledgerUserId || org.ledger_user_id, org.id]
    );
    return { ...org, status, ledger_plan, created: false };
  }

  // Never auto-create or adopt an org for a customer who isn't entitled — otherwise anyone
  // with a free Ledger account could provision (or claim) a tenant just by clicking through.
  if (!payload.hubEntitled) return null;

  const adoptable = await findAdoptableOrg(payload.email);
  if (adoptable) {
    await db.execute(
      `UPDATE orgs SET ledger_workspace_id = ?, ledger_user_id = ?, status = ?,
         ledger_plan = ?, entitlement_checked_at = NOW() WHERE id = ?`,
      [payload.workspaceId, payload.ledgerUserId || null, status, ledger_plan, adoptable.id]
    );
    console.log(
      `[orgProvisioning] adopted existing org ${adoptable.id} (${adoptable.slug}) ` +
      `into Ledger workspace ${payload.workspaceId} via admin ${payload.email}`
    );
    return {
      ...adoptable, status, ledger_plan,
      ledger_workspace_id: payload.workspaceId,
      created: false, adopted: true,
    };
  }

  const name = payload.workspaceName || `${payload.email}'s business`;
  const slug = await uniqueSlug(name);
  const [res] = await db.execute(
    `INSERT INTO orgs (name, slug, status, ledger_workspace_id, ledger_user_id, ledger_plan,
                       entitlement_checked_at)
     VALUES (?, ?, 'active', ?, ?, ?, NOW())`,
    [name, slug, payload.workspaceId, payload.ledgerUserId || null, ledger_plan]
  );
  const [rows] = await db.execute('SELECT * FROM orgs WHERE id = ?', [res.insertId]);
  return { ...rows[0], created: true };
}

/**
 * Find (or create) the staff user for this org + email. A Ledger business workspace is
 * 1:1 with a Ledger user, so the person arriving via SSO is the business owner and gets
 * `admin`. Returns the users row (shaped like deserializeUser's select).
 */
async function findOrCreateUser(org, payload) {
  const email = payload.email.toLowerCase();

  const [existing] = await db.execute(
    'SELECT * FROM users WHERE org_id = ? AND email = ?',
    [org.id, email]
  );

  if (existing[0]) {
    const user = existing[0];
    if (!user.active) return { user: null, reason: 'deactivated' };
    await db.execute(
      'UPDATE users SET last_login = NOW(), ledger_user_id = COALESCE(ledger_user_id, ?) WHERE id = ? AND org_id = ?',
      [payload.ledgerUserId || null, user.id, org.id]
    );
    return { user, reason: null };
  }

  // password_hash stays NULL — an SSO-provisioned account has no local password, exactly
  // like the Google-only staff accounts Settings → Users can already create.
  const sdb = scopedDb(org.id);
  const [res] = await sdb.execute(
    `INSERT INTO users (org_id, email, name, role, origin, ledger_user_id, active, last_login)
     VALUES (?, ?, ?, 'admin', 'ledger_sso', ?, 1, NOW())`,
    [org.id, email, payload.name || email, payload.ledgerUserId || null]
  );
  const [rows] = await sdb.execute(
    'SELECT * FROM users WHERE id = ? AND org_id = ?',
    [res.insertId, org.id]
  );
  return { user: rows[0], reason: null };
}

// Applied by the entitlement webhook when Ledger's subscription state changes.
async function setEntitlement(workspaceId, { hubEntitled, plan }) {
  const [rows] = await db.execute('SELECT id FROM orgs WHERE ledger_workspace_id = ?', [workspaceId]);
  if (!rows[0]) return null;
  await db.execute(
    `UPDATE orgs SET status = ?, ledger_plan = ?, entitlement_checked_at = NOW() WHERE id = ?`,
    [hubEntitled ? 'active' : 'suspended', plan || null, rows[0].id]
  );
  return rows[0].id;
}

module.exports = {
  findOrCreateOrg, findOrCreateUser, findAdoptableOrg, setEntitlement, slugify, uniqueSlug,
};
