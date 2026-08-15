-- First-run onboarding for a newly provisioned tenant.
--
-- welcomed_at: stamped the first time an org's staff lands on /welcome, so the guided
-- screen shows once rather than every visit. Nullable = never seen it.
--
-- setup_dismissed_at: the dashboard checklist is dismissible. Kept separate from
-- welcomed_at because they answer different questions ("have they been shown the intro"
-- vs "do they still want the reminder"), and conflating them means dismissing the
-- checklist would silently re-arm the welcome screen.
--
-- Existing orgs are backfilled as already-welcomed: org 1 has been running for months and
-- must not be shown a first-run intro on the next deploy.

ALTER TABLE orgs
  ADD COLUMN welcomed_at DATETIME NULL AFTER lead_webhook_secret,
  ADD COLUMN setup_dismissed_at DATETIME NULL AFTER welcomed_at;

UPDATE orgs SET welcomed_at = NOW() WHERE welcomed_at IS NULL;
