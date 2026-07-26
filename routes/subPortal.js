const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const path = require('path');
const rateLimit = require('express-rate-limit');
const db = require('../config/db');
const { sendMail } = require('../services/mailer');
const { requireSub, loadSub } = require('../middleware/subAuth');

const LOGIN_TOKEN_TTL_MIN = 30;
const SUB_DOC_ROOT = path.join(__dirname, '../uploads/subcontractors');

router.use(loadSub);

// ---- Magic-link login (mirrors routes/customerPortal.js) ----

router.get('/login', (req, res) => {
  if (req.session && req.session.subcontractorId) return res.redirect(`${res.locals.basePath}/sub`);
  res.render('sub/login', { portalBranded: true, bodyClass: 'portal-page', pageScript: null, sent: false, error: null });
});

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

router.post('/login', loginLimiter, async (req, res, next) => {
  const email = (req.body.email || '').trim();
  try {
    if (!email) {
      return res.render('sub/login', { portalBranded: true, bodyClass: 'portal-page', pageScript: null, sent: false, error: 'Please enter your email address.' });
    }
    // Only active subcontractors on file can log in — no self-signup, no enumeration.
    const [rows] = await db.execute('SELECT id, name FROM subcontractors WHERE LOWER(email) = LOWER(?) AND active = 1', [email]);
    const sub = rows[0];
    if (sub) {
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + LOGIN_TOKEN_TTL_MIN * 60 * 1000);
      await db.execute('INSERT INTO subcontractor_auth_tokens (subcontractor_id, token, expires_at) VALUES (?, ?, ?)', [sub.id, token, expiresAt]);
      const basePath = process.env.BASE_PATH || '';
      const loginUrl = `${process.env.BASE_URL || ''}${basePath}/sub/verify/${token}`;
      await sendMail({
        to: email, subject: 'Your sign-in link — Connected Home Outfitters',
        template: 'subcontractor-magic-link',
        data: { subName: sub.name, loginUrl, ttlMinutes: LOGIN_TOKEN_TTL_MIN },
      });
    }
    res.render('sub/login', { portalBranded: true, bodyClass: 'portal-page', pageScript: null, sent: true, error: null });
  } catch (err) {
    next(err);
  }
});

router.get('/verify/:token', async (req, res, next) => {
  try {
    const [rows] = await db.execute(
      'SELECT * FROM subcontractor_auth_tokens WHERE token = ? AND used_at IS NULL AND expires_at > NOW()',
      [req.params.token]
    );
    const tokenRow = rows[0];
    if (!tokenRow) {
      return res.status(400).render('sub/login', {
        portalBranded: true, bodyClass: 'portal-page', pageScript: null, sent: false,
        error: 'That sign-in link has expired or was already used. Enter your email for a new one.',
      });
    }
    await db.execute('UPDATE subcontractor_auth_tokens SET used_at = NOW() WHERE id = ?', [tokenRow.id]);
    const subId = tokenRow.subcontractor_id;
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.subcontractorId = subId;
      res.redirect(`${res.locals.basePath}/sub`);
    });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  if (req.session) delete req.session.subcontractorId;
  res.redirect(`${res.locals.basePath}/sub/login`);
});

// ---- Dashboard: assigned jobs + the sub's own documents ----

router.get('/', requireSub, async (req, res, next) => {
  try {
    const sid = req.session.subcontractorId;
    const [jobs] = await db.execute(
      `SELECT j.id, j.title, j.type, j.status, j.scheduled_at, j.due_date, j.notes,
              c.name AS customer_name, c.address AS customer_address
       FROM jobs j JOIN customers c ON c.id = j.customer_id
       WHERE j.subcontractor_id = ?
       ORDER BY FIELD(j.status,'in_progress','pending','done','cancelled'),
                (j.scheduled_at IS NULL), j.scheduled_at`,
      [sid]
    );
    const [documents] = await db.execute(
      'SELECT id, category, original_name, created_at FROM subcontractor_documents WHERE subcontractor_id = ? ORDER BY created_at DESC',
      [sid]
    );
    res.render('sub/dashboard', { portalBranded: true, bodyClass: 'portal-page', pageScript: null, jobs, documents });
  } catch (err) {
    next(err);
  }
});

// Stream one of the sub's own documents (COI/W9/etc.) — scoped to the logged-in sub.
router.get('/documents/:id/download', requireSub, async (req, res, next) => {
  try {
    const [rows] = await db.execute(
      'SELECT * FROM subcontractor_documents WHERE id = ? AND subcontractor_id = ?',
      [req.params.id, req.session.subcontractorId]
    );
    const doc = rows[0];
    if (!doc) return res.status(404).render('error', { message: 'Document not found' });
    res.download(path.join(SUB_DOC_ROOT, String(doc.subcontractor_id), doc.filename), doc.original_name || doc.filename);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
