const db = require('../config/db');

// Subcontractor portal sessions — a third principal type, parallel to Passport (staff)
// and req.session.customerId (customers). Mirrors middleware/customerAuth.js exactly.

function requireSub(req, res, next) {
  if (req.session && req.session.subcontractorId) return next();
  return res.redirect(`${res.locals.basePath}/sub/login`);
}

async function loadSub(req, res, next) {
  res.locals.subcontractor = null;
  if (req.session && req.session.subcontractorId) {
    try {
      const [rows] = await db.execute(
        'SELECT id, name, email FROM subcontractors WHERE id = ? AND active = 1',
        [req.session.subcontractorId]
      );
      if (rows[0]) res.locals.subcontractor = rows[0];
      else delete req.session.subcontractorId; // deactivated/removed — drop the session
    } catch (err) {
      return next(err);
    }
  }
  next();
}

module.exports = { requireSub, loadSub };
