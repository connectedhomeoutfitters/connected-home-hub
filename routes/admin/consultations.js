const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { requireAuth } = require('../../middleware/auth');
const consultationOptions = require('../../config/consultationOptions');
const { mapLeadToConsultation } = require('../../config/leadToConsultationMapping');
const { sendMail } = require('../../services/mailer');
const { getCompany } = require('../../services/companySettings');
const { generateConsultationInvite } = require('../../services/calendarInvite');

router.use(requireAuth);

// Photos stay under uploads/consultations/<consultation_id>/ rather than being nested
// per-org: consultation ids are globally unique (one auto-increment across all tenants),
// so two orgs can never share a directory, and the DB lookup that resolves a photo is
// org-scoped. Re-homing these under uploads/<org_id>/ is phase 2 of
// docs/adr/0001-multi-tenancy.md — deferred here to avoid orphaning existing files.
const UPLOAD_ROOT = path.join(__dirname, '../../uploads/consultations');

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

// Checkbox groups submit as a single string when only one is checked, an array when
// multiple, and are simply absent from req.body when none are checked.
function normalizeArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function fieldsFromBody(body) {
  return {
    consultation_date: body.consultation_date ? body.consultation_date.replace('T', ' ') + ':00' : null,
    duration_minutes: parseInt(body.duration_minutes, 10) || 60,
    referral_source: body.referral_source || null,
    home_type: body.home_type || null,
    square_footage: body.square_footage || null,
    number_of_stories: body.number_of_stories || null,
    year_built: body.year_built || null,
    services_interested: JSON.stringify(normalizeArray(body.services_interested)),
    biggest_frustration: body.biggest_frustration || null,
    priorities: JSON.stringify(normalizeArray(body.priorities)),
    internet_provider: body.internet_provider || null,
    internet_speed: body.internet_speed || null,
    has_mesh_wifi: body.has_mesh_wifi || null,
    has_security_cameras: body.has_security_cameras || null,
    existing_smart_devices: JSON.stringify(normalizeArray(body.existing_smart_devices)),
    wifi_coverage_ratings: JSON.stringify(body.wifi_rating || {}),
    connectivity_issue_areas: JSON.stringify(normalizeArray(body.connectivity_issue_areas)),
    desired_camera_locations: JSON.stringify(normalizeArray(body.desired_camera_locations)),
    camera_wiring_present: body.camera_wiring_present || null,
    interested_video_doorbell: body.interested_video_doorbell || null,
    interested_remote_monitoring: body.interested_remote_monitoring || null,
    smart_home_interests: JSON.stringify(normalizeArray(body.smart_home_interests)),
    preferred_smart_platform: body.preferred_smart_platform || null,
    desired_timeline: body.desired_timeline || null,
    budget_range: body.budget_range || null,
    interested_financing: body.interested_financing || null,
    installation_complexity: body.installation_complexity || null,
    recommended_package: body.recommended_package || null,
    recommended_addons: JSON.stringify(normalizeArray(body.recommended_addons)),
    consultant_notes: body.consultant_notes || null,
  };
}

router.get('/', async (req, res, next) => {
  try {
    const [consultations] = await req.db.execute(
      `SELECT co.*, c.name AS customer_name FROM consultations co
       JOIN customers c ON c.id = co.customer_id AND c.org_id = co.org_id
       WHERE co.org_id = ?
       ORDER BY co.created_at DESC`,
      [req.orgId]
    );
    const [customers] = await req.db.execute(
      'SELECT id, name FROM customers WHERE org_id = ? ORDER BY name',
      [req.orgId]
    );

    // Feedback for the "On My Way" action (redirected here with the consultation id).
    let omw = null;
    const omwId = req.query.omw_sent || req.query.omw_noemail;
    if (omwId) {
      const match = consultations.find((c) => String(c.id) === String(omwId));
      if (match) omw = { name: match.customer_name, noemail: !!req.query.omw_noemail };
    }

    res.render('admin/consultations', { pageScript: null, consultations, customers, omw });
  } catch (err) {
    next(err);
  }
});

