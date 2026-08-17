-- Selectable terms per estimate. Prerequisite 2 of docs/adr/0002-recurring-services.md.
--
-- Today an org has exactly ONE body of terms: config/estimateTerms.js's built-in text, or
-- company_settings.terms_override if they wrote their own. A contractor selling both
-- one-off installs and recurring maintenance needs two — a mowing agreement needs term and
-- renewal, cancellation notice, skipped visits and property access, none of which belong
-- on an install quote.
--
-- The harder half is evidentiary. The terms are PART OF WHAT WAS SIGNED, so a reference
-- alone is not enough: if a tenant edits their terms next year, an estimate signed today
-- must still show what the customer actually agreed to. Hence estimates.terms_snapshot —
-- the exact text as presented, frozen when the estimate is SENT (the moment it becomes an
-- offer). Freezing at send rather than at acceptance also means editing a template cannot
-- change an offer that is already sitting in a customer's inbox.
--
-- Same principle as estimate_line_items keeping their own description and unit_price
-- rather than joining live to products: the signed record must not move.

CREATE TABLE terms_templates (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  org_id      INT NOT NULL,
  name        VARCHAR(120) NOT NULL,
  -- Plain text, NOT html. Tenant-authored content is user input, and it reaches the
  -- customer through the same unescaped `<%- terms %>` render as the built-in default —
  -- so it is escaped on the way out and line breaks are preserved with white-space,
  -- exactly as config/estimateTerms.js already does for terms_override.
  body        MEDIUMTEXT NOT NULL,
  -- Offered first on the estimate form. Not enforced unique: a tenant briefly having two
  -- or none is a UI wrinkle, not a reason to reject their save.
  is_default  TINYINT(1) NOT NULL DEFAULT 0,
  active      TINYINT(1) NOT NULL DEFAULT 1,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_terms_org (org_id, active, is_default)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE estimates
  -- Which template was chosen. Nullable, and deliberately NOT a foreign key: a template
  -- may be deleted or deactivated long after an estimate is signed, and the snapshot is
  -- what actually matters. This is for reporting ("which agreement did we sell on").
  ADD COLUMN terms_template_id INT NULL AFTER consultation_id,
  -- The terms as shown to the customer, captured at send. NULL on every existing estimate
  -- and on drafts, in which case the portal resolves terms live exactly as it does now.
  ADD COLUMN terms_snapshot MEDIUMTEXT NULL AFTER terms_template_id;

-- Give every org that already wrote custom terms a template containing them, so their
-- library starts with what they are actually using rather than empty. Orgs on the built-in
-- default get no row and keep falling through to config/estimateTerms.js — seeding that
-- text per org would freeze the company-name interpolation it does at render time.
INSERT INTO terms_templates (org_id, name, body, is_default, active)
SELECT org_id, 'Standard terms', terms_override, 1, 1
  FROM company_settings
 WHERE terms_override IS NOT NULL AND TRIM(terms_override) <> '';
