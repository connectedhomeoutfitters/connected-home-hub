const db = require('../config/db');
const { attachOrg } = require('./orgContext');

// Resolves a signed token from the URL (/e/:token, /i/:token) to the estimate/invoice it
// grants access to. Tokens expire and are single-purpose — no customer password ever exists.
//
// Multi-tenancy: this lookup is deliberately UNSCOPED. A token link carries no session and
// no org context — the random token IS the credential, and the row it resolves to is what
// tells us which tenant this request belongs to. Once resolved we call attachOrg(), so
// every downstream query in the route runs through a scoped handle.
// See docs/adr/0001-multi-tenancy.md.
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
      attachOrg(req, tokenRow.org_id);
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { resolveToken };
