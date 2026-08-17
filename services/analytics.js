'use strict';
// Analytics path redaction.
//
// This app cannot send its real URLs to Google. Customer documents live at /e/:token and
// /i/:token, and magic links at /portal/verify/:token and /sub/verify/:token — on those
// routes THE PATH IS THE CREDENTIAL. A page_view carrying the real path would hand live
// access tokens to a third party, where anyone with access to the analytics property could
// open a customer's invoice or burn their sign-in link.
//
// So every path is rewritten to its ROUTE SHAPE before it reaches gtag: /e/abc123 becomes
// /e/:token. That is also better analytics — reports aggregate by page instead of scattering
// across one row per token.
//
// Three rules, in order of how much they are trusted:
//   1. Known token routes, matched explicitly. The important one.
//   2. Numeric ids collapse to :id, so /admin/customers/12 aggregates (and doesn't publish
//      which record ids exist).
//   3. A catch-all: any long opaque-looking segment becomes :token. This is the safety net
//      for a token route added later that nobody remembers to list here — it should never
//      be the rule that saves us, but it costs nothing.
//
// The QUERY STRING IS ALWAYS DROPPED, never redacted. Stripe appends
// payment_intent_client_secret to its return_url, "On My Way" carries record ids, and any
// future param is unknown-by-default. There is no version of "send the query string" that
// is safe here, and nothing in the reports needs it.

const GA_ID = (process.env.GA_MEASUREMENT_ID || '').trim();

// Explicit shapes for the routes that carry a credential.
const TOKEN_ROUTES = [
  [/^\/e\/[^/]+/, '/e/:token'],
  [/^\/i\/[^/]+/, '/i/:token'],
  [/^\/portal\/verify\/[^/]+/, '/portal/verify/:token'],
  [/^\/sub\/verify\/[^/]+/, '/sub/verify/:token'],
];

function redactPath(rawPath) {
  let p = String(rawPath || '/').split('?')[0].split('#')[0];
  if (!p.startsWith('/')) p = '/' + p;

  // Strip the mount prefix so the rules below match the same way on the NAS (where the app
  // is served under /choHubProject) as on production.
  const base = process.env.BASE_PATH || '';
  if (base && p.startsWith(base)) p = p.slice(base.length) || '/';

  for (const [re, shape] of TOKEN_ROUTES) {
    if (re.test(p)) return p.replace(re, shape);
  }

  return p
    .split('/')
    .map((seg) => {
      if (!seg) return seg;
      if (/^\d+$/.test(seg)) return ':id';
      // Long, no vowels-and-spaces, looks generated rather than typed.
      if (seg.length >= 20 && /^[A-Za-z0-9._-]+$/.test(seg)) return ':token';
      return seg;
    })
    .join('/');
}

// Same treatment for a referrer, which arrives as a full URL. A customer moving from
// /e/:token to the pay page would otherwise leak the estimate token as page_referrer —
// gtag reads document.referrer by default, so this has to be overridden explicitly.
function redactReferrer(ref) {
  if (!ref) return '';
  try {
    const u = new URL(ref);
    return u.origin + redactPath(u.pathname);
  } catch {
    return '';
  }
}

// ── who gets measured ───────────────────────────────────────────────────────
// Only STAFF surfaces. Hub is multi-tenant and there is one analytics property, so
// reporting customer-facing pages would funnel every tenant's own customers and
// subcontractors into the vendor's analytics — people who never chose to be measured by
// us, visiting a page they were emailed a link to. Staff are users of the product and
// their usage is ordinary product analytics; a contractor's customer is not.
//
// This is an ALLOWLIST, deliberately. Default-deny means a route added later is excluded
// until somebody consciously opts it in, rather than being reported until somebody
// remembers to exclude it. For a privacy control that is the only safe direction — the
// failure mode of forgetting is silence, not a leak.
//
// Excluded by falling through: /e/:token and /i/:token (customer estimates and invoices),
// /portal/* (customer portal), /sub/* (subcontractor portal), and the public landing page.
//
// redactPath still runs on everything that IS reported. The two controls are independent:
// this decides whether to report at all, redaction decides what a report may contain.
function isStaffSurface(req) {
  let p = req.path || '/';
  const base = process.env.BASE_PATH || '';
  if (base && p.startsWith(base)) p = p.slice(base.length) || '/';

  if (p === '/admin' || p.startsWith('/admin/')) return true;
  if (p === '/login') return true;
  // '/' serves the public landing page to anonymous visitors and the staff dashboard to
  // signed-in staff — one path, two different pages. Only the signed-in one is ours.
  if (p === '/' && typeof req.isAuthenticated === 'function' && req.isAuthenticated()) return true;
  return false;
}

// Populates res.locals.analytics for views/partials/head.ejs. Null when no measurement id
// is configured — so local dev and the NAS test instance never report — or when the page
// isn't a staff surface.
function analyticsLocals(req, res, next) {
  res.locals.analytics = (GA_ID && isStaffSurface(req))
    ? { id: GA_ID, path: redactPath(req.originalUrl || req.path) }
    : null;
  next();
}

module.exports = { redactPath, redactReferrer, isStaffSurface, analyticsLocals, GA_ID };
