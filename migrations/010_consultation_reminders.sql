-- Tracks whether the automated pre-visit reminder email has gone out for a
-- consultation, so the hourly reminder job doesn't re-send. Reset to NULL on
-- reschedule so a changed appointment gets a fresh reminder for its new time.
ALTER TABLE consultations
  ADD COLUMN reminder_sent_at TIMESTAMP NULL AFTER calendar_invite_sent_at;
