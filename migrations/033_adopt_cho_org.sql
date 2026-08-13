-- CHO Hub — Migration 033: adopt the pre-existing CHO tenant into its Ledger workspace
--
-- ONE-OFF DATA FIX, not a schema change. Safe to run in any environment: every statement
-- is guarded so it matches zero rows once applied (or where the situation never arose).
--
-- Background: Connected Home Outfitters existed as org 1 (33 products, 2 estimate
-- templates, customers, staff logins) BEFORE Ledger SSO shipped. The first SSO click from
-- Ledger workspace 1 found no org linked to that workspace and did the correct thing for a
-- brand-new customer — it provisioned a fresh, empty org 2. CHO isn't a brand-new customer,
-- so the result was the owner landing in an empty tenant with their catalog "missing".
--
-- The fix is to relink, NOT to migrate data: org 1 keeps every row it already has and is
-- simply pointed at the Ledger workspace it belongs to. The empty org 2 and its
-- auto-created staff row are removed. After this, an SSO click matches org 1 and reuses
-- the existing cmasi79@gmail.com admin rather than creating another.
--
-- routes/../services/orgProvisioning.js now adopts an existing unlinked org whose active
-- admin matches the SSO email, so no future tenant can land in this state.

-- 1. Remove the auto-provisioned staff row — but ONLY if its org is genuinely empty of
--    business data. If anything real was created in org 2 after all, this matches nothing
--    and the migration stops being applicable (deal with it by hand rather than guessing).
DELETE FROM users
 WHERE org_id = 2
   AND origin = 'ledger_sso'
   AND (SELECT COUNT(*) FROM customers  WHERE org_id = 2) = 0
   AND (SELECT COUNT(*) FROM estimates  WHERE org_id = 2) = 0
   AND (SELECT COUNT(*) FROM invoices   WHERE org_id = 2) = 0
   AND (SELECT COUNT(*) FROM products   WHERE org_id = 2) = 0
   AND (SELECT COUNT(*) FROM jobs       WHERE org_id = 2) = 0
   AND (SELECT COUNT(*) FROM leads      WHERE org_id = 2) = 0;

-- 2. Remove the now-empty org. Guarded on having no users left, so if step 1 declined to
--    act this does nothing either.
DELETE FROM orgs
 WHERE id = 2
   AND slug = 'connected-home-outfitters'
   AND (SELECT COUNT(*) FROM users WHERE org_id = 2) = 0;

-- 3. Point the real CHO tenant at the Ledger workspace.
--    The derived table works around MySQL's "can't specify target table for update in FROM
--    clause" restriction while still refusing to run if some other org still holds
--    workspace 1 (which would violate UNIQUE(ledger_workspace_id) and abort mid-migration).
UPDATE orgs
   SET ledger_workspace_id    = 1,
       ledger_user_id         = 1,
       ledger_plan            = 'premium',
       entitlement_checked_at = NOW()
 WHERE id = 1
   AND ledger_workspace_id IS NULL
   AND 0 = (SELECT c FROM (SELECT COUNT(*) c FROM orgs WHERE ledger_workspace_id = 1) AS t);
