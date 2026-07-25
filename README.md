# CHO Hub

Customer portal for Connected Home Outfitters — estimates, 50% deposits, and final
invoices via Stripe. See [CLAUDE.md](./CLAUDE.md) for full architecture notes.

## Local setup

```bash
npm install
npm run migrate   # applies migrations/*.sql to the choHub test DB
npm run dev        # nodemon on PORT from .env (default 3100)
```

Create your first staff login:

```bash
node scripts/create-admin.js you@connectedhomeoutfitters.com 'somePassword' "Your Name"
```

## Not built yet

- Estimate create/edit UI + line items
- "Send to customer" (generates an access token + emails the portal link)
- Estimate accept → deposit invoice creation (`routes/admin/estimates.js` has the DB
  helper `createDepositInvoice`, not yet wired to a route)
- Final invoice creation once a job is done
- Stripe test/live keys and this app's own webhook endpoint registration (shares the
  same Stripe account as ConnectedHomeLedger — see CLAUDE.md "Stripe")
- Production deploy target on the VPS (nginx vhost for `hub.connectedhomeoutfitters.com`,
  PM2 process, real DB credentials) — not yet decided/configured
