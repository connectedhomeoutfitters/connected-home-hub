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

**Production URL:** `app.connectedworkos.com` (domain purchased 2026-08-14, moved from
`hub.connectedhomeoutfitters.com`). Hub is a multi-tenant product sold to *other*
contractors, so it can't live on one tenant's brand — see "Domain" below. The old host
is kept forever as a 301 redirect, since emailed estimate/invoice links and customer /
subcontractor magic links already went out pointing at it. The apex
`connectedworkos.com` is deliberately left free for a future marketing site; the app
sits on `app.`.

Deploys to the same Hostinger VPS that hosts Connected Home Ledger, but as its **own
PM2 process, own nginx server block, and own database** (see "Deployment" below).

**Product name: `ConnectedWorkOS`** (one word, matching the domain) — this is the name
shown to users, and it replaced "CHO Hub" / "Connected Home Hub" in tenant-facing copy on
2026-08-14. **Internal names were deliberately NOT renamed**: `cho-hub` is still the repo,
the PM2 process, the database, the `metadata.source` Stripe tag, and the SSO/bookkeeping
wire payloads. Renaming those means coordinated changes across two apps, a Stripe tag the
webhook filters on, and a shared-secret integration — churn with real blast radius and no
user benefit. So: **user-facing text says ConnectedWorkOS; anything a machine reads says
cho-hub.** Places carrying the user-facing name today: `views/landing.ejs`,
`views/auth/login.ejs`, `views/sso-error.ejs`, `views/partials/head.ejs` (default title),
the four SSO denial messages in `routes/sso.js`, the transaction note in
`services/ledgerSync.js`, and — over in Ledger — the Field Operations card in
`views/workspace/index.ejs` plus the inbound-payment fallback description in
`routes/integrations/hub.js`.

**Cross-product link back to Ledger**: the admin nav renders a "Connected Home Ledger"
link **only for orgs with a `ledger_workspace_id`** — a standalone Hub tenant has no
Ledger to return to. The linked flag rides along on `middleware/branding.js`'s existing
per-org 60s-cached lookup, so it costs no extra query per request, and `res.locals.
ledgerUrl` is set there unconditionally (a missing value would throw in the partial rather
than emit a broken link). Defined once in `views/partials/nav.ejs` and rendered into both
the desktop sidebar and the mobile offcanvas, per that file's existing no-drift rule.

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
  **Now also wired into the estimate PDF + Terms** (2026-07-26): `services/
  companySettings.js`'s `getCompany()` loads the row (fallback to "Connected Home
  Outfitters LLC" per field). `services/estimatePdf.js` renders a company block
  (name/address/phone/email/tax ID, top-right) and `config/estimateTerms.js` is now a
  **function** `estimateTerms(companyName)` interpolating the name into the legal text.
  Both are passed `company: await getCompany()` / `estimateTerms(company.company_name)`
  from all three call sites (`GET /:id/pdf` + `POST /:id/send` in estimates.js, `GET /e/
  :token`/`/pdf` + the accept-error render in portal.js). Fill in Settings → Company and
  it flows through; unset fields fall back so nothing breaks.
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

**Estimate templates** (`026_estimate_templates.sql`, `routes/admin/estimateTemplates.js`)
— reusable starting points (WordPress packages, common installs), à la Housecall Pro.
`estimate_templates` + `estimate_template_items` (catalog-linked, mirrors
`estimate_line_items`). Template CRUD at `/admin/estimate-templates` (linked from the
Estimates page) reuses **`page-estimate-form.js`** verbatim — the template form supplies
the same `#line-items-body`/`#line-row-template`/`#tax_percent`/`#summary-*` ids +
`window.CHO_HUB_CATALOG`. Two flows: **Start from template** (a picker on the new-estimate
form → `GET /new?customer_id=X&template_id=Y` pre-fills title/deposit/tax + copies the
lines in, source dropdowns restored via `data-source`) and **Save as template** (from an
estimate → copies its lines into a new template). The shared line parser now lives in
**`services/lineItems.js`** (`lineItemsFromBody`), used by both builders. **Bug fixed in
testing:** the "Save as template" `<form>` was nested inside the main estimate `<form>` —
HTML forbids nested forms, so the browser silently dropped it; moved it after `</form>`
(a `<form>` can never live inside the estimate form — anchors/buttons-outside-a-form only).

**Flat-rate packages, per-line hide-price, line reordering, profitability**
(`027_flat_price_hide_price.sql` + `028_line_item_costing.sql`) — one connected set of
estimate/template builder features, on both `estimates`/`estimate_line_items` and their
`estimate_templates`/`estimate_template_items` mirrors:

