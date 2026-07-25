const db = require('../config/db');

// Resolves a signed token from the URL (/e/:token, /i/:token) to the estimate/invoice it
// grants access to. Tokens expire and are single-purpose — no customer password ever exists.
function resolveToken(resourceType) {
  return async (req, res, next) => {
    try {
      const [rows] = await db.execute(
        `SELECT * FROM access_tokens
         WHERE token = ? AND resource_type = ? AND expires_at > NOW()`,
        [req.params.token, resourceType]
      );
      const tokenRow = rows[0];
      if (!tokenRow) return res.status(404).render('portal/expired');

      req.resourceId = tokenRow.resource_id;
      req.accessToken = tokenRow;
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { resolveToken };
