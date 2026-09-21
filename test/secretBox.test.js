'use strict';
// services/secretBox.js holds tenants' Square OAuth tokens at rest. A silent failure here
// is either a token stored in the clear or a token that can't be read back.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { seal, open, isConfigured } = require('../services/secretBox');

const KEY = crypto.randomBytes(32);

test('round-trips a value and never stores it in the clear', () => {
  const token = 'EAAAl-example-access-token-with-symbols_+/=';
  const blob = seal(token, KEY);
  assert.ok(blob.startsWith('v1:'));
  assert.ok(!blob.includes(token));
  assert.strictEqual(open(blob, KEY), token);
});

test('two seals of the same value differ (random IV) and both open', () => {
  const a = seal('same', KEY), b = seal('same', KEY);
  assert.notStrictEqual(a, b);
  assert.strictEqual(open(a, KEY), 'same');
  assert.strictEqual(open(b, KEY), 'same');
});

test('a tampered blob or the wrong key fails to open', () => {
  const blob = seal('secret', KEY);
  const parts = blob.split(':');
  const ct = Buffer.from(parts[3], 'base64');
  ct[0] ^= 0xff;
  const tampered = [parts[0], parts[1], parts[2], ct.toString('base64')].join(':');
  assert.throws(() => open(tampered, KEY));
  assert.throws(() => open(blob, crypto.randomBytes(32)));
  assert.throws(() => open('not-a-blob', KEY));
});

test('reads the key from the environment and validates its shape', () => {
  const prev = process.env.SQUARE_TOKEN_ENCRYPTION_KEY;
  process.env.SQUARE_TOKEN_ENCRYPTION_KEY = '';
  assert.strictEqual(isConfigured(), false);
  assert.throws(() => seal('x'), /no encryption key/);

  process.env.SQUARE_TOKEN_ENCRYPTION_KEY = 'too-short';
  assert.throws(() => isConfigured(), /64 hex/);

  process.env.SQUARE_TOKEN_ENCRYPTION_KEY = KEY.toString('hex');
  assert.strictEqual(isConfigured(), true);
  assert.strictEqual(open(seal('env')), 'env');
  process.env.SQUARE_TOKEN_ENCRYPTION_KEY = prev;
});
