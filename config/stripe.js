// Shared Stripe account (Connected Home Outfitters LLC) — also used by ConnectedHomeLedger's
// SaaS billing. Every charge from this app tags metadata.source = 'cho-hub' so the two revenue
// streams stay distinguishable in Stripe's reporting/reconciliation despite sharing an account.
module.exports = require('stripe')(process.env.STRIPE_SECRET_KEY);
