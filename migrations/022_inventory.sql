-- Inventory v1. Opt-in per product (track_inventory), building on catalog-linked line
-- items: when an install job completes, the products on its estimate are consumed from
-- stock. stock_movements is the audit trail (receive / adjust / consume) — stock_qty is
-- always the running total those movements produce.

ALTER TABLE products
  ADD COLUMN track_inventory TINYINT(1) NOT NULL DEFAULT 0 AFTER active,
  ADD COLUMN stock_qty INT NOT NULL DEFAULT 0 AFTER track_inventory,
  ADD COLUMN reorder_level INT NULL AFTER stock_qty;

CREATE TABLE stock_movements (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  delta INT NOT NULL,                  -- +received / -consumed / ± adjustment
  reason ENUM('receive', 'consume', 'adjust') NOT NULL,
  job_id INT NULL,                     -- set for 'consume' (which install job used it)
  note VARCHAR(255) NULL,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (job_id) REFERENCES jobs(id),
  FOREIGN KEY (created_by) REFERENCES users(id),
  INDEX idx_stock_movements_product (product_id),
  INDEX idx_stock_movements_job (job_id)
);
