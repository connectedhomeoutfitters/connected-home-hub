'use strict';
// Covers the dual-secret Stripe webhook verification added for Connect.
//
// Two Stripe endpoints deliver to one URL — the account endpoint (platform charges) and
// the Connect endpoint (connected tenants' charges) — each with its own signing secret.
// This decides whether a payment event is trusted, so a bug here either rejects real
// payments or, far worse, accepts forged ones.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const PLATFORM = 'whsec_platform_test_secret';
const CONNECT = 'whsec_connect_test_secret';

// Build a payload signed the way Stripe signs it, so constructEvent really verifies.
function signed(payload, secret, { timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret)
    .update(`${timestamp}.${body}`).digest('hex');
  return { body, header: `t=${timestamp},v1=${sig}` };
}

function loadVerifier(env) {
  const prev = { ...process.env };
  // config/stripe.js constructs a client at require time, so it needs *a* key present.
  // Signature verification is pure HMAC and never calls the API, so a dummy keeps this
  // test hermetic — it must not depend on a real .env being loaded.
  Object.assign(process.env, { STRIPE_SECRET_KEY: 'sk_test_dummy_for_signature_tests' }, env);
  delete require.cache[require.resolve('../routes/webhooks')];
  const { verifyStripeEvent } = require('../routes/webhooks');
  // Restore env but keep the loaded module — it reads process.env at call time.
  return { verifyStripeEvent, restore: () => { process.env = prev; } };
}

const EVENT = { id: 'evt_test', type: 'payment_intent.succeeded', data: { object: { id: 'pi_1' } } };

test('accepts an event signed with the platform secret', () => {
  const { verifyStripeEvent, restore } = loadVerifier({
    STRIPE_WEBHOOK_SECRET: PLATFORM, STRIPE_CONNECT_WEBHOOK_SECRET: CONNECT,
  });
  const { body, header } = signed(EVENT, PLATFORM);
  const { event, error } = verifyStripeEvent(body, header);
  assert.strictEqual(error, null);
  assert.strictEqual(event.id, 'evt_test');
  restore();
});

test('accepts an event signed with the Connect secret', () => {
  const { verifyStripeEvent, restore } = loadVerifier({
    STRIPE_WEBHOOK_SECRET: PLATFORM, STRIPE_CONNECT_WEBHOOK_SECRET: CONNECT,
  });
  const { body, header } = signed(EVENT, CONNECT);
  const { event, error } = verifyStripeEvent(body, header);
  assert.strictEqual(error, null);
  assert.strictEqual(event.id, 'evt_test');
  restore();
});

test('rejects an event signed with neither secret', () => {
  const { verifyStripeEvent, restore } = loadVerifier({
    STRIPE_WEBHOOK_SECRET: PLATFORM, STRIPE_CONNECT_WEBHOOK_SECRET: CONNECT,
  });
  const { body, header } = signed(EVENT, 'whsec_some_other_secret');
  const { event, error } = verifyStripeEvent(body, header);
  assert.strictEqual(event, null);
  assert.ok(error);
  restore();
});

test('rejects a tampered payload even with a valid-looking signature header', () => {
  const { verifyStripeEvent, restore } = loadVerifier({
    STRIPE_WEBHOOK_SECRET: PLATFORM, STRIPE_CONNECT_WEBHOOK_SECRET: CONNECT,
  });
  const { header } = signed(EVENT, PLATFORM);
  const tampered = Buffer.from(JSON.stringify({ ...EVENT, data: { object: { id: 'pi_ATTACKER' } } }));
  const { event } = verifyStripeEvent(tampered, header);
  assert.strictEqual(event, null);
  restore();
});

test('still works when only the platform secret is configured', () => {
  const { verifyStripeEvent, restore } = loadVerifier({
    STRIPE_WEBHOOK_SECRET: PLATFORM, STRIPE_CONNECT_WEBHOOK_SECRET: '',
  });
  const good = signed(EVENT, PLATFORM);
  assert.strictEqual(verifyStripeEvent(good.body, good.header).error, null);

  // A Connect event arriving before its secret is configured must be refused, not trusted.
  const connectEvent = signed(EVENT, CONNECT);
  assert.strictEqual(verifyStripeEvent(connectEvent.body, connectEvent.header).event, null);
  restore();
});

test('fails closed when no secret is configured at all', () => {
  const { verifyStripeEvent, restore } = loadVerifier({
    STRIPE_WEBHOOK_SECRET: '', STRIPE_CONNECT_WEBHOOK_SECRET: '',
  });
  const { body, header } = signed(EVENT, PLATFORM);
  const { event, error } = verifyStripeEvent(body, header);
  assert.strictEqual(event, null);
  assert.match(error.message, /No webhook signing secret configured/);
  restore();
});

test('rejects a stale timestamp (replay protection)', () => {
  const { verifyStripeEvent, restore } = loadVerifier({
    STRIPE_WEBHOOK_SECRET: PLATFORM, STRIPE_CONNECT_WEBHOOK_SECRET: CONNECT,
  });
  const old = Math.floor(Date.now() / 1000) - 60 * 60; // an hour ago
  const { body, header } = signed(EVENT, PLATFORM, { timestamp: old });
  assert.strictEqual(verifyStripeEvent(body, header).event, null);
  restore();
});
