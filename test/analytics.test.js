'use strict';
// The whole point of services/analytics.js is that a token must never reach Google.
// That is a security property, so it gets tested directly rather than eyeballed.

const test = require('node:test');
const assert = require('node:assert');
const { redactPath, redactReferrer } = require('../services/analytics');

const TOKEN = 'a3f9c1e88b2d4f7a9c05e1b6d4382af7';

test('token routes are reduced to their route shape', () => {
  assert.strictEqual(redactPath(`/e/${TOKEN}`), '/e/:token');
  assert.strictEqual(redactPath(`/e/${TOKEN}/pdf`), '/e/:token/pdf');
  assert.strictEqual(redactPath(`/i/${TOKEN}`), '/i/:token');
  assert.strictEqual(redactPath(`/i/${TOKEN}/next-steps`), '/i/:token/next-steps');
  assert.strictEqual(redactPath(`/portal/verify/${TOKEN}`), '/portal/verify/:token');
  assert.strictEqual(redactPath(`/sub/verify/${TOKEN}`), '/sub/verify/:token');
});

test('no output ever contains the token itself', () => {
  const paths = [
    `/e/${TOKEN}`, `/e/${TOKEN}/pdf`, `/i/${TOKEN}`, `/i/${TOKEN}/next-steps`,
    `/portal/verify/${TOKEN}`, `/sub/verify/${TOKEN}`, `/something/new/${TOKEN}`,
  ];
  for (const p of paths) {
    assert.ok(!redactPath(p).includes(TOKEN), `token survived redaction in ${p}`);
  }
});

test('the query string is dropped entirely', () => {
  // Stripe appends the PaymentIntent client secret to its return_url. Redacting the path
  // but keeping the query would leak it just as badly as keeping the token.
  const out = redactPath(`/i/${TOKEN}/next-steps?payment_intent=pi_123&payment_intent_client_secret=pi_123_secret_XYZ&redirect_status=succeeded`);
  assert.strictEqual(out, '/i/:token/next-steps');
  assert.ok(!out.includes('secret'));
  assert.ok(!out.includes('pi_123'));
});

test('numeric record ids collapse so reports aggregate', () => {
  assert.strictEqual(redactPath('/admin/customers/12'), '/admin/customers/:id');
  assert.strictEqual(redactPath('/admin/invoices/6'), '/admin/invoices/:id');
  assert.strictEqual(redactPath('/admin/estimates/3/edit'), '/admin/estimates/:id/edit');
});

test('ordinary admin paths are left alone', () => {
  assert.strictEqual(redactPath('/admin/customers'), '/admin/customers');
  assert.strictEqual(redactPath('/admin/settings/lead-intake'), '/admin/settings/lead-intake');
  assert.strictEqual(redactPath('/'), '/');
});

test('the catch-all covers a token route nobody remembered to list', () => {
  // Safety net: a future /d/<token> download route would still be redacted.
  assert.strictEqual(redactPath(`/d/${TOKEN}`), '/d/:token');
});

test('BASE_PATH is stripped so the NAS and prod report the same paths', () => {
  const prev = process.env.BASE_PATH;
  process.env.BASE_PATH = '/choHubProject';
  try {
    assert.strictEqual(redactPath(`/choHubProject/e/${TOKEN}`), '/e/:token');
    assert.strictEqual(redactPath('/choHubProject/admin/jobs'), '/admin/jobs');
  } finally {
    if (prev === undefined) delete process.env.BASE_PATH; else process.env.BASE_PATH = prev;
  }
});

test('a referrer carrying a token is redacted too', () => {
  // gtag reads document.referrer by default, so moving from an estimate to the pay page
  // would otherwise report the estimate token as page_referrer.
  assert.strictEqual(
    redactReferrer(`https://app.connectedworkos.com/e/${TOKEN}`),
    'https://app.connectedworkos.com/e/:token'
  );
  assert.strictEqual(redactReferrer(''), '');
  assert.strictEqual(redactReferrer('not a url'), '');
});
