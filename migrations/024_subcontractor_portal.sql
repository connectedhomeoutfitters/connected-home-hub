-- Subcontractor portal — the third access tier (staff Passport / customer session /
-- subcontractor session). Subs log in with a magic link (no password), same pattern as
-- the customer portal (req.session.customerId), and see the jobs assigned to them.
--
-- jobs.subcontractor_id was deferred alongside the portal; it lands here so a job can be
-- assigned to a sub and show on their dashboard.

ALTER TABLE jobs
  ADD COLUMN subcontractor_id INT NULL AFTER assigned_to,
  ADD FOREIGN KEY (subcontractor_id) REFERENCES subcontractors(id);

CREATE TABLE subcontractor_auth_tokens (
  id INT AUTO_INCREMENT PRIMARY KEY,
  subcontractor_id INT NOT NULL,
  token VARCHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (subcontractor_id) REFERENCES subcontractors(id) ON DELETE CASCADE,
  INDEX idx_sub_auth_token (token)
);
