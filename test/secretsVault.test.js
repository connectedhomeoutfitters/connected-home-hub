'use strict';
// The secrets vault is the only offline copy of every environment's .env, so the one
// unacceptable failure is a vault that seals but won't reopen. These tests prove the
// round trip and that tampering is detected rather than silently returning garbage.

const test = require('node:test');
const assert = require('node:assert');

const { encrypt, decrypt } = require('../scripts/secrets-vault');

const PASS = 'correct horse battery staple';
const PAYLOAD = JSON.stringify({
  sealedAt: '2026-08-14T00:00:00.000Z',
  files: {
    'prod-cho-hub.env': 'STRIPE_SECRET_KEY=sk_live_example\nSESSION_SECRET=abc123\n',
    'dev-cho-hub.env': 'DB_PASSWORD=hunter2\n',
  },
});

test('a sealed vault reopens to exactly what went in', () => {
  const vault = encrypt(PAYLOAD, PASS);
  assert.strictEqual(decrypt(vault, PASS), PAYLOAD);
});

test('the wrong passphrase fails loudly instead of returning garbage', () => {
  const vault = encrypt(PAYLOAD, PASS);
  assert.throws(() => decrypt(vault, 'not the passphrase'));
});

test('ciphertext does not leak the plaintext', () => {
  const vault = encrypt(PAYLOAD, PASS);
  const blob = JSON.stringify(vault);
  assert.ok(!blob.includes('sk_live_example'), 'secret key must not appear in the vault');
  assert.ok(!blob.includes('hunter2'), 'password must not appear in the vault');
  assert.ok(!blob.includes('SESSION_SECRET'), 'key names must not appear either');
});

test('tampering with the ciphertext is detected (GCM auth tag)', () => {
  const vault = encrypt(PAYLOAD, PASS);
  const raw = Buffer.from(vault.data, 'base64');
  raw[0] ^= 0xff;
  assert.throws(() => decrypt({ ...vault, data: raw.toString('base64') }, PASS));
});

test('a swapped auth tag is rejected', () => {
  const a = encrypt(PAYLOAD, PASS);
  const b = encrypt(PAYLOAD, PASS);
  assert.throws(() => decrypt({ ...a, tag: b.tag }, PASS));
});

test('each seal uses a fresh salt and iv, so identical input differs on disk', () => {
  const a = encrypt(PAYLOAD, PASS);
  const b = encrypt(PAYLOAD, PASS);
  assert.notStrictEqual(a.salt, b.salt);
  assert.notStrictEqual(a.iv, b.iv);
  assert.notStrictEqual(a.data, b.data);
  // …but both still open.
  assert.strictEqual(decrypt(a, PASS), PAYLOAD);
  assert.strictEqual(decrypt(b, PASS), PAYLOAD);
});

test('the vault file is excluded from git and from the NAS sync', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  const gulpfile = fs.readFileSync(path.join(root, 'gulpfile.js'), 'utf8');
  assert.match(gitignore, /^\*\.vault$/m, '.gitignore must exclude *.vault (else it ships to prod)');
  assert.match(gulpfile, /"!\*\.vault"/, 'gulpfile must exclude *.vault (else it syncs to W:)');
});