- **Flat-rate "packages"** (`estimates.flat_price` / `estimate_templates.flat_price`,
  nullable). When set, the estimate is a fixed-price package (e.g. "Starter Package —
  $899"): the customer sees the package title, an **"includes"** bulleted list of the line
  descriptions (**names only, no per-line prices**), and one flat total — on the portal
  view (`views/portal/estimate.ejs`) and the PDF (`services/estimatePdf.js`). The flat price
  is **pre-tax**: sales tax is added **only on the taxable goods** inside the package —
  `taxableBase = Σ(qty × retail price)` of the product lines whose `products.taxable = 1`
  (labor/custom/subcontractor lines are never taxed in flat mode; itemized mode is
  UNCHANGED and still taxes the whole subtotal). So `total = flat_price + tax`, deposit is
  a % of that tax-inclusive total (matching itemized). `flat_price` stores the pre-tax
  package price; `subtotal = flat_price`, `tax` = the goods tax, `total = flat_price + tax`.
  The routes look up `products.taxable` server-side (authoritative — `taxableGoodsBase()` in
  `routes/admin/estimates.js`); the builder JS + PDF/portal show the "Sales tax" line live
  (products now carry `taxable` in `window.CHO_HUB_CATALOG`). This was a **deliberate answer
  to "how do I handle tax on a flat package"** — chosen base is the taxable goods' retail
  value, not a proportional allocation or vendor cost (2026-07-27). Line items keep their
  real qty/price/cost for internal costing regardless. Money math is centralized in
  **`services/estimatePricing.js`** (`computeEstimateTotals`, `parseFlatPrice`) so the
  create/update routes can't drift.
- **Per-line `hide_price`** — on a normal itemized estimate, a hidden line shows to the
  customer as **"Included"** instead of a dollar amount (its cost still counts toward the
  total; bundled pricing). Submitted via an **always-present hidden input** (`name=
  line_hide_price`, value `0`/`1`) that a checkbox writes — **not a bare checkbox**, since
  an unchecked checkbox submits nothing and would misalign the parallel line arrays. Every
  rendered row contributes exactly one value to every `line_*[]` array, so `lineItemsFromBody`
  (`services/lineItems.js`) stays index-aligned even when blank rows are skipped.
- **Line reordering** — ↑/↓ buttons per row in `page-estimate-form.js` (no drag library).
  **No schema change**: `sort_order` already existed and both save routes write row/DOM
  order, so reordering is purely front-end.
- **Profitability / job costing** (`estimate_line_items.unit_cost` + `subcontractor_id`,
  same on template items; **`services/estimateCosting.js`** `computeCosting`). A per-line
  **Unit Cost** (COGS), auto-filled from `products.vendor_cost` or a subcontractor's
  `hourly_rate` when picked, editable for custom lines. **Subcontractor is now a third line
  "source"** alongside product/labor (`line_source` value `sub:<id>`, parsed to
  `subcontractor_id`) so farmed-out work is captured + categorized. A **Profitability panel**
  (`views/partials/costing-panel.ejs`, shared by both builders, live-updated by
  `page-estimate-form.js`) shows Revenue, COGS split into **Materials / Labor /
  Subcontractor / Other**, total COGS, gross profit, margin %. For a flat package, revenue =
  the package price (not the summed lines). Own-labor lines default to $0 cost (owner's
  time), editable. `028` **backfills** existing product lines' `unit_cost` from current
  `vendor_cost` so old estimates show real COGS without a re-save.

**CSP/Bootstrap gotcha (found + fixed in the browser during this work):** the flat-price
field is toggled show/hide by swapping Bootstrap's **`d-none`/`d-flex` classes**, NOT
`element.style.display` — `.d-flex` is `display:flex !important`, which an inline style
can't override, so `style.display='none'` left the field stuck visible. The initial
shown/hidden state is also **server-rendered** (`d-flex` vs `d-none` in the EJS) so it's
correct before JS runs. Watch for this on any JS show/hide of a Bootstrap-utility element.
The estimate/template forms widened to `max-width:1080px` + `.table-responsive` for the
extra Unit Cost / Hide / reorder columns. Verified end-to-end on the NAS test instance
(product cost auto-fill, live profitability, flat-mode total override, hide flag + Source
dropdown + flat price all round-tripping through save→reopen).

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

**Project close-out** (`025_job_closeout.sql`, `jobs.closed_at`) — the final workflow
step: *"final payment collected → customer receives warranty documentation."* Before this,
a paid final invoice did nothing to the job and no warranty docs ever reached the customer.
Now a **`done`** job's edit page shows a **billing status** (`paymentStatusForEstimate`:
Fully paid / Outstanding $X, from the estimate's non-void invoices) and a **"Close out
project"** action (deliberate staff step, per the design decision — not auto-on-payment).
Close-out stamps `closed_at`, emails the customer a **`warranty-summary`** ("project
complete" + a table of their active warranties — the vision's final handoff), and logs
`job.closed`. Idempotent (a closed job just redirects back); allowed even if not fully paid
(staff's call, with a warning). `closed_at` is a **milestone on top of** status='done', not
a new status, so the status flow is untouched; the jobs list shows a "closed" badge.
`onInstallJobDone` remains the *auto* path (done → final invoice + inventory consume);
close-out is the *manual* final step after payment lands.

**Step-aware close-out communications** (`config/jobStepMessages.js`) — close-out is no
longer install-only: **each job type sends its own customer email** when closed out, so the
customer is kept informed as the project moves consultation → estimate → install → done.
The route (`POST /admin/jobs/:id/close-out`) looks up `jobStepMessages[job.type]` and sends
that step's template: **`consultation`** → `job-consultation-complete` ("consultation done,
we're now preparing your estimate"); **`install`** → the existing `warranty-summary` (+ the
customer's active warranties). Types with no entry (e.g. `estimate_followup`) still close
out — stamping `closed_at` — but send no email. The job-edit close-out card is driven by the
same config (per-type heading/description/button), so it reads correctly for a consultation
instead of showing warranty copy. **This also fixed a latent bug**: before, closing out a
*consultation* job sent the customer a warranty-summary email (the route hard-coded that
template regardless of type). Also fixed: the job-edit `GET` query now selects
`c.email AS customer_email` (it didn't before), so the card's "no email on file" warning is
accurate. Add a new step message = add a `config/jobStepMessages.js` entry + a
`views/emails/*.ejs` template; no route/schema change.

**Consultation "On My Way" + staff phone** (`029_consultation_omw_and_user_phone.sql`) —
the Consultations list's "On My Way" button now: (1) gives real feedback — redirects with
`?omw_sent=<id>` / `?omw_noemail=<id>` and the list shows a success/warning alert; (2) records
`consultations.on_the_way_sent_at`, so the row shows a **"✓ On my way sent"** state + a small
**resend** link instead of an always-active button (plus a client-side disable-on-submit so it
can't be double-sent mid-request); and (3) names the **consultant and their contact number** in
the email (`consultation-on-the-way`), from the consultation's `consultant_id` → new
**`users.phone`** column, falling back to `company_settings.phone`. Staff phones are managed in
**Settings → Users** (added to the create + edit forms and the list, `routes/admin/settings.js`).

---

## PICK UP HERE (last session ended 2026-08-14)

Phases 1–4 and 5a are **built, deployed and verified**. Everything is committed and pushed;
prod, the NAS test instance and Ledger are all healthy. Open items, roughly in priority
order:

1. **Domain move — DONE 2026-08-14.** Hub is live at **`https://app.connectedworkos.com`**;
   `hub.connectedhomeoutfitters.com` is now a permanent 301 to it. Apex
   `connectedworkos.com` deliberately left on its registrar parking page, reserved for a
   marketing site — the app took `app.` so it never has to move off the apex later and
   redo every redirect URI a second time.

   What changed: two nginx vhosts (reference copies in `nginx/`), a certbot cert for the
   new host, and **three env vars** — Hub `BASE_URL` + `GOOGLE_CALLBACK_URL`, Ledger
   `HUB_URL`. Pre-change copies are on the VPS as `.env.bak-pre-domain-move` in
   `/var/www/cho-hub` and `/var/www/chl`, plus `/root/hub-vhost.bak-pre-domain-move`.
   **No application code referenced the hostname** — every link is built as
   `BASE_URL + BASE_PATH + path`, which is exactly why this was a config-only move.
   Verified: new host 200 over TLS, old host 301 preserving **path and query** (proved
   against `/e/:token` and `/i/:token/next-steps?redirect_status=…`), the http→https→new-host
   double hop lands correctly, and Ledger stayed 200 throughout.

   **Two corrections to the pre-move notes**, both of which would have wasted time:
   - The **sandbox** Stripe Connect redirect URI was *not* affected — it points at the NAS
     (`masinet.synology.me/choHubProject/...`). The old note said "live AND sandbox".
   - The **old host's certbot cert must keep renewing** even though it only redirects: an
     `https://hub…` link negotiates TLS *before* the 301 is ever sent, so letting it lapse
     would break every already-delivered estimate, invoice and magic link.

   **Google sign-in re-verified in a real browser** on the new host (see Deployment item 3
   for the two-OAuth-clients trap that made this take longer than it should have).

   **Not verifiable from CHO's org:** the **Stripe Connect** redirect URI on the new
   domain. Org 1 has `uses_platform_stripe = TRUE`, so `/admin/settings/payments` just
   says "billing through the platform account" and never builds a Connect OAuth URL. That
   redirect URI is only exercised when a *second* tenant connects, and the sandbox tenant
   points at the NAS instead — so it's registered and the code builds it from the (now
   correct) `BASE_URL`, but it stays unproven until a real tenant connects on live.

   **Still outstanding from this move:** **re-seal the secrets vault** — `secrets.vault`
   holds every environment's `.env` and two of them just changed, so it is now stale.
   Needs the owner's passphrase (not recoverable, in their password manager).
2. **Hub needs its own logo.** `public/img/logo.png` is the DEFAULT every tenant sees until
   they upload their own — so an unbranded contractor's portal and invoice PDFs currently
   carry Connected Home Outfitters' mark. The default must be a neutral product logo.
3. **Landing-page labels.** "Staff sign-in" is ambiguous once there are many companies —
   staff of *whom?* Proposed: **Company sign-in** / **Subcontractor sign-in** /
   **Customer sign-in**, each with a one-line "who this is for".
4. **Org adoption can be claimed by email alone.** `findAdoptableOrg()` adopts an
   **unlinked** org whose active admin email matches the Ledger-verified SSO email. Anyone
   controlling that address could claim the org. Narrow (unlinked orgs only; once linked,
   matching is by workspace id and adoption never runs) and currently zero exposure — no
   unlinked orgs on prod — but every hand-onboarded contractor sits unlinked until they
   connect. Fix if wanted: require a one-time claim code generated in Hub.
5. **Subcontractor working for several tenants** gets one magic link per company and lands
   in one portal with **no switcher**. Works, but a company switcher is the real answer.
6. **Phase 5b — the paid Hub add-on** is not built (see below).
7. **Refund-after-sync doesn't adjust the Ledger transaction** (see phase 5a).

Deliberately declined by the owner: rolling the two live Stripe signing secrets that were
exposed in a screenshot/chat (`whsec_vsms…Q3PQ`, `whsec_3Rir…F8n8`). If ever rolled,
re-seal the vault.

**Secrets vault**: `secrets.vault` in this folder is the only offline copy of every
environment's `.env` (see `scripts/secrets-vault.js`). Dev machine only — excluded from git
and from the NAS sync, with a test enforcing both. Passphrase is in the owner's password
manager and is not recoverable. Re-seal after any secret changes.

**NAS test instance currently points at the Stripe SANDBOX** (test mode of
`acct_1Tfpeq23gE2V9wii`), with org 6 "Sandbox Test Contracting" as a connected-account test
tenant. Prod is unaffected and remains on live keys.

---

## Multi-tenancy — PHASE 1 COMPLETE (2026-08-13)

Hub is being turned into a **multi-tenant SaaS sold to Connected Home Ledger's business
customers**. Full rationale, rejected alternatives, and the 5-phase plan live in
**`docs/adr/0001-multi-tenancy.md`** — read that before touching schema or queries.

Shape: three apps stay separate. **Ledger becomes the identity + subscription layer**
(its `business_workspaces` row is the tenant), **Hub becomes the multi-tenant ops
product**. Hub's new `orgs` table is the tenant boundary; **Connected Home Outfitters is
org #1** and runs the same code path as every other tenant (no special-casing).

**Where it stands — phase 1 (1a + 1b) complete and DEPLOYED TO PROD (2026-08-13).**
Both test and prod are migrated; prod is org 1 with all existing data backfilled.
Deployed as commit `83c6f8a`, pushed to `main`.

- `030_orgs_multitenancy.sql` creates `orgs` (with `ledger_workspace_id`,
  `stripe_account_id`, `entitlement_expires_at`, per-tenant `lead_webhook_secret`) and
  adds `org_id` to all **27 tenant tables**. `users.email`/`google_id` uniqueness became
  **per-org**; `company_settings` stopped being the single `id=1` row and is now one row
  per org (`UNIQUE(org_id)`). `031_orgs_drop_default.sql` then drops the backfill default.
- **Expand/contract, deliberately two migrations**: 030 leaves `org_id NOT NULL DEFAULT 1`
  so existing queries keep working while they're rewritten; 031 drops it so a forgotten
  `org_id` fails loudly (`ER_NO_DEFAULT_FOR_FIELD`) instead of silently writing into CHO's
  data. The first attempt dropped it inside 030 and instantly broke every INSERT — hence
  two files. **Don't re-merge them**; the same pattern applies to any future NOT NULL add.
- **`config/scopedDb.js`** is the isolation control. It wraps the mysql2 pool with an
  org id and **throws** on any statement touching a tenant table without constraining
  `org_id`. **Routes use `req.db`** (set by `middleware/orgContext.js`, mounted in
  `server.js` right after `passport.session()`) and must never import `config/db`.
  Genuinely cross-org queries use **`req.db.unscoped.execute(...)`** so the exception is
  greppable.
- **`npm test`** (Node's built-in runner, no new dependency) — 23 tests covering the
  guard, `orgContext`, a drift check that `TENANT_TABLES` matches migration 030, and a
  **static sweep (`test/queryScoping.test.js`) that extracts every SQL literal in
  `routes/`/`services/`/`middleware/` and fails if one touches a tenant table without
  `org_id`**. Run it after touching any query. Its `ALLOWED_UNSCOPED` map is the list of
  deliberate cross-org lookups; adding to it should be a conscious decision.
- **Conventions** (full list in the ADR): services taking a `conn` also take an `orgId`;
  cron jobs sweep tenants via `services/orgs.js`'s `forEachActiveOrg`; routes accepting a
  `customer_id` from a form body **verify it belongs to `req.orgId` before inserting**
  (org_id on the new row alone doesn't stop a forged id); an interpolated column list must
  still spell `org_id` literally in the SQL or the static sweep can't see it.
- **Verified**: 23/23 tests; all 26 admin pages + 3 portal login pages return 200; a full
  write workflow (customer → product → estimate with catalog-linked line items → edit →
  PDF → materials → save-as-template → invoice → void → consultation → auto-created job →
  company settings) all round-trips with `org_id` set; and a live throwaway **org 2** was
  created to confirm org 1 cannot read, update, or delete any of its rows (and vice versa).

**Auth lookups are deliberately unscoped** (`config/passport.js`) — authentication is
what *establishes* the org, so there's no context to scope by yet. Since email is now
unique per-org rather than globally, login gains an org-selection step in phase 3. The
customer and subcontractor magic-link flows already handle this correctly: a matching
email sends **one link per org** the address exists in, since each token is per-customer.

### Phase 3 — Ledger SSO (DEPLOYED to prod 2026-08-13, commit `0243d82`)

A Connected Home Ledger customer with a Business Workspace clicks **"Open CHO Hub"** on
their workspace page and lands signed in here, with their org auto-provisioned.
`032_ledger_sso.sql` adds `sso_used_tokens`, `users.origin`/`ledger_user_id`, and
`orgs.ledger_plan`/`entitlement_checked_at`.

- **Not a fourth principal type.** `routes/sso.js` establishes the ordinary **staff
  Passport session** via `req.login()`, so `serializeUser`/`deserializeUser` and every
  `requireAuth` are untouched. This is what let SSO land without the `{type,id}` rework.
- **Token format** — `services/ledgerSso.js`, **byte-identical to
  `N:\gymrProject\services\hubSso.js`** (Ledger signs, Hub verifies). Dependency-free
  HMAC-SHA256 over a base64url JSON payload: `b64url(payload).b64url(sig)`. 60-second TTL,
  single-use via a `jti` PRIMARY KEY insert (atomic — a concurrent replay loses the insert
  rather than racing a SELECT-then-INSERT). **A change to the payload shape must land in
  both files at once**; `test/ledgerSso.test.js` asserts they haven't drifted whenever both
  checkouts are present.
- **Entitlement policy lives in Ledger**, which owns billing — `config/hubAccess.js` there.
  Hub only honours the token's `hubEntitled` flag and the entitlement webhook. Currently
  `plan === 'premium'` (business workspaces are already Premium-gated); phase 5 replaces
  that with the paid add-on's subscription-item lookup.
- **Revocation**: Ledger's `syncSubscription()`/`cancelSubscription()` call
  `services/hubEntitlement.js`, which POSTs `/webhooks/ledger-entitlement` (timing-safe
  compare on `X-Ledger-Secret`). **Suspending never deletes** — the org's data stays put so
  a customer who resubscribes finds it waiting. The push is non-blocking and never throws,
  so Hub being down can't break Ledger's Stripe webhook; a missed push is caught at the
  next SSO handshake, which also carries entitlement.
- **`LEDGER_SSO_SECRET` (Hub) must equal `HUB_SSO_SECRET` (Ledger)**, plus `HUB_URL` on
  Ledger. Set in both local `.env`s **and on both prod apps on the VPS** (verified matching
  by comparing sha256 of the two values). Pre-change copies saved as `.env.bak-pre-sso`
  (Hub) and `.env.bak-pre-hub` (Ledger). **Still unset on the NAS test instances.**
- **Verified on test**: org auto-provisioned from a workspace (name → unique slug), first
  SSO user created as `admin` with no password, working staff session, **new org sees zero
  products and none of org 1's customers**, token replay/bad-signature/expired/malformed
  all refused, un-entitled workspace provisions nothing, webhook suspends and restores, and
  the org + staff survive a suspend/resubscribe cycle.

**Deployed and verified on prod** (2026-08-13): migration 032 applied, secret wired on both
apps, and probed live — no token / garbage / wrong-secret all return 400, while a token
signed with the *correct* secret for an un-entitled workspace returns **403**. That
400-vs-403 split is the proof the shared secret matches, and it provisions nothing (prod
still has exactly 1 org, 2 users). The entitlement webhook returns 401 on a bad secret and
200 `{matched:false}` on a good one for an unknown workspace.

**Gotcha found by the first real end-to-end click (2026-08-13): an org that already exists
gets a SECOND, empty org.** CHO existed as org 1 (catalog, templates, customers, staff)
long before SSO shipped, so the first click from Ledger workspace 1 found no matching
`ledger_workspace_id`, did the correct thing for a brand-new customer, and provisioned an
empty org 2 — making it look like the catalog and customers had vanished. **Nothing was
lost; the owner just landed in the wrong tenant.** Two fixes:

- **`services/orgProvisioning.js#findAdoptableOrg`** — before creating an org, look for an
  **unlinked** org with an **active admin whose email matches** the (Ledger-verified) SSO
  email, and adopt it instead. Requires exactly one match; more than one logs a warning and
  adopts nothing rather than guessing its way into someone else's tenant. This is the path
  every manually-onboarded contractor will take.
- **`033_adopt_cho_org.sql`** — one-off data fix for the org 2 that already existed. It
  **relinks rather than migrating**: org 1 keeps every row and is simply pointed at
  workspace 1; the empty org 2 and its auto-created staff row are removed. Every statement
  is guarded, so it's a no-op once applied and refuses to act if org 2 ever turns out to
  hold real data. Verified on test against a faithful reproduction of the prod state,
  including idempotency.

**Do not "migrate the data" to fix this.** Moving 27 tables' worth of rows between orgs is
strictly worse than flipping one foreign key — the relink reaches the identical end state
with no data touched.

### Phase 2 — per-org branding (2026-08-13)

`034_org_branding.sql` adds `logo_filename`, `accent_color`, `website`, `license_number`,
`email_reply_to`, `terms_override` to `company_settings`. Before this every tenant rendered
**CHO's logo, CHO's accent colour, and CHO's legal terms** — invisible while CHO was the
only org, unacceptable the moment a second contractor signs in.

- **Logo** — uploaded in Settings → Company to `uploads/logos/<org_id>/`, served by
  **`routes/branding.js` (`GET /branding/:orgId/logo`), which is deliberately PUBLIC and
  unauthenticated** — the exact opposite of every other upload route here. An email client
  has no session, so a logo referenced in an email must be fetchable without one; it's the
  business's public identity anyway. **Do not copy this pattern for anything else in
  `uploads/`.** Not `express.static`, so a re-upload takes effect at once and an old file
  can't be fetched by guessing its name. Falls back to the bundled `public/img/logo.png`
  for any org that hasn't uploaded one, so CHO looks unchanged until it overrides.
- **Accent colour** — both `app.css` and `portal.css` derive every themed colour from a
  single `--cho-accent`, so `views/partials/head.ejs` overrides just that one variable in a
  nonce'd `<style>` block. The value is validated as a hex colour in
  `services/companySettings.js#safeAccent` — **never interpolate an unvalidated string into
  a stylesheet**.
- **Terms** — `config/estimateTerms.js` now takes `(companyName, override)`. The built-in
  default stays author-controlled HTML; an override is **tenant input, stored and rendered
  as escaped plain text** (`white-space: pre-wrap`), because the portal renders terms with
  `<%- %>` and rendering tenant HTML raw would let an org admin inject script into their own
  customers' estimate pages.
- **Email identity** — `services/mailer.js` sets the From *display name* to the org's
  company name and `replyTo` to its reply-to, while the envelope address stays global (one
  verified sending domain keeps SPF/DKIM working). Templates get the org's absolute
  `logoUrl` and a `company` local.
- **`middleware/branding.js`** puts `res.locals.branding` (logo path, accent, name) on every
  render, cached in-process for 60s so it isn't a query per request; Settings → Company calls
  `bustBranding(orgId)` on save so an admin sees the change immediately.
- **Verified**: 24 end-to-end checks including a throwaway second org proving it inherits
  **none** of org 1's logo, accent, or terms, that the logo endpoint works with no session,
  that an unknown org falls back rather than 404ing, and that `<script>` in a terms override
  comes out escaped.

**Still hardcoded / not done in phase 2**: `favicon.png`, the Roboto/Roboto&nbsp;Slab font
pairing, and the `uploads/` re-homing under `uploads/<org_id>/` for consultation photos,
documents and subcontractor files (safe as-is because those ids are globally unique, so no
two orgs can collide — it's tidiness, not isolation).

### Phase 4 — Stripe Connect (2026-08-13)

`035_stripe_connect.sql` + `services/stripeAccounts.js`. Before this, every PaymentIntent
was created on **our** account, so a second tenant's customer deposit would have settled
into Connected Home Outfitters' bank account — making us a payment facilitator for someone
else's revenue (we'd owe them the funds, absorb their chargebacks, carry their income on
our 1099-K). Now each contractor connects their **own** Stripe account via Connect
(Standard), and we never take custody of their money.

- **One code path, one difference: whether `{ stripeAccount }` is spread into the call.**
  `stripeOptions(org)` returns `{}` for the platform org and `{ stripeAccount }` for a
  connected one. Applied at **every** Stripe call site — PaymentIntent create
  (`routes/portal.js`), charge retrieve (`routes/webhooks.js`), refunds list
  (`services/paymentsSync.js`), PaymentIntent retrieve + refund create
  (`routes/admin/payments.js`). **Miss one and it silently hits the wrong account.**
- **`orgs.uses_platform_stripe` is TRUE only for org 1** (CHO's Stripe account *is* the
  platform account; Stripe won't let a platform connect to itself). This is an explicit
  flag, deliberately **not** "NULL `stripe_account_id` means platform" — a newly
  provisioned org also has NULL there and must never be able to charge into our account.
- **An unconnected tenant cannot take payment at all.** `POST /i/:token/pay` returns 503
  and the pay page says payment isn't available yet, rather than falling back to the
  platform account. This is the single most important behaviour in the phase.
- **Client side**: Connect has no per-tenant publishable key — Stripe.js gets the
  *platform* key plus `{ stripeAccount }`, or the intent can't be retrieved and the
  Payment Element never mounts (`public/js/page-pay.js`, `views/portal/invoice.ejs`).
- **We never store another business's API keys.** Connect means they authorise the
  platform and we act on their behalf with our key + their account id. A settings form
  collecting their secret keys would mean taking custody of credentials that move their
  money — don't add one.
- **OAuth flow** at `/admin/settings/payments` (`routes/admin/stripeConnect.js`,
  admin-only). CSRF-guarded by a single-use `orgs.stripe_oauth_state` cleared before the
  code exchange; `UNIQUE(stripe_account_id)` stops one Stripe account being bound to two
  tenants. Disconnect only clears our reference — it doesn't deauthorize their account or
  touch payment history.
- **Verified**: 27 checks — routing decisions, an unconnected tenant refused at the route,
  the page, and the context helper with no payment row created; org 1 still charging the
  platform account with a **real Stripe test-mode PaymentIntent** carrying the right
  metadata; and the OAuth callback rejecting a forged state.

**Webhooks: Connect needs a SECOND endpoint, not a setting on the existing one.** A
webhook endpoint's `connect` flag is **immutable after creation** — an account-only
endpoint can't be upgraded to also deliver connected-account events. So two endpoints
point at the same `/webhooks/stripe` URL, each with its own signing secret:
`STRIPE_WEBHOOK_SECRET` (platform account = org 1) and `STRIPE_CONNECT_WEBHOOK_SECRET`
(connected tenants). `verifyStripeEvent()` in `routes/webhooks.js` tries each in turn;
every event is still fully signature-verified. A Connect event arriving before its secret
is configured is refused, not trusted.

**Gotcha (proved the hard way 2026-08-14): `webhookEndpoints.create({ connect: true })`
is SILENTLY IGNORED — you get a plain account endpoint.** The call succeeds, returns a
normal endpoint object, and the Dashboard then shows it under **Events from: "Your
account"** rather than "Connected accounts". Compounding it, **the API never returns a
`connect` attribute at all** (confirmed against the raw REST JSON, not just the Node SDK —
the field is absent from every endpoint object), so there is **no way to verify this from
the API**. The only source of truth is the Dashboard's Workbench → Webhooks → Event
destinations list, which has an explicit "Events from" column.

Net: **create the Connect destination in the Dashboard, not via the API.** An API-created
duplicate is worse than useless — it double-delivers every platform event to the same URL.
(That's survivable only because the `payment_intent.succeeded` handler is now idempotent;
before that fix it meant two receipt emails per payment.)

Live endpoints on `acct_1Tfpeq23gE2V9wii` (both "Your account"):
`we_1Tx5m1…` → this app, and `we_1Tg8IG…` → Ledger's billing webhook. A duplicate
`we_1U4KXk…` was created via the API and deleted the same day.

Because duplicate delivery is now possible (two endpoints, plus Stripe's own retries), the
`payment_intent.succeeded` handler was made properly idempotent: the invoice UPDATE carries
`AND status <> 'paid'` and its `affectedRows` gates the receipt email and the activity log,
so a redelivery can't send the customer a second receipt.

**Connect is fully configured and PROVEN END-TO-END (2026-08-14).** Live has
`STRIPE_CONNECT_CLIENT_ID=ca_V4Tpu52HkPA0CSP5I2mFTBcdXO5UD5Cw`, OAuth enabled, and the
callback URI registered. The whole flow was then exercised for real in the **sandbox**
(test mode of the same account, `acct_1Tfpeq23gE2V9wii`) against the NAS test instance with
a genuinely separate connected account (`acct_1Tw6KI1GZBWLiwic`): OAuth handshake →
`stripe_account_id` stored + CSRF state cleared → PaymentIntent created **on the connected
account and provably absent from the platform** → real `pm_card_visa` charge → webhook
reconciled in ~2s to the right org with card details cached and exactly one receipt email →
admin refund landing on the connected account, `amount_refunded` correct, invoice flipped
to `refunded`. Org 1 kept billing the platform account throughout.

**Two bugs that only a real run could find** — both invisible to unit tests and to `curl`:

1. **CSP `form-action` silently killed the "Connect with Stripe" button.** The form POSTs
   same-origin and 302s out to `connect.stripe.com`, and **Chrome enforces `form-action`
   across redirects**, so helmet's default `form-action 'self'` refused the navigation with
   no error and nothing in the console. `server.js` now lists
   `formAction: ["'self'", 'https://connect.stripe.com']`. Fourth member of the CSP family
   already documented here — **server-side checks can't see these; only a real browser can.**
2. **`stripe.x.retrieve(id, options)` is wrong** — the signature is
   `retrieve(id, params, options)`, so passing options second sends `{ stripeAccount }` as a
   **query param** and Stripe rejects it with "Received unknown parameter: stripeAccount".
   `create(params, options)` takes options second, which is exactly why every create path
   worked and the retrieves didn't. Affected the webhook's charge lookup (degraded: card
   details never cached) and the refund fallback (would 500). **Any new connected-account
   call: check whether it's `(params, options)` or `(id, params, options)`.**

**Sandbox setup, for future Connect work** (all separate from live — own keys, own client
id, own webhook destinations): sandbox client id
`ca_V4Tp5GLS0z0eADFkAKxUDk4gddnJb0Pb`, redirect URI
`https://masinet.synology.me/choHubProject/admin/settings/payments/callback`, and **two**
webhook destinations at `https://masinet.synology.me/choHubProject/webhooks/stripe` — one
"Your account", one "Connected accounts". The NAS `.env` holds the sandbox keys.
**Watch which sandbox you're in**: an early attempt used a client id from
`acct_1Tfpeq23gE2V9wii` with API keys from `acct_1Tw6KI1GZBWLiwic`, which would have failed
with a confusing OAuth error. Verify with
`curl https://api.stripe.com/v1/account -u "<key>:"` and check the returned account id.

A throwaway tenant exists on the test DB for this: org 6 "Sandbox Test Contracting",
login `sandbox@example.test` / `SandboxTest!2026`. The weekly prod→test sync will remove it.

### Phase 5a — Hub → Ledger bookkeeping sync (2026-08-14)

The differentiated feature: *"run your jobs in Hub and your books fill themselves in
Ledger."* When a tenant's customer pays an invoice, Hub posts it into that tenant's Ledger
**Business Workspace** as a business income transaction. Neither Housecall Pro nor
QuickBooks does this alone; it only works because the two products share an owner.

- **`036_ledger_bookkeeping_sync.sql`** adds `orgs.ledger_sync_enabled` (per-tenant
  opt-out, default ON) and `invoices.ledger_synced_at` / `ledger_transaction_id` so a Hub
  payment can be traced to the exact bookkeeping entry.
- **`services/ledgerSync.js`** — `pushPaidInvoice(orgId, invoiceId)` POSTs to Ledger's
  `/integrations/hub/transactions` with the shared `LEDGER_SSO_SECRET`. Called from the
  `payment_intent.succeeded` handler **inside the `firstTime` branch**, so it inherits the
  same idempotency latch as the receipt email, and **deliberately not awaited** — Ledger
  being down must never delay or fail reconciling a payment. It swallows its own errors;
  an unsynced invoice is recoverable via `backfillOrg(orgId)`.
- **Posts NET of refunds**, summing `payments.amount − amount_refunded` rather than the
  invoice total, so a partly-refunded job doesn't overstate the contractor's income.
- **Only linked orgs sync.** No `ledger_workspace_id` (a standalone Hub customer) → no
  target, refused. `LEDGER_URL` selects the environment.
- **Idempotency is doubled**: Hub skips anything already stamped, and Ledger dedups
  independently on `import_hash = sha256('cho-hub:invoice:<org>:<invoice>')`. That matters
  because Ledger's `idx_import_hash` is a **plain index, not unique** — so the insert there
  is a single atomic `INSERT … SELECT … WHERE NOT EXISTS`, not a racy SELECT-then-INSERT.
  It also reuses the existing CSV-importer convention (`import_hash`/`import_source`)
  rather than inventing a second dedup mechanism.
- **Verified end to end across both databases** (20 checks): amount, income type, correct
  workspace, correct category, attribution to the workspace owner, Hub's stamp, local
  short-circuit, Ledger-side dedup when the local stamp is cleared, exactly one transaction
  for a repeated push, net-of-refunds, opt-out, backfill, and an unlinked org refused.

**Known gap:** a refund issued *after* the invoice synced does **not** adjust the Ledger
transaction — the income stays at the amount posted. Fixing it needs a decision about
whether to post a negative income row or an offsetting expense, which is Ledger's
bookkeeping semantics rather than Hub's; deliberately left open rather than guessed at.

**Phase 5b (NOT built): the paid Hub add-on.** `config/hubAccess.js` in Ledger still gates
on `plan === 'premium'` as a proxy. Making Hub a real add-on means its own Stripe price, a
subscription-item lookup replacing that plan check, and a pricing/upgrade surface.

**Two things that must not be forgotten later:**
1. **Stripe Connect is required before a second tenant can take payments.**
   `routes/portal.js:246` creates PaymentIntents on *our* account — another contractor's
   customer money would land in CHO's bank account, making us a payment facilitator for
   their revenue (their chargebacks, their income on our 1099-K). Phase 4 moves to
   Connect Standard; webhook org resolution then shifts from `metadata.source` to
   `event.account`.
2. **Schema and code must deploy together from now on.** The migrated schema and the
   rewritten queries only work as a pair — old code against a 031'd schema fails every
   INSERT, and new code against an un-migrated schema fails every query. The phase-1
   deploy ran `npm run migrate && pm2 restart cho-hub --update-env` as one chained command
   to keep that window to seconds. Always back up first
   (`/usr/local/bin/cho-hub-backup.sh` → `/var/backups/cho-hub/`); restore is
   `gunzip -c <file> | mysql choHub` as root.
3. **Dev→prod is still a manual tar-over-SSH push** (the dev machine has no GitHub auth,
   so there's no local `git push`). Phase 1 was deployed by tarring the source — excluding
   `node_modules`/`.git`/`.env`/`uploads`/`public/vendor` — scp'ing it to `/tmp`, extracting
   as the `deploy` user over `/var/www/cho-hub`, then committing and pushing **from the VPS**
   (which does have a working deploy key). Two gotchas hit during that deploy: Git Bash's
   `tar` treats a `C:\...` destination as a remote host (use `/c/Users/...`), and neither
   `node` nor `pm2` is on the default PATH for `sudo -u deploy` (prepend
   `/home/deploy/.nvm/versions/node/v20.20.2/bin`). Worth fixing the dev-side GitHub auth
   before phases 3–5, since phase 3 needs coordinated deploys across two repos.

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
- **Gotcha: `BASE_URL` must NOT include `BASE_PATH`** (found + fixed 2026-08-14). Every
  generated link is built as `BASE_URL + BASE_PATH + path` (estimate links, invoice pay
  links, customer/subcontractor magic links, the Stripe Connect OAuth redirect). The NAS
  `.env` had `BASE_URL=https://masinet.synology.me/choHubProject`, which doubled the
  subpath — every emailed link from the test instance was a 404. `BASE_URL` is the bare
  origin: `https://masinet.synology.me`.
- **The NAS instance can silently not exist in PM2.** On 2026-08-14 it was serving 502
  because `cho-hub-test` wasn't registered at all (only `gymr` was). `pm2 list` showed
  nothing; `pm2 start ecosystem.nas-test.config.js` from `/volume1/web/choHubProject`
  fixed it. It was also still running pre-multi-tenancy code against the migrated test DB
  — **after migrating the shared test DB, always `gulp build` so `W:` gets the matching
  code**, or every write there fails on the NOT NULL `org_id`.
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

**NAS SSH works fine for non-interactive commands** (corrected 2026-08-14 — an older note
in gymrProject's brief claims Synology blocks this; it doesn't, at least with key auth).
`ssh -p 2222 nostrus@192.168.4.199 "<command>"` works, including `sudo` when the password
is piped in: `echo '<pw>' | sudo -S sh -c '...'`.

**But `scp`/`sftp` does NOT work** — the NAS has no sftp subsystem enabled, so `scp` fails
with "subsystem request failed on channel 0". To get a file onto the NAS, **write it
through the mapped `W:` drive** (`W:\choHubProject` == `/volume1/web/choHubProject`) and
then run it over SSH. That's how one-off scripts get there.

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

## Deployment — LIVE at `https://app.connectedworkos.com` (2026-07-25; moved 2026-08-14)

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
| nginx `server_name` | `connectedhomeledger.com` | `app.connectedworkos.com` (+ old host, redirect-only) |
| DB (local MariaDB `127.0.0.1:3306`) | its own DB | `choHub` / user `choHubWeb` |
| TLS | own certbot cert | own certbot cert |

- **SSH access:** `deploy@2.25.186.172` (runs the app / PM2, **no passwordless sudo**)
  and `root@2.25.186.172` (key-based, used for the infra: nginx, certbot, MariaDB,
  `/var/www` dirs). Both work from the dev machine's default key. MariaDB `root` is
  unix-socket auth (`mysql` as system root, no password).
- **DNS:** `app.connectedworkos.com` A record → `2.25.186.172`. The `connectedworkos.com`
  apex is left on its registrar default (`2.57.91.91`, a parking page) on purpose —
  reserved for a future marketing site, so the app never has to move off the apex later
  and redo every redirect URI a second time.
  - The retired `hub` A record on `connectedhomeoutfitters.com` → `2.25.186.172` **stays**
    (it serves the 301). It was originally an `ALIAS` → `…cdn.hstgr.net` (Hostinger shared
    hosting — the WordPress apex `connectedhomeoutfitters.com` lives there on
    `45.93.101.98`, a **different box**, not the VPS); that ALIAS was deleted and replaced
    with the A record. If `hub` ever resolves to a `2a02:4780:…` IPv6 again, the ALIAS/AAAA
    came back and is shadowing the A record.
- **PM2 persistence:** `pm2 save` done and `pm2-deploy.service` is enabled, so both apps
  resurrect on reboot. After changing which processes run, re-run `pm2 save`.
- **nginx safety:** the one shared blast-radius surface. **Always `nginx -t` before any
  reload** — a bad reload hits Ledger too. Hub owns two server blocks in
  `/etc/nginx/sites-available/` (both symlinked into `sites-enabled/`, reference copies
  of both in this repo's `nginx/`):
  - `app.connectedworkos.com` — the real app, proxying to `127.0.0.1:3100`, with
    `client_max_body_size 25M` for consultation-photo / subcontractor-doc uploads.
  - `hub.connectedhomeoutfitters.com` — **redirect only**, `return 301
    https://app.connectedworkos.com$request_uri`. Do not delete it: access-token and
    magic-link URLs carry their token in the *path* (`/e/:token`, `/i/:token`), and
    already-delivered emails point at the old host. `$request_uri` preserves path *and*
    query string, which Stripe's `/i/:token/next-steps` return needs.
- **TLS:** each host has its own certbot cert (auto-renew installed) — Ledger's untouched.
  `certbot --nginx -d app.connectedworkos.com` for the app;
  the old `hub.connectedhomeoutfitters.com` cert **must keep renewing** even though that
  host only redirects, since an old `https://hub…` link hits TLS before the 301.
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
    git clone. `public/vendor/` (gitignored, 9 MB) had to ride along in that tar since the
    VPS has no gulp/devDeps to regenerate it; a fresh `git clone` would be missing it —
    run `gulp build`'s vendor copy, or keep the existing `vendor/` in place across pulls
    (git won't touch the untracked dir).
  - **The old "dev machine has no GitHub auth" note was wrong** (corrected 2026-08-13).
    Its `id_rsa` isn't registered with GitHub, but **Git Credential Manager is configured
    and HTTPS push works fine** — `gymrProject` had been pushing that way all along. The
    real gap was that `N:\choHubProject` simply **wasn't a git repo**. Fixed by
    `git init -b main` + `git remote add origin https://github.com/…/connected-home-hub.git`
    + `git fetch` + `git reset origin/main` (mixed reset — leaves the working tree alone and
    shows uncommitted work as a normal diff). No SSH keys were created.
  - **Gotcha: `N:` is a UNC network share, so git refuses it as "dubious ownership"** until
    you add an exception — `git config --global --add safe.directory
    '%(prefix)///192.168.4.199/npm/choHubProject'`. `gymrProject` already had its own such
    entry, which is why it worked and this didn't. (Note the share resolves as lowercase
    `npm`, not `NPM`.)
  - **Dev→prod is now just git**: commit and `git push origin main` from `N:`, then on the
    VPS `cd /var/www/cho-hub && git pull --ff-only origin main && npm run migrate &&
    pm2 restart cho-hub --update-env`. The VPS keeps using its SSH deploy-key remote
    (`git@github-cho-hub:…`); dev uses HTTPS. Both push to the same `main`.
  - **`core.autocrlf=true`** comes from Git for Windows' system config, so files committed
    from dev are normalized to LF in the repo while the original tar-deployed files are
    stored CRLF. Harmless (Node doesn't care), just don't be surprised by the mixed state.
- **npm `allow-scripts` gotcha:** the VPS npm blocks package install scripts by default,
  so `bcrypt`'s `node-gyp-build` postinstall is skipped with a warning. bcrypt still works
  because its shipped **prebuilt** linux-x64 binary resolves at require time — verified
  (`bcrypt.hashSync`) before starting PM2. If a future native dep has no prebuild, it'll
  need `npm approve-scripts` or a manual `npm rebuild` on the VPS.

**Still needed to be fully production-ready (owner actions, not blocking the app running):**
1. **Staff login** — the prod `choHub` DB starts empty (0 users). Create an admin on the
   VPS: `cd /var/www/cho-hub && node scripts/create-admin.js <email> <password> <name>`.
2. **Stripe go-live — DONE.** Corrected 2026-08-14: prod has been on **live** keys
   (`sk_live`/`pk_live`) for some time; the old "prod holds test keys" note here was
   stale and had been repeated in conversation. **Real money moves through prod** — treat
   any Stripe change there accordingly. Local dev remains test-mode. The account is
   `acct_1Tfpeq23gE2V9wii`, named "Connected Home Ledger" (the shared account, as
   documented above), with charges + payouts enabled.
3. **Google sign-in — DONE, verified in a real browser 2026-08-14** (account chooser →
   consent → callback → staff dashboard, signed in on `app.connectedworkos.com`).

   **Gotcha that cost an hour: there are TWO Google OAuth clients in TWO different GCP
   projects, and the obvious one in the console is the wrong one.**

   | | Client ID | GCP project |
   |---|---|---|
   | **Hub (this app)** | `450439755709-uesesn70pk9q2jvq2bloaqs9opg1tld9` | **450439755709** |
   | Ledger | `450439755709-h41j1fi8aqe7ikl9ic8n5kop1joaq34s` | 450439755709 |
   | **Decoy — not used by any app** | `507881562654-u5ji9qpeve04th7m0kru0cth60j3j8js` | `connected-home-o-1778611…` (**507881562654**) |

   The decoy lives in a project literally named "Connected Home Outfitters LLC" and
   already had `https://hub.connectedhomeoutfitters.com/google/callback` registered, so it
   looks exactly like the right one. It is not — check the **project number** in the
   client id prefix, not the project's display name. (That stale registration also
   suggests Google sign-in on the old prod host never actually worked.)

   Both `app.connectedworkos.com` and the old `hub.…` callback are registered on the real
   client; keep both, since Google matches the URI the app *sends* (i.e. whatever
   `GOOGLE_CALLBACK_URL` is set to), which keeps the cutover reversible.

   **Do not try to verify a redirect URI registration with `curl`.** Hitting the authorize
   endpoint returns the same ~1.3 KB JS-redirect shell whether or not the URI is
   registered — Google defers that check to the browser flow. A curl probe will report
   "registered" for a URI that plainly is not. Only a real browser can tell you.

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
