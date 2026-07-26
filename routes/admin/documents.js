const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../../config/db');
const { requireAuth } = require('../../middleware/auth');

router.use(requireAuth);

// Files live under uploads/documents/<customer_id>/ — never served via express.static
// (contracts/permits can be sensitive); streamed only through the authenticated download
// route below. Mirrors routes/admin/subcontractors.js.
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
    for (const file of req.files || []) {
      await db.execute(
        `INSERT INTO documents (customer_id, job_id, category, filename, original_name, mime_type, size_bytes, notes, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [customer_id, job_id || null, category || null, file.filename, file.originalname,
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
    const [rows] = await db.execute('SELECT * FROM documents WHERE id = ?', [req.params.id]);
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
    const [rows] = await db.execute('SELECT * FROM documents WHERE id = ?', [req.params.id]);
    const doc = rows[0];
    if (doc) {
      await db.execute('DELETE FROM documents WHERE id = ?', [doc.id]);
      fs.unlink(path.join(UPLOAD_ROOT, String(doc.customer_id), doc.filename), () => {});
    }
    res.redirect(`${res.locals.basePath}/admin/customers/${doc ? doc.customer_id : ''}#documents`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
