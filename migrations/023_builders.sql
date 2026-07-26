-- Builder / GC relationship management — the general contractors and builders who refer
-- work to CHO. Customers can be attributed to a referring builder so referral volume and
-- revenue-by-builder can be tracked. (Distinct from `subcontractors`, who CHO hires out to.)

CREATE TABLE builders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  contact_name VARCHAR(255) NULL,
  phone VARCHAR(50) NULL,
  email VARCHAR(255) NULL,
  address VARCHAR(500) NULL,
  notes TEXT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE customers
  ADD COLUMN builder_id INT NULL AFTER address,
  ADD FOREIGN KEY (builder_id) REFERENCES builders(id);
