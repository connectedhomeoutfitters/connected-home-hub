'use strict';
// Covers Square webhook verification (routes/webhooks.js#verifySquareEvent).
//
// Square signs with HMAC-SHA256 over (notification URL + raw body), base64-encoded, in
// the x-square-hmacsha256-signature header. The URL being part of the signed input is the
// subtle bit: the app must sign with exactly the URL registered in the Developer Console.
// This decides whether a payment event is trusted, so it's covered directly.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const KEY = 'test_signature_key_1234';
const URL = 'https://app.example.test/webhooks/square';

function signed(payload, key = KEY, url = URL) {
  const body = Buffer.from(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', key).update(url + body.toString('utf8')).digest('base64');
  return { body, sig };
}

function loadVerifier(env) {
  const prev = { ...process.env };
  Object.assign(process.env, { STRIPE_SECRET_KEY: 'sk_test_dummy_for_signature_tests' }, env);
  delete require.cache[require.resolve('../routes/webhooks')];
  const { verifySquareEvent } = require('../routes/webhooks');
  return { verifySquareEvent, restore: () => { process.env = prev; } };
}

const EVENT = {
  merchant_id: 'MLxxx', type: 'payment.updated', event_id: 'evt_1',
  data: { type: 'payment', id: 'pay_1', object: { payment: { id: 'pay_1', status: 'COMPLETED' } } },
};

test('accepts an event signed with the configured key over the configured URL', () => {
  const { verifySquareEvent, restore } = loadVerifier({
    SQUARE_WEBHOOK_SIGNATURE_KEY: KEY, SQUARE_WEBHOOK_URL: URL,
  });
  const { body, sig } = signed(EVENT);
  const { event, error } = verifySquareEvent(body, sig);
  assert.strictEqual(error, null);
  assert.strictEqual(event.event_id, 'evt_1');
  restore();
});

test('derives the notification URL from BASE_URL + BASE_PATH when not overridden', () => {
  const { verifySquareEvent, restore } = loadVerifier({
    SQUARE_WEBHOOK_SIGNATURE_KEY: KEY, SQUARE_WEBHOOK_URL: '',
    BASE_URL: 'https://app.example.test/', BASE_PATH: '/hub',
  });
  const { body, sig } = signed(EVENT, KEY, 'https://app.example.test/hub/webhooks/square');
  assert.strictEqual(verifySquareEvent(body, sig).error, null);
  restore();
});

test('rejects a signature made over a different URL', () => {
  const { verifySquareEvent, restore } = loadVerifier({
    SQUARE_WEBHOOK_SIGNATURE_KEY: KEY, SQUARE_WEBHOOK_URL: URL,
  });
  const { body, sig } = signed(EVENT, KEY, 'https://elsewhere.example.test/webhooks/square');
  assert.strictEqual(verifySquareEvent(body, sig).event, null);
  restore();
});

test('rejects a wrong key and a tampered body', () => {
  const { verifySquareEvent, restore } = loadVerifier({
    SQUARE_WEBHOOK_SIGNATURE_KEY: KEY, SQUARE_WEBHOOK_URL: URL,
  });
  const wrongKey = signed(EVENT, 'some_other_key');
  assert.strictEqual(verifySquareEvent(wrongKey.body, wrongKey.sig).event, null);

  const { sig } = signed(EVENT);
  const tampered = Buffer.from(JSON.stringify({ ...EVENT, data: { object: { payment: { id: 'pay_ATTACKER' } } } }));
  assert.strictEqual(verifySquareEvent(tampered, sig).event, null);
  restore();
});

test('fails closed with no key configured or no header', () => {
  const noKey = loadVerifier({ SQUARE_WEBHOOK_SIGNATURE_KEY: '', SQUARE_WEBHOOK_URL: URL });
  const { body, sig } = signed(EVENT);
  assert.match(noKey.verifySquareEvent(body, sig).error.message, /No Square webhook signature key/);
  noKey.restore();

  const withKey = loadVerifier({ SQUARE_WEBHOOK_SIGNATURE_KEY: KEY, SQUARE_WEBHOOK_URL: URL });
  assert.match(withKey.verifySquareEvent(body, undefined).error.message, /Missing/);
  withKey.restore();
});

test('a wrong-length signature is refused, not thrown', () => {
  const { verifySquareEvent, restore } = loadVerifier({
    SQUARE_WEBHOOK_SIGNATURE_KEY: KEY, SQUARE_WEBHOOK_URL: URL,
  });
  const { body } = signed(EVENT);
  const { event, error } = verifySquareEvent(body, 'short');
  assert.strictEqual(event, null);
  assert.ok(error);
  restore();
});
