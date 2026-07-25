-- Payments section: refunds + richer payment records for the sales journal.
--
-- The payments table already logs each Stripe PaymentIntent (deposit/final/standalone);
-- this adds the pieces the Payments UI needs: a refunds ledger, a cached refunded-total
-- and card/receipt details on each payment (populated by the webhook so the journal can
-- show "Visa ****4242" and link to Stripe's receipt without a live API call per row), and
-- a 'refunded' invoice status so a fully-refunded invoice reads correctly everywhere.

ALTER TABLE payments
  ADD COLUMN amount_refunded DECIMAL(10,2) NOT NULL DEFAULT 0 AFTER amount,
  ADD COLUMN stripe_charge_id VARCHAR(255) NULL AFTER stripe_payment_intent_id,
  ADD COLUMN card_brand VARCHAR(30) NULL,
  ADD COLUMN card_last4 VARCHAR(4) NULL,
  ADD COLUMN receipt_url VARCHAR(500) NULL;

-- One row per Stripe refund. amount is this refund's own amount (Stripe allows several
-- partial refunds against one charge); payments.amount_refunded is the running total,
-- recomputed as SUM(succeeded refunds) so reconciliation stays idempotent whether the
-- refund route or the charge.refunded webhook applies it first.
CREATE TABLE refunds (
  id INT AUTO_INCREMENT PRIMARY KEY,
  payment_id INT NOT NULL,
  stripe_refund_id VARCHAR(255) NOT NULL UNIQUE,
  amount DECIMAL(10,2) NOT NULL,
  reason VARCHAR(50) NULL,           -- Stripe reason enum: duplicate / fraudulent / requested_by_customer
  note VARCHAR(500) NULL,            -- free-text staff note (Stripe metadata + our record)
  status ENUM('pending', 'succeeded', 'failed', 'canceled') NOT NULL DEFAULT 'pending',
  created_by INT NULL,               -- staff user who issued it; NULL if seen first via webhook
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (payment_id) REFERENCES payments(id),
  FOREIGN KEY (created_by) REFERENCES users(id),
  INDEX idx_refunds_payment (payment_id)
);

ALTER TABLE invoices
  MODIFY COLUMN status ENUM('pending', 'paid', 'void', 'refunded') NOT NULL DEFAULT 'pending';
