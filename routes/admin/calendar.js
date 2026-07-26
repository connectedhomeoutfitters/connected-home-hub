const express = require('express');
const router = express.Router();
const db = require('../../config/db');
const { requireAuth } = require('../../middleware/auth');

router.use(requireAuth);

// Local YYYY-MM-DD key from a Date (used to bucket events onto grid days). Uses local
// time consistently for both events and cells so they line up regardless of server TZ.
function ymd(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
function timeLabel(d) {
  return new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// Month calendar of everything scheduled — jobs (by scheduled_at, plus due-date markers
// for jobs with a deadline but no set time) and consultations. Read-only; each event
// links to its edit page where the time is actually changed.
router.get('/', async (req, res, next) => {
  try {
    const now = new Date();
    let year = now.getFullYear();
    let month = now.getMonth(); // 0-indexed
    const m = /^(\d{4})-(\d{2})$/.exec(req.query.m || '');
    if (m) { year = Number(m[1]); month = Number(m[2]) - 1; }

    // Grid spans whole weeks (Sun–Sat) covering the month: 6 rows × 7 cols = 42 cells.
    const firstOfMonth = new Date(year, month, 1);
    const gridStart = new Date(year, month, 1 - firstOfMonth.getDay());
    const gridEnd = new Date(gridStart);
    gridEnd.setDate(gridEnd.getDate() + 42);

    const [consultations] = await db.execute(
      `SELECT co.id, co.consultation_date, co.status, c.name AS customer_name
       FROM consultations co JOIN customers c ON c.id = co.customer_id
       WHERE co.consultation_date >= ? AND co.consultation_date < ? AND co.status <> 'cancelled'`,
      [gridStart, gridEnd]
    );
    const [scheduledJobs] = await db.execute(
      `SELECT j.id, j.title, j.type, j.status, j.scheduled_at, u.name AS assigned_name
       FROM jobs j LEFT JOIN users u ON u.id = j.assigned_to
       WHERE j.scheduled_at >= ? AND j.scheduled_at < ?`,
      [gridStart, gridEnd]
    );
    const [dueJobs] = await db.execute(
      `SELECT j.id, j.title, j.type, j.status, j.due_date, u.name AS assigned_name
       FROM jobs j LEFT JOIN users u ON u.id = j.assigned_to
       WHERE j.scheduled_at IS NULL AND j.due_date >= ? AND j.due_date < ?
         AND j.status NOT IN ('done', 'cancelled')`,
      [ymd(gridStart), ymd(gridEnd)]
    );

    // Bucket events by day key.
    const byDay = {};
    const push = (key, ev) => { (byDay[key] = byDay[key] || []).push(ev); };
    for (const co of consultations) {
      push(ymd(co.consultation_date), {
        kind: 'consultation', time: timeLabel(co.consultation_date), sortKey: new Date(co.consultation_date).getTime(),
        title: `${co.customer_name} — consult`, link: `/admin/consultations/${co.id}/edit`,
      });
    }
    for (const j of scheduledJobs) {
      push(ymd(j.scheduled_at), {
        kind: j.type, time: timeLabel(j.scheduled_at), sortKey: new Date(j.scheduled_at).getTime(),
        title: j.title, link: `/admin/jobs/${j.id}/edit`,
      });
    }
    for (const j of dueJobs) {
      push(ymd(j.due_date), {
        kind: 'due', time: null, sortKey: 0,
        title: `${j.title} (due)`, link: `/admin/jobs/${j.id}/edit`,
      });
    }
    for (const key of Object.keys(byDay)) byDay[key].sort((a, b) => a.sortKey - b.sortKey);

    // Build 6 weeks of cells.
    const weeks = [];
    const todayKey = ymd(now);
    const cursor = new Date(gridStart);
    for (let w = 0; w < 6; w++) {
      const days = [];
      for (let d = 0; d < 7; d++) {
        const key = ymd(cursor);
        days.push({
          key, day: cursor.getDate(), inMonth: cursor.getMonth() === month, isToday: key === todayKey,
          events: byDay[key] || [],
        });
        cursor.setDate(cursor.getDate() + 1);
      }
      weeks.push(days);
    }

    const prev = new Date(year, month - 1, 1);
    const next = new Date(year, month + 1, 1);
    res.render('admin/calendar', {
      pageScript: null,
      weeks,
      monthLabel: firstOfMonth.toLocaleString('en-US', { month: 'long', year: 'numeric' }),
      prevM: `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`,
      nextM: `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`,
      thisM: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
