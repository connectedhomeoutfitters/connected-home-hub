'use strict';
// Every .ejs template must COMPILE.
//
// Added after a comment block in views/partials/pager.ejs containing a literal EJS tag
// closed itself early and took the whole Leads page down with a 500. `node --check` cannot
// see inside templates, and the org-scoping sweep only reads SQL, so nothing in the suite
// would have caught it — the first sign was a "Something went wrong" page in the browser.
//
// This only proves the template parses, not that it renders with real data. That is still
// worth having: a syntax error in a template is total, immediate, and affects every user of
// that page.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');

const VIEWS = path.join(__dirname, '..', 'views');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : (e.name.endsWith('.ejs') ? [p] : []);
  });
}

test('every EJS template compiles', () => {
  const failures = [];
  for (const file of walk(VIEWS)) {
    try {
      // filename is needed so includes resolve the same way Express resolves them.
      ejs.compile(fs.readFileSync(file, 'utf8'), { filename: file });
    } catch (err) {
      failures.push(`${path.relative(VIEWS, file)}: ${err.message.split('\n')[0]}`);
    }
  }
  assert.deepStrictEqual(failures, []);
});
