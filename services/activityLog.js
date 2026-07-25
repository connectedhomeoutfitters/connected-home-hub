// services/activityLog.js — append-only audit trail. Call log() at key lifecycle points.
// Never throws: an audit-write failure must not break the action being audited.
const db = require('../config/db');

// Optionally pass a db connection (conn) to write inside an existing transaction so the
// audit row commits/rolls back atomically with the action; otherwise uses the pool.
async function log({
  conn, actorType = 'system', actorId = null, actorName = null,
  action, entityType = null, entityId = null, customerId = null, detail = null,
}) {
  try {
    await (conn || db).execute(
      `INSERT INTO activity_log (actor_type, actor_id, actor_name, action, entity_type, entity_id, customer_id, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [actorType, actorId, actorName, action, entityType, entityId, customerId,
        detail ? String(detail).slice(0, 500) : null]
    );
  } catch (err) {
    console.error('activity_log insert failed:', err.message);
  }
}

// Convenience for staff-initiated actions (pulls actor from req.user).
function staff(req) {
  return { actorType: 'staff', actorId: req.user?.id || null, actorName: req.user?.name || null };
}

module.exports = { log, staff };
