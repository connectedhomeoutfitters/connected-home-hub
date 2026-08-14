// services/calendarInvite.js — generates a standard .ics calendar invite (no Google
// Calendar API / OAuth scope needed — any calendar app, including Google Calendar,
// can open/accept an .ics directly from the email it's attached to).
const ics = require('ics');

// consultation.consultation_date comes back from mysql2 as "YYYY-MM-DD HH:MM:SS"
// (dateStrings: true in config/db.js) — ics wants a [Y, M, D, H, Min] array with a
// 1-indexed month.
function dateStringToIcsArray(dateString) {
  const [datePart, timePart] = dateString.split(' ');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = (timePart || '00:00:00').split(':').map(Number);
  return [year, month, day, hour, minute];
}

// companyName is the *tenant's* name (from company_settings), not ours — this text is
// customer-facing. The uid domain is the product's own domain and is deliberately NOT
// per-tenant: it only has to be globally unique and stable so calendar apps can match
// an update to the event they already have.
const UID_DOMAIN = 'connectedworkos.com';

function generateConsultationInvite({ consultation, customer, consultantName, consultantEmail, companyName }) {
  const company = companyName || 'your contractor';
  const { error, value } = ics.createEvent({
    start: dateStringToIcsArray(consultation.consultation_date),
    duration: { minutes: consultation.duration_minutes || 60 },
    title: `${company} — Consultation with ${customer.name}`,
    description: `On-site smart home consultation with ${company}.`,
    location: customer.address || undefined,
    organizer: { name: consultantName, email: consultantEmail },
    attendees: [
      { name: consultantName, email: consultantEmail, rsvp: true, partstat: 'ACCEPTED' },
      { name: customer.name, email: customer.email, rsvp: true, partstat: 'NEEDS-ACTION' },
    ],
    uid: `consultation-${consultation.id}@${UID_DOMAIN}`,
    status: 'CONFIRMED',
  });

  if (error) throw error;
  return value;
}

module.exports = { generateConsultationInvite };
