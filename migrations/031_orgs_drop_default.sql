-- CHO Hub — Migration 031: drop the org_id backfill defaults
-- The "contract" half of the expand/contract pair started in 030.
--
-- DO NOT RUN THIS until every query site supplies org_id explicitly. 030 left
-- `org_id NOT NULL DEFAULT 1` so the app kept working while the ~180 query sites in
-- routes/ and services/ were rewritten; this migration removes that safety net so a
-- forgotten org_id fails loudly (ER_NO_DEFAULT_FOR_FIELD) instead of silently writing
-- another tenant's row into Connected Home Outfitters' data.
--
-- Readiness check before applying:
--   npm test                       — config/scopedDb.js guard suite passes
--   grep -rn "require.*config/db" routes/ services/
--                                  — every remaining hit is a deliberate, commented
--                                    cross-org case (auth lookups, token resolution, crons)
--
-- See docs/adr/0001-multi-tenancy.md.

ALTER TABLE users                      ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE company_settings           ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE products                   ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE labor_rates                ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE subcontractors             ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE builders                   ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE leads                      ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE customers                  ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE consultations              ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE jobs                       ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE warranties                 ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE estimates                  ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE estimate_templates         ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE estimate_line_items        ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE estimate_template_items    ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE consultation_photos        ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE subcontractor_documents    ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE documents                  ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE invoices                   ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE payments                   ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE refunds                    ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE stock_movements            ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE access_tokens              ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE customer_auth_tokens       ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE subcontractor_auth_tokens  ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE activity_log               ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE email_log                  ALTER COLUMN org_id DROP DEFAULT;
