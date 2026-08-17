require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const methodOverride = require('method-override');
const cron = require('node-cron');
const passport = require('./config/passport');
const db = require('./config/db');
const { setLocals } = require('./middleware/auth');
const orgContext = require('./middleware/orgContext');
const branding = require('./middleware/branding');
const { sendDueReminders } = require('./services/consultationReminders');
const { sendExpiryReminders } = require('./services/warrantyReminders');
const { expireStaleEstimates } = require('./services/estimateExpiry');

const app = express();
const BASE_PATH = process.env.BASE_PATH || '';

// Behind nginx (NAS test hosting, and eventually the VPS) — without this, Express can't
// tell the original request was HTTPS, which silently breaks secure session cookies
// (see middleware/auth.js's cookie.secure) and makes express-rate-limit reject
// X-Forwarded-For as untrusted.
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

// Generates a per-request nonce so the app's own inline <script> blocks (e.g. the
// window.CHO_HUB/CHO_HUB_CATALOG data-embedding scripts in estimate-form.ejs,
// invoice.ejs, consultation-form.ejs) can run under a strict CSP without 'unsafe-inline'
// — must run before helmet() below, since helmet reads res.locals.cspNonce while
// building the CSP header for this same request. Also carries basePath/user like
// setLocals so it's available even on error pages rendered before setLocals runs.
app.use((req, res, next) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  next();
});

// Default CSP blocks both the Stripe.js script itself (cross-origin, not 'self') and
// the Payment Element's internal iframes/API calls — Stripe requires explicit script-src/
// frame-src/connect-src exceptions or the deposit/invoice pay page can never work.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        scriptSrc: ["'self'", 'https://js.stripe.com', (req, res) => `'nonce-${res.locals.cspNonce}'`],
        frameSrc: ["'self'", 'https://js.stripe.com', 'https://hooks.stripe.com'],
        connectSrc: ["'self'", 'https://api.stripe.com'],
        // Stripe Connect's OAuth handoff is a same-origin form POST that 302s out to
        // connect.stripe.com, and Chrome enforces form-action ACROSS REDIRECTS — so
        // helmet's default `form-action 'self'` silently refuses the navigation and the
        // "Connect with Stripe" button appears to do nothing at all (no error, nothing in
        // the console). Same family as the script-src / script-src-attr gotchas above.
        formAction: ["'self'", 'https://connect.stripe.com'],
      },
    },
  })
);
app.set('view engine', 'ejs');
app.set('views', __dirname + '/views');

