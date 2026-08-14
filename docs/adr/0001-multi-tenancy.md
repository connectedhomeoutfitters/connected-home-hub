# ADR 0001 — Multi-tenancy: offering CHO Hub to Connected Home Ledger customers

- **Status:** Accepted
- **Date:** 2026-08-13
- **Supersedes:** the "initially internal-only … architected as though it could become a
  commercial SaaS later" note in `CLAUDE.md`. That day has arrived; this ADR is the plan.

---

## Context

CHO Hub is today a **single-tenant** application. Every table is global: `customers`,
`estimates`, `invoices`, `products`, `users` and 22 others all implicitly belong to
Connected Home Outfitters LLC. `company_settings` is literally a single always-`id=1`
row. Stripe PaymentIntents are created directly on the CHO Stripe account.

We want to sell Hub to other low-voltage / smart-home / AV contractors, reaching them
through **Connected Home Ledger**, which already has:

- user identity (Passport, local + Google) and a `users.plan` tier system,
- working Stripe **subscription** billing (`routes/billing.js`), and
- a **Business Workspace** concept (`migrations/025_business_workspace.sql`) — a
  per-user business identity with name, entity type, tax set-aside, and onboarding.

That business workspace row is the natural tenant boundary. A Ledger customer who runs a
contracting business is exactly the person who needs Hub.

## Decision

**Keep three separate apps and three separate databases.** Ledger becomes the identity
and subscription layer; Hub becomes a multi-tenant operations product; the WordPress
marketing site is unchanged.

Hub gains an `orgs` table. One row = one contracting business = one tenant.
Connected Home Outfitters is **org #1** and runs on exactly the same code path as every
other tenant — no special-casing, so we dogfood the multi-tenant path daily.

```
orgs
  id                      -- CHO is 1
  name, slug, status
  ledger_workspace_id     -- UNIQUE NULL → gymr_db.business_workspaces.id
  ledger_user_id          -- who owns/pays on the Ledger side
  stripe_account_id       -- their Stripe Connect account
  entitlement_expires_at  -- cached from Ledger's subscription state
  lead_webhook_secret     -- per-tenant inbound lead auth
```

Tenancy is **row-level in one shared database** (`org_id` on all 27 tenant tables), not
database-per-tenant.

### Rejected alternatives

| Option | Why not |
|---|---|
| Merge Hub into Ledger's codebase | 27 unrelated tables, unrelated domain model. Both project briefs already forbid mixing concerns, and a Hub bug would take Ledger's paying subscribers down. |
| Database-per-tenant | 30+ migrations × N tenants on every release, N backup/restore paths, and cross-tenant reporting becomes impossible. Not justified at our tenant count or data volume. |
| Serve Hub under Ledger's domain / `BASE_PATH` | Couples deploys and TLS, and makes Hub-without-Ledger impossible to sell later. |
| Schema-per-tenant (MariaDB databases as namespaces) | Same migration-fanout problem as DB-per-tenant with worse connection pooling. |

## Consequences

### The dominant risk is cross-tenant data leakage

There are ~180 query sites across `routes/` and `services/`. **One missed
`AND org_id = ?` means one contractor sees another contractor's customers.** This is the
single largest correctness risk in the project and it is not mitigated by discipline
across 180 hand-edited call sites.

Mitigation: `config/scopedDb.js` wraps the mysql2 pool with an org id and **refuses**
any statement that touches a tenant table without constraining `org_id`. Routes use
`req.db` (scoped) instead of importing `config/db` directly. Genuinely global queries —
resolving a random access token, cron sweeps across all orgs — must say so explicitly via
`req.db.unscoped.execute(...)`, which makes the exception visible in review and in
`grep` rather than invisible by omission.

### Timing is favourable

Prod and test are still essentially empty (33 products, 2 staff users, 2 templates, and
no customers/estimates/invoices/payments at all). The `org_id` backfill is therefore
trivial and effectively risk-free **right now**. Every real customer record added before
this lands makes the migration marginally harder, so phase 1 should go first.

### Schema consequences

- `users.email` and `users.google_id` stop being globally unique and become unique
  **per org** — the same person may legitimately be staff at two contracting businesses.
  Login therefore stops being "find the user by email" and needs an org resolution step
  (phase 3; harmless while only org 1 exists).
