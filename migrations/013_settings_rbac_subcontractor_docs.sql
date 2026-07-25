-- Settings feature: admin-only RBAC (users.active lets staff be deactivated without
-- deleting their history), a single-row company_settings table (tax ID, default sales
-- tax rate, company profile), and expanded subcontractor profiles + uploaded documents
-- (W9s, certificates of insurance, etc.) — mirrors the consultation_photos pattern.

ALTER TABLE users
  ADD COLUMN active BOOLEAN NOT NULL DEFAULT TRUE AFTER role;

CREATE TABLE company_settings (
  id INT PRIMARY KEY,
  company_name VARCHAR(255) NULL,
  tax_id VARCHAR(50) NULL,
  default_tax_percent DECIMAL(5,2) NOT NULL DEFAULT 0,
  address VARCHAR(500) NULL,
  phone VARCHAR(50) NULL,
  email VARCHAR(255) NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

ALTER TABLE subcontractors
  ADD COLUMN address VARCHAR(500) NULL AFTER email,
  ADD COLUMN insurance_provider VARCHAR(255) NULL AFTER license_number,
  ADD COLUMN insurance_expires_on DATE NULL AFTER insurance_provider,
  ADD COLUMN w9_on_file BOOLEAN NOT NULL DEFAULT FALSE AFTER insurance_expires_on;

CREATE TABLE subcontractor_documents (
  id INT AUTO_INCREMENT PRIMARY KEY,
  subcontractor_id INT NOT NULL,
  category VARCHAR(100) NULL,
  filename VARCHAR(255) NOT NULL,
  original_name VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (subcontractor_id) REFERENCES subcontractors(id) ON DELETE CASCADE,
  INDEX idx_subcontractor_documents_sub (subcontractor_id)
);
