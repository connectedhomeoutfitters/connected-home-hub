-- CHO Hub — lightweight acceptance audit trail (checkbox + timestamp + IP, per the
-- "lightweight click-to-accept" decision — see CLAUDE.md). accepted_at already existed;
-- accepted_ip is new.
ALTER TABLE estimates
  ADD COLUMN accepted_ip VARCHAR(64) NULL AFTER accepted_at;
