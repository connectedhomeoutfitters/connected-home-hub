// services/mailer.js — mirrors gymrProject's services/mailer.js pattern.
require('dotenv').config();
const nodemailer = require('nodemailer');
const ejs = require('ejs');
const path = require('path');

const APP_NAME = 'Connected Home Outfitters';
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
async function sendMail({ to, subject, template, data = {}, attachments, icalEvent }) {
  if (!transporter) {
    console.warn(`sendMail('${template}') skipped — SMTP not configured`);
    return false;
  }

  try {
    const html = await ejs.renderFile(
      path.join(__dirname, '..', 'views', 'emails', `${template}.ejs`),
      { ...data, appName: APP_NAME, appUrl: APP_URL, logoUrl: `${APP_URL}/img/logo.png` }
    );

    await transporter.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to,
      subject,
      html,
      attachments,
      icalEvent, // { filename, method: 'REQUEST', content } — see services/calendarInvite.js
    });
    return true;
  } catch (err) {
    console.error(`Email send failed (${template} -> ${to}):`, err.message);
    return false;
  }
}

module.exports = { sendMail };
