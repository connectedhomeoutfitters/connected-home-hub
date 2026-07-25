const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../config/db');
const { sendMail } = require('../services/mailer');
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

    // Only emails already on file (staff-created customers) can log in — no self-signup.
    const [rows] = await db.execute('SELECT id, name FROM customers WHERE LOWER(email) = LOWER(?)', [email]);
    const customer = rows[0];

    if (customer) {
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + LOGIN_TOKEN_TTL_MIN * 60 * 1000);
      await db.execute(
        'INSERT INTO customer_auth_tokens (customer_id, token, expires_at) VALUES (?, ?, ?)',
        [customer.id, token, expiresAt]
      );
      const basePath = process.env.BASE_PATH || '';
      const loginUrl = `${process.env.BASE_URL || ''}${basePath}/portal/verify/${token}`;
      await sendMail({
        to: email,
        subject: 'Your sign-in link — Connected Home Outfitters',
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
    await db.execute('UPDATE customer_auth_tokens SET used_at = NOW() WHERE id = ?', [tokenRow.id]);

    // Regenerate the session on login to avoid session fixation, then mark it a customer.
    const customerId = tokenRow.customer_id;
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.customerId = customerId;
      res.redirect(`${res.locals.basePath}/portal`);
    });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  if (req.session) delete req.session.customerId;
  res.redirect(`${res.locals.basePath}/portal/login`);
});

// ---- Dashboard --------------------------------------------------------------------

router.get('/', requireCustomer, async (req, res, next) => {
  try {
    const cid = req.session.customerId;
    const [estimates] = await db.execute(
      `SELECT id, title, status, total, created_at FROM estimates
       WHERE customer_id = ? ORDER BY created_at DESC`,
      [cid]
    );
    const [invoices] = await db.execute(
      `SELECT id, type, amount, status, due_date, created_at FROM invoices
       WHERE customer_id = ? ORDER BY created_at DESC`,
      [cid]
    );
    const [payments] = await db.execute(
      `SELECT p.amount, p.status, p.created_at, p.card_brand, p.card_last4, i.type AS invoice_type
       FROM payments p JOIN invoices i ON i.id = p.invoice_id
       WHERE i.customer_id = ? AND p.status = 'succeeded'
       ORDER BY p.created_at DESC`,
      [cid]
    );
    res.render('portal/dashboard', {
      portalBranded: true, bodyClass: 'portal-page', pageScript: null,
      estimates, invoices, payments,
    });
  } catch (err) {
    next(err);
  }
});

// ---- Action delegation: mint a one-off access token, hand off to the existing
// token-gated estimate/invoice flow (reuses all the tested accept/pay/Stripe logic) ----

async function mintTokenAndRedirect(req, res, next, { table, resourceType, urlPrefix }) {
  try {
    const [rows] = await db.execute(
      `SELECT id FROM ${table} WHERE id = ? AND customer_id = ?`,
      [req.params.id, req.session.customerId]
    );
    if (!rows[0]) return res.status(404).render('error', { message: 'Not found' });

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + ACTION_TOKEN_TTL_HOURS * 60 * 60 * 1000);
    await db.execute(
      'INSERT INTO access_tokens (token, resource_type, resource_id, expires_at) VALUES (?, ?, ?, ?)',
      [token, resourceType, rows[0].id, expiresAt]
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
