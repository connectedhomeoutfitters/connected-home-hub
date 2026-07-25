-- CHO Hub — stores the tax rate used, not just the resulting dollar amount in `tax`,
-- so re-opening an estimate to edit shows the original rate rather than forcing staff
-- to re-derive it from subtotal/tax.
ALTER TABLE estimates
  ADD COLUMN tax_percent DECIMAL(5,2) NOT NULL DEFAULT 0 AFTER subtotal;
