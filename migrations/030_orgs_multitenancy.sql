-- CHO Hub — Migration 030: multi-tenancy foundation
-- Phase 1 of docs/adr/0001-multi-tenancy.md
--
-- Introduces `orgs` (one row = one contracting business = one tenant) and puts
-- `org_id` on all 27 tenant tables. Connected Home Outfitters becomes org #1 and
-- runs on the same code path as every other tenant.
--
-- Backfill strategy: org_id is added as NOT NULL DEFAULT 1 so every existing row
-- lands on org 1 without a separate UPDATE pass.
--
-- The DEFAULT is deliberately LEFT IN PLACE by this migration and dropped later by
-- 031_orgs_drop_default.sql — an expand/contract pair. Long-term the default is
-- unwanted (a forgotten org_id on an INSERT would silently write into CHO's data
-- instead of failing loudly), but dropping it here would break every one of the ~180
-- existing query sites the moment this runs, since none of them supply org_id yet.
-- Order is: 030 → rewrite the queries → 031. The app works at every step.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The tenant table
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE orgs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(64) NOT NULL,
  status ENUM('active', 'suspended', 'cancelled') NOT NULL DEFAULT 'active',
  -- Link to Connected Home Ledger. NULL for a contractor who bought Hub standalone.
  -- MariaDB allows repeated NULLs in a UNIQUE index, so many standalone orgs coexist.
  ledger_workspace_id INT NULL,
  ledger_user_id INT NULL,
  -- Stripe Connect (Standard) account that this org's customer payments settle into.
  -- NULL until they connect one; org 1 keeps using the platform account until phase 4.
  stripe_account_id VARCHAR(255) NULL,
  -- Cached from Ledger's subscription state; NULL = no expiry (e.g. org 1).
  entitlement_expires_at TIMESTAMP NULL,
  -- Per-tenant shared secret for POST /webhooks/lead-intake, replacing the global
  -- LEAD_WEBHOOK_SECRET env var so each contractor's site posts to their own org.
  lead_webhook_secret VARCHAR(128) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_orgs_slug (slug),
  UNIQUE KEY uniq_orgs_ledger_workspace (ledger_workspace_id)
);

INSERT INTO orgs (id, name, slug, status)
VALUES (1, 'Connected Home Outfitters LLC', 'cho', 'active');

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. org_id on every tenant table
-- ─────────────────────────────────────────────────────────────────────────────

-- Staff / config
ALTER TABLE users
  ADD COLUMN org_id INT NOT NULL DEFAULT 1 AFTER id,
  ADD INDEX idx_users_org (org_id),
  ADD CONSTRAINT fk_users_org FOREIGN KEY (org_id) REFERENCES orgs(id);

ALTER TABLE company_settings
  ADD COLUMN org_id INT NOT NULL DEFAULT 1 AFTER id,
  ADD CONSTRAINT fk_company_settings_org FOREIGN KEY (org_id) REFERENCES orgs(id);

ALTER TABLE products
  ADD COLUMN org_id INT NOT NULL DEFAULT 1 AFTER id,
  ADD INDEX idx_products_org (org_id),
  ADD CONSTRAINT fk_products_org FOREIGN KEY (org_id) REFERENCES orgs(id);

ALTER TABLE labor_rates
  ADD COLUMN org_id INT NOT NULL DEFAULT 1 AFTER id,
  ADD INDEX idx_labor_rates_org (org_id),
  ADD CONSTRAINT fk_labor_rates_org FOREIGN KEY (org_id) REFERENCES orgs(id);

ALTER TABLE subcontractors
  ADD COLUMN org_id INT NOT NULL DEFAULT 1 AFTER id,
  ADD INDEX idx_subcontractors_org (org_id),
  ADD CONSTRAINT fk_subcontractors_org FOREIGN KEY (org_id) REFERENCES orgs(id);

ALTER TABLE builders
  ADD COLUMN org_id INT NOT NULL DEFAULT 1 AFTER id,
  ADD INDEX idx_builders_org (org_id),
  ADD CONSTRAINT fk_builders_org FOREIGN KEY (org_id) REFERENCES orgs(id);

