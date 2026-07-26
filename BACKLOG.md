# Connected Home Hub — Backlog

Open, **optional** work items. Nothing here is in-progress or blocking — the core
product (full lead → consultation → estimate → e-sign → deposit → job → inventory →
final invoice → payment/refund → warranty → project close-out lifecycle, plus customer &
subcontractor portals, reporting, activity/audit log, backups) is built and live at
`hub.connectedhomeoutfitters.com`. See `CLAUDE.md` for what's already done.

Roughly priority-ordered within each section.

---

## Not built — "future" in the product vision

- **Maps / GPS** — geocode customer addresses; service-area map; route planning between
  jobs; "jobs near me" for the field. (Nothing today beyond the Google-Maps *search* link
  on the customer address.)
- **Native mobile field app** — the responsive web UI works on phones today; a real
  installed app (offline, camera, push) is a larger, separate effort.

## Depth / feature enhancements

- **Subcontractor document upload** from the sub portal — subs can currently only
  view/download their docs (COIs, W9s); let them upload updated ones.
- **Inventory purchase orders / reorder** — turn the low-stock list into a PO workflow
  (create PO to a vendor, receive against it). Builds on inventory v1 + `stock_movements`.
- **Builder referral pipeline** — currently just `customers.builder_id` attribution +
  referred-revenue. Add lead-level attribution and a per-builder pipeline/leaderboard.
- **Estimate "expiring soon" nudge** — a customer email a few days before an estimate's
  `expires_at` (auto-expiry already runs; this would improve conversion). Would need an
  `expiry_reminder_sent_at` column, mirroring the warranty/consultation reminder pattern.
- **Reporting exports / richer analytics** — CSV/PDF export of the Reports page; date-range
  filters; per-service-type and per-technician breakdowns.
- **Calendar interactions** — drag-to-reschedule and click-a-day-to-add-job on
  `/admin/calendar` (currently read-only). Needs client-side JS + CSP nonce handling.

## Polish / hardening

- **Off-site raw DB backups** — the VPS keeps 14 days of local dumps and the prod→test
  sync copies data to the NAS; add a job that pulls the nightly dump *off* the VPS (to the
  NAS or cloud) so a VPS loss doesn't lose the raw backups too.
- **Automated tests / CI** — everything is currently verified manually + via browser.
- **Dev→prod git workflow** — the `N:` dev machine has no GitHub auth, so deploys go up as
  a tar push then a commit *on the VPS*. Add GitHub auth (deploy key / credential) on `N:`
  so the loop is edit → `git push` from `N:` → `git pull` on the VPS.
- **Staff roles** — the 3 original staff accounts are all `role='admin'`. Decide whether
  any should be demoted to `staff` (RBAC + last-admin-lockout protection already exist).

## Operational (owner actions, not dev work)

- **WordPress "Coming Soon"** — the marketing site is intentionally in Elementor
  maintenance mode. Flipping it off (Elementor → Tools → Maintenance Mode) makes the public
  site, the lead form, **and** the new footer "Customer Portal" link go live together.

---

## Done (recent) — for reference, not open

Company name/address/tax ID now flow from Settings → Company into the estimate PDF and
Terms & Conditions (previously hardcoded). Stripe is live (keys + webhook). Prod DB backups
(daily) and prod→test sync (weekly) are running. WordPress footer "Customer Portal" link is
in place (shows once the site leaves Coming Soon).
