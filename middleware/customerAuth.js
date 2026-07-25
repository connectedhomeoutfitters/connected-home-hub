const db = require('../config/db');

// Customer portal sessions run parallel to (not through) Passport: staff use
// req.isAuthenticated() (Passport), customers use req.session.customerId. Keeping them
// separate means the customer tier can't accidentally satisfy a staff `requireAuth`
// check and vice versa, and the staff auth flow is untouched.

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
    try {
      const [rows] = await db.execute(
        'SELECT id, name, email FROM customers WHERE id = ?',
        [req.session.customerId]
      );
      if (rows[0]) {
        res.locals.customer = rows[0];
      } else {
        delete req.session.customerId; // stale session — customer no longer exists
      }
    } catch (err) {
      return next(err);
    }
  }
  next();
}

module.exports = { requireCustomer, loadCustomer };
