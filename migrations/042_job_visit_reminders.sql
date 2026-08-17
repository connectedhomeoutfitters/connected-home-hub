-- Pre-visit reminders for recurring service visits.
--
-- The customer asked for "you have upcoming service scheduled for X" — a heads-up so
-- somebody unlocks the gate and moves the car, not a payment prompt. Under pay-after-
-- service (ADR 0002) there is nothing to collect before the visit anyway.
--
-- reminder_sent_at is the idempotency latch, exactly as on consultations and warranties:
-- the sweep runs hourly and this is what stops a second email on the second run.
ALTER TABLE jobs
  ADD COLUMN reminder_sent_at DATETIME NULL AFTER scheduled_at;

-- Rescheduling must re-arm the reminder, or a customer told "Tuesday" never hears that it
-- moved to Thursday. Handled in routes/admin/jobs.js on save (NULLs this when scheduled_at
-- changes), mirroring how routes/admin/consultations.js re-arms on reschedule.
