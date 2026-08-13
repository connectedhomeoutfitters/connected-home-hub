'use strict';
// Covers the Ledger→Hub SSO token format. This is a bearer credential that grants a staff
// session, so the failure modes matter more than the happy path.

const test = require('node:test');
const assert = require('node:assert');

const { createToken, verifyToken } = require('../services/ledgerSso');

const SECRET = 'test-secret-do-not-use-in-production';
const claims = {
  ledgerUserId: 42,
  workspaceId: 7,
  workspaceName: "Dave's Low Voltage",
  email: 'Dave@Example.COM',
  name: 'Dave Smith',
  plan: 'premium',
  hubEntitled: true,
};

test('a freshly signed token verifies and round-trips its claims', () => {
  const res = verifyToken(createToken(claims, SECRET), SECRET);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.payload.workspaceId, 7);
  assert.strictEqual(res.payload.ledgerUserId, 42);
  assert.strictEqual(res.payload.name, 'Dave Smith');
  assert.strictEqual(res.payload.plan, 'premium');
  assert.strictEqual(res.payload.hubEntitled, true);
});

test('email is normalised to lowercase at signing time', () => {
  const res = verifyToken(createToken(claims, SECRET), SECRET);
  assert.strictEqual(res.payload.email, 'dave@example.com');
});

test('each token gets a distinct jti', () => {
  const a = verifyToken(createToken(claims, SECRET), SECRET).payload.jti;
  const b = verifyToken(createToken(claims, SECRET), SECRET).payload.jti;
  assert.notStrictEqual(a, b);
});

test('a token signed with a different secret is rejected', () => {
  const res = verifyToken(createToken(claims, 'some-other-secret'), SECRET);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'bad_signature');
});

test('tampering with the payload invalidates the signature', () => {
  const token = createToken(claims, SECRET);
  const [body, sig] = token.split('.');
  const decoded = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());

  // Escalate: claim entitlement and a different workspace.
  decoded.hubEntitled = true;
  decoded.workspaceId = 999;
  const forgedBody = Buffer.from(JSON.stringify(decoded)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const res = verifyToken(`${forgedBody}.${sig}`, SECRET);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'bad_signature');
});

test('an expired token is rejected', () => {
  const token = createToken(claims, SECRET, 60);
  const later = Math.floor(Date.now() / 1000) + 61;
  const res = verifyToken(token, SECRET, { now: later });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'expired');
});

test('a token still valid one second before expiry is accepted', () => {
  const token = createToken(claims, SECRET, 60);
  const justBefore = Math.floor(Date.now() / 1000) + 59;
  assert.strictEqual(verifyToken(token, SECRET, { now: justBefore }).ok, true);
});

test('a far-future-dated token is rejected (clock skew / forged iat)', () => {
  const token = createToken(claims, SECRET, 10_000);
  const wayBack = Math.floor(Date.now() / 1000) - 10_000;
  const res = verifyToken(token, SECRET, { now: wayBack });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'not_yet_valid');
});

test('malformed input is rejected rather than throwing', () => {
  for (const bad of [undefined, null, '', 'nodot', 'a.b.c.d', '.', 'x.', '.y', 12345, {}]) {
    const res = verifyToken(bad, SECRET);
    assert.strictEqual(res.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
  }
});

test('a signature of the wrong length is rejected without throwing', () => {
  // timingSafeEqual throws on length mismatch — verifyToken must guard that itself.
  const token = createToken(claims, SECRET);
  const [body] = token.split('.');
  assert.doesNotThrow(() => verifyToken(`${body}.short`, SECRET));
  assert.strictEqual(verifyToken(`${body}.short`, SECRET).ok, false);
});

test('verification fails closed when no secret is configured', () => {
  const res = verifyToken(createToken(claims, SECRET), undefined);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'no_secret_configured');
});

test('signing without a secret throws rather than producing a weak token', () => {
  assert.throws(() => createToken(claims, ''), /secret is required/);
});

test('a token missing workspace or email is rejected', () => {
  const noWorkspace = verifyToken(createToken({ ...claims, workspaceId: null }, SECRET), SECRET);
  assert.strictEqual(noWorkspace.reason, 'missing_workspace');
  const noEmail = verifyToken(createToken({ ...claims, email: '' }, SECRET), SECRET);
  assert.strictEqual(noEmail.reason, 'missing_email');
});

test('hubEntitled is always a boolean, never a truthy string', () => {
  const res = verifyToken(createToken({ ...claims, hubEntitled: 'no' }, SECRET), SECRET);
  assert.strictEqual(res.payload.hubEntitled, true); // 'no' is truthy — caller's problem
  const res2 = verifyToken(createToken({ ...claims, hubEntitled: undefined }, SECRET), SECRET);
  assert.strictEqual(res2.payload.hubEntitled, false);
});

test('Hub and Ledger share a byte-identical token module', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const ledgerCopy = path.join(__dirname, '..', '..', 'gymrProject', 'services', 'hubSso.js');
  if (!fs.existsSync(ledgerCopy)) {
    // Ledger lives in a sibling checkout that may not be present (e.g. on the VPS).
    return;
  }
  const strip = (s) => s.replace(/^[\s\S]*?^const crypto = require\('crypto'\);/m, '').trim();
  assert.strictEqual(
    strip(fs.readFileSync(path.join(__dirname, '..', 'services', 'ledgerSso.js'), 'utf8')),
    strip(fs.readFileSync(ledgerCopy, 'utf8')),
    'services/ledgerSso.js and gymrProject/services/hubSso.js have drifted — SSO will break'
  );
});
