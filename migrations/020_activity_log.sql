-- Activity / audit log. The customer-360 timeline reconstructs events from row
-- timestamps but can't say WHO did what (no actor) and can't show a global feed. This is
-- an append-only record of key lifecycle actions with actor attribution — staff member,
-- the customer (via portal/token), or the system (webhooks/cron).
--
-- actor_name/detail are denormalized so the feed renders without extra joins. customer_id
-- lets the feed be filtered to one customer (linked from their detail page).

CREATE TABLE activity_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  actor_type ENUM('staff', 'customer', 'system') NOT NULL DEFAULT 'system',
  actor_id INT NULL,
  actor_name VARCHAR(255) NULL,
  action VARCHAR(100) NOT NULL,        -- e.g. estimate.sent, estimate.accepted, invoice.paid, refund.issued
  entity_type VARCHAR(50) NULL,        -- estimate / invoice / payment / customer / ...
  entity_id INT NULL,
  customer_id INT NULL,
  detail VARCHAR(500) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_activity_customer (customer_id),
  INDEX idx_activity_created (created_at),
  INDEX idx_activity_entity (entity_type, entity_id)
);
