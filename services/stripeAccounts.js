'use strict';
// Which Stripe account a given tenant's money moves through.
// Phase 4 of docs/adr/0001-multi-tenancy.md.
//
// There is ONE code path, differing only by whether a `{ stripeAccount }` option is passed:
//
//   Connected Home Outfitters (org 1)  — uses_platform_stripe = 1 → no option, charges land
//                                        on the platform account, exactly as before Connect.
//   every other tenant                 — stripe_account_id set → option passed, charges land
//                                        on THEIR account, and we never touch the money.
//
// A tenant that hasn't connected yet can't take payments at all. That's deliberate: the
// alternative is silently collecting their customer's money into our bank account.
//
// Note we never store another business's API keys. Connect means they authorise our
// platform and we act on their behalf with our own key plus their account id — holding
// their secret keys would mean taking custody of credentials that can move their money.

const db = require('../config/db');
const stripe = require('../config/stripe');

// Loaded without org scoping: `orgs` is a global table, and the webhook path needs to
// resolve an account with no session in hand.
async function getOrgStripe(orgId) {
  const [rows] = await db.execute(
    `SELECT id, name, stripe_account_id, uses_platform_stripe, stripe_connected_at,
            stripe_account_name
       FROM orgs WHERE id = ?`,
    [orgId]
  );
  return rows[0] || null;
}

// The options object to spread into every Stripe call for this org.
// `{}` for the platform org; `{ stripeAccount }` for a connected one.
function stripeOptions(org) {
  if (!org) return {};
  if (org.uses_platform_stripe) return {};
  return org.stripe_account_id ? { stripeAccount: org.stripe_account_id } : {};
}

function canAcceptPayments(org) {
  if (!org) return false;
  return !!(org.uses_platform_stripe || org.stripe_account_id);
}

// Convenience for request handlers: everything needed to charge on behalf of an org.
async function paymentContext(orgId) {
  const org = await getOrgStripe(orgId);
  return {
    org,
    options: stripeOptions(org),
    canAccept: canAcceptPayments(org),
    // Connect uses the PLATFORM publishable key plus the account id on the client side —
    // there is no per-tenant publishable key to store.
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null,
    stripeAccount: org && !org.uses_platform_stripe ? org.stripe_account_id : null,
  };
}

// Resolve an org from a Connect webhook's `event.account`. Platform-account events arrive
// with no `account` field at all.
async function orgByStripeAccount(accountId) {
  if (!accountId) return null;
  const [rows] = await db.execute('SELECT * FROM orgs WHERE stripe_account_id = ?', [accountId]);
  return rows[0] || null;
}

// Ask Stripe what the connected account is actually called, for display in Settings.
// Best-effort: a failure here must not fail the connect flow itself.
async function fetchAccountName(accountId) {
  try {
    const acct = await stripe.accounts.retrieve(accountId);
    return acct.business_profile?.name
      || acct.settings?.dashboard?.display_name
      || acct.email
      || null;
  } catch (err) {
    console.error('stripeAccounts: could not read connected account name:', err.message);
    return null;
  }
}

module.exports = {
  getOrgStripe, stripeOptions, canAcceptPayments, paymentContext,
  orgByStripeAccount, fetchAccountName,
};
