-- CHO Hub — Migration 032: Connected Home Ledger SSO
-- Phase 3 of docs/adr/0001-multi-tenancy.md.
--
-- Ledger is the identity + subscription layer: a Ledger user with a Business Workspace
-- clicks through to Hub carrying a short-lived signed token, and Hub finds-or-creates the
-- matching org + staff user. This is NOT a fourth principal type — it establishes the
-- ordinary staff Passport session, so serializeUser/deserializeUser are untouched.

-- Single-use guard for SSO handoff tokens. A token is valid for ~60 seconds, so rows here
-- are short-lived; pruned opportunistically on each successful SSO (see routes/sso.js).
CREATE TABLE sso_used_tokens (
  jti VARCHAR(64) PRIMARY KEY,
  used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_sso_used_tokens_used_at (used_at)
);

-- How a staff row got here, so an SSO-provisioned account is distinguishable from one
-- created by hand in Settings → Users. 'local' covers everything that predates SSO.
ALTER TABLE users
  ADD COLUMN origin ENUM('local', 'ledger_sso') NOT NULL DEFAULT 'local' AFTER role,
  ADD COLUMN ledger_user_id INT NULL AFTER origin;

-- Which Ledger plan the org was last seen on, for display + support. Entitlement itself is
-- carried by orgs.entitlement_expires_at / orgs.status, which the SSO handshake and the
-- entitlement webhook both write.
ALTER TABLE orgs
  ADD COLUMN ledger_plan VARCHAR(32) NULL AFTER ledger_user_id,
  ADD COLUMN entitlement_checked_at TIMESTAMP NULL AFTER entitlement_expires_at;
