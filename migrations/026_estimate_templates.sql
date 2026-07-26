-- Estimate templates — reusable starting points for common jobs (the WordPress packages,
-- plus common custom installs), à la Housecall Pro. A template holds a default title/
-- description/deposit + a set of line items (catalog-linked or custom). Loading a template
-- into a new estimate COPIES its items in (they're then tweaked per customer) — the estimate
-- keeps no live link to the template, so templates can be edited/removed freely afterward.

CREATE TABLE estimate_templates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,               -- internal template name (e.g. "Starter Package")
  title VARCHAR(255) NOT NULL,               -- default estimate title shown to the customer
  description TEXT NULL,                      -- default estimate description
  deposit_percent DECIMAL(5,2) NOT NULL DEFAULT 50.00,
  tax_percent DECIMAL(5,2) NULL,             -- NULL = use the company default when loaded
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE estimate_template_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  template_id INT NOT NULL,
  product_id INT NULL,
  labor_rate_id INT NULL,
  description VARCHAR(500) NOT NULL,
  quantity DECIMAL(10,2) NOT NULL DEFAULT 1,
  unit_price DECIMAL(10,2) NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0,
  FOREIGN KEY (template_id) REFERENCES estimate_templates(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (labor_rate_id) REFERENCES labor_rates(id),
  INDEX idx_template_items_template (template_id)
);
