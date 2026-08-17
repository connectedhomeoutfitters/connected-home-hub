// Shared invoice creation + balance math, used by the estimate-accept deposit flow, the
// "bill final balance" action, and manual standalone/final invoices — so the money math
// lives in exactly one place.

// Inserts an invoice row (always starts 'pending'). Pass a db connection (inside a
// transaction) or a scoped pool handle. Returns the new invoice id.
//
// `lines` is optional itemised detail — [{ description, quantity, unit_price, job_id }].
// When given, `amount` is DERIVED from them rather than trusted from the caller, so an
// invoice can never show lines that disagree with the figure the customer is charged.
// Without lines nothing changes: `amount` is used as passed, which is how the deposit and
// "bill final balance" paths still work.
async function createInvoice(conn, { org_id, estimate_id = null, customer_id, type, amount, due_date = null, description = null, lines = null }) {
  const items = Array.isArray(lines) ? lines.filter(l => l && String(l.description || '').trim()) : [];
  const total = items.length ? lineItemsTotal(items) : Number(amount);

  const [result] = await conn.execute(
    `INSERT INTO invoices (org_id, estimate_id, customer_id, type, description, amount, status, due_date)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [org_id, estimate_id, customer_id, type, description, total.toFixed(2), due_date]
  );
  const invoiceId = result.insertId;

  for (const [i, line] of items.entries()) {
    await conn.execute(
      `INSERT INTO invoice_line_items (org_id, invoice_id, description, quantity, unit_price, job_id, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [org_id, invoiceId, String(line.description).slice(0, 500),
       Number(line.quantity ?? 1).toFixed(2), Number(line.unit_price ?? 0).toFixed(2),
       line.job_id || null, i]
    );
  }
  return invoiceId;
}

// Rounded per line before summing, so the total matches what the customer reads off the
// invoice. Summing raw floats and rounding once at the end can differ by a cent, and a
// cent that cannot be traced to a line is the kind of thing that costs an afternoon.
function lineItemsTotal(lines) {
  return lines.reduce((sum, l) => {
    const qty = Number(l.quantity ?? 1);
    const price = Number(l.unit_price ?? 0);
    return sum + Math.round(qty * price * 100) / 100;
  }, 0);
}

// The lines on an invoice, in display order. Returns [] for the many invoices that have
// none — callers render the single `description` in that case.
async function lineItemsForInvoice(conn, orgId, invoiceId) {
  const [rows] = await conn.execute(
    `SELECT id, description, quantity, unit_price, job_id, sort_order
       FROM invoice_line_items
      WHERE org_id = ? AND invoice_id = ?
      ORDER BY sort_order, id`,
    [orgId, invoiceId]
  );
  return rows;
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

module.exports = { createInvoice, remainingBalanceForEstimate, lineItemsForInvoice, lineItemsTotal };