- `company_settings` stops being the single `id=1` row and becomes one row per org, keyed
  by `UNIQUE(org_id)`. `services/companySettings.js#getCompany()` takes an org id.
- `org_id` is added with `DEFAULT 1` to backfill existing rows, and the default is
  dropped **later**, by a second migration. Leaving it permanently would mean a
  forgotten `org_id` on an INSERT silently writes into Connected Home Outfitters' data
  instead of failing loudly — but dropping it in the same migration breaks every one of
  the ~180 existing query sites the instant it runs, since none of them supply `org_id`
  yet. Hence an **expand/contract pair**:
  `030_orgs_multitenancy.sql` (expand, keeps the default) → rewrite the query sites →
  `031_orgs_drop_default.sql` (contract). The app is functional at every point in
  between, which also means the rewrite can land incrementally rather than as one
  all-or-nothing commit.
- `org_id` also goes on child tables (`estimate_line_items`, `consultation_photos`,
  `estimate_template_items`, `subcontractor_documents`) even though they are reachable
  through their parent. Defense in depth: a query like
  `FROM estimate_line_items WHERE estimate_id = ?` leaks if the parent's org check is
  ever skipped.
- Random-token tables (`access_tokens`, `customer_auth_tokens`,
  `subcontractor_auth_tokens`) keep a **globally** unique token — the token itself is the
  secret — but still carry `org_id` so the resolved page renders the right branding.

### Stripe: Connect is required, and it is a legal issue, not plumbing

`routes/portal.js:246` creates PaymentIntents on **our** Stripe account. If another
contractor invoices their homeowner through Hub as-is, that money lands in Connected Home
Outfitters' bank account. That would make us a payment facilitator for someone else's
revenue: we would owe them the funds, absorb their chargebacks, and carry their income on
our 1099-K.

Decision: **Stripe Connect with Standard accounts.** Each tenant connects their own
Stripe account and owns their KYC, disputes, payouts, and processing fees. Consequences:

- every Stripe call becomes account-scoped —
  `stripe.paymentIntents.create({...}, { stripeAccount: org.stripe_account_id })`, and
  likewise in `services/paymentsSync.js` and `routes/webhooks.js`;
- the browser must mount `Stripe(pk, { stripeAccount })` in `public/js/page-pay.js`;
- **webhook org resolution moves from `metadata.source` to `event.account`**, because
  Connect events arrive tagged with the connected account. The `metadata.source =
  'cho-hub'` tag stays (Ledger still shares the platform account) and gains `org_id`.

Standard over Express: Express would let us take an application fee and control more of
the UX, but pulls liability and support burden back onto us. Start Standard; revisit
`application_fee_amount` only if we decide to take a cut of processing.

### Identity: SSO without touching Passport

Ledger mints a short-lived (60 s), single-use HMAC token —
`{ledger_user_id, workspace_id, email, name, plan, exp, jti}` — and redirects to
`hub/sso/ledger?t=…`. Hub verifies the signature, replay-checks the `jti`, finds-or-creates
the org by `ledger_workspace_id`, finds-or-creates the staff `users` row, then
`req.session.regenerate()` + `req.login()`.

This is deliberately **not** a fourth principal type. It is a new way to establish the
*existing* staff Passport session, which avoids the `serializeUser`/`deserializeUser`
`{type, id}` rework that `CLAUDE.md` has been deferring since the subcontractor portal.
Customer (`req.session.customerId`) and subcontractor (`req.session.subcontractorId`)
sessions are untouched.

Entitlement revocation hangs off Ledger's `syncSubscription()` / `cancelSubscription()`
(`routes/billing.js:209` and `:262`) — the two functions that already own all plan state —
which POST an entitlement update to Hub. The SSO token also carries the plan, so a lapsed
tenant is caught at next sign-in even if the webhook was missed.

### Per-tenant configuration

