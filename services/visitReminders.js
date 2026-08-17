// services/visitReminders.js — emails the customer a heads-up before a recurring service
// visit. Hourly tick from server.js, mirroring services/consultationReminders.js.
//
// Under pay-after-service (docs/adr/0002-recurring-services.md) this is purely a heads-up:
// move the car, unlock the gate, keep the dog in. There is nothing to collect yet, which is
// what keeps it a one-way notification with no payment state to get wrong.
//
// jobs.reminder_sent_at is what makes an hourly sweep safe to repeat, and is reset to NULL
// when a visit is rescheduled so the customer hears about the NEW time.
const { forEachActiveOrg } = require('./orgs');
const { sendMail } = require('./mailer');

const REMINDER_WINDOW_HOURS = 24;

async function remindersForOrg(db, org) {
  const [rows] = await db.execute(
    `SELECT j.id, j.title, j.scheduled_at, j.visit_date,
            c.name AS customer_name, c.email AS customer_email, c.address AS customer_address
       FROM jobs j
       JOIN customers c ON c.id = j.customer_id AND c.org_id = j.org_id
      WHERE j.org_id = ?
        AND j.type = 'service'
        AND j.status = 'pending'
        AND j.reminder_sent_at IS NULL
        AND j.scheduled_at IS NOT NULL
        AND j.scheduled_at BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL ? HOUR)`,
    [org.id, REMINDER_WINDOW_HOURS]
  );

  let sentCount = 0;
  for (const row of rows) {
    // A visit with no email on file still gets stamped below, so it is not re-examined
    // every hour forever — there is no address to try again with.
    if (row.customer_email) {
      const when = new Date(String(row.scheduled_at).replace(' ', 'T')).toLocaleString('en-US', {
        dateStyle: 'full', timeStyle: 'short',
      });
      const sent = await sendMail({
        orgId: org.id,
        to: row.customer_email,
        subject: `Reminder — ${row.title} on ${when}`,
        template: 'service-visit-reminder',
        data: {
          customerName: row.customer_name,
          serviceTitle: row.title,
          when,
          address: row.customer_address,
        },
      });
      // Only stamp on a successful send, so a transient SMTP failure is retried next hour
      // rather than silently swallowing the reminder.
      if (!sent) continue;
      sentCount++;
    }

    await db.execute(
      'UPDATE jobs SET reminder_sent_at = NOW() WHERE id = ? AND org_id = ?',
      [row.id, org.id]
    );
  }

  return sentCount;
}

async function sendVisitReminders() {
  return forEachActiveOrg(remindersForOrg, 'service visit reminders');
}

module.exports = { sendVisitReminders };
