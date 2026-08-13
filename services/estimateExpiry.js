// services/estimateExpiry.js — marks sent estimates past their expires_at as 'expired'
// and cancels the outstanding follow-up job (no point chasing an expired quote). Run on a
// daily tick from server.js. Idempotent: it only touches estimates still in 'sent'. Staff
// can re-send an expired estimate, which resets status + expires_at (routes/admin/
// estimates.js), so this never permanently closes a quote.
//
// Sweeps every active tenant, one scoped handle at a time — see services/orgs.js.
const { forEachActiveOrg } = require('./orgs');

async function expireForOrg(db, org) {
  const [stale] = await db.execute(
    "SELECT id FROM estimates WHERE org_id = ? AND status = 'sent' AND expires_at IS NOT NULL AND expires_at < NOW()",
    [org.id]
  );
  if (!stale.length) return 0;

  const ids = stale.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      `UPDATE estimates SET status = 'expired' WHERE org_id = ? AND id IN (${placeholders})`,
      [org.id, ...ids]
    );
    await conn.execute(
      `UPDATE jobs SET status = 'cancelled'
       WHERE org_id = ? AND estimate_id IN (${placeholders}) AND type = 'estimate_followup'
         AND status IN ('pending', 'in_progress')`,
      [org.id, ...ids]
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return ids.length;
}

async function expireStaleEstimates() {
  return forEachActiveOrg(expireForOrg, 'estimate expiry');
}

module.exports = { expireStaleEstimates };
