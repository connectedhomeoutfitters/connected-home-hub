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

function generateConsultationInvite({ consultation, customer, consultantName, consultantEmail }) {
  const { error, value } = ics.createEvent({
    start: dateStringToIcsArray(consultation.consultation_date),
    duration: { minutes: consultation.duration_minutes || 60 },
    title: `Connected Home Outfitters — Consultation with ${customer.name}`,
    description: 'On-site smart home consultation with Connected Home Outfitters.',
    location: customer.address || undefined,
    organizer: { name: consultantName, email: consultantEmail },
    attendees: [
      { name: consultantName, email: consultantEmail, rsvp: true, partstat: 'ACCEPTED' },
      { name: customer.name, email: customer.email, rsvp: true, partstat: 'NEEDS-ACTION' },
    ],
    uid: `consultation-${consultation.id}@connectedhomeoutfitters.com`,
    status: 'CONFIRMED',
  });

  if (error) throw error;
  return value;
}

module.exports = { generateConsultationInvite };
