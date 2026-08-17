'use strict';
// Helpers for the shared customer picker (views/partials/customer-picker.ejs).
//
// Forms used to load every customer in the org to fill a <select>. That is fine at 20
// customers and unusable at 5,000 — the picker searches server-side instead
// (GET /admin/customers/search), so a form needs only two cheap things:
//
//   customerCount  — for the "no customers yet, add one first" empty state, which is the
//                    only reason those pages ever needed the full list.
//   customerName   — the label to show when editing a record that already has a customer.

async function customerCount(db, orgId) {
  const [[row]] = await db.execute(
    'SELECT COUNT(*) AS n FROM customers WHERE org_id = ?', [orgId]
  );
  return row.n;
}

async function customerName(db, orgId, customerId) {
  if (!customerId) return '';
  const [[row]] = await db.execute(
    'SELECT name FROM customers WHERE id = ? AND org_id = ?', [customerId, orgId]
  );
  return row ? row.name : '';
}

module.exports = { customerCount, customerName };
