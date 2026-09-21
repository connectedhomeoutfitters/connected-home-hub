-- ConnectedWorkOS — Migration 043: Square as a second card processor
-- docs/adr/0003-payment-providers.md
--
-- Some tenants already run their business on Square (POS, readers, payouts) and want
-- WorkOS invoices to land in that same account rather than opening a Stripe account just
-- for us. Square's OAuth model is close to Stripe Connect's — the seller authorises our
-- application against THEIR account and their customers' money settles to THEM — with one
-- material difference: Square hands us per-merchant access + refresh tokens that we must
-- hold (encrypted, see services/secretBox.js) and renew, where Stripe only needs an
-- account id alongside our own key.
--
-- `payment_provider` is an explicit switch, for the same reason `uses_platform_stripe` is:
-- a newly provisioned org has NULL in every id column of both providers, and "which one is
-- set" must never decide where money goes.

ALTER TABLE orgs
  ADD COLUMN payment_provider ENUM('stripe', 'square') NOT NULL DEFAULT 'stripe' AFTER uses_platform_stripe,
  ADD COLUMN square_merchant_id VARCHAR(64) NULL AFTER stripe_oauth_state,
  -- Display only, like stripe_account_name.
  ADD COLUMN square_merchant_name VARCHAR(255) NULL AFTER square_merchant_id,
  -- Every Square payment is taken at a location. Most sellers have one; a multi-location
  -- seller picks in Settings.
  ADD COLUMN square_location_id VARCHAR(64) NULL AFTER square_merchant_name,
  ADD COLUMN square_location_name VARCHAR(255) NULL AFTER square_location_id,
  -- AES-256-GCM sealed blobs, never plaintext. TEXT because a sealed value is longer than
  -- the token itself.
  ADD COLUMN square_access_token TEXT NULL AFTER square_location_name,
  ADD COLUMN square_refresh_token TEXT NULL AFTER square_access_token,
  -- Square access tokens live ~30 days; a daily cron renews anything close to expiry.
  ADD COLUMN square_token_expires_at DATETIME NULL AFTER square_refresh_token,
  ADD COLUMN square_connected_at TIMESTAMP NULL AFTER square_token_expires_at,
  -- OAuth CSRF guard, written when the flow starts and cleared when redeemed — same shape
  -- as stripe_oauth_state.
  ADD COLUMN square_oauth_state VARCHAR(64) NULL AFTER square_connected_at,
  -- One Square account may be bound to one tenant, or one seller's payments would land in
  -- another tenant's books.
  ADD UNIQUE KEY uniq_orgs_square_merchant (square_merchant_id);

ALTER TABLE payments
  -- Which processor took a card payment. NULL for offline (cash/cheque/...) rows, which
  -- have no processor at all.
  ADD COLUMN provider ENUM('stripe', 'square') NULL AFTER method,
  -- Square's payment id is the handle for refunds and the webhook, as stripe_charge_id is
  -- for Stripe. UNIQUE (NULLs permitted) so the webhook can update by it.
  ADD COLUMN square_payment_id VARCHAR(64) NULL AFTER stripe_charge_id,
  ADD UNIQUE KEY uniq_payments_square_payment (square_payment_id);

UPDATE payments SET provider = 'stripe' WHERE stripe_payment_intent_id IS NOT NULL;

ALTER TABLE refunds
  ADD COLUMN provider ENUM('stripe', 'square') NOT NULL DEFAULT 'stripe' AFTER payment_id,
  -- A Square refund has no Stripe id. UNIQUE survives: MariaDB allows repeated NULLs.
  MODIFY COLUMN stripe_refund_id VARCHAR(255) NULL,
  -- 255 not 64: a Square refund id is "<payment id>_<suffix>", ~60 chars on its own.
  ADD COLUMN square_refund_id VARCHAR(255) NULL AFTER stripe_refund_id,
  ADD UNIQUE KEY uniq_refunds_square_refund (square_refund_id);
