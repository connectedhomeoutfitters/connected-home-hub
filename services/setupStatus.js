'use strict';
// What a new tenant still has to do before ConnectedWorkOS is actually usable.
//
// Drives both the one-time /welcome screen and the dashboard checklist, so the two can
// never disagree about what "set up" means. Every item is derived from real data — there
// is no "completed onboarding" flag to drift out of sync with reality. Delete your only
// customer and that step honestly goes back to incomplete.
//
// Ordered by what blocks the most: you cannot take money at all without Stripe, so that
// sits above cosmetics.

const db = require('../config/db');

async function getSetupStatus(orgId) {
  const [[org]] = await db.execute(
    'SELECT name, stripe_account_id, uses_platform_stripe, setup_dismissed_at, welcomed_at FROM orgs WHERE id = ?',
    [orgId]
  );
  if (!org) return null;

  const [[settings]] = await db.execute(
    'SELECT company_name, address, phone, email, logo_filename FROM company_settings WHERE org_id = ?',
    [orgId]
  );
  const s = settings || {};

  const one = async (sql) => {
    const [[row]] = await db.execute(sql, [orgId]);
    return Number(row.c) > 0;
  };
  const hasProducts = await one('SELECT COUNT(*) AS c FROM products WHERE org_id = ? AND active = 1');
  const hasLabor    = await one('SELECT COUNT(*) AS c FROM labor_rates WHERE org_id = ? AND active = 1');
  const hasCustomer = await one('SELECT COUNT(*) AS c FROM customers WHERE org_id = ?');

  // Payments settle into the tenant's OWN Stripe account. org 1 is the platform account
  // itself, which Stripe will not let connect to itself, so it counts as done.
  const stripeReady = !!org.stripe_account_id || !!org.uses_platform_stripe;

  const items = [
    {
      key: 'stripe',
      done: stripeReady,
      title: 'Connect Stripe',
      body: stripeReady
        ? 'Card payments go straight to your own Stripe account.'
        : 'Until this is connected you cannot take a deposit or an invoice payment — the pay page will tell your customer payment is unavailable.',
      href: '/admin/settings/payments',
      cta: 'Connect Stripe',
      blocking: true,
    },
    {
      key: 'company',
      done: !!(s.address || s.phone || s.email),
      title: 'Add your business details',
      body: 'Your address, phone and email appear on every estimate PDF and invoice you send.',
      href: '/admin/settings/company',
      cta: 'Add details',
    },
    {
      key: 'logo',
      done: !!s.logo_filename,
      title: 'Upload your logo',
      body: 'Shown on your customer portal, your emails and your estimate PDFs. Without one they carry the ConnectedWorkOS mark.',
      href: '/admin/settings/company',
      cta: 'Upload logo',
    },
    {
      key: 'pricing',
      done: hasProducts || hasLabor,
      title: 'Add your price list',
      body: 'Materials and labour rates you quote from. You can also type one-off lines on any quote, so this is optional.',
      href: '/admin/products',
      cta: 'Add items',
      optional: true,
    },
    {
      key: 'customer',
      done: hasCustomer,
      title: 'Add your first customer',
      body: 'Then quote them, send it for signature, and take the deposit.',
      href: '/admin/customers/new',
      cta: 'Add customer',
    },
  ];

  const done = items.filter(i => i.done).length;
  return {
    orgName: org.name,
    items,
    done,
    total: items.length,
    complete: done === items.length,
    dismissed: !!org.setup_dismissed_at,
    welcomed: !!org.welcomed_at,
    // The checklist earns its place only while there is something left to do.
    show: done < items.length && !org.setup_dismissed_at,
  };
}

// These write to `orgs`, which is a global table rather than a tenant one, so they live
// here: routes must never import the unscoped pool (test/queryScoping.test.js enforces
// it), and a scoped handle is the wrong tool for a non-tenant table.
async function markWelcomed(orgId) {
  await db.execute('UPDATE orgs SET welcomed_at = NOW() WHERE id = ? AND welcomed_at IS NULL', [orgId]);
}

async function dismissSetup(orgId) {
  await db.execute('UPDATE orgs SET setup_dismissed_at = NOW() WHERE id = ?', [orgId]);
}

module.exports = { getSetupStatus, markWelcomed, dismissSetup };
