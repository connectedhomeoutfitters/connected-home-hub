'use strict';
// GET /branding/:orgId/logo — a tenant's logo.
//
// DELIBERATELY PUBLIC and unauthenticated, which is the opposite of every other upload
// route in this app (consultation photos, customer documents, subcontractor W-9s are all
// streamed behind a session check). A logo has to render inside an email client that has
// no cookie, and it's the business's public identity anyway — the same image is on their
// website. Nothing else in uploads/ is exposed this way.
//
// Not express.static: the current filename lives in company_settings, so serving through a
// lookup means a re-upload takes effect immediately and an old file can't be fetched by
// guessing its name.

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const db = require('../config/db');
const { logoDir } = require('../services/companySettings');

const DEFAULT_LOGO = path.join(__dirname, '..', 'public', 'img', 'logo.png');

router.get('/:orgId/logo', async (req, res, next) => {
  try {
    const orgId = Number(req.params.orgId);
    if (!Number.isInteger(orgId) || orgId <= 0) return res.sendFile(DEFAULT_LOGO);

    // Unscoped by necessity: this is a public asset request with no session to scope by,
    // and the org id is the whole address. It reads nothing but the logo filename.
    const [rows] = await db.execute(
      'SELECT logo_filename FROM company_settings WHERE org_id = ?',
      [orgId]
    );
    const filename = rows[0]?.logo_filename;
    if (!filename) return res.sendFile(DEFAULT_LOGO);

    // path.basename strips any traversal that somehow reached the column.
    const file = path.join(logoDir(orgId), path.basename(filename));
    if (!fs.existsSync(file)) return res.sendFile(DEFAULT_LOGO);

    // Short cache: long enough to spare the lookup on a page full of references, short
    // enough that a re-upload shows up without a hard refresh.
    res.set('Cache-Control', 'public, max-age=300');
    res.sendFile(file);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
