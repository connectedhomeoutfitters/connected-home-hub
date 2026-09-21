'use strict';
// Which card processor an org takes payment through, and everything the pay page and the
// pay route need to use it. docs/adr/0003-payment-providers.md.
//
// `orgs.payment_provider` is the switch. It is an explicit column rather than "whichever
// provider has ids set", for the same reason `uses_platform_stripe` is: a fresh org has
// nothing set for either, and must not be able to take a payment anywhere. Connecting a
// provider in Settings sets the switch; an org with both connected can flip it there.

const stripeAccounts = require('./stripeAccounts');
const squareAccounts = require('./squareAccounts');

// Returns one of:
//   { provider: 'stripe', canAccept, options, publishableKey, stripeAccount, org }
//   { provider: 'square', canAccept, accessToken, locationId, applicationId, sdkUrl, env, org }
async function paymentContextFor(orgId) {
  const org = await stripeAccounts.getOrgStripe(orgId);
  if (org && org.payment_provider === 'square') {
    const ctx = await squareAccounts.squareContext(orgId);
    return { provider: 'square', ...ctx };
  }
  const ctx = await stripeAccounts.paymentContext(orgId);
  return { provider: 'stripe', ...ctx };
}

const LABELS = { stripe: 'Stripe', square: 'Square' };

function providerLabel(p) {
  return LABELS[p] || (p ? String(p) : '—');
}

module.exports = { paymentContextFor, providerLabel };
