-- Typed electronic signature + browser info captured alongside the existing
-- accepted_at/accepted_ip (007_estimate_acceptance.sql) at estimate-acceptance time —
-- part of a proper audit trail for the click-to-accept flow.
ALTER TABLE estimates
  ADD COLUMN signature_name VARCHAR(255) NULL AFTER accepted_ip,
  ADD COLUMN accepted_user_agent VARCHAR(500) NULL AFTER signature_name;
