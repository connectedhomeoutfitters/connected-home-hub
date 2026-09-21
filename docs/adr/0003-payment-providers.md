# ADR 0003 — Square as a second card processor

- **Status:** Accepted, implemented and verified on the sandbox (2026-09-21)
- **Date:** 2026-09-21
- **Relates to:** `0001-multi-tenancy.md` phase 4 (Stripe Connect). Every table touched
  carries `org_id` and obeys the `config/scopedDb.js` guard; the static sweep in
  `test/queryScoping.test.js` still passes.

---

## Context

Several prospective tenants already run their business on Square — POS, readers, payouts —
and asked whether WorkOS invoices could land in that same account rather than opening a
Stripe account just for us. The first concrete case is a contractor who takes every card
payment on Square today.

Before this, Stripe was the only processor. It was more contained than it looked: eight
API call sites in five files, one routing seam (`services/stripeAccounts.js#
paymentContext`) deciding which account an org's money moves through, and a `payments`
table that migration `038` had already made processor-neutral in shape (nullable
`stripe_payment_intent_id`, `method`, provider-agnostic `card_brand`/`card_last4`/
`receipt_url`). Everything downstream — the Payments list, CSV export, Reports, customer
360, builder revenue, the Ledger bookkeeping sync — reads `payments`, not Stripe.

## Decision

**One provider per org, chosen by an explicit switch, with the tenant's own account on
either side.** `orgs.payment_provider ENUM('stripe','square')` picks the processor; each
side keeps its own connection state. Square's model maps onto what phase 4 built with
three real differences, all of which are Square's rather than ours:

| | Stripe (phase 4) | Square (this ADR) |
|---|---|---|
| Tenant onboarding | Connect OAuth → we store only `stripe_account_id` and call with our key | OAuth → Square hands us a per-merchant **access token (30-day) + refresh token**; we hold them **sealed** and renew them |
| Client flow | Server creates PaymentIntent → browser confirms it | Browser tokenises the card (Web Payments SDK) → server calls `CreatePayment` with the token + a `location_id` + an idempotency key |
| Confirmation | Webhook is the source of truth | `CreatePayment` normally returns `COMPLETED` synchronously; the `payment.updated` webhook lands on the same idempotent settle path |

### What was deliberately NOT done

- **No `square` npm dependency.** The surface is eight REST calls and a five-line HMAC;
  `services/squareApi.js` is a thin `fetch` client. The SDK's BigInt money types sit badly
  next to `DECIMAL(10,2)` columns, and every new dependency has to be installed on the NAS
  before PM2's watch mode restarts into it (see CLAUDE.md). Same reasoning as
  `services/ledgerSso.js`.
- **No platform Square account.** CHO is on Stripe and stays there. Every Square tenant is
  a connected merchant; there is no `uses_platform_square` and nothing to fall back to.
  An unconnected tenant cannot take payment at all — `POST /i/:token/pay` returns 503 —
  exactly as phase 4 decided for Stripe.
- **No dual-mode.** An org with both processors connected picks one in Settings; existing
  payments and refunds stay with whichever processor took them (`payments.provider`,
  `refunds.provider`).
- **No pre-emptive provider abstraction beyond what two providers need.**
  `services/paymentProvider.js#paymentContextFor(orgId)` returns a tagged union; the pay
  route and pay page branch on `provider`. A third processor would be the moment to
  generalise further, not before.

### Holding another business's credentials

Phase 4 was explicit that we never store another business's API keys. Square's OAuth
tokens are the closest we have come. The distinction that makes it acceptable: it is a
scoped, revocable grant (`PAYMENTS_WRITE`, `PAYMENTS_READ`, `MERCHANT_PROFILE_READ` — no
bank, inventory or customer access), issued to our application by the seller's consent,
which the seller can revoke from their own dashboard at any time. It is not their
account's API key. Mitigations:

- Tokens are stored **AES-256-GCM sealed** (`services/secretBox.js`, key in
  `SQUARE_TOKEN_ENCRYPTION_KEY`) — never plaintext, never logged. Losing the key means
  tenants reconnect Square; it is a nuisance, not a breach.
- Disconnect **revokes** the grant at Square (best-effort) as well as clearing our copy.
- Square is simply unavailable in Settings if the encryption key is unset — fail closed.

## Consequences

### Schema — `043_square_payments.sql`

- `orgs`: `payment_provider`, `square_merchant_id` (UNIQUE — one Square account, one
  tenant), `square_merchant_name`, `square_location_id`/`_name`, sealed
  `square_access_token`/`square_refresh_token`, `square_token_expires_at`,
  `square_connected_at`, `square_oauth_state`.
- `payments`: `provider` (NULL for offline rows), `square_payment_id` (UNIQUE).
- `refunds`: `provider`, `stripe_refund_id` made nullable, `square_refund_id` (UNIQUE,
  **VARCHAR(255)** — a Square refund id is `<payment id>_<suffix>`; 64 was too short and
  cost a real 500 on the first sandbox refund).

### One place an invoice becomes paid — `services/invoicePayment.js`

Three things can now pay an invoice (Stripe webhook, Square settle, staff recording cash).
`latchInvoicePaid()` is the `status <> 'paid'` latch and `afterInvoicePaid()` the
consequences (activity entry, receipt, Ledger push). Before this the latch and its
side-effects were copied between `routes/webhooks.js` and `services/manualPayment.js`;
now all three paths call the same two functions.

