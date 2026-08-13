// Subcontractor portal sessions — a third principal type, parallel to Passport (staff)
// and req.session.customerId (customers). Mirrors middleware/customerAuth.js exactly,
// including the req.session.orgId stamped at magic-link verify (routes/subPortal.js).

function requireSub(req, res, next) {
  if (req.session && req.session.subcontractorId) return next();
  return res.redirect(`${res.locals.basePath}/sub/login`);
}

async function loadSub(req, res, next) {
  res.locals.subcontractor = null;
  if (req.session && req.session.subcontractorId) {
    // Malformed session (pre-030 cookie, or a removed org) — drop it rather than
    // querying unscoped.
    if (!req.db) {
      delete req.session.subcontractorId;
      delete req.session.orgId;
      return next();
    }
    try {
      const [rows] = await req.db.execute(
        'SELECT id, name, email FROM subcontractors WHERE id = ? AND org_id = ? AND active = 1',
        [req.session.subcontractorId, req.orgId]
      );
      if (rows[0]) res.locals.subcontractor = rows[0];
      else {
        delete req.session.subcontractorId; // deactivated/removed — drop the session
        delete req.session.orgId;
      }
    } catch (err) {
      return next(err);
    }
  }
  next();
}

module.exports = { requireSub, loadSub };
