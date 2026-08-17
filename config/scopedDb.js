'use strict';
// Tenant-scoped database access — see docs/adr/0001-multi-tenancy.md.
//
// Hub became multi-tenant in migration 030: every table below carries an org_id, and
// a statement that touches one without constraining org_id can read or write another
// contractor's data. There are ~180 query sites; relying on every one of them to
// remember `AND org_id = ?` is not a control.
//
// So routes use `req.db` (a scoped wrapper) instead of importing config/db directly,
// and this module REFUSES any statement that touches a tenant table without mentioning
// org_id. Queries that genuinely must span orgs — resolving a random access token
// before any org context exists, cron sweeps across all tenants — go through
// `db.unscoped.execute(...)`, which makes the exception greppable and reviewable
// instead of invisible by omission.

const pool = require('./db');

// Every table holding tenant data. Keep in sync with migration 030.
const TENANT_TABLES = new Set([
  'access_tokens',
  'activity_log',
  'builders',
  'company_settings',
  'consultation_photos',
  'consultations',
  'customer_auth_tokens',
  'customers',
  'documents',
  'email_log',
  'estimate_line_items',
  'invoice_line_items',
  'terms_templates',
  'recurring_services',
  'estimate_template_items',
  'estimate_templates',
  'estimates',
  'invoices',
  'jobs',
  'labor_rates',
  'leads',
  'payments',
  'products',
  'refunds',
  'stock_movements',
  'subcontractor_auth_tokens',
  'subcontractor_documents',
  'subcontractors',
  'users',
  'warranties',
]);

// Tables that are deliberately global and never need an org filter.
const GLOBAL_TABLES = new Set(['orgs', 'schema_migrations', 'sessions']);

// 'throw' (default) | 'warn' | 'off'. Kept as an escape hatch for an emergency in
// production, but the default is to fail loudly: a cross-tenant read is worse than a 500.
const ENFORCE = process.env.SCOPED_DB_ENFORCE || 'throw';

// Strip comments and string literals so a table name mentioned inside a quoted value
// (e.g. an activity_log detail string) can't be mistaken for a real table reference.
function stripLiterals(sql) {
  return String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/#[^\n]*/g, ' ')
    .replace(/'(?:\\.|''|[^'])*'/g, "''")
    .replace(/"(?:\\.|""|[^"])*"/g, '""');
}

// Table references are whatever follows FROM / JOIN / INTO / UPDATE.
const TABLE_REF = /\b(?:from|join|into|update)\s+`?([a-z_][a-z0-9_]*)`?/gi;

function tenantTablesIn(sql) {
  const cleaned = stripLiterals(sql);
  const found = new Set();
  let m;
  TABLE_REF.lastIndex = 0;
  while ((m = TABLE_REF.exec(cleaned)) !== null) {
    const name = m[1].toLowerCase();
    if (TENANT_TABLES.has(name)) found.add(name);
  }
  return [...found];
}

function assertScoped(sql) {
  if (ENFORCE === 'off') return;

  const tables = tenantTablesIn(sql);
  if (tables.length === 0) return;

  // A single mention is the bar. A join across tenant tables should scope the root
  // table and reach the rest through their foreign keys; that reads as one org_id.
  if (/\borg_id\b/i.test(stripLiterals(sql))) return;

  const msg =
    `scopedDb: statement touches tenant table(s) [${tables.join(', ')}] without ` +
    `constraining org_id. Add "AND org_id = ?" (or org_id to the INSERT column list), ` +
    `or use db.unscoped.* if this query genuinely must span orgs.\n  SQL: ${String(sql).trim().slice(0, 300)}`;

  if (ENFORCE === 'warn') return void console.warn(msg);
  throw new Error(msg);
}

// Wraps a pooled connection so transactions get the same guard. beginTransaction /
// commit / rollback / release pass straight through.
function wrapConnection(conn) {
  return {
    execute: (sql, params) => {
      assertScoped(sql);
      return conn.execute(sql, params);
    },
    query: (sql, params) => {
      assertScoped(sql);
      return conn.query(sql, params);
    },
    unscoped: {
      execute: (sql, params) => conn.execute(sql, params),
      query: (sql, params) => conn.query(sql, params),
    },
    beginTransaction: () => conn.beginTransaction(),
    commit: () => conn.commit(),
    rollback: () => conn.rollback(),
    release: () => conn.release(),
    raw: conn,
  };
}

/**
 * Build a tenant-scoped database handle.
 * @param {number} orgId - the org whose data this handle may touch.
 * @param {object} [base] - underlying pool (injectable for tests).
 */
function scopedDb(orgId, base = pool) {
  if (!Number.isInteger(orgId) || orgId <= 0) {
    throw new Error(`scopedDb: orgId must be a positive integer, got ${JSON.stringify(orgId)}`);
  }

  return {
    orgId,

    execute: (sql, params) => {
      assertScoped(sql);
      return base.execute(sql, params);
    },
    query: (sql, params) => {
      assertScoped(sql);
      return base.query(sql, params);
    },

    // Explicit, greppable escape hatch for genuinely cross-org queries.
    unscoped: {
      execute: (sql, params) => base.execute(sql, params),
      query: (sql, params) => base.query(sql, params),
      getConnection: () => base.getConnection(),
    },

    async getConnection() {
      return wrapConnection(await base.getConnection());
    },

    raw: base,
  };
}

module.exports = scopedDb;
module.exports.scopedDb = scopedDb;
module.exports.assertScoped = assertScoped;
module.exports.tenantTablesIn = tenantTablesIn;
module.exports.TENANT_TABLES = TENANT_TABLES;
module.exports.GLOBAL_TABLES = GLOBAL_TABLES;
