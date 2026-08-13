'use strict';
// Static sweep: every SQL literal in routes/ and services/ must either constrain org_id
// or be an explicitly-marked cross-org query.
//
// This is the backstop for the ~180-site rewrite in phase 1b of
// docs/adr/0001-multi-tenancy.md. config/scopedDb.js catches a missed org_id at runtime,
// but only if that code path actually runs; this catches it at `npm test` instead.
//
// Cross-org queries are recognised by being invoked on the plain pool (`db.execute`) or
// through the escape hatch (`db.unscoped.execute`) rather than on a scoped handle. Those
// files are listed in ALLOWED_UNSCOPED below with the reason, so adding a new one is a
// deliberate, reviewable act.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { tenantTablesIn } = require('../config/scopedDb');

const ROOT = path.join(__dirname, '..');

// Files permitted to query tenant tables without an org filter, and why. Each is a point
// where the org is not yet known — authentication and webhooks resolve the tenant *from*
// the row they look up.
const ALLOWED_UNSCOPED = {
  'config/passport.js': 'staff login — the user row is what establishes the org',
  'middleware/customerAccess.js': 'access-token lookup — the token row carries the org',
  'routes/customerPortal.js': 'magic-link login/verify — discovers the org from the email/token',
  'routes/subPortal.js': 'magic-link login/verify — discovers the org from the email/token',
  'routes/webhooks.js': 'Stripe/lead webhooks arrive with no session; org resolved from the row',
  'services/paymentsSync.js': 'refund reconciliation resolves the org from the charge id',
  'services/orgs.js': 'reads the orgs table itself to enumerate tenants',
  'routes/sso.js': 'Ledger SSO handshake — runs before any org context exists',
  'services/orgProvisioning.js': 'finds-or-creates the org/user an SSO request resolves to',
  'scripts/create-admin.js': 'CLI; takes an explicit orgId argument',
  'scripts/import-products-csv.js': 'CLI; takes an explicit orgId argument',
  'scripts/sync-prod-to-test.js': 'whole-database dump/restore; its row counts are a post-load sanity check, not a tenant query',
};

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// Pull the first argument of every *.execute( / *.query( call, when it's a string literal.
// Returns { sql, receiver } where receiver is the expression the method was called on.
function sqlCallsIn(source) {
  const calls = [];
  // e.g.  await req.db.execute(`SELECT ...`, [...])   →  receiver "req.db"
  const re = /([A-Za-z_$][\w$.]*)\.(execute|query)\(\s*(`|'|")/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const [, receiver, , quote] = m;
    const start = m.index + m[0].length;
    // Scan to the matching close quote, honouring backslash escapes.
    let i = start;
    let sql = '';
    while (i < source.length) {
      const ch = source[i];
      if (ch === '\\') { sql += source[i + 1] ?? ''; i += 2; continue; }
      if (ch === quote) break;
      sql += ch;
      i += 1;
    }
    calls.push({ receiver, sql });
    re.lastIndex = i;
  }
  return calls;
}

test('every tenant-table query in routes/ and services/ constrains org_id', () => {
  const files = [
    ...walk(path.join(ROOT, 'routes')),
    ...walk(path.join(ROOT, 'services')),
    ...walk(path.join(ROOT, 'middleware')),
    ...walk(path.join(ROOT, 'config')),
    ...walk(path.join(ROOT, 'scripts')),
  ];

  const violations = [];

  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const source = fs.readFileSync(file, 'utf8');

    for (const { receiver, sql } of sqlCallsIn(source)) {
      const tables = tenantTablesIn(sql);
      if (tables.length === 0) continue;
      if (/\borg_id\b/i.test(sql)) continue;

      // In an allow-listed file, a query issued on anything OTHER than the scoped
      // request handle is one of that file's documented cross-org lookups (the raw pool,
      // a directly-opened connection, or the explicit `.unscoped` escape hatch).
      // Anything still going through `req.db` must be scoped even here, so the scoped
      // path stays covered in files that mix both.
      if (ALLOWED_UNSCOPED[rel] && receiver !== 'req.db') continue;

      violations.push(
        `${rel}: [${tables.join(', ')}] via ${receiver}.execute — ${sql.replace(/\s+/g, ' ').trim().slice(0, 110)}`
      );
    }
  }

  assert.deepStrictEqual(
    violations, [],
    `\nQueries touching tenant tables without an org_id filter:\n  ${violations.join('\n  ')}\n`
  );
});

test('the unscoped allow-list only names files that exist', () => {
  for (const rel of Object.keys(ALLOWED_UNSCOPED)) {
    assert.ok(
      fs.existsSync(path.join(ROOT, rel)),
      `ALLOWED_UNSCOPED names ${rel}, which no longer exists — remove it`
    );
  }
});

test('routes no longer import the unscoped pool except where allow-listed', () => {
  const offenders = [];
  for (const file of walk(path.join(ROOT, 'routes'))) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const source = fs.readFileSync(file, 'utf8');
    if (/require\(['"][^'"]*config\/db['"]\)/.test(source) && !ALLOWED_UNSCOPED[rel]) {
      offenders.push(rel);
    }
  }
  assert.deepStrictEqual(
    offenders, [],
    `\nThese routes import config/db directly instead of using req.db:\n  ${offenders.join('\n  ')}\n`
  );
});
