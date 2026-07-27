-- Package/flat-rate pricing + per-line price hiding for estimates and templates.
--
-- flat_price (nullable, on estimates + estimate_templates): when set, the estimate is a
--   fixed-price "package" (e.g. "Starter Package — $899"). The customer sees the included
--   items as a plain list with NO per-line prices, and one flat total; deposit + invoices
--   bill off this amount instead of the summed line items. NULL = the normal itemized
--   behavior (total = sum of lines + tax). Line items are still stored with their real
--   quantities/prices for internal job costing, material lists, and inventory — flat_price
--   only changes what's billed and what the customer sees.
--
-- hide_price (per line, on estimate_line_items + estimate_template_items): on a normal
--   itemized estimate, a hidden line shows to the customer as "Included" instead of a
--   dollar amount. Its cost still counts toward the total (bundled pricing) — staff always
--   see the real numbers on the admin side.

ALTER TABLE estimates
  ADD COLUMN flat_price DECIMAL(10,2) NULL AFTER total;

ALTER TABLE estimate_templates
  ADD COLUMN flat_price DECIMAL(10,2) NULL AFTER tax_percent;

ALTER TABLE estimate_line_items
  ADD COLUMN hide_price BOOLEAN NOT NULL DEFAULT FALSE AFTER unit_price;

ALTER TABLE estimate_template_items
  ADD COLUMN hide_price BOOLEAN NOT NULL DEFAULT FALSE AFTER unit_price;
