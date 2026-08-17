const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcrypt');
const { requireAuth, requireAdmin } = require('../../middleware/auth');
const { logoDir, safeAccent } = require('../../services/companySettings');
const { bustBranding } = require('../../middleware/branding');

// Whole Settings area is admin-only — staff/company config and who else gets to be
// admin isn't something regular staff should be able to see or touch. Admin is scoped to
// the tenant: an org admin administers their own org only, never another's.
router.use(requireAuth, requireAdmin);

router.get('/', (req, res) => {
  res.render('admin/settings-index', { pageScript: null });
});

// ── Lead intake ─────────────────────────────────────────────────────────────
// POST /webhooks/lead-intake has been multi-tenant since migration 030 — it resolves the
// org from orgs.lead_webhook_secret. But that secret was exposed nowhere, so a new tenant
// literally could not obtain their own key without someone reading it out of the database.
// This page is that missing surface.
const crypto = require('crypto');
const newLeadSecret = () => crypto.randomBytes(24).toString('hex');

router.get('/lead-intake', async (req, res, next) => {
  try {
    // Cross-org by necessity: `orgs` is the tenant table itself, not tenant DATA, so it is
    // reached through the documented escape hatch rather than the scoped handle.
    const [[org]] = await req.db.unscoped.execute(
      'SELECT id, lead_webhook_secret FROM orgs WHERE id = ?', [req.orgId]
    );
    res.render('admin/settings-lead-intake', {
      pageScript: null, org,
      endpoint: `${process.env.BASE_URL || ''}${res.locals.basePath}/webhooks/lead-intake`,
      rotated: req.query.rotated === '1',
    });
  } catch (err) { next(err); }
});

// Generate on demand rather than at provisioning time, so an org that never wires up a
// website form never carries a live credential it didn't ask for.
router.post('/lead-intake/rotate', async (req, res, next) => {
  try {
    await req.db.unscoped.execute(
      'UPDATE orgs SET lead_webhook_secret = ? WHERE id = ?', [newLeadSecret(), req.orgId]
    );
    res.redirect(`${res.locals.basePath}/admin/settings/lead-intake?rotated=1`);
  } catch (err) { next(err); }
});

// Email delivery log — last 200 send attempts, optionally filtered to failures.
router.get('/email-log', async (req, res, next) => {
  try {
    const failedOnly = req.query.failed === '1';
    const [rows] = await req.db.execute(
      `SELECT * FROM email_log WHERE org_id = ? ${failedOnly ? "AND status <> 'sent'" : ''}
       ORDER BY created_at DESC LIMIT 200`,
      [req.orgId]
    );
    const [[counts]] = await req.db.execute(
      `SELECT COUNT(*) AS total,
              SUM(status = 'sent') AS sent,
              SUM(status <> 'sent') AS problems
       FROM email_log WHERE org_id = ?`,
      [req.orgId]
    );
    res.render('admin/settings-email-log', { pageScript: null, rows, counts, failedOnly });
  } catch (err) {
    next(err);
  }
});

