function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect(`${res.locals.basePath}/login`);
}

// Gates the Settings area — staff/company config, promoting/deactivating users —
// separately from ordinary staff access. Must run after requireAuth.
function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  res.status(403).render('error', { message: 'Admins only' });
}

function redirectIfAuth(req, res, next) {
  if (req.isAuthenticated()) return res.redirect(`${res.locals.basePath}/`);
  next();
}

function setLocals(req, res, next) {
  res.locals.basePath = process.env.BASE_PATH || '';
  res.locals.user = req.user || null;
  // Full request path (includes BASE_PATH on the NAS) — the sidebar nav uses it to
  // highlight the active section.
  res.locals.currentPath = req.path;
  // Current query params, so views/partials/pager.ejs can build page links that keep
  // whatever filters and sorts are already applied — paging a filtered list must not
  // silently drop the filter.
  res.locals.currentQuery = req.query || {};
  next();
}

module.exports = { requireAuth, requireAdmin, redirectIfAuth, setLocals };