// Mounted before express.json()/urlencoded() below: the Stripe route inside needs the
// exact raw request bytes for signature verification, and a global body parser ahead
// of it would consume that stream first, leaving nothing for express.raw() to read.
// Routes in here that DO want a parsed body (e.g. the lead-intake webhook) apply their
// own express.json() individually — see routes/webhooks.js.
app.use(`${BASE_PATH}/webhooks`, require('./routes/webhooks'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
// Must carry BASE_PATH like every other route — under the NAS's /choHubProject
// subpath, a request for /choHubProject/css/app.css needs to resolve to
// public/css/app.css, not public/choHubProject/css/app.css. Silently broken until
// now: local dev (BASE_PATH='') never exposed this, and testing only ever checked
// HTML page status codes via curl, never an actual browser loading a page's
// sub-resources (CSS/JS) on the NAS.
// Keep the whole application out of search indexes. This is a privacy control, not an SEO
// preference: /e/:token and /i/:token serve a customer's estimate or invoice, and
// /portal/verify/:token is single-use. An indexed token URL is a leaked document.
//
// Applied before express.static so it covers assets too, and set on EVERY response rather
// than per-route, because the failure mode of forgetting one route is a customer document
// in Google. The marketing site is a separate host and is unaffected by this.
app.use((req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});

app.use(`${BASE_PATH}/`, express.static(__dirname + '/public'));

const sessionStore = new MySQLStore({}, db);
app.use(
  session({
    key: 'cho_hub_sid',
    secret: process.env.SESSION_SECRET,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 24 * 7,
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
    },
  })
);

app.use(passport.initialize());
app.use(passport.session());
// Must run after passport.session() — it reads req.user.org_id (and the customer/
// subcontractor portals' req.session.orgId) to build this request's tenant-scoped
// db handle. See docs/adr/0001-multi-tenancy.md.
app.use(orgContext);
// Reads req.orgId, so it must follow orgContext. Puts the tenant's logo/accent/name on
// res.locals for the nav, portal header and <head> (see middleware/branding.js).
app.use(branding);
app.use(setLocals);

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
app.use(`${BASE_PATH}/login`, authLimiter);

app.use(`${BASE_PATH}/`, require('./routes/index'));
app.use(`${BASE_PATH}/`, require('./routes/auth'));
// Connected Home Ledger SSO — establishes an ordinary staff session from a signed
// handoff token (see docs/adr/0001-multi-tenancy.md phase 3).
app.use(`${BASE_PATH}/sso`, require('./routes/sso'));
// Public, unauthenticated tenant logos — must be reachable from an email client.
app.use(`${BASE_PATH}/branding`, require('./routes/branding'));
app.use(`${BASE_PATH}/admin/leads`, require('./routes/admin/leads'));
app.use(`${BASE_PATH}/admin/customers`, require('./routes/admin/customers'));
app.use(`${BASE_PATH}/admin/documents`, require('./routes/admin/documents'));
app.use(`${BASE_PATH}/admin/consultations`, require('./routes/admin/consultations'));
app.use(`${BASE_PATH}/admin/jobs`, require('./routes/admin/jobs'));
app.use(`${BASE_PATH}/admin/calendar`, require('./routes/admin/calendar'));
app.use(`${BASE_PATH}/admin/estimates`, require('./routes/admin/estimates'));
app.use(`${BASE_PATH}/admin/estimate-templates`, require('./routes/admin/estimateTemplates'));
app.use(`${BASE_PATH}/admin/invoices`, require('./routes/admin/invoices'));
app.use(`${BASE_PATH}/admin/payments`, require('./routes/admin/payments'));
app.use(`${BASE_PATH}/admin/reports`, require('./routes/admin/reports'));
app.use(`${BASE_PATH}/admin/activity`, require('./routes/admin/activity'));
app.use(`${BASE_PATH}/admin/products`, require('./routes/admin/products'));
app.use(`${BASE_PATH}/admin/labor-rates`, require('./routes/admin/laborRates'));
app.use(`${BASE_PATH}/admin/subcontractors`, require('./routes/admin/subcontractors'));
app.use(`${BASE_PATH}/admin/builders`, require('./routes/admin/builders'));
app.use(`${BASE_PATH}/admin/warranties`, require('./routes/admin/warranties'));
// Mounted before the general settings router so /settings/payments/* resolves here.
app.use(`${BASE_PATH}/admin/settings/payments`, require('./routes/admin/stripeConnect'));
// Before /admin/settings so its own routes are not swallowed by the settings router.
app.use(`${BASE_PATH}/admin/settings/terms`, require('./routes/admin/termsTemplates'));
app.use(`${BASE_PATH}/admin/settings`, require('./routes/admin/settings'));
app.use(`${BASE_PATH}/portal`, require('./routes/customerPortal'));
app.use(`${BASE_PATH}/sub`, require('./routes/subPortal'));
app.use(`${BASE_PATH}/`, require('./routes/portal'));

app.use((req, res) => res.status(404).render('error', { message: 'Page not found' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { message: 'Something went wrong' });
});

// Hourly check for consultations happening in the next day that haven't had a
// reminder emailed yet — see services/consultationReminders.js.
cron.schedule('0 * * * *', () => {
  sendDueReminders().catch((err) => console.error('sendDueReminders failed:', err.message));
});

// Daily at 9am — email customers whose warranties lapse within 30 days (see
// services/warrantyReminders.js).
cron.schedule('0 9 * * *', () => {
  sendExpiryReminders().catch((err) => console.error('sendExpiryReminders failed:', err.message));
});

// Daily at 1am — expire sent estimates past their expires_at (see services/estimateExpiry.js).
cron.schedule('0 1 * * *', () => {
  expireStaleEstimates().catch((err) => console.error('expireStaleEstimates failed:', err.message));
});

const PORT = process.env.PORT || 3100;
app.listen(PORT, () => console.log(`CHO Hub listening on :${PORT}`));
