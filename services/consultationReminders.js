// services/consultationReminders.js — checks for consultations happening in the next
// day that haven't had a reminder sent yet, and emails the customer one. Run on an
// hourly tick from server.js (see cron.schedule there); reminder_sent_at is what makes
// re-running this hourly idempotent, and gets reset to NULL on reschedule (see
// routes/admin/consultations.js's /:id/reschedule) so a changed appointment gets a
// fresh reminder for its new time.
//
// Sweeps every active tenant, one scoped handle at a time — see services/orgs.js.
const { forEachActiveOrg } = require('./orgs');
const { sendMail } = require('./mailer');

const REMINDER_WINDOW_HOURS = 24;

async function remindersForOrg(db, org) {
  const [rows] = await db.execute(
    `SELECT co.id, co.consultation_date, co.duration_minutes, c.name AS customer_name,
       c.email AS customer_email, c.address AS customer_address
     FROM consultations co
     JOIN customers c ON c.id = co.customer_id AND c.org_id = co.org_id
     WHERE co.org_id = ?
       AND co.status != 'completed'
       AND co.consultation_date IS NOT NULL
       AND co.reminder_sent_at IS NULL
       AND co.consultation_date BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL ? HOUR)`,
    [org.id, REMINDER_WINDOW_HOURS]
  );

  for (const row of rows) {
    if (!row.customer_email) continue;

    const when = new Date(row.consultation_date.replace(' ', 'T')).toLocaleString('en-US', {
      dateStyle: 'full', timeStyle: 'short',
    });

    const sent = await sendMail({
      orgId: org.id,
      to: row.customer_email,
      subject: `Reminder — your consultation is coming up (${when})`,
      template: 'consultation-reminder',
      data: { customerName: row.customer_name, when, address: row.customer_address },
    });

    if (sent) {
      await db.execute(
        'UPDATE consultations SET reminder_sent_at = NOW() WHERE id = ? AND org_id = ?',
        [row.id, org.id]
      );
    }
  }

  return rows.length;
}

async function sendDueReminders() {
  return forEachActiveOrg(remindersForOrg, 'consultation reminders');
}

module.exports = { sendDueReminders };
