-- Customer self-service portal: magic-link login (no passwords, no self-signup).
--
-- Customers already exist in `customers` (staff-created). This table holds single-use,
-- expiring login tokens emailed as a magic link — the customer clicks it and gets a
-- session (req.session.customerId) that lets them see a dashboard of THEIR estimates,
-- invoices, and payments. Distinct from `access_tokens` (which grant access to one
-- specific estimate/invoice document); this grants a customer-scoped login instead.

CREATE TABLE customer_auth_tokens (
  id INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL,
  token VARCHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  INDEX idx_customer_auth_token (token)
);