Everything currently hardcoded to CHO becomes org-scoped: company profile, logo, estimate
Terms & Conditions text (another contractor's legal terms are not ours), PDF header,
email branding, and the inbound lead webhook secret. Uploads move from
`uploads/consultations/<id>/` to `uploads/<org_id>/consultations/<id>/`, likewise for
`documents/` and `subcontractors/`.

Outbound email sends from **one neutral platform address** with the tenant's name as the
From display name and their address as reply-to. Per-tenant verified sending domains
(SPF/DKIM per contractor) is a support tarpit and is explicitly out of scope until a
customer asks for it.

### Product packaging

Hub is sold as a **Ledger add-on subscription**, not folded into the Premium tier: Hub
carries real per-tenant support cost, and an add-on cleanly allows selling Hub standalone
to a contractor who does not want Ledger.

The differentiating feature, once tenancy lands, is a one-way **Hub → Ledger** push: a
paid Hub invoice becomes a business income transaction in the tenant's Ledger business
workspace, and material/subcontractor costs become categorized business expenses. Ledger
already has `transactions`, `business_categories`, and Schedule C mapping
(`migrations/036_schedule_c_mapping.sql`). *"Run your jobs in Hub and your books fill
themselves in Ledger"* is a pitch neither Housecall Pro nor QuickBooks makes alone.

### Naming

`hub.connectedhomeoutfitters.com` is our brand, not a product brand; competitors will not
want to sign into it. The SaaS needs a neutral product host.

**Resolved 2026-08-14:** `connectedworkos.com` was purchased and the product moved to
`app.connectedworkos.com`. CHO does **not** keep a separate instance on the old host — it
is org #1 on the new domain like every other tenant, and the old host is a permanent 301
(there is only ever one deployment; a second one would fork the data). The apex is
reserved for a marketing site, which is why the app took `app.` rather than the apex.

Orgs resolve from the session, **not** from a subdomain — per-tenant subdomains and
custom domains are deferred until there is demand.

## Rollout

| Phase | Work | State at the end |
|---|---|---|
| **1a** | `orgs` table, `org_id` on 27 tables (migration 030), `config/scopedDb.js` + tests, `middleware/orgContext.js` | **Done 2026-08-13.** No user-visible change; org 1 = CHO |
| **1b** | Rewrote all query sites onto `req.db`; per-tenant cron sweeps; migration 031 dropped the backfill defaults | **Done 2026-08-13.** Foundation is safe; isolation verified with a live second org |
| **2** | Per-org settings, branding, uploads, mailer, terms | CHO still the only tenant, but nothing is hardcoded |
| **3** | Ledger SSO, org provisioning, entitlement webhook | **Built + verified on test 2026-08-13, not yet deployed.** A second tenant can sign in and run jobs — **but cannot take payments** |
| **4** | Stripe Connect | A second tenant is commercially usable |
| **5** | Ledger add-on billing, pricing page, Hub → Ledger bookkeeping sync | The differentiated product |

Phase 1 is the one to do slowly and carefully. Phases 3–5 are each roughly a session's
work on top of it.

### Conventions established in phase 1b

- **Routes never import `config/db`.** They use `req.db`, the scoped handle built by
  `middleware/orgContext.js`. `test/queryScoping.test.js` enforces this.
- **Services that take a `conn`/`exec` also take an `orgId`** (in the options object where
  one exists — `adjustStock`, `consumeForJob`, `activityLog.log`, `sendMail`), so they can
  join a caller's transaction. Services without one take `orgId` first and build their own
  scoped handle (`getCompany`, and the cron sweeps).
- **Cron jobs sweep tenants explicitly** via `services/orgs.js`'s `forEachActiveOrg`, which
  hands each callback a handle scoped to that org. A failure in one tenant is logged and
  skipped so it can't stall the sweep for everyone else.
- **Ownership checks on foreign keys from form bodies.** Any route accepting a
  `customer_id` (etc.) from the request body verifies it belongs to `req.orgId` before
  insert — `org_id` on the new row alone would not stop a forged id attaching a record to
  another tenant's customer.
- **Interpolated column lists must still spell out `org_id` literally** in the SQL string
  (see the consultations INSERT), or the static sweep can't see it.
- The five deliberately-unscoped lookups (staff login, access-token resolution, the two
  magic-link flows, refund reconciliation, lead intake) are each commented at the call site
  and listed in `ALLOWED_UNSCOPED` in `test/queryScoping.test.js`.
