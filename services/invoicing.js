// Shared invoice creation + balance math, used by the estimate-accept deposit flow, the
// "bill final balance" action, and manual standalone/final invoices — so the money math
// lives in exactly one place.

// Inserts an invoice row (always starts 'pending'). Pass a db connection (inside a
// transaction) or a scoped pool handle. Returns the new invoice id.
async function createInvoice(conn, { org_id, estimate_id = null, customer_id, type, amount, due_date = null, description = null }) {
  const [result] = await conn.execute(
    `INSERT INTO invoices (org_id, estimate_id, customer_id, type, description, amount, status, due_date)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [org_id, estimate_id, customer_id, type, description, Number(amount).toFixed(2), due_date]
  );
  return result.insertId;
}

// What's left to bill on an estimate = its total minus every non-void invoice already
// raised against it (deposit + any prior final). Using non-void (not just paid) prevents
// creating a second final invoice on top of one that's already outstanding.
async function remainingBalanceForEstimate(conn, orgId, estimateId) {
  const [[row]] = await conn.execute(
    `SELECT e.total - COALESCE(
       (SELECT SUM(i.amount) FROM invoices i
         WHERE i.estimate_id = e.id AND i.org_id = e.org_id AND i.status <> 'void'), 0
     ) AS remaining
     FROM estimates e WHERE e.id = ? AND e.org_id = ?`,
    [estimateId, orgId]
  );
  return row ? Number(row.remaining) : 0;
}

module.exports = { createInvoice, remainingBalanceForEstimate };
