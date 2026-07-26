// Inventory movements. stock_movements is the source of truth (audit trail); stock_qty
// on the product is the running total kept in sync here. Always adjust stock through
// these helpers so a movement is always recorded.
const db = require('../config/db');

// Apply a single stock change: record the movement and bump products.stock_qty. Pass a
// db connection (conn) to run inside an existing transaction.
async function adjustStock(exec, { productId, delta, reason, jobId = null, note = null, userId = null }) {
  await exec.execute(
    'INSERT INTO stock_movements (product_id, delta, reason, job_id, note, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    [productId, delta, reason, jobId, note, userId]
  );
  await exec.execute('UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?', [delta, productId]);
}

// Consume the tracked products on an estimate when its install job is completed.
// Idempotent per job: if this job already has 'consume' movements, do nothing (re-marking
// a job done must not deplete stock twice). Only products with track_inventory are touched.
async function consumeForJob(conn, { estimateId, jobId, userId }) {
  const [[already]] = await conn.execute(
    "SELECT COUNT(*) AS c FROM stock_movements WHERE job_id = ? AND reason = 'consume'",
    [jobId]
  );
  if (already.c > 0) return 0;

  const [lines] = await conn.execute(
    `SELECT eli.product_id, SUM(eli.quantity) AS qty, p.name
     FROM estimate_line_items eli JOIN products p ON p.id = eli.product_id
     WHERE eli.estimate_id = ? AND p.track_inventory = 1
     GROUP BY eli.product_id, p.name`,
    [estimateId]
  );
  for (const l of lines) {
    const qty = Math.round(Number(l.qty));
    if (qty <= 0) continue;
    await adjustStock(conn, {
      productId: l.product_id, delta: -qty, reason: 'consume', jobId, userId,
      note: `Used on install job #${jobId}`,
    });
  }
  return lines.length;
}

module.exports = { adjustStock, consumeForJob };
