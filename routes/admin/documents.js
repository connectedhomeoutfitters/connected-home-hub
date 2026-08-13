const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { requireAuth } = require('../../middleware/auth');

router.use(requireAuth);

// Files live under uploads/documents/<customer_id>/ — never served via express.static
// (contracts/permits can be sensitive); streamed only through the authenticated download
// route below. Mirrors routes/admin/subcontractors.js. Customer ids are globally unique
// across tenants, so two orgs can't share a directory; re-homing under uploads/<org_id>/
// is phase 2 of docs/adr/0001-multi-tenancy.md.
const UPLOAD_ROOT = path.join(__dirname, '../../uploads/documents');

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOAD_ROOT, String(req.body.customer_id || 'unknown'));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// Upload one or more documents for a customer (optionally tagged to a job). Redirects
// back to the customer detail page where the upload form lives.
router.post('/', upload.array('documents', 20), async (req, res, next) => {
  try {
    const { customer_id, job_id, category, notes } = req.body;
    if (!customer_id) return res.status(400).render('error', { message: 'Missing customer' });

    // multer has already written the files by this point (destination is chosen from the
    // request body), so confirm the customer is this tenant's before recording them.
    const [[owned]] = await req.db.execute(
      'SELECT id FROM customers WHERE id = ? AND org_id = ?',
      [customer_id, req.orgId]
    );
    if (!owned) {
      for (const file of req.files || []) fs.unlink(file.path, () => {});
      return res.status(404).render('error', { message: 'Customer not found' });
    }

    for (const file of req.files || []) {
      await req.db.execute(
        `INSERT INTO documents (org_id, customer_id, job_id, category, filename, original_name, mime_type, size_bytes, notes, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [req.orgId, customer_id, job_id || null, category || null, file.filename, file.originalname,
          file.mimetype || null, file.size || null, (notes || '').trim() || null, req.user.id]
      );
    }
    res.redirect(`${res.locals.basePath}/admin/customers/${customer_id}#documents`);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/download', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(
      'SELECT * FROM documents WHERE id = ? AND org_id = ?',
      [req.params.id, req.orgId]
    );
    const doc = rows[0];
    if (!doc) return res.status(404).render('error', { message: 'Document not found' });
    const filePath = path.join(UPLOAD_ROOT, String(doc.customer_id), doc.filename);
    res.download(filePath, doc.original_name || doc.filename);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/delete', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(
      'SELECT * FROM documents WHERE id = ? AND org_id = ?',
      [req.params.id, req.orgId]
    );
    const doc = rows[0];
    if (doc) {
      await req.db.execute(
        'DELETE FROM documents WHERE id = ? AND org_id = ?',
        [doc.id, req.orgId]
      );
      fs.unlink(path.join(UPLOAD_ROOT, String(doc.customer_id), doc.filename), () => {});
    }
    res.redirect(`${res.locals.basePath}/admin/customers/${doc ? doc.customer_id : ''}#documents`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
