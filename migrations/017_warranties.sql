-- Warranty tracking — a home-services repeat-business driver: record what's covered on
-- each install, surface it to staff + the customer, and email a reminder before it lapses.
--
-- Optionally linked to the job it came from (job_id). reminder_sent_at makes the daily
-- expiry-reminder cron idempotent (same pattern as consultations.reminder_sent_at).
-- active soft-deactivates instead of deleting, matching products/labor_rates/subcontractors.

CREATE TABLE warranties (
  id INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL,
  job_id INT NULL,
  item VARCHAR(255) NOT NULL,               -- what's covered, e.g. "Lutron lighting" or "Labor"
  type VARCHAR(50) NULL,                     -- 'product' / 'labor' / free text
  provider VARCHAR(255) NULL,                -- manufacturer, or the company for labor warranties
  start_date DATE NULL,
  expires_on DATE NULL,
  coverage_notes TEXT NULL,
  reminder_sent_at TIMESTAMP NULL,           -- 30-day expiry reminder emailed
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (job_id) REFERENCES jobs(id),
  INDEX idx_warranties_customer (customer_id),
  INDEX idx_warranties_expires (expires_on)
);
