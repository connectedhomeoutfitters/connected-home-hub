'use strict';
// public/robots.txt is a privacy control, not a config file.
//
// It now carries three `Allow:` exceptions so Googlebot can fetch the sign-in pages and
// read their `X-Robots-Tag: noindex` (a URL that cannot be fetched is a URL whose noindex
// can never be read, which is what put an app page in the index in the first place).
//
// The risk that introduces is someone later widening one of those — `Allow: /portal/`
// instead of `Allow: /portal/login` would expose /portal/verify/:token, and a crawler
// fetching a magic link BURNS it. This test exists to make that mistake loud.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROBOTS = fs.readFileSync(path.join(__dirname, '..', 'public', 'robots.txt'), 'utf8');

const directives = (name) => ROBOTS.split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l.toLowerCase().startsWith(name.toLowerCase() + ':'))
  .map((l) => l.slice(name.length + 1).trim());

// Routes where the path itself is a credential or a customer document.
const SENSITIVE = [
  '/e/a3f9c1e88b2d4f7a9c05e1b6d4382af7',
  '/i/a3f9c1e88b2d4f7a9c05e1b6d4382af7',
  '/portal/verify/a3f9c1e88b2d4f7a9c05e1b6d4382af7',
  '/sub/verify/a3f9c1e88b2d4f7a9c05e1b6d4382af7',
  '/admin/customers',
  '/admin/invoices/6',
];

test('everything is disallowed by default', () => {
  assert.ok(directives('Disallow').includes('/'), 'robots.txt must still Disallow: /');
});

test('no Allow rule exposes a token route or the admin area', () => {
  const allows = directives('Allow');
  for (const url of SENSITIVE) {
    for (const rule of allows) {
      assert.ok(
        !url.startsWith(rule),
        `Allow: ${rule} would let a crawler fetch ${url} — widening an Allow past a ` +
        'specific sign-in page exposes token URLs. Keep the rules exact.'
      );
    }
  }
});

test('the allowed paths are exactly the three public sign-in pages', () => {
  // Deliberately an equality check rather than a subset: adding a fourth exception should
  // be a conscious edit to this test, not something that slips in.
  assert.deepStrictEqual(directives('Allow').sort(), ['/login', '/portal/login', '/sub/login']);
});
