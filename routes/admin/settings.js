const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const db = require('../../config/db');
const { requireAuth, requireAdmin } = require('../../middleware/auth');

// Whole Settings area is admin-only — staff/company config and who else gets to be
// admin isn't something regular staff should be able to see or touch.
router.use(requireAuth, requireAdmin);

router.get('/', (req, res) => {
  res.render('admin/settings-index', { pageScript: null });
});

// Email delivery log — last 200 send attempts, optionally filtered to failures.
router.get('/email-log', async (req, res, next) => {
  try {
    const failedOnly = req.query.failed === '1';
    const [rows] = await db.execute(
      `SELECT * FROM email_log ${failedOnly ? "WHERE status <> 'sent'" : ''}
       ORDER BY created_at DESC LIMIT 200`
    );
    const [[counts]] = await db.execute(
      `SELECT COUNT(*) AS total,
              SUM(status = 'sent') AS sent,
              SUM(status <> 'sent') AS problems
       FROM email_log`
    );
    res.render('admin/settings-email-log', { pageScript: null, rows, counts, failedOnly });
  } catch (err) {
    next(err);
  }
});

router.get('/company', async (req, res, next) => {
  try {
    const [rows] = await db.execute('SELECT * FROM company_settings WHERE id = 1');
    res.render('admin/settings-company', { pageScript: null, settings: rows[0] || {}, saved: req.query.saved === '1' });
  } catch (err) {
    next(err);
  }
});

router.post('/company', async (req, res, next) => {
  try {
    const { company_name, tax_id, default_tax_percent, address, phone, email } = req.body;
    await db.execute(
      `INSERT INTO company_settings (id, company_name, tax_id, default_tax_percent, address, phone, email)
       VALUES (1, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE company_name = VALUES(company_name), tax_id = VALUES(tax_id),
         default_tax_percent = VALUES(default_tax_percent), address = VALUES(address),
         phone = VALUES(phone), email = VALUES(email)`,
      [company_name || null, tax_id || null, parseFloat(default_tax_percent) || 0, address || null, phone || null, email || null]
    );
    res.redirect(`${res.locals.basePath}/admin/settings/company?saved=1`);
  } catch (err) {
    next(err);
  }
});

// Excludes the given user id so a role/active change can check "would this leave zero
// active admins behind" before it's applied, not after.
async function countOtherActiveAdmins(excludeUserId) {
  const [rows] = await db.execute(
    "SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND active = 1 AND id != ?",
    [excludeUserId]
  );
  return rows[0].c;
}

router.get('/users', async (req, res, next) => {
  try {
    const [users] = await db.execute('SELECT * FROM users ORDER BY name');
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
    const { name, email, password, role } = req.body;
    const passwordHash = password ? await bcrypt.hash(password, 12) : null;
    await db.execute(
      "INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)",
      [name, email, passwordHash, role === 'admin' ? 'admin' : 'staff']
    );
    res.redirect(`${res.locals.basePath}/admin/settings/users`);
  } catch (err) {
    next(err);
  }
});

router.get('/users/:id/edit', async (req, res, next) => {
  try {
    const [rows] = await db.execute('SELECT * FROM users WHERE id = ?', [req.params.id]);
    const targetUser = rows[0];
    if (!targetUser) return res.status(404).render('error', { message: 'User not found' });
    res.render('admin/settings-user-edit', { pageScript: null, targetUser, error: null });
  } catch (err) {
    next(err);
  }
});

router.post('/users/:id', async (req, res, next) => {
  try {
    const [rows] = await db.execute('SELECT * FROM users WHERE id = ?', [req.params.id]);
    const targetUser = rows[0];
    if (!targetUser) return res.status(404).render('error', { message: 'User not found' });

    const { name, role, password } = req.body;
    const nextRole = role === 'admin' ? 'admin' : 'staff';
    const nextActive = req.body.active === 'on';

    const wasActiveAdmin = targetUser.role === 'admin' && targetUser.active;
    const staysActiveAdmin = nextRole === 'admin' && nextActive;
    if (wasActiveAdmin && !staysActiveAdmin) {
      const remaining = await countOtherActiveAdmins(targetUser.id);
      if (remaining === 0) {
        return res.status(400).render('admin/settings-user-edit', {
          pageScript: null, targetUser,
          error: 'Cannot remove admin from the last remaining active admin.',
        });
      }
    }

    const passwordHash = password ? await bcrypt.hash(password, 12) : null;
    if (passwordHash) {
      await db.execute(
        'UPDATE users SET name = ?, role = ?, active = ?, password_hash = ? WHERE id = ?',
        [name, nextRole, nextActive, passwordHash, req.params.id]
      );
    } else {
      await db.execute(
        'UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?',
        [name, nextRole, nextActive, req.params.id]
      );
    }
    res.redirect(`${res.locals.basePath}/admin/settings/users`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
