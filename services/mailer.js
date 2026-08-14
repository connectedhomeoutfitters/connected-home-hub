// services/mailer.js — mirrors gymrProject's services/mailer.js pattern.
require('dotenv').config();
const nodemailer = require('nodemailer');
const ejs = require('ejs');
const path = require('path');
const scopedDb = require('./../config/scopedDb');

// Fallback only — a tenant with a company name set always gets their own (see the
// appName local below). This is what an org that hasn't filled in Settings → Company
// sees, so it must be the PRODUCT's name, never one tenant's.
const APP_NAME = 'ConnectedWorkOS';
const APP_URL = process.env.BASE_URL || '';

let transporter = null;

if (process.env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
      : undefined,
  });

  transporter.verify()
    .then(() => console.log('SMTP connected:', process.env.SMTP_HOST))
    .catch((err) => console.error('SMTP connection failed:', err.message));
} else {
  console.warn('SMTP_HOST not set — outbound email is disabled');
}

// Renders views/emails/<template>.ejs and sends it. Returns true on success, false on
// failure or if SMTP isn't configured — never throws, so a down/misconfigured mail
// server never blocks the underlying action (e.g. accepting an estimate still works,
// it just won't also email a confirmation).
// Records every send attempt. Wrapped so a logging failure never affects the send itself.
async function logEmail(orgId, recipient, template, subject, status, error) {
  try {
    await scopedDb(orgId).execute(
      'INSERT INTO email_log (org_id, recipient, template, subject, status, error) VALUES (?, ?, ?, ?, ?, ?)',
      [orgId, recipient || '', template || null, subject || null, status, error ? String(error).slice(0, 500) : null]
    );
  } catch (err) {
    console.error('email_log insert failed:', err.message);
  }
}

// Per-tenant sender identity. The envelope address stays global — one verified sending
// domain keeps SPF/DKIM working, and per-tenant verified domains are a support tarpit
// (see docs/adr/0001-multi-tenancy.md). What varies is the display NAME the customer sees
// and the reply-to, so a reply reaches the contractor rather than us.
function fromHeader(company) {
  const address = process.env.MAIL_FROM || process.env.SMTP_USER || '';
  if (!company || !company.company_name) return address;
  // MAIL_FROM may already be "Name <addr>" — pull out just the address before renaming.
  const match = /<([^>]+)>/.exec(address);
  const bare = match ? match[1] : address;
  return `"${company.company_name.replace(/"/g, '')}" <${bare}>`;
}

// orgId identifies which tenant this mail belongs to — it scopes the email_log row so
// Settings → Email log only ever shows that tenant's deliveries, and it selects the
// branding (logo, name, reply-to) the recipient sees.
async function sendMail({ orgId, to, subject, template, data = {}, attachments, icalEvent }) {
  if (!transporter) {
    console.warn(`sendMail('${template}') skipped — SMTP not configured`);
    await logEmail(orgId, to, template, subject, 'skipped', 'SMTP not configured');
    return false;
  }

  // Required lazily to avoid a require cycle at module load (companySettings pulls in the
  // db layer, which several callers of this module are already inside).
  let company = null;
  try {
    company = orgId ? await require('./companySettings').getCompany(orgId) : null;
  } catch (err) {
    console.error('mailer: branding lookup failed, using defaults:', err.message);
  }

  try {
    const html = await ejs.renderFile(
      path.join(__dirname, '..', 'views', 'emails', `${template}.ejs`),
      {
        ...data,
        appName: company?.company_name || APP_NAME,
        appUrl: APP_URL,
        // Absolute — an email client has no session and no notion of basePath.
        logoUrl: company?.logo_url || `${APP_URL}/img/logo.png`,
        company,
      }
    );

    await transporter.sendMail({
      from: fromHeader(company),
      replyTo: company?.email_reply_to || undefined,
      to,
      subject,
      html,
      attachments,
      icalEvent, // { filename, method: 'REQUEST', content } — see services/calendarInvite.js
    });
    await logEmail(orgId, to, template, subject, 'sent', null);
    return true;
  } catch (err) {
    console.error(`Email send failed (${template} -> ${to}):`, err.message);
    await logEmail(orgId, to, template, subject, 'failed', err.message);
    return false;
  }
}

module.exports = { sendMail };
