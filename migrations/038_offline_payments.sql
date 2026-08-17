-- Offline payments: cash, cheque, bank transfer, Venmo / Cash App / Zelle.
--
-- Until now the ONLY way an invoice could become paid was the Stripe webhook, and
-- `payments` had nowhere to express a payment that did not come from Stripe. A customer
-- who paid cash left the invoice `pending` forever, and staff's only lever was `void` —
-- which means "this invoice should not have existed", not "this was paid".
--
-- The consequence that actually mattered: services/ledgerSync.js#pushPaidInvoice is called
-- from exactly one place, the payment_intent.succeeded handler. So cash revenue never
-- reached the tenant's Connected Home Ledger books at all — the opposite of the product's
-- central promise. Manual payments go through the same push.

ALTER TABLE payments
  -- 'other' deliberately covers Venmo / Cash App / Zelle rather than enumerating apps that
  -- come and go; `reference` carries the detail ("Venmo @dana", cheque no. 1042).
  ADD COLUMN method ENUM('card','cash','check','bank_transfer','other') NOT NULL DEFAULT 'card' AFTER invoice_id,
  ADD COLUMN reference VARCHAR(120) NULL AFTER method,
  -- When the money actually changed hands, which is not when it was typed in. created_at
  -- keeps its own meaning (when the row was written) so both facts survive.
  ADD COLUMN received_at DATETIME NULL AFTER reference,
  -- Who recorded it. A card payment has Stripe as its witness; a cash payment has a person,
  -- so the person is the audit trail.
  ADD COLUMN recorded_by INT NULL AFTER received_at;

-- Every existing row came from Stripe, and the column default already says 'card' — this
-- is belt and braces for any row written between deploy and migrate.
UPDATE payments SET method = 'card' WHERE stripe_payment_intent_id IS NOT NULL;

-- A cash payment has no PaymentIntent. The column is NOT NULL today, which is what makes
-- this migration necessary rather than optional.
--
-- Its UNIQUE index is kept: MariaDB permits repeated NULLs in a UNIQUE index, so many
-- offline payments coexist happily while Stripe ids stay unique. That uniqueness is load-
-- bearing — routes/webhooks.js updates the payment row by intent id.
ALTER TABLE payments
  MODIFY COLUMN stripe_payment_intent_id VARCHAR(255) NULL;
