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

// Populates res.locals.analytics for views/partials/head.ejs. Null when no measurement id
// is configured, so the tag simply isn't rendered in environments that shouldn't report
// (local dev, the NAS test instance) rather than polluting the property with test traffic.
function analyticsLocals(req, res, next) {
  res.locals.analytics = GA_ID ? { id: GA_ID, path: redactPath(req.originalUrl || req.path) } : null;
  next();
}

module.exports = { redactPath, redactReferrer, analyticsLocals, GA_ID };
