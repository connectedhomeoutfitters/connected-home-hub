'use strict';
// Guards the tenant-isolation rule from docs/adr/0001-multi-tenancy.md.
// Run with: npm test   (Node's built-in runner — no test dependency)

const test = require('node:test');
const assert = require('node:assert');

const scopedDb = require('../config/scopedDb');
const { assertScoped, tenantTablesIn, TENANT_TABLES } = scopedDb;

// A stub pool that records what it was asked to run instead of hitting MariaDB.
function fakePool() {
  const calls = [];
  const rec = (kind) => (sql, params) => {
    calls.push({ kind, sql, params });
    return Promise.resolve([[], []]);
  };
  return {
    calls,
    execute: rec('execute'),
    query: rec('query'),
    getConnection: async () => ({
      execute: rec('conn.execute'),
      query: rec('conn.query'),
      beginTransaction: async () => calls.push({ kind: 'begin' }),
      commit: async () => calls.push({ kind: 'commit' }),
      rollback: async () => calls.push({ kind: 'rollback' }),
      release: () => calls.push({ kind: 'release' }),
    }),
  };
}

test('rejects an unscoped read of a tenant table', () => {
  assert.throws(
    () => assertScoped('SELECT * FROM customers ORDER BY name'),
    /without constraining org_id/
  );
});

test('rejects an unscoped join even when one side is filtered by id', () => {
  assert.throws(
    () => assertScoped(`SELECT e.*, c.name FROM estimates e
                        JOIN customers c ON c.id = e.customer_id
                        WHERE e.id = ?`),
    /without constraining org_id/
  );
});

test('rejects an INSERT that omits org_id', () => {
  assert.throws(
    () => assertScoped('INSERT INTO invoices (customer_id, amount, status) VALUES (?,?,?)'),
    /without constraining org_id/
  );
});

test('rejects an UPDATE that omits org_id', () => {
  assert.throws(
    () => assertScoped("UPDATE estimates SET status = 'sent' WHERE id = ?"),
    /without constraining org_id/
  );
});

test('allows a scoped read', () => {
  assert.doesNotThrow(() =>
    assertScoped('SELECT * FROM customers WHERE org_id = ? ORDER BY name')
  );
});

test('allows a scoped INSERT', () => {
  assert.doesNotThrow(() =>
    assertScoped('INSERT INTO invoices (org_id, customer_id, amount) VALUES (?,?,?)')
  );
});

test('allows statements that touch only global tables', () => {
  assert.doesNotThrow(() => assertScoped('SELECT * FROM orgs WHERE id = ?'));
  assert.doesNotThrow(() => assertScoped('SELECT filename FROM schema_migrations'));
});

test('a table name inside a string literal is not a table reference', () => {
  // activity_log details routinely contain words like "from customers"
  assert.doesNotThrow(() =>
    assertScoped("SELECT 1 FROM orgs WHERE name = 'imported from customers'")
  );
});

test('a commented-out query does not trip the guard', () => {
  assert.doesNotThrow(() =>
    assertScoped('SELECT id FROM orgs -- was: SELECT * FROM customers')
  );
});

test('tenantTablesIn finds every tenant table referenced', () => {
  const found = tenantTablesIn(`SELECT * FROM payments p
                                JOIN invoices i ON i.id = p.invoice_id
                                JOIN customers c ON c.id = i.customer_id`);
  assert.deepStrictEqual(found.sort(), ['customers', 'invoices', 'payments']);
});

test('scopedDb requires a positive integer orgId', () => {
  assert.throws(() => scopedDb(null), /positive integer/);
  assert.throws(() => scopedDb(0), /positive integer/);
  assert.throws(() => scopedDb('1'), /positive integer/);
  assert.doesNotThrow(() => scopedDb(1, fakePool()));
});

test('the unscoped escape hatch bypasses the guard and still runs', async () => {
  const pool = fakePool();
  const db = scopedDb(1, pool);

  await assert.rejects(async () => db.execute('SELECT * FROM customers'), /org_id/);
  await db.unscoped.execute('SELECT * FROM customers');

  assert.strictEqual(pool.calls.length, 1);
  assert.strictEqual(pool.calls[0].sql, 'SELECT * FROM customers');
});

test('transactions through getConnection are guarded too', async () => {
  const db = scopedDb(1, fakePool());
  const conn = await db.getConnection();

  await conn.beginTransaction();
  await assert.rejects(
    async () => conn.execute("UPDATE invoices SET status='paid' WHERE id=?", [1]),
    /org_id/
  );
  await conn.execute("UPDATE invoices SET status='paid' WHERE id=? AND org_id=?", [1, 1]);
  await conn.commit();
  conn.release();
});

// ── middleware/orgContext ────────────────────────────────────────────────────

const orgContext = require('../middleware/orgContext');
const { attachOrg } = orgContext;

function fakeReqRes(req = {}) {
  const res = { locals: {} };
  req.res = res;
  return [req, res];
}

test('orgContext scopes a staff request from req.user.org_id', () => {
  const [req, res] = fakeReqRes({ user: { id: 7, org_id: 3 } });
  orgContext(req, res, () => {});

  assert.strictEqual(req.orgId, 3);
  assert.strictEqual(req.db.orgId, 3);
  assert.strictEqual(res.locals.orgId, 3);
});

test('orgContext scopes a portal request from req.session.orgId', () => {
  const [req, res] = fakeReqRes({ session: { customerId: 42, orgId: 5 } });
  orgContext(req, res, () => {});

  assert.strictEqual(req.orgId, 5);
  assert.strictEqual(req.db.orgId, 5);
});

test('orgContext leaves an anonymous request tenant-less', () => {
  const [req, res] = fakeReqRes({ session: {} });
  orgContext(req, res, () => {});

  assert.strictEqual(req.orgId, null);
  assert.strictEqual(req.db, null);
  assert.strictEqual(res.locals.orgId, null);
});

test('orgContext prefers the staff session over a stale portal session', () => {
  // A staff member who also has a customer portal session in the same browser must
  // not have their org silently taken from the portal side.
  const [req, res] = fakeReqRes({ user: { id: 1, org_id: 1 }, session: { orgId: 9 } });
  orgContext(req, res, () => {});

  assert.strictEqual(req.orgId, 1);
});

test('attachOrg rejects a non-positive-integer org id', () => {
  const [req] = fakeReqRes({});
  assert.throws(() => attachOrg(req, 0), /positive integer/);
  assert.throws(() => attachOrg(req, undefined), /positive integer/);
});

test('attachOrg scopes a token request that has no session at all', () => {
  const [req, res] = fakeReqRes({});
  orgContext(req, res, () => {});
  assert.strictEqual(req.db, null);

  attachOrg(req, 4); // middleware/customerAccess.js does this from the token row
  assert.strictEqual(req.orgId, 4);
  assert.strictEqual(req.db.orgId, 4);
  assert.strictEqual(res.locals.orgId, 4);
});

// ── drift guard ──────────────────────────────────────────────────────────────

test('the tenant table list matches migration 030', () => {
  const fs = require('node:fs');
  const sql = fs.readFileSync(__dirname + '/../migrations/030_orgs_multitenancy.sql', 'utf8');

  const migrated = new Set();
  const re = /ALTER TABLE\s+(\w+)\s+ADD COLUMN org_id/gi;
  let m;
  while ((m = re.exec(sql)) !== null) migrated.add(m[1].toLowerCase());

  const declared = [...TENANT_TABLES].sort();
  assert.deepStrictEqual(
    [...migrated].sort(),
    declared,
    'TENANT_TABLES in config/scopedDb.js has drifted from migration 030'
  );
});
