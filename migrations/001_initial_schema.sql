-- CHO Hub — initial schema
-- Staff (internal login) + customers (no password, token-based portal access)

CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  role ENUM('admin', 'staff') NOT NULL DEFAULT 'staff',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE customers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  phone VARCHAR(50),
  address VARCHAR(500),
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_customers_email (email)
);

CREATE TABLE estimates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  status ENUM('draft', 'sent', 'accepted', 'declined', 'expired') NOT NULL DEFAULT 'draft',
  subtotal DECIMAL(10,2) NOT NULL DEFAULT 0,
  tax DECIMAL(10,2) NOT NULL DEFAULT 0,
  total DECIMAL(10,2) NOT NULL DEFAULT 0,
  deposit_percent DECIMAL(5,2) NOT NULL DEFAULT 50.00,
  deposit_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  sent_at TIMESTAMP NULL,
  accepted_at TIMESTAMP NULL,
  expires_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  INDEX idx_estimates_customer (customer_id),
  INDEX idx_estimates_status (status)
);

CREATE TABLE estimate_line_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  estimate_id INT NOT NULL,
  description VARCHAR(500) NOT NULL,
  quantity DECIMAL(10,2) NOT NULL DEFAULT 1,
  unit_price DECIMAL(10,2) NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0,
  FOREIGN KEY (estimate_id) REFERENCES estimates(id) ON DELETE CASCADE,
  INDEX idx_line_items_estimate (estimate_id)
);

-- One row per bill a customer owes: the deposit, the final balance, or a standalone invoice
CREATE TABLE invoices (
  id INT AUTO_INCREMENT PRIMARY KEY,
  estimate_id INT NULL,
  customer_id INT NOT NULL,
  type ENUM('deposit', 'final', 'standalone') NOT NULL DEFAULT 'standalone',
  amount DECIMAL(10,2) NOT NULL,
  status ENUM('pending', 'paid', 'void') NOT NULL DEFAULT 'pending',
  due_date DATE NULL,
  sent_at TIMESTAMP NULL,
  paid_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (estimate_id) REFERENCES estimates(id),
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  INDEX idx_invoices_customer (customer_id),
  INDEX idx_invoices_estimate (estimate_id),
  INDEX idx_invoices_status (status)
);

CREATE TABLE payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  invoice_id INT NOT NULL,
  stripe_payment_intent_id VARCHAR(255) NOT NULL UNIQUE,
  amount DECIMAL(10,2) NOT NULL,
  status ENUM('pending', 'succeeded', 'failed') NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (invoice_id) REFERENCES invoices(id),
  INDEX idx_payments_invoice (invoice_id)
);

-- Signed, expiring links so customers can view/pay an estimate or invoice without an account
CREATE TABLE access_tokens (
  id INT AUTO_INCREMENT PRIMARY KEY,
  token VARCHAR(64) NOT NULL UNIQUE,
  resource_type ENUM('estimate', 'invoice') NOT NULL,
  resource_id INT NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_access_tokens_token (token)
);
