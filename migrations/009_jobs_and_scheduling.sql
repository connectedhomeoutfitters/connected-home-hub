-- CHO Hub — job/task tracking spanning the whole lifecycle (consultation execution,
-- estimate follow-ups, installs, ad-hoc reminders — not just "installation jobs" in
-- the traditional contractor sense), plus consultation scheduling (for calendar
-- invites) and linking estimates back to the consultation they were built from.

ALTER TABLE consultations
  MODIFY COLUMN consultation_date DATETIME NULL,
  ADD COLUMN duration_minutes INT NOT NULL DEFAULT 60 AFTER consultation_date,
  ADD COLUMN calendar_invite_sent_at TIMESTAMP NULL;

ALTER TABLE estimates
  ADD COLUMN consultation_id INT NULL AFTER customer_id,
  ADD FOREIGN KEY (consultation_id) REFERENCES consultations(id);

CREATE TABLE jobs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  type ENUM('consultation', 'estimate_followup', 'install', 'other') NOT NULL DEFAULT 'other',
  title VARCHAR(255) NOT NULL,
  customer_id INT NOT NULL,
  consultation_id INT NULL,
  estimate_id INT NULL,
  assigned_to INT NULL,
  status ENUM('pending', 'in_progress', 'done', 'cancelled') NOT NULL DEFAULT 'pending',
  due_date DATE NULL,
  scheduled_at DATETIME NULL,
  notes TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (consultation_id) REFERENCES consultations(id),
  FOREIGN KEY (estimate_id) REFERENCES estimates(id),
  FOREIGN KEY (assigned_to) REFERENCES users(id),
  INDEX idx_jobs_status (status),
  INDEX idx_jobs_assigned (assigned_to)
);
