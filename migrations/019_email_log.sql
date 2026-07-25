-- Email delivery logging. Outbound mail (estimate/invoice/receipt/reminder/magic-link)
-- was fire-and-forget — a bounced estimate email was a silent lost sale. Every send
-- attempt now records a row here so staff can confirm what actually went out (admin
-- Email Log under Settings). status: 'sent' (accepted by SMTP), 'failed' (threw),
-- 'skipped' (SMTP not configured).

CREATE TABLE email_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  recipient VARCHAR(255) NOT NULL,
  template VARCHAR(100) NULL,
  subject VARCHAR(255) NULL,
  status ENUM('sent', 'failed', 'skipped') NOT NULL,
  error VARCHAR(500) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_email_log_created (created_at),
  INDEX idx_email_log_status (status)
);
