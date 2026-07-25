-- CHO Hub — product catalog, labor rates, and subcontractors.
-- Sourced from the user's real product-catalog spreadsheet, simplified: the sheet's
-- sparse subcategory_1..10 columns collapse into a plain vendor/product_line pair
-- since the real data never went more than two levels deep (e.g. Amazon > Eero).
-- retail_price is the actual field estimates read from; markup_percent is only used
-- to (re)compute it when markup_enabled is on — both are stored so a manually
-- overridden retail_price isn't silently clobbered.

CREATE TABLE products (
  id INT AUTO_INCREMENT PRIMARY KEY,
  category VARCHAR(100) NOT NULL,
  vendor VARCHAR(100) NULL,
  product_line VARCHAR(100) NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT NULL,
  part_number VARCHAR(100) NULL,
  vendor_cost DECIMAL(10,2) NOT NULL DEFAULT 0,
  markup_percent DECIMAL(6,2) NULL,
  markup_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  retail_price DECIMAL(10,2) NOT NULL DEFAULT 0,
  taxable BOOLEAN NOT NULL DEFAULT TRUE,
  unit_of_measure VARCHAR(50) NOT NULL DEFAULT 'Each',
  reference_url VARCHAR(1000) NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_products_category (category),
  INDEX idx_products_active (active)
);

CREATE TABLE labor_rates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  hourly_rate DECIMAL(10,2) NOT NULL,
  notes TEXT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Trades kept as free text rather than an ENUM — the roster of subcontractor types
-- (low-voltage electrician, HVAC, etc.) isn't fixed and shouldn't need a migration
-- every time a new trade shows up.
CREATE TABLE subcontractors (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  trade VARCHAR(100) NOT NULL,
  contact_name VARCHAR(255) NULL,
  phone VARCHAR(50) NULL,
  email VARCHAR(255) NULL,
  hourly_rate DECIMAL(10,2) NULL,
  license_number VARCHAR(100) NULL,
  notes TEXT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
