-- CHO Hub — corrects 004: the real lead form on choProject is an Elementor Pro form
-- ("FreeConsultForm" on page /free-smart-home-consultation-form/), not the WPForms form
-- 004 was built against (that WPForms form turned out to be unused/dead content).
-- Elementor's form uses a single "Full Name" field, not first/last split, matching
-- customers.name's convention — and captures far more useful intake data than the
-- WPForms form did, worth actually storing rather than discarding into raw_payload only.
-- No real lead data exists yet, so this replaces rather than ALTERs the table.
DROP TABLE IF EXISTS leads;

CREATE TABLE leads (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  phone VARCHAR(50) NULL,
  property_address VARCHAR(500) NULL,
  home_size VARCHAR(100) NULL,
  home_type VARCHAR(100) NULL,
  interests JSON NULL,
  budget VARCHAR(100) NULL,
  timeline VARCHAR(100) NULL,
  additional_details TEXT NULL,
  source VARCHAR(100) NOT NULL DEFAULT 'website',
  status ENUM('new', 'contacted', 'scheduled', 'converted', 'lost') NOT NULL DEFAULT 'new',
  customer_id INT NULL,
  notes TEXT NULL,
  raw_payload JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  INDEX idx_leads_status (status),
  INDEX idx_leads_email (email)
);
