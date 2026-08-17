'use strict';
// Shared list pagination.
//
// Every list page used to render every row it could find. That is invisible at 20 records
// and a multi-megabyte page at 20,000 — and the pages that grow fastest (jobs, invoices,
// payments, activity) are exactly the ones a busy contractor accumulates without ever
// deleting anything.
//
// Two pieces, kept deliberately small:
//   pageParams  parses ?page and hands back the LIMIT/OFFSET to use.
//   pager       bundles what views/partials/pager.ejs needs to draw the controls.
//
// LIMIT/OFFSET are interpolated into the SQL rather than passed as placeholders, because
// MySQL will not accept them as bound parameters in a prepared statement. That is only
// safe because both are coerced to integers here — never interpolate them from raw input.

const DEFAULT_PER_PAGE = 50;

function pageParams(req, perPage = DEFAULT_PER_PAGE) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const size = Math.max(1, parseInt(perPage, 10) || DEFAULT_PER_PAGE);
  return { page, perPage: size, limit: size, offset: (page - 1) * size };
}

function pager({ page, perPage, total }) {
  const count = Number(total) || 0;
  return {
    page,
    perPage,
    total: count,
    pages: Math.max(1, Math.ceil(count / perPage)),
    from: count === 0 ? 0 : (page - 1) * perPage + 1,
    to: Math.min(page * perPage, count),
  };
}

module.exports = { pageParams, pager, DEFAULT_PER_PAGE };
