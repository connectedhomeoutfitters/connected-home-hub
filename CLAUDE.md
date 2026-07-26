# Connected Home Hub
## Claude Code Project Brief

Internal business-operations platform for **Connected Home Outfitters LLC**'s home
services business (repo/process name `choHubProject` / `cho-hub` — "CHO Hub" and
"Connected Home Hub" refer to the same thing). Sister project to `choProject` (the
WordPress marketing site, local copy at `C:\Users\cmasi\choProject` — outside the NAS,
unlike this project and gymrProject) and `gymrProject` / Connected Home Ledger (a
separate household-finance SaaS product). Do not mix concerns across the three:

| Project | Purpose | Users |
|---|---|---|
| `choProject` | WordPress marketing/lead-gen site — **no business logic belongs here** | public visitors |
| `gymrProject` (Connected Home Ledger) | Household Financial Command Center, subscription SaaS | GYMR subscribers |
| `choHubProject` (this project, Connected Home Hub) | Full customer-lifecycle ops platform for CHO's home-automation business | CHO staff (login) + CHO's customers (token links, no login) |

All three are owned by the same LLC (Connected Home Outfitters) and **share one Stripe
account** — see "Stripe" below for how this app stays distinguishable within it.

**Production URL:** `hub.connectedhomeoutfitters.com` — subdomain created (2026-07-22).
Deploys to the same Hostinger VPS that hosts Connected Home Ledger, but as its **own
PM2 process, own nginx server block, and own database**. DNS exists; nginx/PM2/TLS/app
deploy still not done (see "Deployment" below).

---

## Product vision (scope is bigger than what's currently built)

Per the CHO product-ecosystem vision (2026-07-22): Connected Home Hub is meant to
become the **full CRM/ops platform** for the home-services business — eventually
replacing multiple third-party tools — covering:

CRM & customer management · consultation forms · digital site surveys · photo uploads
· estimate generation · proposal management · e-approval · Stripe payments/invoice
tracking · job scheduling · material lists · job costing · inventory · builder
relationship management · reporting · document storage · warranty tracking · maps/GPS
· customer history · (future) a mobile field app.

**Target end-to-end workflow:**
lead submitted on the Outfitters WordPress site → lead created in Hub → consultation
completed digitally → photos/notes uploaded → estimate generated → customer approves
online → Stripe collects deposit → job scheduled → installation completed → final
payment collected → customer receives warranty documentation.

**What's actually scaffolded so far (this session) is only one slice of that**:
customers, estimates + line items, deposit/final invoices, Stripe payment collection,
and staff/customer access. CRM lead intake, consultation forms, site surveys, photo
uploads, job scheduling, material lists, job costing, inventory, builder relationship
management, document storage, warranty tracking, and maps/GPS are **not built** —
treat the current schema/routes as phase 1 (billing), not the finished data model.
Expect to extend the `customers`/`estimates` tables (or add new ones: `leads`, `jobs`,
`site_surveys`, `photos`, `materials`, `documents`) as later phases land — don't design
new features as if billing is the whole app.

**Long-term positioning:** initially internal-only, but deliberately meant to be
architected as though it could become a commercial SaaS for other low-voltage/smart-
home/AV contractors later. Practical implication for how to build features here: keep
business logic modular, avoid hard-coding Connected-Home-Outfitters-specific
assumptions into the data model where it's not costly to avoid, and prefer data-driven
configuration over hard-coded values (e.g. job types, material categories, proposal
templates) — without over-engineering phase-1 features for a multi-tenant future that
isn't being built yet.

**Shared-architecture aspiration across all three CHO products** (Node.js + Express +
MariaDB + JWT auth + Bootstrap + Stripe + REST APIs, with shared user accounts/email/
notifications/PDF generation/Stripe integration/logging/reporting/config reused across
apps): this is a **future direction, not current reality**. Ledger uses Passport local-
strategy + session cookies, and this app was scaffolded the same way for consistency
with Ledger's proven pattern rather than the vision doc's JWT recommendation. Don't
retrofit JWT or extract shared services unprompted — flag the gap when relevant, but
treat each app's current auth/session approach as the working baseline until asked to
change it.

---

## Why a separate app instead of extending Connected Home Ledger

Ledger already has working Passport auth, Stripe billing, and a proven Node/EJS/MariaDB
stack — this project's config/passport.js, config/stripe.js, config/db.js, and overall
layout **deliberately copy those patterns** (same tech stack, same conventions). But it
is a separate codebase and database because:
- The domain model is unrelated (customers/estimates/invoices vs. households/accounts/bills).
- A bug or deploy in one must not be able to take down or corrupt data in the other.