-- CRM / lifecycle
ALTER TABLE leads
  ADD COLUMN org_id INT NOT NULL DEFAULT 1 AFTER id,
  ADD INDEX idx_leads_org (org_id),
  ADD CONSTRAINT fk_leads_org FOREIGN KEY (org_id) REFERENCES orgs(id);

ALTER TABLE customers
  ADD COLUMN org_id INT NOT NULL DEFAULT 1 AFTER id,
  ADD INDEX idx_customers_org (org_id),
  ADD CONSTRAINT fk_customers_org FOREIGN KEY (org_id) REFERENCES orgs(id);

ALTER TABLE consultations
  ADD COLUMN org_id INT NOT NULL DEFAULT 1 AFTER id,
  ADD INDEX idx_consultations_org (org_id),
  ADD CONSTRAINT fk_consultations_org FOREIGN KEY (org_id) REFERENCES orgs(id);

ALTER TABLE jobs
  ADD COLUMN org_id INT NOT NULL DEFAULT 1 AFTER id,
  ADD INDEX idx_jobs_org (org_id),
  ADD CONSTRAINT fk_jobs_org FOREIGN KEY (org_id) REFERENCES orgs(id);

ALTER TABLE warranties
  ADD COLUMN org_id INT NOT NULL DEFAULT 1 AFTER id,
  ADD INDEX idx_warranties_org (org_id),
  ADD CONSTRAINT fk_warranties_org FOREIGN KEY (org_id) REFERENCES orgs(id);

-- Estimates / templates
ALTER TABLE estimates
  ADD COLUMN org_id INT NOT NULL DEFAULT 1 AFTER id,
  ADD INDEX idx_estimates_org (org_id),
  ADD CONSTRAINT fk_estimates_org FOREIGN KEY (org_id) REFERENCES orgs(id);

ALTER TABLE estimate_templates
  ADD COLUMN org_id INT NOT NULL DEFAULT 1 AFTER id,
  ADD INDEX idx_estimate_templates_org (org_id),
  ADD CONSTRAINT fk_estimate_templates_org FOREIGN KEY (org_id) REFERENCES orgs(id);

-- Child tables: reachable via their parent, but carry org_id anyway (defense in
-- depth — a query filtering only on the parent id leaks if the parent's own org
-- check is ever skipped).
ALTER TABLE estimate_line_items
  ADD COLUMN org_id INT NOT NULL DEFAULT 1 AFTER id,
  ADD INDEX idx_estimate_line_items_org (org_id),
  ADD CONSTRAINT fk_estimate_line_items_org FOREIGN KEY (org_id) REFERENCES orgs(id);

ALTER TABLE estimate_template_items
  ADD COLUMN org_id INT NOT NULL DEFAULT 1 AFTER id,
  ADD INDEX idx_estimate_template_items_org (org_id),
  ADD CONSTRAINT fk_estimate_template_items_org FOREIGN KEY (org_id) REFERENCES orgs(id);

ALTER TABLE consultation_photos
  ADD COLUMN org_id INT NOT NULL DEFAULT 1 AFTER id,
  ADD INDEX idx_consultation_photos_org (org_id),
  ADD CONSTRAINT fk_consultation_photos_org FOREIGN KEY (org_id) REFERENCES orgs(id);

ALTER TABLE subcontractor_documents
  ADD COLUMN org_id INT NOT NULL DEFAULT 1 AFTER id,
  ADD INDEX idx_subcontractor_documents_org (org_id),
  ADD CONSTRAINT fk_subcontractor_documents_org FOREIGN KEY (org_id) REFERENCES orgs(id);

ALTER TABLE documents
  ADD COLUMN org_id INT NOT NULL DEFAULT 1 AFTER id,
  ADD INDEX idx_documents_org (org_id),
  ADD CONSTRAINT fk_documents_org FOREIGN KEY (org_id) REFERENCES orgs(id);

-- Billing
ALTER TABLE invoices
  ADD COLUMN org_id INT NOT NULL DEFAULT 1 AFTER id,
  ADD INDEX idx_invoices_org (org_id),
  ADD CONSTRAINT fk_invoices_org FOREIGN KEY (org_id) REFERENCES orgs(id);

