-- Line items on invoices. Prerequisite 1 of docs/adr/0002-recurring-services.md.
--
-- `invoices` carries a single `amount` and a single `description`. That is enough for
-- "Deposit on Q-1042", and hopeless for the monthly rollup a recurring service needs —
-- "Aug 4 mow $45, Aug 18 mow $45, Sep 1 skipped" cannot be expressed at all. Recurring
-- billing is unbuildable until an invoice can itemise.
--
-- Mirrors estimate_line_items deliberately (same column names, same decimal precision) so
-- the two read alike, but WITHOUT the estimate-only columns: product_id, labor_rate_id,
-- subcontractor_id, unit_cost and hide_price all exist to price and cost a job before it
-- is sold. An invoice records what is being charged, after the fact.
--
-- `invoices.amount` REMAINS the total and the source of truth. Lines are optional detail,
-- so every existing invoice and every existing query keeps working untouched —
-- remainingBalanceForEstimate, the payments reconciliation and the Ledger push all still
-- read `amount`. Code that writes lines is responsible for making them sum to it; nothing
-- silently recomputes the total behind a user's back.

CREATE TABLE invoice_line_items (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  org_id       INT NOT NULL,
  invoice_id   INT NOT NULL,
  description  VARCHAR(500) NOT NULL,
  quantity     DECIMAL(10,2) NOT NULL DEFAULT 1.00,
  unit_price   DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  -- Set when the line is a recurring-service visit, so a rollup invoice can point back at
  -- the job it bills. Nullable: a hand-typed line has no job. FK deliberately omitted for
  -- now — jobs gains the service type in a later migration, and a hard reference would
  -- order these two migrations against each other for no benefit.
  job_id       INT NULL,
  sort_order   INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_ili_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
  -- Every read is "the lines on this invoice, in order", and org_id leads so the
  -- tenant-scoping guard in config/scopedDb.js has an index to use.
  KEY idx_ili_org_invoice (org_id, invoice_id, sort_order),
  -- Lets the recurring biller ask "has this visit already been billed?" cheaply, which is
  -- what stops a month-end run double-billing a visit.
  KEY idx_ili_job (org_id, job_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