### One place a refund is reconciled — `services/paymentsSync.js`

`reconcileRefunds()` takes whichever processor id the caller has and re-reads the truth
from that processor (Stripe lists by charge; Square's payment carries `refund_ids`).
`amount_refunded` is always recomputed, never incremented, so the admin route and the
webhook can both run in any order.

**Customer notification is keyed to the TRANSITION into succeeded, observed inside
reconciliation.** Found on the sandbox: Square answers a refund request with `PENDING`
and completes it via `refund.updated` seconds later, so a route that only notifies on a
synchronous success would never email the customer. Both routes now insert their row as
`pending` and let reconciliation notify exactly once, whichever path sees the transition.
Stripe hid this because its refunds succeed synchronously.

### Webhooks

`POST /webhooks/square` (`express.raw`, HMAC-SHA256 over **notification URL + body**,
base64, timing-safe compare). The URL being part of the signed input means the app must
sign with the exact URL registered in the Developer Console — computed from
`BASE_URL + BASE_PATH`, overridable with `SQUARE_WEBHOOK_URL`. Events: `payment.created`,
`payment.updated`, `refund.created`, `refund.updated`. Each event's `merchant_id` is
cross-checked against the org that owns the payment row, mirroring the Stripe handler's
`event.account` check — a mismatch is ignored, never reconciled.

**Events are not ordered.** Seen on the sandbox: `payment.created` (status `APPROVED`)
arrived *after* the synchronous `COMPLETED` settle and dragged the payments row back to
`pending` (the invoice stayed paid only because of the latch). `settleSquarePayment` now
never lets a row that reached `succeeded` regress.

### CSP — the fifth member of the family

- `script-src`/`frame-src`: `web.squarecdn.com`, `sandbox.web.squarecdn.com`;
  `connect-src`: `pci-connect.squareup.com`, `pci-connect.squareupsandbox.com`,
  `o160250.ingest.sentry.io` (Square's published list).
- **`form-action` needs the apex AND a wildcard for each environment** —
  `squareup.com`, `*.squareup.com`, `squareupsandbox.com`, `*.squareupsandbox.com`. The
  authorize URL is a redirect chain (`connect.squareup.com` → `squareup.com` → `/logout`
  → `/login`) and Chrome enforces `form-action` on every hop. With only
  `connect.squareupsandbox.com` listed the "Connect with Square" button did nothing at all;
  the only evidence was a `securitypolicyviolation` event naming our own form URL.

### Token renewal — a seventh cron

`45 2 * * *` → `services/squareAccounts.js#refreshExpiringTokens` renews any token
within seven days of lapsing; `accessTokenFor()` also renews inline if a request finds one
that close. A failed renewal falls back to the existing token and is retried tomorrow.

### Setup — what the platform owner does once

One Square Developer application ("ConnectedWorkOS") holds a sandbox and a production
side. Per side: Application ID + Application **Secret** (not the Access Token shown on the
same page — that is our own account's token and is unused), OAuth redirect URL
`<BASE_URL><BASE_PATH>/admin/settings/payments/square/callback`, and a webhook subscription
to `<BASE_URL><BASE_PATH>/webhooks/square` whose Signature Key goes in
`SQUARE_WEBHOOK_SIGNATURE_KEY`. The app can stay unlisted; App Marketplace review is only
for the marketplace. Tenants need nothing beyond the Square seller account they already
have.

**Sandbox OAuth only works if the test seller's sandbox dashboard is open in the same
browser first** (Developer Console → Sandbox test accounts → Square Dashboard). Otherwise
the authorize page errors with "first launch the seller test account". Production has a
real login page and no such step.

### Verified on the sandbox (2026-09-21)

Against the NAS test instance with test seller "Test Contractor" (`MLYSP0YG9NN11`):
OAuth handshake → merchant, name and single location stored, tokens sealed (`v1:` blobs
that decrypt to a real `EAAA…` token), 30-day expiry recorded, state cleared, provider
switched, activity logged → card form mounted under the CSP → `cnon:card-nonce-ok`
payment `COMPLETED` synchronously with card details and receipt URL cached, invoice paid,
exactly one receipt email and one `invoice.paid` entry → `payment.updated` webhook
verified and idempotently skipped → `cnon:card-nonce-declined` refused with Square's
cardholder message and a second attempt on the paid invoice refused → partial refund
reconciled from Square's records, full refund flipping the invoice to `refunded`,
`refund.updated` completing a `PENDING` refund and firing exactly one notification →
a Stripe test-mode `pm_card_visa` charge and refund on org 1 still working through the
refactored shared paths.

## Open items

- **Buyer verification (SCA).** `payments.verifyBuyer()` is optional for US cards and was
  skipped. Add it (and pass `verification_token` to `CreatePayment`) before any non-US
  tenant connects.
- **Currency** is `USD` throughout, as it was for Stripe. A location's currency is
  available from `ListLocations` if that ever changes.
- **In-person payments** (Square Terminal / Reader) are a separate API and a separate
  feature; this ADR is online invoice payment only.
- **Production** needs the `_PROD` values from the vault under the plain names on the VPS,
  migration `043`, and the production redirect URL + webhook subscription (both already
  registered in the Developer Console).