router.get('/new', async (req, res, next) => {
  try {
    const customerId = req.query.customer_id;
    const [customerRows] = await req.db.execute(
      'SELECT * FROM customers WHERE id = ? AND org_id = ?',
      [customerId, req.orgId]
    );
    if (!customerRows[0]) return res.status(404).render('error', { message: 'Customer not found' });

    const [leadRows] = await req.db.execute(
      'SELECT * FROM leads WHERE customer_id = ? AND org_id = ? ORDER BY created_at DESC LIMIT 1',
      [customerId, req.orgId]
    );
    const lead = leadRows[0] || null;

    res.render('admin/consultation-form', {
      pageScript: null,
      isNew: true,
      consultation: mapLeadToConsultation(lead),
      customer: customerRows[0],
      lead,
      photos: [],
      opts: consultationOptions,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  const conn = await req.db.getConnection();
  try {
    const fields = fieldsFromBody(req.body);
    const [leadRows] = await conn.execute(
      'SELECT id FROM leads WHERE customer_id = ? AND org_id = ? ORDER BY created_at DESC LIMIT 1',
      [req.body.customer_id, req.orgId]
    );
    const [customerRows] = await conn.execute(
      'SELECT name FROM customers WHERE id = ? AND org_id = ?',
      [req.body.customer_id, req.orgId]
    );
    if (!customerRows[0]) { conn.release(); return res.status(404).render('error', { message: 'Customer not found' }); }

    await conn.beginTransaction();
    // New consultations always start 'scheduled' — this route is only ever hit from
    // the schedule-only form (contact info + Section 1), never the full site-visit
    // survey, so there's nothing else to conditionally set status from yet.
    // org_id is spelled out in the literal rather than folded into `columns` so that both
    // the runtime guard (config/scopedDb.js) and the static sweep (test/queryScoping.test.js)
    // can see it — the rest of the column list is interpolated and opaque to the latter.
    const columns = ['customer_id', 'lead_id', 'consultant_id', 'status', ...Object.keys(fields)];
    const values = [req.body.customer_id, leadRows[0]?.id || null, req.user.id, 'scheduled', ...Object.values(fields)];
    const [result] = await conn.execute(
      `INSERT INTO consultations (org_id, ${columns.join(', ')})
       VALUES (?, ${columns.map(() => '?').join(', ')})`,
      [req.orgId, ...values]
    );

    // "Job" here means any lifecycle task, not just an installation — this one tracks
    // the consultation visit itself. Defaults to whoever created it; reassignable
    // later from the Jobs list.
    await conn.execute(
      `INSERT INTO jobs (org_id, type, title, customer_id, consultation_id, assigned_to, scheduled_at)
       VALUES (?, 'consultation', ?, ?, ?, ?, ?)`,
      [req.orgId, `Consultation — ${customerRows[0].name}`, req.body.customer_id, result.insertId, req.user.id, fields.consultation_date]
    );
    await conn.commit();
    res.redirect(`${res.locals.basePath}/admin/consultations/${result.insertId}/edit`);
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.get('/:id/edit', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(
      `SELECT co.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
        c.address AS customer_address, c.notes AS customer_notes FROM consultations co
       JOIN customers c ON c.id = co.customer_id AND c.org_id = co.org_id
       WHERE co.id = ? AND co.org_id = ?`,
      [req.params.id, req.orgId]
    );
    const consultation = rows[0];
    if (!consultation) return res.status(404).render('error', { message: 'Consultation not found' });

    const [photos] = await req.db.execute(
      'SELECT * FROM consultation_photos WHERE consultation_id = ? AND org_id = ? ORDER BY created_at',
      [req.params.id, req.orgId]
    );

    let lead = null;
    if (consultation.lead_id) {
      const [leadRows] = await req.db.execute(
        'SELECT * FROM leads WHERE id = ? AND org_id = ?',
        [consultation.lead_id, req.orgId]
      );
      lead = leadRows[0] || null;
    }

    res.render('admin/consultation-form', {
      pageScript: null,
      isNew: false,
      consultation,
      customer: {
        id: consultation.customer_id,
        name: consultation.customer_name,
        email: consultation.customer_email,
        phone: consultation.customer_phone,
        address: consultation.customer_address,
        notes: consultation.customer_notes,
      },
      lead,
      photos,
      opts: consultationOptions,
    });
  } catch (err) {
    next(err);
  }
});

// Saving the full site-visit survey is what advances a consultation past
// 'scheduled' — but only the first time. If it's already completed/on_hold/
// cancelled, a later edit (e.g. fixing a typo in consultant notes) shouldn't
// silently revive it; hold/resume/cancel below are the only way to change status
// from that point on.
router.post('/:id', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(
      'SELECT status FROM consultations WHERE id = ? AND org_id = ?',
      [req.params.id, req.orgId]
    );
    const current = rows[0];
    if (!current) return res.status(404).render('error', { message: 'Consultation not found' });

    const fields = fieldsFromBody(req.body);
    const nextStatus = current.status === 'scheduled' ? 'completed' : current.status;
    const setClause = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
    await req.db.execute(
      `UPDATE consultations SET ${setClause}, status = ? WHERE id = ? AND org_id = ?`,
      [...Object.values(fields), nextStatus, req.params.id, req.orgId]
    );
    res.redirect(`${res.locals.basePath}/admin/consultations/${req.params.id}/edit`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/hold', async (req, res, next) => {
  try {
    await req.db.execute(
      "UPDATE consultations SET status = 'on_hold' WHERE id = ? AND org_id = ?",
      [req.params.id, req.orgId]
    );
    res.redirect(`${res.locals.basePath}/admin/consultations/${req.params.id}/edit`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/resume', async (req, res, next) => {
  try {
    await req.db.execute(
      "UPDATE consultations SET status = 'completed' WHERE id = ? AND org_id = ?",
      [req.params.id, req.orgId]
    );
    res.redirect(`${res.locals.basePath}/admin/consultations/${req.params.id}/edit`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/cancel', async (req, res, next) => {
  try {
    await req.db.execute(
      "UPDATE consultations SET status = 'cancelled' WHERE id = ? AND org_id = ?",
      [req.params.id, req.orgId]
    );
    res.redirect(`${res.locals.basePath}/admin/consultations/${req.params.id}/edit`);
  } catch (err) {
    next(err);
  }
});

// One-click heads-up email, distinct from reschedule — doesn't touch consultation_date,
// just lets the customer know staff is en route. Fired from the Consultations list
// (see views/admin/consultations.ejs), not the consultation's own page.
// Emails the customer a "we're on our way" heads-up, naming the consultant and their
// contact number (the consultant's own phone, falling back to the company phone). Records
// on_the_way_sent_at so the list can show a sent state; redirects with a flag so the list
// can confirm it went through (or warn if the customer has no email on file).
router.post('/:id/on-the-way', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(
      `SELECT co.id, c.name AS customer_name, c.email AS customer_email, c.address AS customer_address,
              u.name AS consultant_name, u.phone AS consultant_phone
       FROM consultations co
       JOIN customers c ON c.id = co.customer_id AND c.org_id = co.org_id
       LEFT JOIN users u ON u.id = co.consultant_id AND u.org_id = co.org_id
       WHERE co.id = ? AND co.org_id = ?`,
      [req.params.id, req.orgId]
    );
    const consultation = rows[0];
    if (!consultation) return res.status(404).render('error', { message: 'Consultation not found' });

    if (!consultation.customer_email) {
      return res.redirect(`${res.locals.basePath}/admin/consultations?omw_noemail=${consultation.id}`);
    }

    const company = await getCompany(req.orgId);
    await sendMail({
      orgId: req.orgId,
      to: consultation.customer_email,
      subject: `On our way — ${consultation.customer_name}'s consultation`,
      template: 'consultation-on-the-way',
      data: {
        customerName: consultation.customer_name,
        address: consultation.customer_address,
        consultantName: consultation.consultant_name || null,
        consultantPhone: consultation.consultant_phone || company.phone || null,
      },
    });
    await req.db.execute(
      'UPDATE consultations SET on_the_way_sent_at = NOW() WHERE id = ? AND org_id = ?',
      [consultation.id, req.orgId]
    );
    res.redirect(`${res.locals.basePath}/admin/consultations?omw_sent=${consultation.id}`);
  } catch (err) {
    next(err);
  }
});

// Shared by the initial "Send Calendar Invite" action and reschedule — emails an .ics
// invite to both the consultant (whoever's sending it — "for myself to use on Google
// Calendar", per how this was scoped) and the customer. Throws if no date is set.
async function sendConsultationInvite(db, orgId, consultationId, user, { rescheduled = false } = {}) {
  const [rows] = await db.execute(
    `SELECT co.*, c.name AS customer_name, c.email AS customer_email, c.address AS customer_address
     FROM consultations co
     JOIN customers c ON c.id = co.customer_id AND c.org_id = co.org_id
     WHERE co.id = ? AND co.org_id = ?`,
    [consultationId, orgId]
  );
  const consultation = rows[0];
  if (!consultation) throw Object.assign(new Error('Consultation not found'), { status: 404 });
  if (!consultation.consultation_date) {
    throw Object.assign(new Error('Set a consultation date/time before sending an invite'), { status: 400 });
  }

  const inviteCompany = await getCompany(orgId);
  const icsContent = generateConsultationInvite({
    consultation,
    customer: { name: consultation.customer_name, email: consultation.customer_email, address: consultation.customer_address },
    consultantName: user.name,
    consultantEmail: user.email,
    companyName: inviteCompany.company_name,
  });

  const when = new Date(consultation.consultation_date.replace(' ', 'T')).toLocaleString('en-US', {
    dateStyle: 'full', timeStyle: 'short',
  });

  const recipients = [user.email, consultation.customer_email].filter(Boolean);
  for (const to of recipients) {
    await sendMail({
      orgId,
      to,
      subject: `Consultation ${rescheduled ? 'rescheduled' : 'confirmed'} — ${when}`,
      template: 'consultation-scheduled',
      data: { customerName: consultation.customer_name, when, address: consultation.customer_address, rescheduled },
      icalEvent: { filename: 'consultation.ics', method: 'REQUEST', content: icsContent },
    });
  }

  await db.execute(
    'UPDATE consultations SET calendar_invite_sent_at = NOW() WHERE id = ? AND org_id = ?',
    [consultationId, orgId]
  );
}

router.post('/:id/send-invite', async (req, res, next) => {
  try {
    await sendConsultationInvite(req.db, req.orgId, req.params.id, req.user);
    res.redirect(`${res.locals.basePath}/admin/consultations/${req.params.id}/edit`);
  } catch (err) {
    if (err.status) return res.status(err.status).render('error', { message: err.message });
    next(err);
  }
});

// Lightweight date/time-only change, distinct from the full survey-form save — resets
// reminder_sent_at so the automated reminder re-fires correctly for the new time, and
// immediately re-sends the calendar invite so the customer isn't left with a stale one.
router.post('/:id/reschedule', async (req, res, next) => {
  try {
    const consultation_date = req.body.consultation_date ? req.body.consultation_date.replace('T', ' ') + ':00' : null;
    const duration_minutes = parseInt(req.body.duration_minutes, 10) || 60;
    if (!consultation_date) {
      return res.status(400).render('error', { message: 'A new date/time is required to reschedule' });
    }

    await req.db.execute(
      'UPDATE consultations SET consultation_date = ?, duration_minutes = ?, reminder_sent_at = NULL WHERE id = ? AND org_id = ?',
      [consultation_date, duration_minutes, req.params.id, req.orgId]
    );
    await sendConsultationInvite(req.db, req.orgId, req.params.id, req.user, { rescheduled: true });
    res.redirect(`${res.locals.basePath}/admin/consultations/${req.params.id}/edit`);
  } catch (err) {
    if (err.status) return res.status(err.status).render('error', { message: err.message });
    next(err);
  }
});

router.post('/:id/photos', upload.array('photos', 20), async (req, res, next) => {
  try {
    // Confirm the consultation is this tenant's before attaching photos to it.
    const [[owned]] = await req.db.execute(
      'SELECT id FROM consultations WHERE id = ? AND org_id = ?',
      [req.params.id, req.orgId]
    );
    if (!owned) return res.status(404).render('error', { message: 'Consultation not found' });

    for (const file of req.files || []) {
      await req.db.execute(
        'INSERT INTO consultation_photos (org_id, consultation_id, category, filename, original_name) VALUES (?, ?, ?, ?, ?)',
        [req.orgId, req.params.id, req.body.category || null, file.filename, file.originalname]
      );
    }
    res.redirect(`${res.locals.basePath}/admin/consultations/${req.params.id}/edit`);
  } catch (err) {
    next(err);
  }
});

// Site photos are customer property photos — never served through express.static,
// only streamed here behind requireAuth.
router.get('/:id/photos/:photoId', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(
      'SELECT * FROM consultation_photos WHERE id = ? AND consultation_id = ? AND org_id = ?',
      [req.params.photoId, req.params.id, req.orgId]
    );
    const photo = rows[0];
    if (!photo) return res.status(404).render('error', { message: 'Photo not found' });
    res.sendFile(path.join(UPLOAD_ROOT, req.params.id, photo.filename));
  } catch (err) {
    next(err);
  }
});

router.post('/:id/photos/:photoId/delete', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(
      'SELECT * FROM consultation_photos WHERE id = ? AND consultation_id = ? AND org_id = ?',
      [req.params.photoId, req.params.id, req.orgId]
    );
    const photo = rows[0];
    if (photo) {
      await req.db.execute(
        'DELETE FROM consultation_photos WHERE id = ? AND org_id = ?',
        [photo.id, req.orgId]
      );
      fs.unlink(path.join(UPLOAD_ROOT, req.params.id, photo.filename), () => {});
    }
    res.redirect(`${res.locals.basePath}/admin/consultations/${req.params.id}/edit`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
