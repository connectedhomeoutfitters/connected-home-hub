-- CHO Hub — Migration 036: Hub → Ledger bookkeeping sync
-- Phase 5 of docs/adr/0001-multi-tenancy.md — the differentiated feature.
--
-- When a tenant's customer pays an invoice, Hub pushes it to Connected Home Ledger as a
-- business income transaction in that tenant's Business Workspace. "Run your jobs in Hub
-- and your books fill themselves in Ledger" is the thing neither Housecall Pro nor
-- QuickBooks does alone, and it only works because the two products share an owner.
--
-- Only meaningful for orgs that arrived via Ledger SSO (orgs.ledger_workspace_id set) —
-- a contractor who bought Hub standalone has no workspace to post into.

ALTER TABLE orgs
  -- Per-tenant opt-out. Defaults ON so a Ledger customer gets the benefit without having
  -- to discover a setting, but a tenant who keeps books elsewhere can turn it off.
  ADD COLUMN ledger_sync_enabled TINYINT(1) NOT NULL DEFAULT 1 AFTER ledger_plan;

ALTER TABLE invoices
  -- Stamped when Ledger confirms it recorded the income. NULL = never synced (either the
  -- org isn't linked, sync is off, or the push failed and will be retried).
  ADD COLUMN ledger_synced_at TIMESTAMP NULL AFTER paid_at,
  -- Ledger's transactions.id, so staff can trace a Hub payment to the exact bookkeeping
  -- entry rather than guessing from amounts and dates.
  ADD COLUMN ledger_transaction_id INT NULL AFTER ledger_synced_at;

CREATE INDEX idx_invoices_ledger_sync ON invoices (org_id, status, ledger_synced_at);
