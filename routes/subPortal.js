const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const path = require('path');
const rateLimit = require('express-rate-limit');
const db = require('../config/db');
const scopedDb = require('../config/scopedDb');
const { sendMail } = require('../services/mailer');
const { getCompany } = require('../services/companySettings');
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
    // Deliberately UNSCOPED — no session yet, so this is what discovers which tenant(s)
    // the address belongs to. Only active subcontractors on file can log in — no
    // self-signup, no enumeration. A sub who works for two contractors on the platform
    // gets one link per relationship (tokens are per-subcontractor, hence per-org).
    const [rows] = await db.execute(
      'SELECT id, org_id, name FROM subcontractors WHERE LOWER(email) = LOWER(?) AND active = 1',
      [email]
    );
    for (const sub of rows) {
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + LOGIN_TOKEN_TTL_MIN * 60 * 1000);
      await scopedDb(sub.org_id).execute(
        'INSERT INTO subcontractor_auth_tokens (org_id, subcontractor_id, token, expires_at) VALUES (?, ?, ?, ?)',
        [sub.org_id, sub.id, token, expiresAt]
      );
      const basePath = process.env.BASE_PATH || '';
      const loginUrl = `${process.env.BASE_URL || ''}${basePath}/sub/verify/${token}`;
      const company = await getCompany(sub.org_id);
      await sendMail({
        orgId: sub.org_id,
        to: email, subject: `Your sign-in link — ${company.company_name}`,
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
    // Unscoped: the random token is the credential and carries the org on its row.
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
    await scopedDb(tokenRow.org_id).execute(
      'UPDATE subcontractor_auth_tokens SET used_at = NOW() WHERE id = ? AND org_id = ?',
      [tokenRow.id, tokenRow.org_id]
    );
    const { subcontractor_id: subId, org_id: orgId } = tokenRow;
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.subcontractorId = subId;
      req.session.orgId = orgId;
      res.redirect(`${res.locals.basePath}/sub`);
    });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  if (req.session) {
    delete req.session.subcontractorId;
    delete req.session.orgId;
  }
  res.redirect(`${res.locals.basePath}/sub/login`);
});

// ---- Dashboard: assigned jobs + the sub's own documents ----

router.get('/', requireSub, async (req, res, next) => {
  try {
    const scoped = [req.session.subcontractorId, req.orgId];
    const [jobs] = await req.db.execute(
      `SELECT j.id, j.title, j.type, j.status, j.scheduled_at, j.due_date, j.notes,
              c.name AS customer_name, c.address AS customer_address
       FROM jobs j JOIN customers c ON c.id = j.customer_id AND c.org_id = j.org_id
       WHERE j.subcontractor_id = ? AND j.org_id = ?
       ORDER BY FIELD(j.status,'in_progress','pending','done','cancelled'),
                (j.scheduled_at IS NULL), j.scheduled_at`,
      scoped
    );
    const [documents] = await req.db.execute(
      'SELECT id, category, original_name, created_at FROM subcontractor_documents WHERE subcontractor_id = ? AND org_id = ? ORDER BY created_at DESC',
      scoped
    );
    res.render('sub/dashboard', { portalBranded: true, bodyClass: 'portal-page', pageScript: null, jobs, documents });
  } catch (err) {
    next(err);
  }
});

// Stream one of the sub's own documents (COI/W9/etc.) — scoped to the logged-in sub.
router.get('/documents/:id/download', requireSub, async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(
      'SELECT * FROM subcontractor_documents WHERE id = ? AND subcontractor_id = ? AND org_id = ?',
      [req.params.id, req.session.subcontractorId, req.orgId]
    );
    const doc = rows[0];
    if (!doc) return res.status(404).render('error', { message: 'Document not found' });
    res.download(path.join(SUB_DOC_ROOT, String(doc.subcontractor_id), doc.filename), doc.original_name || doc.filename);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
