const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { requireAuth } = require('../../middleware/auth');

router.use(requireAuth);

// Subcontractor ids are globally unique across tenants, so two orgs never share a
// directory here. Re-homing under uploads/<org_id>/ is phase 2 of
// docs/adr/0001-multi-tenancy.md.
const UPLOAD_ROOT = path.join(__dirname, '../../uploads/subcontractors');

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOAD_ROOT, req.params.id);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
});

router.get('/', async (req, res, next) => {
  try {
    const [subcontractors] = await req.db.execute(
      'SELECT * FROM subcontractors WHERE org_id = ? ORDER BY active DESC, trade, name',
      [req.orgId]
    );
    res.render('admin/subcontractors', { pageScript: null, subcontractors });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, trade, contact_name, phone, email, hourly_rate, license_number,
      address, insurance_provider, insurance_expires_on, notes } = req.body;
    await req.db.execute(
      `INSERT INTO subcontractors
        (org_id, name, trade, contact_name, phone, email, hourly_rate, license_number,
         address, insurance_provider, insurance_expires_on, w9_on_file, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.orgId, name, trade, contact_name || null, phone || null, email || null,
        hourly_rate || null, license_number || null, address || null,
        insurance_provider || null, insurance_expires_on || null,
        req.body.w9_on_file === 'on', notes || null]
    );
    res.redirect(`${res.locals.basePath}/admin/subcontractors`);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/edit', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(
      'SELECT * FROM subcontractors WHERE id = ? AND org_id = ?',
      [req.params.id, req.orgId]
    );
    if (!rows[0]) return res.status(404).render('error', { message: 'Subcontractor not found' });
    const [documents] = await req.db.execute(
      'SELECT * FROM subcontractor_documents WHERE subcontractor_id = ? AND org_id = ? ORDER BY created_at DESC',
      [req.params.id, req.orgId]
    );
    res.render('admin/subcontractors-edit', { pageScript: null, subcontractor: rows[0], documents });
  } catch (err) {
    next(err);
  }
});

router.post('/:id', async (req, res, next) => {
  try {
    const { name, trade, contact_name, phone, email, hourly_rate, license_number,
      address, insurance_provider, insurance_expires_on, notes } = req.body;
    await req.db.execute(
      `UPDATE subcontractors SET name=?, trade=?, contact_name=?, phone=?, email=?,
        hourly_rate=?, license_number=?, address=?, insurance_provider=?,
        insurance_expires_on=?, w9_on_file=?, notes=? WHERE id=? AND org_id=?`,
      [name, trade, contact_name || null, phone || null, email || null,
        hourly_rate || null, license_number || null, address || null,
        insurance_provider || null, insurance_expires_on || null,
        req.body.w9_on_file === 'on', notes || null, req.params.id, req.orgId]
    );
    res.redirect(`${res.locals.basePath}/admin/subcontractors/${req.params.id}/edit`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/toggle-active', async (req, res, next) => {
  try {
    await req.db.execute(
      'UPDATE subcontractors SET active = NOT active WHERE id = ? AND org_id = ?',
      [req.params.id, req.orgId]
    );
    res.redirect(`${res.locals.basePath}/admin/subcontractors`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/documents', upload.array('documents', 20), async (req, res, next) => {
  try {
    // multer writes before this handler runs, so confirm ownership then record.
    const [[owned]] = await req.db.execute(
      'SELECT id FROM subcontractors WHERE id = ? AND org_id = ?',
      [req.params.id, req.orgId]
    );
    if (!owned) {
      for (const file of req.files || []) fs.unlink(file.path, () => {});
      return res.status(404).render('error', { message: 'Subcontractor not found' });
    }

    for (const file of req.files || []) {
      await req.db.execute(
        'INSERT INTO subcontractor_documents (org_id, subcontractor_id, category, filename, original_name) VALUES (?, ?, ?, ?, ?)',
        [req.orgId, req.params.id, req.body.category || null, file.filename, file.originalname]
      );
    }
    res.redirect(`${res.locals.basePath}/admin/subcontractors/${req.params.id}/edit`);
  } catch (err) {
    next(err);
  }
});

// Contract/insurance/W9 documents may contain sensitive personal or financial info —
// never served through express.static, only streamed here behind requireAuth.
router.get('/:id/documents/:docId', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(
      'SELECT * FROM subcontractor_documents WHERE id = ? AND subcontractor_id = ? AND org_id = ?',
      [req.params.docId, req.params.id, req.orgId]
    );
    const doc = rows[0];
    if (!doc) return res.status(404).render('error', { message: 'Document not found' });
    res.download(path.join(UPLOAD_ROOT, req.params.id, doc.filename), doc.original_name || doc.filename);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/documents/:docId/delete', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(
      'SELECT * FROM subcontractor_documents WHERE id = ? AND subcontractor_id = ? AND org_id = ?',
      [req.params.docId, req.params.id, req.orgId]
    );
    const doc = rows[0];
    if (doc) {
      await req.db.execute(
        'DELETE FROM subcontractor_documents WHERE id = ? AND org_id = ?',
        [doc.id, req.orgId]
      );
      fs.unlink(path.join(UPLOAD_ROOT, req.params.id, doc.filename), () => {});
    }
    res.redirect(`${res.locals.basePath}/admin/subcontractors/${req.params.id}/edit`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
