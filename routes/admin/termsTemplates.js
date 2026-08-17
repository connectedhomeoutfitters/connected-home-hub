'use strict';
// Settings → Terms & conditions. A tenant's library of agreements, so an install quote and
// a recurring maintenance agreement can carry different wording.
//
// Admin-only, matching the rest of /admin/settings/*: these are the legal terms the
// business contracts on, not an operational setting.
//
// Nothing here can alter an estimate that has already been sent — the wording is frozen
// onto the estimate at send time (estimates.terms_snapshot). Editing or deactivating a
// template only affects estimates sent afterwards, which is the entire point of the
// snapshot and worth remembering before "fixing" a typo in live terms.

const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../../middleware/auth');
const { listTemplates, getTemplate } = require('../../services/terms');
const activity = require('../../services/activityLog');

router.use(requireAuth, requireAdmin);

router.get('/', async (req, res, next) => {
  try {
    res.render('admin/terms-templates', {
      pageScript: null,
      templates: await listTemplates(req.db, req.orgId, { includeInactive: true }),
      editing: null,
      error: null,
      saved: req.query.saved === '1',
    });
  } catch (err) { next(err); }
});

router.get('/:id/edit', async (req, res, next) => {
  try {
    const editing = await getTemplate(req.db, req.orgId, req.params.id);
    if (!editing) return res.status(404).render('error', { message: 'Terms not found' });
    res.render('admin/terms-templates', {
      pageScript: null,
      templates: await listTemplates(req.db, req.orgId, { includeInactive: true }),
      editing, error: null, saved: false,
    });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  const { id, name, body, is_default } = req.body;
  try {
    const cleanName = String(name || '').trim();
    const cleanBody = String(body || '').trim();
    if (!cleanName || !cleanBody) {
      return res.status(400).render('admin/terms-templates', {
        pageScript: null,
        templates: await listTemplates(req.db, req.orgId, { includeInactive: true }),
        editing: { id: id || null, name, body, is_default: is_default === '1' },
        error: 'Give the terms a name and some text.',
        saved: false,
      });
    }

    // Only one default. Cleared first so the new one cannot briefly collide, and scoped to
    // this org so it cannot touch another tenant's library.
    if (is_default === '1') {
      await req.db.execute('UPDATE terms_templates SET is_default = 0 WHERE org_id = ?', [req.orgId]);
    }

    if (id) {
      await req.db.execute(
        'UPDATE terms_templates SET name = ?, body = ?, is_default = ? WHERE id = ? AND org_id = ?',
        [cleanName.slice(0, 120), cleanBody, is_default === '1' ? 1 : 0, id, req.orgId]
      );
    } else {
      await req.db.execute(
        'INSERT INTO terms_templates (org_id, name, body, is_default, active) VALUES (?, ?, ?, ?, 1)',
        [req.orgId, cleanName.slice(0, 120), cleanBody, is_default === '1' ? 1 : 0]
      );
    }

    await activity.log({
      ...activity.staff(req),
      action: id ? 'terms.updated' : 'terms.created',
      entityType: 'terms_template', entityId: id ? Number(id) : null,
      detail: `Terms "${cleanName}"${is_default === '1' ? ' (set as default)' : ''}`,
    });
    res.redirect(`${res.locals.basePath}/admin/settings/terms?saved=1`);
  } catch (err) { next(err); }
});

// Deactivated, never deleted — an estimate may reference this template, and the reporting
// value of "which agreement did we sell on" outlives the tenant's use of it.
router.post('/:id/archive', async (req, res, next) => {
  try {
    await req.db.execute(
      'UPDATE terms_templates SET active = 0, is_default = 0 WHERE id = ? AND org_id = ?',
      [req.params.id, req.orgId]
    );
    res.redirect(`${res.locals.basePath}/admin/settings/terms?saved=1`);
  } catch (err) { next(err); }
});

router.post('/:id/restore', async (req, res, next) => {
  try {
    await req.db.execute(
      'UPDATE terms_templates SET active = 1 WHERE id = ? AND org_id = ?',
      [req.params.id, req.orgId]
    );
    res.redirect(`${res.locals.basePath}/admin/settings/terms?saved=1`);
  } catch (err) { next(err); }
});

module.exports = router;
