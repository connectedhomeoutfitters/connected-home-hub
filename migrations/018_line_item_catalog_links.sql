-- Catalog-linked estimate line items — the foundation for material lists, job costing,
-- and (later) inventory. Each line can optionally point at the product or labor_rate it
-- came from; both NULL means a fully custom line (the existing behavior). The line still
-- keeps its own description/unit_price snapshot, so editing the catalog later never
-- rewrites what a customer already accepted — the link is for reporting, not a live join.

ALTER TABLE estimate_line_items
  ADD COLUMN product_id INT NULL AFTER estimate_id,
  ADD COLUMN labor_rate_id INT NULL AFTER product_id,
  ADD FOREIGN KEY (product_id) REFERENCES products(id),
  ADD FOREIGN KEY (labor_rate_id) REFERENCES labor_rates(id);
