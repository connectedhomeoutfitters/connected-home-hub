// services/activityLog.js — append-only audit trail. Call log() at key lifecycle points.
// Never throws: an audit-write failure must not break the action being audited.
const scopedDb = require('../config/scopedDb');

// orgId is required — an audit row that can't be attributed to a tenant is worse than
// useless. Optionally pass a db connection (conn) to write inside an existing transaction
// so the audit row commits/rolls back atomically with the action; otherwise a scoped pool
// handle is used.
async function log({
  orgId, conn, actorType = 'system', actorId = null, actorName = null,
  action, entityType = null, entityId = null, customerId = null, detail = null,
}) {
  try {
    const exec = conn || scopedDb(orgId);
    await exec.execute(
      `INSERT INTO activity_log (org_id, actor_type, actor_id, actor_name, action, entity_type, entity_id, customer_id, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [orgId, actorType, actorId, actorName, action, entityType, entityId, customerId,
        detail ? String(detail).slice(0, 500) : null]
    );
  } catch (err) {
    console.error('activity_log insert failed:', err.message);
  }
}

// Convenience for staff-initiated actions (pulls actor and org from req).
function staff(req) {
  return {
    orgId: req.orgId,
    actorType: 'staff',
    actorId: req.user?.id || null,
    actorName: req.user?.name || null,
  };
}

module.exports = { log, staff };
