// Customer portal sessions run parallel to (not through) Passport: staff use
// req.isAuthenticated() (Passport), customers use req.session.customerId. Keeping them
// separate means the customer tier can't accidentally satisfy a staff `requireAuth`
// check and vice versa, and the staff auth flow is untouched.
//
// req.session.orgId is stamped alongside customerId at magic-link verify (see
// routes/customerPortal.js), which is what middleware/orgContext.js reads to build
// req.db for portal requests.

// Gate for /portal/* pages that need a logged-in customer.
function requireCustomer(req, res, next) {
  if (req.session && req.session.customerId) return next();
  return res.redirect(`${res.locals.basePath}/portal/login`);
}

// Loads the logged-in customer onto res.locals.customer for portal views. Runs on the
// portal routes only. Also self-heals a session whose customer was since deleted.
async function loadCustomer(req, res, next) {
  res.locals.customer = null;
  if (req.session && req.session.customerId) {
    // A session with a customerId but no org context is malformed (pre-030 cookie, or
    // an org that was since removed) — drop it rather than querying unscoped.
    if (!req.db) {
      delete req.session.customerId;
      delete req.session.orgId;
      return next();
    }
    try {
      const [rows] = await req.db.execute(
        'SELECT id, name, email FROM customers WHERE id = ? AND org_id = ?',
        [req.session.customerId, req.orgId]
      );
      if (rows[0]) {
        res.locals.customer = rows[0];
      } else {
        delete req.session.customerId; // stale session — customer no longer exists
        delete req.session.orgId;
      }
    } catch (err) {
      return next(err);
    }
  }
  next();
}

module.exports = { requireCustomer, loadCustomer };
