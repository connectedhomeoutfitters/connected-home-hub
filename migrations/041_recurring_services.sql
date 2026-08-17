-- Recurring services. The feature itself, per docs/adr/0002-recurring-services.md.
--
-- The central decision: a recurring service is a GENERATOR OF VISITS, not a billing
-- schedule. Visits are ordinary `jobs`, so they inherit the calendar, crew assignment, the
-- subcontractor portal and the existing billing hook without any of those learning what
-- recurrence is. Reschedule, skip and pause then become edits to one job row.

CREATE TABLE recurring_services (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  org_id        INT NOT NULL,
  customer_id   INT NOT NULL,
  -- Set when the series was sold through an estimate the customer signed, which is the
  -- normal path (ADR 0002: a standing authorisation to bill must not be the one thing with
  -- no signature). Nullable for a series entered by staff from a paper agreement.
  estimate_id   INT NULL,
  title         VARCHAR(200) NOT NULL,
  unit_price    DECIMAL(10,2) NOT NULL DEFAULT 0.00,

  cadence       ENUM('weekly','biweekly','monthly') NOT NULL DEFAULT 'weekly',
  -- 0=Sunday..6=Saturday, for weekly/biweekly. Monthly repeats on start_date's day of the
  -- month instead, so this is ignored there.
  day_of_week   TINYINT NULL,
  start_date    DATE NOT NULL,
  -- Season. NULL end_date = runs until ended by hand, which is what a year-round pest or
  -- pool contract wants.
  end_date      DATE NULL,

  status        ENUM('active','paused','ended') NOT NULL DEFAULT 'active',
  -- Suspends generation without losing the series or its history — the winter shutdown.
  -- NULL while active.
  paused_until  DATE NULL,

  notes         TEXT NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_rs_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  KEY idx_rs_org_status (org_id, status),
  KEY idx_rs_customer (org_id, customer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE jobs
  -- 'service' is a recurring visit. The existing four types are untouched, so every job in
  -- the system keeps behaving exactly as before.
  MODIFY COLUMN type ENUM('consultation','estimate_followup','install','other','service') NOT NULL,
  ADD COLUMN recurring_service_id INT NULL AFTER estimate_id,
  -- WHICH visit in the series this is. Distinct from scheduled_at on purpose: rescheduling
  -- moves the appointment (scheduled_at) but not the visit's identity (visit_date), so a
  -- moved visit is still the same visit and cannot be generated a second time, and it
  -- still bills in the month it belonged to.
  ADD COLUMN visit_date DATE NULL AFTER recurring_service_id;

-- Idempotency enforced by the DATABASE rather than by application logic, because the
-- generator runs nightly and a double-generated visit means a double-billed customer.
-- MariaDB permits repeated NULLs in a UNIQUE index, so the thousands of ordinary jobs
-- (recurring_service_id NULL) coexist without colliding.
ALTER TABLE jobs
  ADD UNIQUE KEY uniq_job_visit (recurring_service_id, visit_date);
