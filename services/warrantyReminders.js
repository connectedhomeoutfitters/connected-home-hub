// services/warrantyReminders.js — emails the customer ~30 days before an active warranty
// lapses, so they (and the business) have a chance to renew or schedule service. Run on a
// daily tick from server.js. reminder_sent_at makes re-running idempotent, and is reset to
// NULL whenever a warranty's expiry is edited (see routes/admin/warranties.js) so a new
// date can notify again. Mirrors services/consultationReminders.js.
const db = require('../config/db');
const { sendMail } = require('./mailer');

const REMINDER_WINDOW_DAYS = 30;

async function sendExpiryReminders() {
  const [rows] = await db.execute(
    `SELECT w.id, w.item, w.provider, w.expires_on, c.name AS customer_name, c.email AS customer_email
     FROM warranties w JOIN customers c ON c.id = w.customer_id
     WHERE w.active = 1
       AND w.expires_on IS NOT NULL
       AND w.reminder_sent_at IS NULL
       AND w.expires_on BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL ? DAY)`,
    [REMINDER_WINDOW_DAYS]
  );

  for (const row of rows) {
    if (!row.customer_email) continue;

    const expires = new Date(row.expires_on).toLocaleDateString('en-US', { dateStyle: 'long' });
    const sent = await sendMail({
      to: row.customer_email,
      subject: `Your ${row.item} warranty expires soon`,
      template: 'warranty-expiring',
      data: { customerName: row.customer_name, item: row.item, provider: row.provider, expires },
    });

    if (sent) {
      await db.execute('UPDATE warranties SET reminder_sent_at = NOW() WHERE id = ?', [row.id]);
    }
  }

  return rows.length;
}

module.exports = { sendExpiryReminders };
