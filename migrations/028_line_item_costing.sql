-- Job-costing / profitability basis for estimate + template line items.
--
-- unit_cost: the per-unit COST to CHO for that line (COGS), parallel to unit_price (what
--   the customer is charged). Auto-filled from products.vendor_cost or a subcontractor's
--   hourly_rate when a catalog source is picked, but editable — custom/own-labor lines can
--   carry a manual cost or none. Gross profit = revenue − Σ(quantity × unit_cost).
--
-- subcontractor_id: a third line "source" alongside product_id / labor_rate_id, so work
--   farmed out to a sub is captured and its cost is broken out separately from materials
--   and own labor in the profitability panel. All three source ids NULL = a custom line.
--
-- Cost category (for the breakdown) is derived, not stored: product_id → Materials,
-- subcontractor_id → Subcontractor, labor_rate_id → Labor, none → Other.

ALTER TABLE estimate_line_items
  ADD COLUMN unit_cost DECIMAL(10,2) NOT NULL DEFAULT 0 AFTER unit_price,
  ADD COLUMN subcontractor_id INT NULL AFTER labor_rate_id,
  ADD FOREIGN KEY (subcontractor_id) REFERENCES subcontractors(id);

ALTER TABLE estimate_template_items
  ADD COLUMN unit_cost DECIMAL(10,2) NOT NULL DEFAULT 0 AFTER unit_price,
  ADD COLUMN subcontractor_id INT NULL AFTER labor_rate_id,
  ADD FOREIGN KEY (subcontractor_id) REFERENCES subcontractors(id);

-- Backfill existing material lines' cost from the current product vendor_cost, so
-- estimates/templates built before this migration show real COGS immediately (rather than
-- $0) without a manual re-save. Only touches product-linked lines; custom/labor stay 0.
UPDATE estimate_line_items eli
  JOIN products p ON p.id = eli.product_id
  SET eli.unit_cost = p.vendor_cost
  WHERE eli.product_id IS NOT NULL;

UPDATE estimate_template_items eti
  JOIN products p ON p.id = eti.product_id
  SET eti.unit_cost = p.vendor_cost
  WHERE eti.product_id IS NOT NULL;
