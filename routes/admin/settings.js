const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { requireAuth, requireAdmin } = require('../../middleware/auth');

// Whole Settings area is admin-only — staff/company config and who else gets to be
// admin isn't something regular staff should be able to see or touch. Admin is scoped to
// the tenant: an org admin administers their own org only, never another's.
router.use(requireAuth, requireAdmin);

router.get('/', (req, res) => {
  res.render('admin/settings-index', { pageScript: null });
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

router.get('/company', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(
      'SELECT * FROM company_settings WHERE org_id = ?',
      [req.orgId]
    );
    res.render('admin/settings-company', { pageScript: null, settings: rows[0] || {}, saved: req.query.saved === '1' });
  } catch (err) {
    next(err);
  }
});

router.post('/company', async (req, res, next) => {
  try {
    const { company_name, tax_id, default_tax_percent, address, phone, email } = req.body;
    // Upsert keys off UNIQUE(org_id) (migration 030) rather than the old hardcoded id=1.
    await req.db.execute(
      `INSERT INTO company_settings (org_id, company_name, tax_id, default_tax_percent, address, phone, email)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE company_name = VALUES(company_name), tax_id = VALUES(tax_id),
         default_tax_percent = VALUES(default_tax_percent), address = VALUES(address),
         phone = VALUES(phone), email = VALUES(email)`,
      [req.orgId, company_name || null, tax_id || null, parseFloat(default_tax_percent) || 0,
        address || null, phone || null, email || null]
    );
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
