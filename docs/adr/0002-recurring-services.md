# ADR 0002 — Recurring services: billing work that repeats

- **Status:** Accepted (not yet implemented)
- **Date:** 2026-08-17
- **Relates to:** `0001-multi-tenancy.md`. Nothing here changes the tenancy model; every
  table introduced carries `org_id` and obeys the `config/scopedDb.js` guard.

---

## Context

ConnectedWorkOS today bills **one job at a time**. An estimate is accepted, a deposit
invoice is raised, the work is done, the balance is billed. Verified against the schema on
2026-08-17:

- `invoices.type` is `deposit` / `final` / `standalone` — no series, no parent, no
  interval, no next-run date.
- `jobs` has `scheduled_at` and `due_date`: single points in time, no recurrence rule.
- Stripe usage is **PaymentIntents only**. No `subscriptions`, no `SetupIntent`, no
  `setup_future_usage`, so there is not even a saved card — every payment is the customer
  typing their card in again.
- The three cron jobs are reminders and expiry. **None of them creates an invoice.**

That is a poor fit for half the trades the marketing site targets. **Lawn care, pool &
spa, pest control and cleaning are all recurring-revenue businesses** — a mowing contract
is the billing model, not an edge case. Today the only option is to save the package as an
estimate template and raise a standalone invoice by hand every cycle: workable for five
customers, unworkable for fifty.

### Why not Stripe Subscriptions

The obvious answer is wrong for this domain. **A subscription bills the calendar and does
not care whether anyone showed up.** Field service is the opposite: it rains, the crew is
short, the customer is having a party on Saturday and wants to skip. Billing has to follow
what actually happened, and a Stripe subscription cannot express "we skipped the second
visit in August, so that month is $45 not $90" without fighting it with proration every
time.

The unit that matters is **the visit**, not the billing period.

---

## Decision

**A recurring service is a generator of visits, not a billing schedule.**

`recurring_services` describes the pattern — customer, price per visit, cadence, season
start/stop. A nightly cron materialises upcoming visits as ordinary rows in **`jobs`**
(a new `type = 'service'`). That is the whole trick: a visit is a normal job, so it
inherits the calendar, crew assignment, the subcontractor portal and the existing billing
hook without any of them being taught about recurrence.

Every operation the business actually needs is then an edit to one row:

| Action | Implementation |
|---|---|
| Team reschedules | change that visit's `scheduled_at` |
| Skip one visit | cancel that visit; the series is untouched |
| Winter shutdown | suspend generation; the series and its history stay |
| Customer cancels | deactivate the series; already-scheduled visits stand |

### Billing: monthly rollup, after the work

**One invoice per month, listing the visits actually completed.** Not per visit. Stripe
takes roughly 2.9% + 30¢, which on a $45 mow is about **3.6%** — paying that 26 times a
year instead of 12 is a real cost for no benefit, and it fills the customer's inbox and the
payments list with noise. This is also simply what lawn companies do.

**Always in arrears.** At month end, invoice the visits that happened. This is exactly the
shape of `onInstallJobDone` — work happened, therefore bill — so it reuses a path that is
already idempotent and already syncs to Ledger.

The tradeoff being accepted is real: **you do the work before you are paid.** It is
accepted because the alternative doubles the design (see rejected alternatives) and because
a skipped visit then needs no mechanic at all — it simply never appears on an invoice.
That single property removes credits, refunds and proration from the whole feature.

A customer who cannot be trusted to pay in arrears is not a recurring-service customer yet;
the existing one-off flow already covers them, with an estimate and a deposit up front.

### Notifications

Two different messages, deliberately not merged:

- **"You have mowing scheduled Thursday 9am."** Informational, sent a few days out. It
  stops a customer being surprised and is the natural place to say "call us to skip". It
  carries **no pay link** — there is nothing to pay for work that has not happened.
- **"Your August invoice is ready."** The payment prompt, monthly, after the fact.

The original request was a single "upcoming service — pay now" message. Billing in arrears
splits it in two, because when the reminder goes out there is nothing owed yet.

### Pausing is staff-only, for now

The customer portal is **entirely read-only** today (view, accept or decline an estimate,
pay an invoice). A customer skipping a visit would be the first write action a customer
has ever performed against a job, and it needs a cutoff rule, an audit trail and a
notification to whoever is driving there. Deferred — the customer calls, staff skips it.
Revisit once the rest works.

### Rejected alternatives

- **Stripe Subscriptions.** Bills the calendar, not the work. See Context.
- **Card on file with automatic charging.** Needs `SetupIntent`, off-session charges on
  the connected account, and dunning when a card expires or declines. That is most of the
  work and all of the risk, for a convenience that a pay link already covers. Revisit when
  there is demand.
- **Prepay, or prepay selectable per service.** Considered and dropped on 2026-08-17 for
  simplicity. Charging in advance means invoicing visits that have not happened, so a
  skipped visit needs a credit-forward mechanic (refunding a card pays the fee twice and
  reconciles badly), the reminder email needs two variants, and non-payment needs a policy
  nobody wants to write: does the crew still go? Billing in arrears makes a skipped visit
  cost nothing to model — it simply never reaches an invoice. Adding a `billing_mode`
  column later is additive if collections ever become a real problem.
- **Per-visit invoices.** Multiplies card fees by ~26/12 and buries the payments list.
- **A separate `visits` table.** A visit already *is* a job — scheduled, assignable,
  completable, billable. A parallel table would need its own calendar, its own crew
  assignment and its own portal, all duplicating `jobs`.

---

## Consequences

### Schema

- **`recurring_services`** — `org_id`, `customer_id`, `title`, `unit_price`, `cadence`
  (`weekly` / `biweekly` / `monthly` / `custom_days`), `day_of_week`, `season_start`,
  `season_end`, `status`
  (`active` / `paused` / `ended`), `paused_until`, `next_generation_at`.
  No `billing_mode` — everything bills in arrears. Adding one later is additive.
- **`jobs`** — `type` gains `'service'`, plus `recurring_service_id` (nullable) and
  `visit_date`. A one-off job keeps `recurring_service_id NULL`, so nothing existing
  changes.
- **`invoices`** — needs to carry line detail, which it does not today (`amount` is a
  single figure, `description` a single string). Either an `invoice_line_items` table or
  reuse of the estimate line-item shape. **This is the largest piece of new work** and
  should be settled before anything else is built, because a monthly rollup invoice is
  meaningless without lines.

### Generation must be idempotent, like everything else that bills

The generator runs nightly and must never create a visit twice, and the monthly biller
must never invoice a visit twice. The existing precedents are the pattern to copy:
`onInstallJobDone` gates on `remainingBalanceForEstimate`, `consumeForJob` skips a job
that already has `consume` movements, and the payment webhook gates its receipt email on
`affectedRows`. A visit should carry the invoice it was billed on, and generation should
key on `(recurring_service_id, visit_date)`.

### Cron

A fourth and fifth scheduled job join the three in `server.js` (consultation reminders,
warranty expiry, estimate expiry). They sweep tenants with `forEachActiveOrg`, per the
convention in ADR 0001 — a recurring service belongs to an org and the sweep must be
org-scoped, not global.

### Ledger sync needs no change

A monthly invoice paid by card posts into the tenant's Business Workspace through
`services/ledgerSync.js` exactly as a deposit does. Recurring revenue lands in the books
with no new code, which is the strongest argument for billing through the existing invoice
path rather than inventing a parallel one.

### Marketing must not run ahead of this

The site already names lawn care, pool, pest control and cleaning. The copy does not
promise recurring billing today and must not start until this ships. When it does, the
lawn-care page is where it belongs.
