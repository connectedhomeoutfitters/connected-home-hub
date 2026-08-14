-- CHO Hub — Migration 035: Stripe Connect
-- Phase 4 of docs/adr/0001-multi-tenancy.md — the blocker before a second tenant can take
-- money.
--
-- Until now every PaymentIntent was created directly on OUR Stripe account. With a second
-- tenant that means their customer's deposit settles into Connected Home Outfitters' bank
-- account, which would make us a payment facilitator for someone else's revenue: we'd owe
-- them the funds, absorb their chargebacks, and carry their income on our 1099-K. Connect
-- (Standard accounts) puts each contractor on their own Stripe account, owning their KYC,
-- disputes, payouts and processing fees.
--
-- orgs.stripe_account_id already existed (migration 030); this adds the surrounding state.

ALTER TABLE orgs
  -- TRUE only for Connected Home Outfitters, whose Stripe account IS the platform account.
  -- Stripe won't let a platform connect to itself, so org 1 keeps charging directly and
  -- everyone else charges through a connected account. This is an explicit flag rather
  -- than inferring "NULL stripe_account_id means platform" — a newly provisioned org also
  -- has NULL there, and it must NOT be able to take payments into our account.
  ADD COLUMN uses_platform_stripe TINYINT(1) NOT NULL DEFAULT 0 AFTER stripe_account_id,
  ADD COLUMN stripe_connected_at TIMESTAMP NULL AFTER uses_platform_stripe,
  -- Display only: the business name Stripe reports for the connected account, so Settings
  -- can show "Connected: Dave's Low Voltage" rather than a bare acct_ id.
  ADD COLUMN stripe_account_name VARCHAR(255) NULL AFTER stripe_connected_at,
  -- Guards the OAuth callback against CSRF / replay. Written when the admin starts the
  -- flow, cleared the moment it's redeemed.
  ADD COLUMN stripe_oauth_state VARCHAR(64) NULL AFTER stripe_account_name,
  ADD UNIQUE KEY uniq_orgs_stripe_account (stripe_account_id);

-- Connected Home Outfitters keeps charging on the platform account exactly as before, so
-- this migration is a no-op for live billing.
UPDATE orgs SET uses_platform_stripe = 1 WHERE id = 1;