**Stripe account: shared, not separate.** Both apps bill through the same Stripe
account (Connected Home Outfitters LLC is the account holder for both GYMR's SaaS
subscriptions and CHO's contracting income) — a deliberate choice, not an oversight.
Because of that, every PaymentIntent this app creates is tagged
`metadata.source = 'cho-hub'` (see `routes/portal.js`), and the webhook handler
(`routes/webhooks.js`) checks that tag before acting — otherwise it would also try to
react to Ledger's subscription-payment webhook events, since Stripe delivers a given
event type to every registered endpoint on the account regardless of which app created
the underlying object. Register **this app's own webhook endpoint** in the Stripe
dashboard (its own URL, its own signing secret) rather than reusing Ledger's.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js + Express |
| Templates | EJS (server-side rendering) |
| Staff auth | Passport.js — local strategy (bcrypt) always on; Google OAuth optional, enabled when `GOOGLE_CLIENT_ID` is set |
| Customer access | Signed, expiring tokens (`access_tokens` table) — no customer accounts/passwords |
| Database | MariaDB |
| Session store | express-mysql-session |
| Payments | Stripe (PaymentIntents + Payment Element, webhook-driven reconciliation) |
| Process manager | PM2 (once deployed) |

---

## Database (test environment)

- **Host:** `192.168.4.199` (LAN — Synology NAS, same box class as gymrProject's MariaDB)
- **Port:** `3307`
- **DB name:** `choHub`
- **User:** `choHubWeb`
- Credentials live in `.env` (gitignored) — see `.env.example` for the shape.
- `config/db.js` — mysql2 promise pool. `db.execute()` returns `[rows, fields]`,
  always destructure: `const [rows] = await db.execute(...)`.
- For multi-step writes (e.g. marking an invoice paid + logging a payment), use a
  transaction: `const conn = await db.getConnection()` → `beginTransaction()` →
  `commit()`/`rollback()` → always `release()` in a `finally`. See
  `routes/webhooks.js` for the pattern.

### Migrations
Plain numbered `.sql` files in `migrations/`, tracked in a `schema_migrations` table.
```bash
npm run migrate
```
`001_initial_schema.sql` has the full initial schema: `users`, `customers`, `estimates`,
`estimate_line_items`, `invoices`, `payments`, `access_tokens`. `002_google_auth.sql`
adds Google OAuth support to `users` (`google_id`, `avatar_url`, `last_login`; makes
`password_hash` nullable for Google-only staff). `003_catalog_labor_subcontractors.sql`
adds `products` (the material catalog — `category`/`vendor`/`product_line` instead of
literally replicating the source spreadsheet's sparse `subcategory_1..10` columns;
`retail_price` is the field estimates read from, recomputed from `vendor_cost` +
`markup_percent` when `markup_enabled` is on, otherwise manually set), `labor_rates`,
and `subcontractors` (`trade` is free text, not an ENUM, since the roster of trades
isn't fixed). Staff CRUD for all three lives under `/admin/products`,
`/admin/labor-rates`, `/admin/subcontractors` — `routes/admin/products.js` /
`laborRates.js` / `subcontractors.js`. Rows are soft-deactivated (`active` flag), never
hard-deleted, since estimate line items will eventually reference them.

`005_leads_elementor_fields.sql` adds `leads` (replacing an earlier, wrong `004` version
built against a WPForms form that turned out to be dead/unused content on the
choProject site — see that project's own CLAUDE.md "Relationship to Connected Home
Hub" section for the full story). Leads arrive via `POST /webhooks/lead-intake`
(`routes/webhooks.js`, shared-secret auth via `LEAD_WEBHOOK_SECRET`, not a signature
scheme) from a WordPress mu-plugin hooked to the real lead form — an Elementor Pro
form, "FreeConsultForm". Staff work leads at `/admin/leads` (`routes/admin/leads.js`):
change `status`, or "Convert to Customer" (creates a `customers` row, links
`leads.customer_id`, lead stays around as history rather than being deleted).

`006_consultations.sql` adds `consultations` (the native on-site survey, replacing the
Google Form — see "Product vision" above) and `consultation_photos`. Explicit typed
columns for single-value fields, `JSON` columns for multi-select/checkbox fields and
the Wi-Fi coverage rating grid. `lead_id` is nullable, set automatically when a
consultation is started for a customer that came from a lead — `config/
leadToConsultationMapping.js` best-effort pre-fills the consultation's dropdowns from
that lead's answers (only where the two forms' option wording is unambiguous; the
consultation form also always shows the lead's raw answers in a reference panel, so
nothing from the lead is ever silently lost even when a field can't be auto-mapped).
Staff work: `/admin/consultations` (`routes/admin/consultations.js`), launched via
"New Consultation" on a customer row or the page's own customer picker. Site photos
(Section 9) are **never served through `express.static`** — private customer property
photos, stored under `uploads/consultations/<id>/` (excluded from the `N:`→`W:` gulp
sync — see "Local Dev / Test Hosting" below) and streamed only through an authenticated
route.

`007_estimate_acceptance.sql` / `008_estimate_tax_percent.sql` add `estimates.
accepted_ip` and `estimates.tax_percent`. The estimate builder
(`routes/admin/estimates.js`, `views/admin/estimate-form.ejs` +
`public/js/page-estimate-form.js`) has a dynamic line-item table that can pull from
the `products`/`labor_rates` catalog (auto-fills description/price, still editable) or
take fully custom lines — **the line-item input fields are named `line_description`/
`line_quantity`/`line_unit_price`, deliberately not `description`/`quantity`/
`unit_price`**: same-named form fields merge into one array on submit, and reusing the
estimate's own `description` field name for the line items silently corrupted both the
first time this was built (caught in testing, not a live incident, but don't reuse
those plain names elsewhere in this form).

**Send → accept → deposit flow, fully wired:** staff "Send to Customer"
(`POST /admin/estimates/:id/send`) creates an `access_tokens` row, emails the `/e/:token`
link with the estimate PDF attached (`services/estimatePdf.js` — pdfkit, a coded
layout, not a screenshot of the web view), and sets `status='sent'`. The customer's
`/e/:token` page shows `config/estimateTerms.js` — **real Terms & Conditions provided
by the business owner (2026-07-23), replacing the earlier non-legal placeholder**,
authored as HTML and rendered unescaped (safe: fully author-controlled content, never
user input) — with a required checkbox plus a **typed e-signature name field**
(`estimates.signature_name`). `POST /e/:token/accept` (`routes/portal.js`) rejects the
request if either the checkbox or the signature name is missing, otherwise sets
`status='accepted'` + `accepted_at`/`accepted_ip`/`signature_name`/
`accepted_user_agent` (added in `012_estimate_esignature.sql`) — staff can see this
full acceptance record on the estimate's admin page. It then calls
`createDepositInvoice()` (exported from `routes/admin/estimates.js`), creates a new
`access_tokens` row for that invoice, emails the `/i/:token` pay link
(`views/emails/deposit-invoice.ejs`), and redirects the customer straight there.
Payment itself was already scaffolded (Stripe PaymentIntent + Payment Element) and is
now exercised end-to-end by this flow — Stripe's Payment Element `return_url` sends
the customer to `GET /i/:token/next-steps` (`views/portal/next-steps.ejs`) once
confirmed; that route re-checks `invoices.status === 'paid'` before showing it (the
webhook, not the client redirect, is the source of truth) and bounces back to the pay
page otherwise. The webhook also emails a `payment-receipt` template on success.
**Final invoice creation is still the old manual staff action** — accepting an
estimate now auto-creates an `install`-type job (see "Jobs" below) as a placeholder
for that work, but nothing yet turns "job done" into "send the final invoice."

**Gotcha (found and fixed 2026-07-23): default Helmet CSP silently broke every inline
`<script>` block in the app, including Stripe payments entirely.** `helmet()`'s
default `script-src 'self'` blocks both inline `<script>` content (no nonce) and
cross-origin `<script src>` — meaning `views/portal/invoice.ejs`'s `window.CHO_HUB`
data (so `page-pay.js` never got a publishable key), `views/admin/estimate-form.ejs`'s
`window.CHO_HUB_CATALOG` (so the line-item catalog picker and live total silently
broke), and `js.stripe.com/v3` itself (so `Stripe()` never loaded, and the Payment
Element's iframes/API calls were blocked by the default `frame-src`/`connect-src`
fallback to `default-src 'self'`) were **all silently broken — nobody could actually
pay a deposit through this app**. No visible error banner; just an empty payment
area. Fixed in `server.js`: a per-request `res.locals.cspNonce` (set *before* `helmet()`
runs, since helmet reads it while building that same request's CSP header) plus
explicit `scriptSrc`/`frameSrc`/`connectSrc` exceptions for `js.stripe.com`/
`api.stripe.com`/`hooks.stripe.com`. Every inline `<script>` block in the app must
carry `nonce="<%= cspNonce %>"` or it silently no-ops under this CSP — check for this
first if a new inline script "does nothing" with no console error explaining why
(Chrome does log a `securitypolicyviolation` event, but nothing prints to the console
by default unless you listen for it). **Not fixed, flagged for later:** the same CSP's
`script-src-attr 'none'` also silently blocks inline event-handler attributes like
estimate-form.ejs's `onsubmit="return confirm(...)"` on "Send to Customer" — staff
never actually see that confirmation dialog, the form just submits immediately. Low
severity (no functional break, just a missing confirmation step) so left alone; fix
would be moving it to an addEventListener in a real script file rather than an inline
attribute.

`009_jobs_and_scheduling.sql` adds three things together, since they were asked for
as one connected phase:

- **`consultations.consultation_date`** changed from `DATE` to `DATETIME` (a real
  appointment time, not just "the date it happened"), plus `duration_minutes` and
  `calendar_invite_sent_at`. "Send Calendar Invite" on the consultation form
  (`POST /admin/consultations/:id/send-invite`) emails an `.ics` file to **both** the
  consultant (whoever's logged in — no per-staff Google account linkage, matches
  "for myself to use") and the customer — `services/calendarInvite.js` (the `ics`
  npm package), attached via nodemailer's `icalEvent` option (not a generic
  attachment — this is what makes calendar apps recognize and offer to add it).
  Deliberately **not** a real Google Calendar API integration — that would need
  re-consenting the Google OAuth login with Calendar scope and storing/refreshing a
  token per staff member; an `.ics` invite email needs neither.
- **`estimates.consultation_id`** (nullable) links an estimate back to the
  consultation it was built from. "Create Estimate from this Consultation" on the
  consultation form pre-fills the new estimate's title from
  `consultation.recommended_package` and description from `consultant_notes` — see
  `mapLeadToConsultation`-style reasoning in `routes/admin/estimates.js`'s `GET /new`.
- **`jobs`** — a general lifecycle task list, not just "installation jobs": `type`
  is `consultation` / `estimate_followup` / `install` / `other`, assignable to a
  staff member (`assigned_to`, per explicit decision — this app is single-user today
  but jobs are assignable from day one). Staff work jobs at `/admin/jobs`
  (`routes/admin/jobs.js`) — status changes, reassignment, due dates. **Auto-created**
  at three points, each reflecting who has (or doesn't have) a staff session at that
  moment:
  - Creating a consultation → a `consultation`-type job, assigned to whoever created it.
  - Sending an estimate → an `estimate_followup`-type job due 5 days out, assigned to
    whoever sent it.
  - A customer accepting an estimate (`routes/portal.js`, no staff session exists in
    that customer-facing route) → an `install`-type job, **left unassigned** for
    staff to claim from the Jobs list.

**Email: outbound SMTP is Google Workspace, confirmed working end-to-end** (as of
2026-07-23) — `services/mailer.js` (mirrors `N:\gymrProject\services\mailer.js`)
no-ops safely with a console warning if `SMTP_HOST` is ever unset, so nothing crashes
if this gets misconfigured later, but both `.env` and `W:\choHubProject\.env`
currently have real credentials: `smtp.gmail.com`, authenticated as
`chris@connectedhomeoutfitters.com` (an actual Workspace login — App Password
generated on that account), sending as its `Billing@connectedhomeoutfitters.com`
alias via `MAIL_FROM`. Since `connectedhomeoutfitters.com` is a real verified
Workspace domain, there's no sandbox/recipient restriction — confirmed by sending to
addresses unrelated to the sending account and having them actually arrive.

**Gotcha: Gmail's alias matching for "Send mail as" is case-sensitive.** The alias is
configured in Gmail (Settings → Accounts → "Send mail as") as
`Billing@connectedhomeoutfitters.com` (capital B) — `MAIL_FROM` using lowercase
`billing@` sent successfully (`250 OK`, no error) but Gmail silently rewrote the
visible From address back to `chris@connectedhomeoutfitters.com` instead of honoring
the alias, with nothing in the SMTP response indicating this happened. `MAIL_FROM`
must match the alias's exact casing as configured in Gmail, not just its lowercase
email-address equivalent.

**Earlier attempts, for context on why this ended up as the final choice:**
- **Brevo** (reusing `N:\zodiacpb2026`'s account): accepted and "queued" every test
  message (valid auth, full SMTP conversation succeeded) but never delivered anything
  and never appeared in Brevo's own transactional logs — even sent directly from the
  NAS's own IP. Likely an account-level block specific to zodiacpb2026's Brevo
  account. Don't reintroduce without solving that first.
- **Resend**: worked, but its sandbox mode restricts the *recipient*, not just the
  sender — email to any address other than the Resend account owner's own got
  rejected with `550 You can only send testing emails to your own email address`.
  Fine for verifying flow logic, not for testing real customer-facing delivery,
  without paying to verify a domain there.

**Production DB has not been provisioned yet** — only the test DB above exists. Get
real prod credentials before deploying, and never point production at the LAN test DB.

`013_settings_rbac_subcontractor_docs.sql` adds admin-only RBAC, company-wide settings,
and expanded subcontractor profiles/documents — a genuinely new access tier distinction,
not just another CRUD screen:

- **`users.active`** + **`middleware/auth.js`'s `requireAdmin`** (checks
  `req.user.role === 'admin'`, 403s otherwise) — the whole `/admin/settings/*` area is
  gated with `requireAuth, requireAdmin` together. `config/passport.js`'s local and
  Google strategies both now also reject `!user.active`, so deactivating staff actually
  blocks login, not just hides a nav link. **All 3 pre-existing `users` rows are
  `role='admin'`** (an artifact of `scripts/create-admin.js` always hardcoding
  `'admin'` — there was no other way to create a staff row before this) — flagged to
  the user 2026-07-24, not changed unilaterally since demoting an account is a real
  access change, not a formatting cleanup.
- **`company_settings`** is a single always-`id=1` row (`routes/admin/settings.js`
  upserts via `ON DUPLICATE KEY UPDATE`, never a real multi-row table) — company name,
  tax ID, address/phone/email, and `default_tax_percent`. The tax default actually
  does something: `routes/admin/estimates.js`'s `GET /new` reads it and pre-fills the
  new estimate's `tax_percent` field (still editable per estimate, same as always).
  Deliberately **not** wired into `services/estimatePdf.js` or `config/estimateTerms.js`
  (both still hardcode "Connected Home Outfitters LLC") — that would touch 3 call
  sites across `routes/portal.js`/`routes/admin/estimates.js` for a cosmetic win, out
  of scope for what was asked.
- **Staff management UI** (`/admin/settings/users`) replaces `scripts/create-admin.js`
  for day-to-day use (the CLI script still works, treat it as a break-glass fallback).
  New staff can be created with **no password** (`password_hash` stays `NULL`) for a
  Google-only account — matches how `config/passport.js`'s Google strategy already
  only ever attaches to an existing `users` row by email, never creates one.
  **Last-admin lockout protection**: `countOtherActiveAdmins()` in
  `routes/admin/settings.js` blocks any role/active change that would leave zero
  active admins, checked *before* the update is applied.
- **Subcontractor profiles** gained `address`, `insurance_provider`,
  `insurance_expires_on`, and `w9_on_file` columns, plus a **`subcontractor_documents`**
  table (W-9s, certificates of insurance, signed agreements — uploaded files, not a
  generated e-signature flow) — directly mirrors the `consultation_photos` pattern:
  multer disk storage under `uploads/subcontractors/<id>/`, never served via
  `express.static`, streamed only through an authenticated
  `GET /admin/subcontractors/:id/documents/:docId` route.
- **Explicitly deferred** (per 2026-07-24 scoping decision): a real subcontractor
  login/portal is a third access tier beyond staff sessions and token-linked customers,
  and would need Passport's `serializeUser`/`deserializeUser` to discriminate on a
  `{type, id}` shape rather than assuming one principal type — planned as its own
  follow-up session, not started here. `jobs.subcontractor_id` (linking a job to a sub)
  was deferred alongside it for the same reason — design it together with whatever
  the portal's job-assignment model ends up needing.

`014_payments_refunds.sql` adds the **Payments section** (`/admin/payments`,
`routes/admin/payments.js`, nav link between Invoices and Catalog) — a read layer over
the existing `payments` table plus Stripe refund support. It's a reporting/reconciliation
view, not a new billing path: money still gets *collected* through the estimate→accept→
deposit flow, this is where staff *see* it and *return* it.

- **List + sales-journal summary** (`GET /`): all payments joined to invoice/customer,
  with filters (payment status, invoice type, from/to date, customer search) shared by a
  single `buildFilters()` helper across the list, the summary tiles, and the CSV export
  so all three always agree. Summary tiles = collected / refunded / net / counts over the
  *filtered* set. **`GET /export.csv`** streams the same filtered set as a sales-journal
  CSV (hand-rolled escaping, no dep) for accounting.
- **Refunds** (`POST /:id/refund`, **`requireAdmin` — moves money out, admins only**,
  matching the Settings gate; the refund form in `payment-detail.ejs` is also hidden for
  non-admins). Supports partial refunds (blank amount = remaining balance). New
  **`refunds`** table (one row per Stripe refund; `payments.amount_refunded` is a cached
  running total; `invoices.status` gained **`'refunded'`** for the fully-refunded case).
- **`services/paymentsSync.js`'s `reconcileRefunds({chargeId, paymentIntentId})`** is the
  single reconciliation path, called by *both* the refund route and the webhook. It
  **re-lists the charge's refunds from Stripe** and recomputes `amount_refunded` as
  `SUM(succeeded refunds)` rather than incrementing — so it's idempotent no matter which
  path runs first or twice. It finds the payment by charge/PI id in our own table; a
  charge that isn't ours (e.g. a Ledger charge on the shared account) returns `null` and
  is ignored. **This is why the refund webhook can't use the `metadata.source` filter the
  payment-success handler uses** — the Stripe *charge* object doesn't inherit the
  PaymentIntent's metadata, so the DB lookup *is* the cho-hub filter.
- **Webhook changes (`routes/webhooks.js`):** `payment_intent.succeeded` now also
  retrieves the charge to cache `stripe_charge_id`/`card_brand`/`card_last4`/`receipt_url`
  on the payment (best-effort — a charge-lookup failure still marks the invoice paid), so
  the Payments list shows "Visa ••••4242" + a receipt link without a live API call per
  row. A new **`charge.refunded`** handler catches refunds issued straight from the Stripe
  dashboard (or async status changes) and runs the same `reconcileRefunds`. **Register
  `charge.refunded` on this app's Stripe webhook endpoint** alongside
  `payment_intent.succeeded`.
- On a successful refund the customer gets a **`refund-issued`** email
  (`views/emails/refund-issued.ejs`), mirroring the auto-sent `payment-receipt` — sent
  non-blocking so a mail failure never undoes a completed Stripe refund.

`015_customer_portal.sql` adds the **customer self-service portal** (magic-link login) —
a genuine **third access tier** alongside staff Passport sessions and the per-document
`access_tokens`. It's the multi-principal step CLAUDE.md previously flagged as deferred,
but done **without touching Passport**: customer sessions are a plain
`req.session.customerId`, parallel to (not through) Passport, so staff `requireAuth`
(`req.isAuthenticated()`) and customer `requireCustomer` (`middleware/customerAuth.js`)
can never satisfy each other. That deliberately sidesteps the serialize/deserialize
`{type,id}` rework — if the subcontractor portal ever lands, it can follow the same
separate-session pattern rather than overloading Passport.

- **No passwords, no self-signup.** `customer_auth_tokens` holds single-use, 30-min
  magic-link tokens. `POST /portal/login` only emails a link if the address already
  exists in `customers` (staff-created), and **always** renders the same "check your
  email" response either way — no account enumeration. Rate-limited (10/15min).
  `GET /portal/verify/:token` marks the token used, `req.session.regenerate()`s (session-
  fixation guard), sets `customerId`, redirects to `/portal`. Email template
  `views/emails/customer-magic-link.ejs`.
- **`GET /portal`** (`routes/customerPortal.js`, mounted at `${BASE_PATH}/portal`
  **before** `routes/portal.js` in `server.js`) is the dashboard: the customer's
  estimates, invoices, and succeeded payments (`views/portal/dashboard.ejs`).
- **Actions reuse the existing token flow instead of duplicating it.** "Review & accept"
  / "Pay now" hit `GET /portal/estimates/:id` or `/portal/invoices/:id`, which
  **ownership-check the row against `req.session.customerId`**, mint a short-lived
  `access_tokens` row, and redirect into the already-tested `/e/:token` / `/i/:token`
  accept/pay/Stripe pages. Zero duplication of the accept/payment logic.
- **Landing page (`views/landing.ejs`):** `GET /` now renders a public branded landing
  (what CHO Hub is + Customer-portal / Staff-sign-in entry points) for anyone not
  signed in as staff; logged-in staff still fall through to the dashboard
  (`routes/index.js` two-handler split, first checks `req.isAuthenticated()`).
- **portal.css gotcha (found + fixed in the browser):** `body.portal-page a { color:
  accent }` repaints **anchor-styled buttons** (`<a class="btn-primary">`) blue-on-blue —
  invisible text. Real `<button class="btn-primary">` elements are unaffected (not `a`),
  which is why it only bit the new landing/dashboard links, not the older portal forms.
  Fixed by forcing `color:#fff` on `body.portal-page .btn-primary/.btn-success`. Watch
  for this on any new anchor-button on a portal page.
- **To test on prod:** the prod DB has no customers yet — create one via staff admin
  (`/admin/customers`) with a real email, then that email works at `/portal/login`.

`016_invoicing_and_decline.sql` completes the **back half of the billing loop** — before
this, an invoice could only exist as the auto-created deposit on estimate acceptance;
staff had no way to bill a final balance or a standalone cash job (`routes/admin/
invoices.js` was a list-only stub).

- **`services/invoicing.js`** is now the one place invoice money-math lives:
  `createInvoice(conn, fields)` (always inserts `pending`) and
  `remainingBalanceForEstimate(conn, id)` = `estimate.total − SUM(non-void invoices for
  it)`. `createDepositInvoice` (estimates.js) was refactored to call it, so the deposit
  is no longer computed in two places. **Non-void** (not just paid) is deliberate — it
  stops a second final invoice being billed on top of an outstanding one.
- **Manual invoices** (`routes/admin/invoices.js`): `GET /new` + `POST /` create a
  `final`/`standalone` invoice (deposit stays auto-only), `GET /:id` is the detail page,
  `POST /:id/send` mints an `access_tokens` row + emails the `/i/:token` pay link
  (`views/emails/invoice-sent.ejs`) + sets `sent_at`, `POST /:id/void` voids a pending
  one. `invoices.description` (new column) is the customer-facing "what is this for" line
  — without it a standalone invoice was a context-free bare amount.
- **"Bill final balance"** (`POST /admin/estimates/:id/final-invoice`, button on an
  accepted estimate) creates a `final` invoice for `remainingBalanceForEstimate` and
  drops staff on its detail page to review + Send. This is the piece that closes
  "job done → collect the rest"; still a manual click, not auto-fired on job completion.
- **Accepted/declined estimates are now locked.** `POST /admin/estimates/:id` (save) and
  `/:id/send` reject with 409 when status ∈ {accepted, declined} — the line items are the
  e-signed record and must not silently change. `estimate-form.ejs` hides Save/Send and
  shows a lock notice for those statuses.
- **Estimate decline path** (`estimates.declined_at`): the customer portal estimate page
  (`views/portal/estimate.ejs`) now has a "Decline this estimate" button →
  `POST /e/:token/decline` (`routes/portal.js`) sets `status='declined'`/`declined_at`
  and **cancels the outstanding `estimate_followup` job** (no point chasing it). The
  `declined` status existed in the enum since day one but had no way to be set until now.

**Reports & analytics** (`/admin/reports`, `routes/admin/reports.js` + `views/admin/
reports.ejs`, nav link between Payments and Catalog) — the first Tier-2 feature. **No
migration**: it's pure read-only aggregation over existing tables. KPI tiles (net revenue,
outstanding A/R, open pipeline value, estimate win rate), a 12-month net-revenue bar chart,
estimate pipeline by status, revenue mix by invoice type, and a lead funnel with conversion
%. The bar chart is **plain CSS bars** (`style="height:X%"`), deliberately no charting
library — inline `style` attributes are allowed (helmet's default `style-src` includes
`'unsafe-inline'`, unlike `script-src`), so this needs no CSP change and no vendored JS.
Missing months are gap-filled in JS so all 12 always render; win-rate = accepted ÷
(accepted+declined+expired), null until there's at least one decision. All staff (not
admin-only) — it's operational data.

`017_warranties.sql` adds **warranty tracking** (second Tier-2 feature). A `warranties`
table (customer-linked, optional `job_id`, `item`/`type`/`provider`/
`start_date`/`expires_on`/`coverage_notes`, `active` soft-delete, `reminder_sent_at`).
Staff CRUD at `/admin/warranties` (`routes/admin/warranties.js`, nav link after
Subcontractors) with an expiry-status badge (Active / Expires in Nd / Expired, computed
from `expires_on` vs today). Editing the expiry **re-arms** the reminder (sets
`reminder_sent_at = NULL`). **`services/warrantyReminders.js`** (`sendExpiryReminders`,
daily `0 9 * * *` cron in server.js — the app's second scheduled job alongside the hourly
consultation reminder) emails `warranty-expiring.ejs` to customers whose active warranty
lapses within 30 days, once, idempotent via `reminder_sent_at`. Warranties surface on the
**customer 360 timeline** (`routes/admin/customers.js`) and the **customer portal
dashboard** (`routes/customerPortal.js` + `views/portal/dashboard.ejs`) — delivering on
the portal's "track your project" line. The form prefills `?customer_id`/`?job_id` so it
can be launched from a customer or a completed install job.

**Estimate expiry + portal project tracking** (third Tier-2 slice, **no migration** — both
use existing columns):
- **Estimate expiry**: the long-dead `estimates.expires_at`/`expired` status are now live.
  Sending an estimate sets `expires_at = NOW() + 30d` (`ESTIMATE_VALID_DAYS` in
  `routes/admin/estimates.js`). **`services/estimateExpiry.js`** (`expireStaleEstimates`,
  daily `0 1 * * *` cron — the app's third scheduled job) flips `sent` estimates past
  `expires_at` to `expired` and cancels their `estimate_followup` jobs. Re-sending resets
  status + `expires_at`, so nothing is permanently closed. Only touches `sent` rows, so
  it's idempotent and never overrides accepted/declined.
- **Portal project tracking**: the customer portal dashboard
  (`routes/customerPortal.js` + `views/portal/dashboard.ejs`) now shows **Appointments**
  (their consultations) and **Installation** (their `type='install'` jobs with status +
  scheduled time). **Internal jobs stay hidden** — the jobs query filters to
  `type='install'` only, so `consultation`/`estimate_followup` staff tasks never leak to
  the customer. Both sections only render when there's data (unlike the always-shown
  Estimates/Invoices/Warranties cards), to keep a new customer's portal uncluttered.

`018_line_item_catalog_links.sql` adds **catalog-linked line items** (final Tier-2 piece) —
`estimate_line_items.product_id`/`labor_rate_id` (both nullable; both NULL = custom line).
The line keeps its own description/unit_price **snapshot** — the link is for reporting,
never a live join, so editing a product later can't rewrite an accepted estimate.
- **Builder wiring:** the Source `<select>` now has `name="line_source"` (submits parallel
  to `line_description[]` etc., value `''`/`product:<id>`/`labor:<id>`), parsed back in
  `lineItemsFromBody`. On edit the row carries `data-source` and `page-estimate-form.js`
  restores the dropdown. **Bug fixed in passing:** the builder cloned
  `querySelector('.line-item-row')`, which is `null` on a new estimate (zero
  server-rendered rows) — it now clones an inert **`<template id="line-row-template">`**,
  so new-estimate line entry actually works.
- **Job costing** (`computeCosting` in estimates.js, shown on the estimate edit page):
  margin is only computed on **materials** (product `vendor_cost` × qty vs. what's charged)
  — labor/custom lines have no cost basis and are revenue-only. Needs items joined with
  `products.vendor_cost AS product_cost` (see `GET /:id/edit`).
- **Material list** (`GET /admin/estimates/:id/materials`, `estimate-materials.ejs`):
  product lines aggregated by product (SUM qty), with vendor + extended vendor cost, for
  purchasing — printable. Custom/labor lines excluded (not physical stock). Foundation for
  future material-ordering / inventory.
- **Test gotcha (my own):** driving the estimate form via `document.querySelector('form')`
  in the browser grabs the **sidebar logout form** (first in DOM) — target the real form
  via `getElementById('line-items-body').closest('form')` or `form[action$=...]`.

### Tier 3 — polish/hardening (migrations 019, 020)

- **CSP-blocked inline handlers fixed.** The CSP's `script-src-attr 'none'` silently
  killed every inline `on*=` handler. Two were **functional breaks, not cosmetic**: the
  `onchange="this.form.submit()"` on the jobs *and* leads status dropdowns meant changing
  a status via the dropdown **did nothing**. All three (those two + estimate "Send to
  Customer" confirm) moved to nonce'd `addEventListener` blocks (`.js-autosubmit` class +
  a per-page nonced script). **Rule: never add an inline `on*=` handler — it will no-op
  under the CSP.** (`grep -rn "on\(submit\|click\|change\)=" views/` should stay empty.)
- **Email delivery logging** (`019_email_log.sql`). `services/mailer.js` now writes an
  `email_log` row for every send — `sent` / `failed` (with error) / `skipped` (SMTP
  unset) — wrapped so a logging failure never affects the send. Admin-only view at
  **`/admin/settings/email-log`** (card on the Settings index) with a "problems only"
  filter, so a bounced estimate/invoice email is visible instead of silent.
- **Activity / audit log** (`020_activity_log.sql`, `services/activityLog.js`). Append-only
  record with actor attribution (`staff`/`customer`/`system`) that the reconstructed
  customer-360 timeline couldn't provide. `log()` never throws (audit write must not break
  the audited action) and can take a `conn` to commit inside the action's transaction.
  Instrumented at: estimate.sent (staff), estimate.accepted/declined (customer, from the
  portal), invoice.created/sent (staff), invoice.paid (system, from the webhook),
  refund.issued (staff). Global feed at **`/admin/activity`** (all staff, nav link after
  Reports) with a `?customer_id=` filter linked from the customer detail page's "Activity"
  button. `activity.staff(req)` is the shorthand for staff-actor fields.

**Scheduling calendar** (`/admin/calendar`, `routes/admin/calendar.js` + `views/admin/
calendar.ejs`, nav link after Jobs; **no migration**). A server-rendered month grid
(6 weeks × 7 days, CSS in `app.css` `.cho-cal*`, **no JS calendar library**) of everything
scheduled: consultations (by `consultation_date`), jobs by `scheduled_at` (timed), and
jobs with a `due_date` but no time as all-day "due" markers. Colour-coded by kind, events
link to their edit pages, prev/Today/next nav via `?m=YYYY-MM`. Read-only — times are
changed on the job/consultation edit pages. The grid shows whole weeks, so events on the
leading/trailing adjacent-month days appear (normal calendar behaviour). Day bucketing
uses a local-time `ymd()` for both events and cells so they line up regardless of server
TZ (the one thing to watch if dates ever look off by a day).

**Document storage** (`021_documents.sql`, `routes/admin/documents.js`) — a `documents`
table + a Documents section on the customer detail page: upload (multer disk, 25 MB,
category + optional job tag), download, delete. Files live under
`uploads/documents/<customer_id>/`, **never `express.static`** — streamed through the
authenticated `/admin/documents/:id/download` route (contracts/permits/PII). Same pattern
as `subcontractor_documents`/`consultation_photos`. The `uploads/documents` dir is created
on the VPS at deploy time.

**Job-done → auto final invoice** (`routes/admin/jobs.js` `maybeBillFinal`) — marking an
**install** job that's linked to an **accepted** estimate as `done` (via either the list
dropdown or the edit form) auto-creates the `final` invoice for the remaining balance and
redirects staff to it (`?created=1` shows a review-and-send notice). Idempotent via
`remainingBalanceForEstimate` (nets out invoices already raised), so re-marking done never
double-bills. Closes the last manual gap in the billing loop.

**Inventory v1** (`022_inventory.sql`, `services/inventory.js`) — opt-in per product
(`products.track_inventory`), building on catalog-linked line items. `stock_movements` is
the audit trail (`receive`/`consume`/`adjust`); `products.stock_qty` is the running total,
only ever changed through `adjustStock()` so a movement is always recorded. Product edit
has an Inventory card (current stock + Low badge, receive/set form, movement history);
the catalog list shows a Stock column + `?low=1` filter (`stock_qty <= reorder_level`).
`onInstallJobDone` (in jobs.js, renamed from `maybeBillFinal`) now also calls
`consumeForJob` — completing an install job **decrements the estimate's tracked products
from stock**, idempotent per job (skips if that job already has `consume` movements, so
re-marking done never double-consumes). Only `track_inventory=1` products are touched.

**Builder/GC management** (`023_builders.sql`, `routes/admin/builders.js`) — the general
contractors/builders who **refer** work to CHO (distinct from `subcontractors`, whom CHO
hires out). `builders` CRUD (nav link after Subcontractors) + `customers.builder_id` (set
via a "Referred by" dropdown on the customer edit page, shown on the customer detail). The
builder detail page lists that builder's referred customers and their **net paid revenue**
(sum of succeeded payments − refunds), so staff can see which referral relationships are
worth nurturing.

**Subcontractor portal** (`024_subcontractor_portal.sql`) — the **third access tier**,
previously deferred as needing multi-principal auth, now built by mirroring the customer
portal's separate-session pattern (`req.session.subcontractorId`, **not** Passport —
`middleware/subAuth.js`, `routes/subPortal.js`, mounted at `/sub`). Magic-link login (only
active subs with an email on file; no self-signup / no enumeration; single-use 30-min
tokens in `subcontractor_auth_tokens`). Dashboard shows the sub's **assigned jobs** and
their **own documents** (COIs/W9s, streamed scoped to the logged-in sub). Enabled by
`jobs.subcontractor_id` (also deferred with the portal) — assigned via a dropdown on the
job edit page. Landing page gained a "Subcontractor sign in" link. This is the third of
three portals sharing `views/partials/portal-header.ejs` + `portal.css`; all three
(`/portal` customer, `/sub` subcontractor, staff `/login`) are independent session
mechanisms that can't satisfy each other's guards.

---

## Local Dev / Test Hosting (NAS: `N:\` and `W:\` drives)

This repo's source lives on the mapped `N:\choHubProject` NAS drive (same NAS as
`N:\gymrProject`), which is the **real path `/volume1/NPM/choHubProject`** on the NAS
itself. `W:\choHubProject` is a genuinely separate folder — **real path
`/volume1/web/choHubProject`** — not the same directory under a different name;
verified directly (a marker file written to one side does not appear on the other).
Do not assume `/volume1/npm` (lowercase) or `/volume1/NPM` are interchangeable with
`/volume1/web` — confusing the two once already caused an accidental `npm install
--omit=dev` against the dev source (`N:\`), which pruned devDependencies out of the
working local `node_modules` (fixed by re-running plain `npm install`).

- **`N:\`** — source/dev drive; this repo is edited directly here.
- **`W:\`** — the NAS's test-hosting share. `gulp build` (see `gulpfile.js`) pushes
  the whole app there (minus `node_modules`/`.git`/`.env`), mirroring gymrProject's
  `N:\gymrProject\gulpfile.js` pattern but simplified: this app has no separate
  `src/` front-end authoring layer, so there's nothing to bundle, just a full mirror.
- This `N:\`/`W:\` NAS flow is **test-only** — it's unrelated to the production deploy
  target (the Hostinger VPS covered under "Deployment" below).
- **`W:\choHubProject` needs its own `.env`, created directly on the NAS** (never
  synced by gulp) — different `PORT` (`3001`), `BASE_PATH` (`/choHubProject`), and
  `GOOGLE_CALLBACK_URL` (`https://masinet.synology.me/choHubProject/google/callback` — note
  no `/auth` prefix, unlike the `passport-google-oauth20` README's example convention;
  this app's routes mount `/google/callback` directly, not under `/auth`)
  than local dev, though same DB/Stripe/SMTP secrets as the shared test DB setup.
- **`node_modules` on `W:\` must be installed on the NAS itself** (Linux) inside
  `/volume1/web/choHubProject` — native modules like `bcrypt` need to build for the
  NAS's own architecture, not Windows, and must stay isolated from `N:\`'s own
  Windows-built `node_modules`.

**PM2 on the NAS runs in watch mode** (`ecosystem.nas-test.config.js`, process name
`cho-hub-test`, port `3001` — gymr already occupies `3000` on this NAS) — it watches
its own `cwd` (`/volume1/web/choHubProject`) and restarts itself whenever `gulp build`
lands new files there. No flag file, no DSM Task Scheduler cron job needed (unlike
gymrProject's `nas-pm2-watcher.sh` pattern) — just run `deploy-nas-test.bat` (or
`npx gulp build`) after making changes and PM2 picks it up on its own.

**NAS SSH access** (needed for the npm-install/pm2-restart steps in the gotcha below,
and for the one-time setup that follows): port **2222**, not the default 22. Either
`masinet.synology.me` or its LAN IP `192.168.4.199` works (each pins its own host key
the first time you connect to it — accept both). User `nostrus`, password
`9axrN54Pi9yrHzD`. Two PATH gotchas once connected, both from Node.js being a Package
Center package rather than a system one:
- **Neither `node`/`npm` nor `pm2` are on the default PATH**
  (`/usr/bin:/bin:/usr/sbin:/sbin` only). There's no bare `npm` binary at all — only
  `node`/`npx`/`corepack` — so `npm` has to be invoked explicitly through `node`:
  `/var/packages/Node.js_v20/target/usr/local/bin/node
  /var/packages/Node.js_v20/target/usr/local/lib/node_modules/npm/bin/npm-cli.js
  install --omit=dev` (run from `/volume1/web/choHubProject`). `pm2` itself lives at
  `/usr/local/bin/pm2`.
- **`pm2` requires `sudo`, and `sudo` resets PATH again** — its `secure_path` doesn't
  include the Node.js package's bin dir either, so a bare `sudo pm2 restart ...` fails
  with `env: node: No such file or directory`. Re-inject the path inside the sudo
  shell: `sudo sh -c 'PATH=/var/packages/Node.js_v20/target/usr/local/bin:$PATH
  /usr/local/bin/pm2 restart cho-hub-test --update-env'`.

**One-time NAS setup** (needs NAS shell/DSM UI access, not doable from a mapped
drive): `npm install` inside `/volume1/web/choHubProject`; `pm2 start
ecosystem.nas-test.config.js`; place `nginx/www.chohub.conf` at
`/etc/nginx/conf.d/` and `nginx -t && nginx -s reload` (mirrors
`N:\gymrProject\nginx\www.gymr.conf`) — validate with `nginx -t` before reloading,
since a bad reload affects every other site this NAS hosts, not just this one.

**Gotcha: new npm dependencies crash-loop the NAS instance until installed there
too.** PM2 watch mode restarts `cho-hub-test` the instant `gulp build` lands new
files — including a `require()` of a package that only exists in `N:\`'s
`node_modules`, not yet in `/volume1/web/choHubProject`'s. In practice watch mode
reacts faster than an SSH `npm install` can complete, so it *will* burn through PM2's
restart attempts and land in `errored` state even if you run the install right after
the `gulp build` — don't bother racing it. Just always run, in order: `gulp build` →
`npm install --omit=dev` over SSH → `sudo pm2 restart cho-hub-test --update-env`
(manual restart is required, `errored` processes don't resume on their own).

---

## Project Structure

```
choHubProject/
├── server.js                  — Express app entry
├── ecosystem.config.js        — PM2 config (name: cho-hub)
├── gulpfile.js                — Mirrors this app to W:\choHubProject for NAS test hosting
├── ecosystem.nas-test.config.js — PM2 config for the NAS test instance (BASE_PATH=/choHubProject)
├── deploy-nas-test.bat        — gulp build + drop NAS PM2-restart flag
├── nginx/www.chohub.conf      — NAS nginx reverse-proxy snippet for /choHubProject (place manually)
├── .env                       — Secrets (never commit)
├── config/
│   ├── db.js                  — MariaDB pool
│   ├── passport.js            — Local strategy for staff login
│   └── stripe.js              — Stripe client (shared account, see below)
├── middleware/
│   ├── auth.js                — requireAuth, redirectIfAuth, setLocals (staff)
│   └── customerAccess.js      — resolveToken (customer portal links)
├── routes/
│   ├── index.js                — Staff dashboard
│   ├── auth.js                  — Staff login/logout
│   ├── portal.js                — Customer-facing: view/accept estimate, view/pay invoice
│   ├── webhooks.js              — Stripe webhook (payment_intent.succeeded → mark invoice paid)
│   └── admin/
│       ├── customers.js         — Staff CRUD
│       ├── estimates.js         — Staff CRUD + createDepositInvoice() helper
│       └── invoices.js          — Staff CRUD
├── views/
│   ├── partials/                — head, footer, nav
│   ├── admin/                   — staff-facing pages
│   ├── portal/                  — customer-facing pages (estimate, invoice, expired)
│   └── auth/login.ejs
├── public/
│   ├── css/app.css
│   └── js/page-pay.js           — Stripe Payment Element mount + confirm
├── migrations/
└── scripts/create-admin.js      — CLI to create/reset a staff login
```

---

## Key Architecture Decisions

### Two access models, one app
- **Staff** (CHO employees) log in via Passport, same session-cookie pattern as
  gymrProject. Two strategies: local (email/password, bcrypt) and Google OAuth
  (`config/passport.js`). Unlike gymrProject's public-signup Google flow, this app's
  Google strategy **never creates a user** — it only attaches `google_id` to an
  existing `users` row matched by email. Staff accounts must be provisioned first via
  `scripts/create-admin.js`; an unrecognized Google account is rejected, not signed up.
  The Google strategy only registers if `GOOGLE_CLIENT_ID` is set — unset in an
  environment, the login page just shows the local form (see `.env.example` for the
  `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_CALLBACK_URL` vars). Routes under
  `/admin/*` require `requireAuth`.
- **Customers** never get a password. Every estimate/invoice they need to see or pay
  gets a row in `access_tokens` (random token, `expires_at`, single resource). They
  visit `/e/:token` (estimate) or `/i/:token` (invoice). `middleware/customerAccess.js`
  resolves the token; an expired/missing token renders `views/portal/expired.ejs`.
  This mirrors how Stripe's own hosted invoice links work — no signup friction for
  a customer who's paying a contractor once or twice a year.

### Deposit flow (not yet wired end-to-end — see README "Not built yet")
1. Staff creates an `estimate` with `estimate_line_items`, sets `deposit_percent`
   (defaults 50%). Status `draft` → `sent` (generates an `access_tokens` row, emails
   the customer the `/e/:token` link).
2. Customer opens the link, clicks Accept → status becomes `accepted`, and a deposit
   `invoice` (`type = 'deposit'`) is created for `total * deposit_percent / 100`
   (see `createDepositInvoice()` in `routes/admin/estimates.js`, currently exported
   but not called by any route — hook it up when building "accept").
3. A new `access_tokens` row is created for that invoice; customer gets emailed the
   `/i/:token` pay link.
4. Customer pays via Stripe Payment Element (`public/js/page-pay.js` +
   `POST /i/:token/pay` creates the PaymentIntent).
5. `routes/webhooks.js` receives `payment_intent.succeeded`, marks the `payments` row
   `succeeded` and the `invoices` row `paid` — **the webhook is the source of truth**,
   not the client-side confirm callback (client can close the tab mid-payment).
6. When the job is complete, staff creates a `final` invoice the same way (no
   estimate-accept step needed — invoices can also stand alone, `type = 'standalone'`,
   for e.g. small jobs with no formal estimate).

### Stripe
- `config/stripe.js` reads `STRIPE_SECRET_KEY` — same Stripe account as
  ConnectedHomeLedger (Connected Home Outfitters LLC), used by both apps.
- Every PaymentIntent this app creates carries `metadata.source = 'cho-hub'`
  (`routes/portal.js`) plus a `statement_descriptor_suffix` so charges are
  identifiable in the Stripe dashboard/bank statement even though the account is shared.
- Webhook endpoint `/webhooks/stripe` needs the **raw body** for signature verification
  — mounted with `express.raw()` in `routes/webhooks.js`, before any `express.json()`
  parsing would consume the stream for that path.
- The handler only acts on events tagged `metadata.source === 'cho-hub'` — Ledger's
  subscription-payment events will also arrive at this endpoint if it's subscribed to
  `payment_intent.succeeded`, and must be ignored rather than mis-reconciled.
- `STRIPE_WEBHOOK_SECRET` comes from **this app's own webhook endpoint** registration
  in the Stripe Dashboard (not Ledger's) — each registered endpoint gets its own
  signing secret even on a shared account.

---

## Deployment — LIVE at `https://hub.connectedhomeoutfitters.com` (2026-07-25)

Deployed to the **same Hostinger VPS as Connected Home Ledger** (`2.25.186.172`,
Ubuntu, `srv1741987`), fully isolated from it — no shared port/process/DB/server_name/
cert. Ledger was verified untouched throughout (its `chl` PM2 process kept its uptime,
`https://connectedhomeledger.com` stayed `200`).

**VPS layout (both apps side by side):**

| | Ledger (existing) | CHO Hub (this app) |
|---|---|---|
| App dir | `/var/www/chl` | `/var/www/cho-hub` |
| PM2 process | `chl` | `cho-hub` |
| Port | 3000 | **3100** |
| nginx `server_name` | `connectedhomeledger.com` | `hub.connectedhomeoutfitters.com` |
| DB (local MariaDB `127.0.0.1:3306`) | its own DB | `choHub` / user `choHubWeb` |
| TLS | own certbot cert | own certbot cert |

- **SSH access:** `deploy@2.25.186.172` (runs the app / PM2, **no passwordless sudo**)
  and `root@2.25.186.172` (key-based, used for the infra: nginx, certbot, MariaDB,
  `/var/www` dirs). Both work from the dev machine's default key. MariaDB `root` is
  unix-socket auth (`mysql` as system root, no password).
- **DNS:** `hub` A record → `2.25.186.172`. Originally an `ALIAS` → `…cdn.hstgr.net`
  (Hostinger shared hosting — the WordPress apex `connectedhomeoutfitters.com` lives
  there on `45.93.101.98`, a **different box**, not the VPS); that ALIAS was deleted and
  replaced with the A record. If `hub` ever resolves to a `2a02:4780:…` IPv6 again, the
  ALIAS/AAAA came back and is shadowing the A record.
- **PM2 persistence:** `pm2 save` done and `pm2-deploy.service` is enabled, so both apps
  resurrect on reboot. After changing which processes run, re-run `pm2 save`.
- **nginx safety:** the one shared blast-radius surface. The server block is
  `/etc/nginx/sites-available/hub.connectedhomeoutfitters.com` (symlinked into
  `sites-enabled/`), with `client_max_body_size 25M` for consultation-photo / subcontractor-
  doc uploads. **Always `nginx -t` before any reload** — a bad reload hits Ledger too.
- **TLS:** `certbot --nginx -d hub.connectedhomeoutfitters.com` issued its own cert
  (auto-renew task installed) + added the 443 block and 80→443 redirect. Ledger's cert
  untouched.
- **Deploy path (git, like Ledger):** GitHub repo
  `github.com/connectedhomeoutfitters/connected-home-hub`. The VPS pushes/pulls it with a
  **dedicated deploy key** — `~/.ssh/id_cho_hub` (write access) — kept separate from
  Ledger's key via `~/.ssh/config` host aliases (`github.com` → `id_ed25519` = Ledger's
  key; `github-cho-hub` → `id_cho_hub`, both `IdentitiesOnly yes`). The remote is
  `git@github-cho-hub:connectedhomeoutfitters/connected-home-hub.git`. **Do not** point
  cho-hub at plain `git@github.com` — that offers Ledger's repo-scoped deploy key and
  fails. Redeploy = get code onto `main` → on the VPS `cd /var/www/cho-hub && git pull &&
  npm install --omit=dev && pm2 restart cho-hub --update-env`.
  - **Initial deploy (2026-07-25) was a tar-over-ssh push** from the dev machine, not a
    git clone, because the dev machine has no GitHub auth (its `id_rsa` isn't registered)
    and there's no `gh` CLI anywhere. `public/vendor/` (gitignored, 9 MB) had to ride
    along in that tar since the VPS has no gulp/devDeps to regenerate it; a fresh `git
    clone` would be missing it — run `gulp build`'s vendor copy, or keep the existing
    `vendor/` in place across pulls (git won't touch the untracked dir).
  - **Ongoing dev→prod is still a gap:** dev happens on `N:` (no GitHub auth), so there's
    no local `git push` yet. Until the dev machine gets GitHub auth, changes reach the VPS
    by committing/pushing from the VPS itself or another tar push.
- **npm `allow-scripts` gotcha:** the VPS npm blocks package install scripts by default,
  so `bcrypt`'s `node-gyp-build` postinstall is skipped with a warning. bcrypt still works
  because its shipped **prebuilt** linux-x64 binary resolves at require time — verified
  (`bcrypt.hashSync`) before starting PM2. If a future native dep has no prebuild, it'll
  need `npm approve-scripts` or a manual `npm rebuild` on the VPS.

**Still needed to be fully production-ready (owner actions, not blocking the app running):**
1. **Staff login** — the prod `choHub` DB starts empty (0 users). Create an admin on the
   VPS: `cd /var/www/cho-hub && node scripts/create-admin.js <email> <password> <name>`.
2. **Stripe go-live** — `.env` currently holds **test** keys (carried from dev). Swap to
   `sk_live`/`pk_live`, then register a webhook at
   `https://hub.connectedhomeoutfitters.com/webhooks/stripe` for
   **`payment_intent.succeeded` + `charge.refunded`**, and set that endpoint's signing
   secret as `STRIPE_WEBHOOK_SECRET`, then `pm2 restart cho-hub --update-env`.
3. **Google sign-in** — add `https://hub.connectedhomeoutfitters.com/google/callback` to
   the OAuth client's authorized redirect URIs, or the "Sign in with Google" button
   fails `redirect_uri_mismatch` (local password login is unaffected).

### Database backups & prod→test sync (2026-07-25)

- **Prod backups**: `/usr/local/bin/cho-hub-backup.sh` on the VPS (reference copy in
  `scripts/cho-hub-backup.sh`), root crontab **daily 2:30am**, `mysqldump` via root
  unix_socket auth (no password), gzipped to `/var/backups/cho-hub/` (chmod 600 — dumps
  hold customer PII), **14-day** retention, logs to `backup.log`. Restore:
  `gunzip -c <file> | mysql choHub` (as root on the VPS).
- **Prod→test sync**: `scripts/sync-prod-to-test.js` (run via
  `scripts/sync-prod-to-test.bat`) pulls a fresh prod dump over SSH (`root@2.25.186.172`,
  socket auth) and **loads it into the test NAS DB, replacing its contents** — test
  becomes a mirror of prod; test-only scratch data is discarded each run. Runs from the
  **dev machine** (it's the only host that can reach both the internet-facing VPS and the
  LAN test DB at `192.168.4.199:3307`). Scheduled via a Windows Task Scheduler task
  **"CHO Hub prod-to-test sync"** (weekly Mon 6am, InteractiveToken = runs when logged
  on, no stored password, `StartWhenAvailable` catches up missed runs); logs to
  `%USERPROFILE%\cho-hub-sync.log`.
  - **Safety**: the script refuses to run unless `DB_HOST === 192.168.4.199`, so it can
    only ever write to test, never prod.
  - **`--skip-add-locks` is required**: the test DB user (`choHubWeb`) lacks the
    `LOCK TABLES` privilege, and mysqldump's default `LOCK TABLES` wrappers would fail the
    load with "Access denied … to database 'choHub'".
- **Catalog seeding (2026-07-25)**: prod was deployed empty; the real product catalog
  (28 rows, from the CSV import) lived only in test. A one-off `mysql2.escape`-generated
  `DELETE`+`INSERT` of the config tables (`products`, `company_settings`, + empty
  `labor_rates`/`subcontractors`) was piped `test → prod` so prod can build real
  estimates. The recurring sync is the reverse direction (`prod → test`); now that prod
  holds the catalog, a sync preserves it in test.

---

## Common Gotchas

1. **Customer routes take no auth session** — never gate `/e/:token` or `/i/:token`
   behind `requireAuth`; they're deliberately public-but-token-gated.
2. **Webhook route must stay before any global JSON body parser** for that path, or
   signature verification breaks (Stripe needs the exact raw bytes).
3. **`db.getConnection()`** for multi-table writes — remember `conn.release()` in a
   `finally` block (see `routes/webhooks.js`).
4. **One Stripe account serves both apps** (GYMR SaaS billing and CHO's contracting
   income) — always tag PaymentIntents `metadata.source = 'cho-hub'` and never remove
   the source check in `routes/webhooks.js`, or this app will start reacting to
   Ledger's subscription payments too.
5. **`BASE_PATH`** — unlike gymrProject (served under a subpath `/gymrProject` on
   shared infra), this app is meant to own its own subdomain, so `BASE_PATH` defaults
   to `''`. Only set it if this ever needs to be reverse-proxied under a subpath instead.
6. **Every `app.use()` mount in `server.js` must carry `` `${BASE_PATH}/...` ``,
   including `express.static`.** Fixed 2026-07-23 — `express.static` was mounted
   bare (no `BASE_PATH` prefix) while every route mount already had it, so under the
   NAS's `/choHubProject` subpath every static asset (CSS, JS, vendor files) 404'd
   silently. This went undetected all session because local dev's `BASE_PATH=''`
   never exposed it, and testing only ever checked HTML page HTTP status via `curl`,
   never an actual browser rendering a page's sub-resources on the NAS. **Test real
   UI changes in an actual browser on the actual target environment**, not just via
   `curl` status codes — this bug and the two below were only caught by finally doing
   that (via `claude-in-chrome`) after a user report that a button "did nothing."
7. **Bootstrap CSS/JS is self-hosted, not loaded from a CDN.** Was
   `cdn.jsdelivr.net` originally; switched 2026-07-23 after `bootstrap.bundle.min.js`
   returned a transient `503` from jsdelivr, silently breaking every
   collapse/dropdown/toggle sitewide (the CSS loaded fine, so pages still looked
   right — only interactive JS-driven behavior was dead). `bootstrap`/
   `bootstrap-icons` are **devDependencies only** — nothing server-side
   `require()`s them, so the NAS doesn't need them in its own `node_modules`.
   `gulpfile.js`'s `copy_vendor` task copies their pre-built `dist`/`font` files into
   `public/vendor/` (gitignored, regenerate with `gulp build`) as part of every
   `build`/`default` run; `views/partials/head.ejs`/`footer.ejs` reference
   `` `${basePath}/vendor/...` ``.
8. **Admin nav is a fixed left sidebar on desktop, hamburger→offcanvas on mobile
   (2026-07-25).** `views/partials/nav.ejs` was a top navbar that got too crowded on
   desktop as sections were added; it's now a fixed 220px left sidebar (`.cho-sidebar`,
   `d-none d-lg-flex`) with a mobile top bar + Bootstrap offcanvas (`d-lg-none`) below
   `lg`. The nav-item list is defined **once** in the partial and looped into both the
   sidebar and the offcanvas so they can't drift — add new sections to that one array.
   Content is offset via **`body:has(.cho-sidebar) { padding-left: 220px }`** inside an
   `@media (min-width: 992px)` block in `app.css` — this works because the sidebar
   element is always in the DOM (Bootstrap just `display:none`s it below `lg`, and
   `:has()` matches on presence, not display), and because **only admin pages include
   `nav.ejs`** — portal (`body.portal-page`, uses `portal-header.ejs`) and login pages
   have no `.cho-sidebar`, so they never get the offset. Active-section highlighting
   uses `res.locals.currentPath` (set in `middleware/auth.js`'s `setLocals` = `req.path`,
   which includes `BASE_PATH` on the NAS) via a substring match, so a detail page like
   `/admin/payments/3` still lights up its section. Verified at desktop + forced-mobile
   widths via `claude-in-chrome` (note: that tool's screenshot viewport is pinned ~1531px
   and doesn't follow `resize_window`, so the mobile breakpoint had to be forced with a
   temporary style override rather than by shrinking the window).
9. **Branding (2026-07-24)** — `public/img/logo.png` and `public/img/favicon.png` are
   Connected Home Outfitters' real brand assets, pulled from the live WordPress site
   (`choProject`'s Elementor global kit — colors
   `#0799D6`/`#6EC1E4`/`#54595F`/`#7A7A7A`, fonts Roboto/Roboto Slab via Google Fonts).
   Applied everywhere: `views/portal/*.ejs` (via `views/partials/head.ejs`'s
   `portalBranded`/`bodyClass` params, plus `public/css/portal.css` for the
   customer-facing header/Roboto Slab headings specifically), all 6
   `views/emails/*.ejs` templates (via shared `views/emails/_header.ejs`/`_footer.ejs`
   includes and `services/mailer.js`'s `logoUrl` template local),
   `services/estimatePdf.js`, **and the staff admin shell** (`views/partials/nav.ejs`
   — light navbar with the real logo instead of "CHO Hub" text — plus
   `public/css/app.css` overriding Bootstrap's `--bs-primary`/`.btn-primary` etc. with
   the brand accent blue sitewide, since app.css loads unconditionally on every page,
   admin included).
   **Gotcha: pdfkit renders a PNG's fully-transparent pixels as solid black instead of
   honoring alpha**, for reasons unrelated to the PNG's own alpha encoding being
   correct or not (confirmed via raw zlib/chunk-level decoding, not just a rendering
   guess) — if a logo/image embedded via `doc.image()` shows a black box behind it,
   this is why. Worse, the actual root cause turned out to be a *second*, unrelated
   problem stacked on top: the source logo file itself had a genuinely opaque black
   background baked into its pixels (RGBA `(0,0,0,255)`, not `alpha=0`) despite
   rendering as if transparent in every normal image viewer/browser — only caught by
   decoding raw PNG bytes independently via two different methods (manual zlib inflate
   math and .NET `Bitmap.GetPixel`) and finding they agreed. Fixed by chroma-keying the
   real logo file (hard-transparent below a low brightness threshold, smooth alpha
   ramp between low/high thresholds to avoid a hard edge fringe, colors left untouched
   above the high threshold) — a plain de-matte-from-black divide (`true_color =
   displayed/alpha`) does **not** work here since this image has fully-opaque
   (`alpha=255`) dark design colors like navy text, which a de-matte divide incorrectly
   washes out along with the real transparent background. One shared `logo.png` now
   works for web, email, and the PDF — no separate flattened variant needed once the
   file itself was actually fixed.