// Logos land in uploads/logos/<org_id>/. Unlike every other upload in this app they're
// served publicly (routes/branding.js) because an email client has to fetch them.
const logoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = logoDir(req.orgId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.png').toLowerCase().slice(0, 5);
      cb(null, `logo-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    // Only real image types — this file gets served to the public unauthenticated.
    const okay = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.mimetype);
    cb(null, okay);
  },
});

router.get('/company', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(
      'SELECT * FROM company_settings WHERE org_id = ?',
      [req.orgId]
    );
    res.render('admin/settings-company', {
      pageScript: null, settings: rows[0] || {},
      saved: req.query.saved === '1', error: null,
    });
  } catch (err) {
    next(err);
  }
});

// Replaces the org's logo, keeping only the newest file so an old one can't linger and be
// fetched by name. Returns the new filename, or undefined to leave the column untouched.
async function resolveLogo(req) {
  const dir = logoDir(req.orgId);

  if (req.body.remove_logo === '1' && !req.file) {
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }
  if (!req.file) return undefined;

  // Drop any previous logo now that the new one is safely written.
  for (const existing of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (existing !== req.file.filename) {
      fs.unlink(path.join(dir, existing), () => {});
    }
  }
  return req.file.filename;
}

router.post('/company', logoUpload.single('logo'), async (req, res, next) => {
  try {
    const {
      company_name, tax_id, default_tax_percent, address, phone, email,
      website, license_number, email_reply_to, terms_override, accent_color,
    } = req.body;

    const logoFilename = await resolveLogo(req);

    // Upsert keys off UNIQUE(org_id) (migration 030) rather than the old hardcoded id=1.
    // logo_filename is only written when the upload actually changed, so saving the rest
    // of the form never clears an existing logo.
    await req.db.execute(
      `INSERT INTO company_settings
         (org_id, company_name, tax_id, default_tax_percent, address, phone, email,
          website, license_number, email_reply_to, terms_override, accent_color, logo_filename)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE company_name = VALUES(company_name), tax_id = VALUES(tax_id),
         default_tax_percent = VALUES(default_tax_percent), address = VALUES(address),
         phone = VALUES(phone), email = VALUES(email), website = VALUES(website),
         license_number = VALUES(license_number), email_reply_to = VALUES(email_reply_to),
         terms_override = VALUES(terms_override), accent_color = VALUES(accent_color),
         logo_filename = ${logoFilename === undefined ? 'logo_filename' : 'VALUES(logo_filename)'}`,
      [req.orgId, company_name || null, tax_id || null, parseFloat(default_tax_percent) || 0,
        address || null, phone || null, email || null, website || null, license_number || null,
        email_reply_to || null, (terms_override || '').trim() || null,
        safeAccent(accent_color), logoFilename === undefined ? null : logoFilename]
    );

    // The nav/portal header read branding from a short-lived cache; drop this org's entry
    // so the admin sees their change on the very next page rather than up to a minute later.
    bustBranding(req.orgId);

    res.redirect(`${res.locals.basePath}/admin/settings/company?saved=1`);
  } catch (err) {
    next(err);
  }
});

// Excludes the given user id so a role/active change can check "would this leave zero
// active admins behind" before it's applied, not after. Counts within this org only —
// another tenant's admins are irrelevant to whether this one is locking itself out.
async function countOtherActiveAdmins(db, orgId, excludeUserId) {
  const [rows] = await db.execute(
    "SELECT COUNT(*) AS c FROM users WHERE org_id = ? AND role = 'admin' AND active = 1 AND id != ?",
    [orgId, excludeUserId]
  );
  return rows[0].c;
}

router.get('/users', async (req, res, next) => {
  try {
    const [users] = await req.db.execute(
      'SELECT * FROM users WHERE org_id = ? ORDER BY name',
      [req.orgId]
    );
    res.render('admin/settings-users', { pageScript: null, users });
  } catch (err) {
    next(err);
  }
});

// Password is optional here — leaving it blank creates a Google-only staff account
// (password_hash stays NULL), matching how config/passport.js's Google strategy only
// ever attaches to an existing users row rather than creating one.
router.post('/users', async (req, res, next) => {
  try {
    const { name, email, password, role, phone } = req.body;
    const passwordHash = password ? await bcrypt.hash(password, 12) : null;
    await req.db.execute(
      'INSERT INTO users (org_id, name, email, password_hash, role, phone) VALUES (?, ?, ?, ?, ?, ?)',
      [req.orgId, name, email, passwordHash, role === 'admin' ? 'admin' : 'staff', phone || null]
    );
    res.redirect(`${res.locals.basePath}/admin/settings/users`);
  } catch (err) {
    next(err);
  }
});

router.get('/users/:id/edit', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(
      'SELECT * FROM users WHERE id = ? AND org_id = ?',
      [req.params.id, req.orgId]
    );
    const targetUser = rows[0];
    if (!targetUser) return res.status(404).render('error', { message: 'User not found' });
    res.render('admin/settings-user-edit', { pageScript: null, targetUser, error: null });
  } catch (err) {
    next(err);
  }
});

router.post('/users/:id', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(
      'SELECT * FROM users WHERE id = ? AND org_id = ?',
      [req.params.id, req.orgId]
    );
    const targetUser = rows[0];
    if (!targetUser) return res.status(404).render('error', { message: 'User not found' });

    const { name, role, password, phone } = req.body;
    const nextRole = role === 'admin' ? 'admin' : 'staff';
    const nextActive = req.body.active === 'on';

    const wasActiveAdmin = targetUser.role === 'admin' && targetUser.active;
    const staysActiveAdmin = nextRole === 'admin' && nextActive;
    if (wasActiveAdmin && !staysActiveAdmin) {
      const remaining = await countOtherActiveAdmins(req.db, req.orgId, targetUser.id);
      if (remaining === 0) {
        return res.status(400).render('admin/settings-user-edit', {
          pageScript: null, targetUser,
          error: 'Cannot remove admin from the last remaining active admin.',
        });
      }
    }

    const passwordHash = password ? await bcrypt.hash(password, 12) : null;
    if (passwordHash) {
      await req.db.execute(
        'UPDATE users SET name = ?, phone = ?, role = ?, active = ?, password_hash = ? WHERE id = ? AND org_id = ?',
        [name, phone || null, nextRole, nextActive, passwordHash, req.params.id, req.orgId]
      );
    } else {
      await req.db.execute(
        'UPDATE users SET name = ?, phone = ?, role = ?, active = ? WHERE id = ? AND org_id = ?',
        [name, phone || null, nextRole, nextActive, req.params.id, req.orgId]
      );
    }
    res.redirect(`${res.locals.basePath}/admin/settings/users`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
