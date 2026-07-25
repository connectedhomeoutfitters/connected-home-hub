-- Tier-1 billing completion: manual invoice creation + estimate decline.
--
-- invoices.description: standalone/final invoices are a single amount with no line items,
-- so without a memo the customer just sees "$500 (standalone)" with no context — this is
-- the "what is this for" line shown on the invoice + pay page.
-- estimates.declined_at: the 'declined' status already existed but had no timestamp and
-- no path to set it; the customer portal can now decline an estimate.

ALTER TABLE invoices
  ADD COLUMN description VARCHAR(500) NULL AFTER type;

ALTER TABLE estimates
  ADD COLUMN declined_at TIMESTAMP NULL AFTER accepted_at;