ALTER TABLE payments
  ADD COLUMN org_id INT NOT NULL DEFAULT 1 AFTER id,
  ADD INDEX idx_payments_org (org_id),
  ADD CONSTRAINT fk_payments_org FOREIGN KEY (org_id) REFERENCES orgs(id);

ALTER TABLE refunds
  ADD COLUMN org_id INT NOT NULL DEFAULT 1 AFTER id,
  ADD INDEX idx_refunds_org (org_id),
  ADD CONSTRAINT fk_refunds_org FOREIGN KEY (org_id) REFERENCES orgs(id);

ALTER TABLE stock_movements
  ADD COLUMN org_id INT NOT NULL DEFAULT 1 AFTER id,
  ADD INDEX idx_stock_movements_org (org_id),
  ADD CONSTRAINT fk_stock_movements_org FOREIGN KEY (org_id) REFERENCES orgs(id);

-- Access tokens. The token itself stays GLOBALLY unique (it is the secret, and it is
-- resolved before any org context exists) — org_id is here so the page it resolves to
-- can be rendered with the right tenant's branding.
ALTER TABLE access_tokens
  ADD COLUMN org_id INT NOT NULL DEFAULT 1 AFTER id,
  ADD INDEX idx_access_tokens_org (org_id),
  ADD CONSTRAINT fk_access_tokens_org FOREIGN KEY (org_id) REFERENCES orgs(id);

ALTER TABLE customer_auth_tokens
  ADD COLUMN org_id INT NOT NULL DEFAULT 1 AFTER id,
  ADD INDEX idx_customer_auth_tokens_org (org_id),
  ADD CONSTRAINT fk_customer_auth_tokens_org FOREIGN KEY (org_id) REFERENCES orgs(id);

ALTER TABLE subcontractor_auth_tokens
  ADD COLUMN org_id INT NOT NULL DEFAULT 1 AFTER id,
  ADD INDEX idx_subcontractor_auth_tokens_org (org_id),
  ADD CONSTRAINT fk_subcontractor_auth_tokens_org FOREIGN KEY (org_id) REFERENCES orgs(id);

-- Logs
ALTER TABLE activity_log
  ADD COLUMN org_id INT NOT NULL DEFAULT 1 AFTER id,
  ADD INDEX idx_activity_log_org (org_id),
  ADD CONSTRAINT fk_activity_log_org FOREIGN KEY (org_id) REFERENCES orgs(id);

ALTER TABLE email_log
  ADD COLUMN org_id INT NOT NULL DEFAULT 1 AFTER id,
  ADD INDEX idx_email_log_org (org_id),
  ADD CONSTRAINT fk_email_log_org FOREIGN KEY (org_id) REFERENCES orgs(id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Uniqueness that was global becomes per-org
-- ─────────────────────────────────────────────────────────────────────────────

-- The same person may legitimately be staff at two contracting businesses, so email
-- and google_id stop being globally unique. Consequence: login can no longer be a
-- bare "find the user by email" — see ADR phase 3. Harmless while only org 1 exists.
ALTER TABLE users
  DROP INDEX email,
  DROP INDEX google_id,
  ADD UNIQUE KEY uniq_users_org_email (org_id, email),
  ADD UNIQUE KEY uniq_users_org_google (org_id, google_id);

-- company_settings stops being the single always-id=1 row and becomes one row per
-- org. UNIQUE(org_id) is what routes/admin/settings.js's ON DUPLICATE KEY UPDATE
-- upsert now keys off, so `id` no longer has to be hardcoded to 1 on insert.
ALTER TABLE company_settings
  MODIFY id INT NOT NULL AUTO_INCREMENT,
  ADD UNIQUE KEY uniq_company_settings_org (org_id);

-- payments.stripe_payment_intent_id stays globally unique: Stripe PaymentIntent ids
-- are random and unique across connected accounts, so this remains a useful guard
-- against double-recording a webhook.

-- The backfill DEFAULT 1 stays until 031_orgs_drop_default.sql — see the header.
