-- Project close-out — the final workflow step. A job that's `done` can be "closed out"
-- once the final invoice is collected: closed_at is stamped and the customer is emailed
-- their warranty documentation. closed_at is a milestone on top of status='done' (not a
-- new status), so the existing job status flow is untouched.

ALTER TABLE jobs
  ADD COLUMN closed_at TIMESTAMP NULL AFTER status;
