const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../config/db');
const scopedDb = require('../config/scopedDb');
const { sendMail } = require('../services/mailer');
const { getCompany } = require('../services/companySettings');
const { requireCustomer, loadCustomer } = require('../middleware/customerAuth');

const LOGIN_TOKEN_TTL_MIN = 30;      // magic-link validity
const ACTION_TOKEN_TTL_HOURS = 2;    // minted access token for a delegated /e/ or /i/ view

// Customer is always loaded (if a session exists) so views can show their name / a
// logged-in state even on the public login page.
router.use(loadCustomer);

// ---- Magic-link login -------------------------------------------------------------

router.get('/login', (req, res) => {
  if (req.session && req.session.customerId) return res.redirect(`${res.locals.basePath}/portal`);
  res.render('portal/login', {
    portalBranded: true, bodyClass: 'portal-page', pageScript: null,
    sent: false, error: null,
  });
});

// Rate-limited so the endpoint can't be used to spam a customer's inbox or probe emails.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

router.post('/login', loginLimiter, async (req, res, next) => {
  const email = (req.body.email || '').trim();
  const render = (extra) => res.render('portal/login', {
    portalBranded: true, bodyClass: 'portal-page', pageScript: null,
    sent: false, error: null, ...extra,
  });
  try {
    if (!email) return render({ error: 'Please enter your email address.' });

    // Deliberately UNSCOPED: there is no session yet, so this lookup is what discovers
    // which tenant(s) the address belongs to. Only emails already on file (staff-created
    // customers) can log in — no self-signup.
    //
    // The same person can be a customer of two different contractors on this platform, so
    // this may match more than one row. Each match gets its own magic link (tokens are
    // per-customer, and therefore per-org), rather than guessing which one they meant.
    const [rows] = await db.execute(
      'SELECT id, org_id, name FROM customers WHERE LOWER(email) = LOWER(?)',
      [email]
    );

    for (const customer of rows) {
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + LOGIN_TOKEN_TTL_MIN * 60 * 1000);
      await scopedDb(customer.org_id).execute(
        'INSERT INTO customer_auth_tokens (org_id, customer_id, token, expires_at) VALUES (?, ?, ?, ?)',
        [customer.org_id, customer.id, token, expiresAt]
      );
      const basePath = process.env.BASE_PATH || '';
      const loginUrl = `${process.env.BASE_URL || ''}${basePath}/portal/verify/${token}`;
      const company = await getCompany(customer.org_id);
      await sendMail({
        orgId: customer.org_id,
        to: email,
        subject: `Your sign-in link — ${company.company_name}`,
        template: 'customer-magic-link',
        data: { customerName: customer.name, loginUrl, ttlMinutes: LOGIN_TOKEN_TTL_MIN },
      });
    }

    // Same response whether or not the email matched — no account enumeration.
    res.render('portal/login', {
      portalBranded: true, bodyClass: 'portal-page', pageScript: null,
      sent: true, error: null,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/verify/:token', async (req, res, next) => {
  try {
    // Unscoped for the same reason as the login lookup: the random token is the
    // credential, and the row it resolves to carries the org this session belongs to.
    const [rows] = await db.execute(
      'SELECT * FROM customer_auth_tokens WHERE token = ? AND used_at IS NULL AND expires_at > NOW()',
      [req.params.token]
    );
    const tokenRow = rows[0];
    if (!tokenRow) {
      return res.status(400).render('portal/login', {
        portalBranded: true, bodyClass: 'portal-page', pageScript: null, sent: false,
        error: 'That sign-in link has expired or was already used. Enter your email for a new one.',
      });
    }
    await scopedDb(tokenRow.org_id).execute(
      'UPDATE customer_auth_tokens SET used_at = NOW() WHERE id = ? AND org_id = ?',
      [tokenRow.id, tokenRow.org_id]
    );

    // Regenerate the session on login to avoid session fixation, then mark it a customer.
    // orgId is stamped alongside so middleware/orgContext.js can build req.db on every
    // subsequent portal request.
    const { customer_id: customerId, org_id: orgId } = tokenRow;
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.customerId = customerId;
      req.session.orgId = orgId;
      res.redirect(`${res.locals.basePath}/portal`);
    });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  if (req.session) {
    delete req.session.customerId;
    delete req.session.orgId;
  }
  res.redirect(`${res.locals.basePath}/portal/login`);
});

// ---- Dashboard --------------------------------------------------------------------

router.get('/', requireCustomer, async (req, res, next) => {
  try {
    const scoped = [req.session.customerId, req.orgId];
    const [estimates] = await req.db.execute(
      `SELECT id, title, status, total, created_at FROM estimates
       WHERE customer_id = ? AND org_id = ? ORDER BY created_at DESC`,
      scoped
    );
    const [invoices] = await req.db.execute(
      `SELECT id, type, amount, status, due_date, created_at FROM invoices
       WHERE customer_id = ? AND org_id = ? ORDER BY created_at DESC`,
      scoped
    );
    const [payments] = await req.db.execute(
      `SELECT p.amount, p.status, p.created_at, p.card_brand, p.card_last4, i.type AS invoice_type
       FROM payments p JOIN invoices i ON i.id = p.invoice_id AND i.org_id = p.org_id
       WHERE i.customer_id = ? AND p.org_id = ? AND p.status = 'succeeded'
       ORDER BY p.created_at DESC`,
      scoped
    );
    const [warranties] = await req.db.execute(
      `SELECT item, type, provider, start_date, expires_on FROM warranties
       WHERE customer_id = ? AND org_id = ? AND active = 1 ORDER BY (expires_on IS NULL), expires_on`,
      scoped
    );
    // Appointments the customer can see (their consultations, not cancelled).
    const [consultations] = await req.db.execute(
      `SELECT consultation_date, duration_minutes, status FROM consultations
       WHERE customer_id = ? AND org_id = ? AND status <> 'cancelled'
       ORDER BY (consultation_date IS NULL), consultation_date DESC`,
      scoped
    );
    // Project status — only the actual install work, never internal staff tasks
    // (consultation/estimate_followup jobs stay hidden from the customer).
    const [jobs] = await req.db.execute(
      `SELECT title, status, scheduled_at FROM jobs
       WHERE customer_id = ? AND org_id = ? AND type = 'install'
       ORDER BY (scheduled_at IS NULL), scheduled_at DESC`,
      scoped
    );
    res.render('portal/dashboard', {
      portalBranded: true, bodyClass: 'portal-page', pageScript: null,
      estimates, invoices, payments, warranties, consultations, jobs,
    });
  } catch (err) {
    next(err);
  }
});

// ---- Action delegation: mint a one-off access token, hand off to the existing
// token-gated estimate/invoice flow (reuses all the tested accept/pay/Stripe logic) ----

// `table` is never user input — it comes from the two call sites below.
async function mintTokenAndRedirect(req, res, next, { table, resourceType, urlPrefix }) {
  try {
    const [rows] = await req.db.execute(
      `SELECT id FROM ${table} WHERE id = ? AND customer_id = ? AND org_id = ?`,
      [req.params.id, req.session.customerId, req.orgId]
    );
    if (!rows[0]) return res.status(404).render('error', { message: 'Not found' });

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + ACTION_TOKEN_TTL_HOURS * 60 * 60 * 1000);
    await req.db.execute(
      'INSERT INTO access_tokens (org_id, token, resource_type, resource_id, expires_at) VALUES (?, ?, ?, ?, ?)',
      [req.orgId, token, resourceType, rows[0].id, expiresAt]
    );
    res.redirect(`${res.locals.basePath}${urlPrefix}/${token}`);
  } catch (err) {
    next(err);
  }
}

router.get('/estimates/:id', requireCustomer, (req, res, next) =>
  mintTokenAndRedirect(req, res, next, { table: 'estimates', resourceType: 'estimate', urlPrefix: '/e' }));

router.get('/invoices/:id', requireCustomer, (req, res, next) =>
  mintTokenAndRedirect(req, res, next, { table: 'invoices', resourceType: 'invoice', urlPrefix: '/i' }));

module.exports = router;
