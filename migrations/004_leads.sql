-- CHO Hub — leads captured from the choProject WordPress site's WPForms "Free Smart
-- Home Consultation" form (name + email only, today) via a webhook. raw_payload keeps
-- the full original submission so nothing is lost if the WP form grows more fields
-- later without a CHO Hub migration to match.
CREATE TABLE leads (
  id INT AUTO_INCREMENT PRIMARY KEY,
  first_name VARCHAR(255) NOT NULL,
  last_name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  phone VARCHAR(50) NULL,
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
