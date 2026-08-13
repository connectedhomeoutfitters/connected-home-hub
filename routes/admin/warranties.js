const express = require('express');
const router = express.Router();
const { requireAuth } = require('../../middleware/auth');

router.use(requireAuth);

// List — active by default; ?all=1 includes deactivated. Sorted so soonest-expiring
// active warranties surface first.
router.get('/', async (req, res, next) => {
  try {
    const showAll = req.query.all === '1';
    const [warranties] = await req.db.execute(
      `SELECT w.*, c.name AS customer_name FROM warranties w
       JOIN customers c ON c.id = w.customer_id AND c.org_id = w.org_id
       WHERE w.org_id = ? ${showAll ? '' : 'AND w.active = 1'}
       ORDER BY (w.expires_on IS NULL), w.expires_on`,
      [req.orgId]
    );
    res.render('admin/warranties', { pageScript: null, warranties, showAll });
  } catch (err) {
    next(err);
  }
});

async function customerList(db, orgId) {
  const [customers] = await db.execute(
    'SELECT id, name FROM customers WHERE org_id = ? ORDER BY name',
    [orgId]
  );
  return customers;
}

router.get('/new', async (req, res, next) => {
  try {
    const customers = await customerList(req.db, req.orgId);
    // Prefill customer (and default the provider for a labor warranty) when launched from
    // a customer or a completed job.
    res.render('admin/warranty-form', {
      pageScript: null, isNew: true, customers, error: null,
      warranty: {
        customer_id: req.query.customer_id || '',
        job_id: req.query.job_id || null,
        item: '', type: 'product', provider: '', start_date: '', expires_on: '', coverage_notes: '',
      },
    });
  } catch (err) {
    next(err);
  }
});

function validate(body) {
  if (!body.customer_id) return 'Please choose a customer.';
  if (!(body.item || '').trim()) return 'Describe what the warranty covers.';
  if (body.start_date && body.expires_on && body.expires_on < body.start_date) {
    return 'Expiry date must be on or after the start date.';
  }
  return null;
}

// The customer must belong to this tenant — a forged customer_id would otherwise attach
// a warranty to another org's customer.
async function ownsCustomer(db, orgId, customerId) {
  const [[row]] = await db.execute(
    'SELECT id FROM customers WHERE id = ? AND org_id = ?',
    [customerId, orgId]
  );
  return !!row;
}

router.post('/', async (req, res, next) => {
  try {
    const error = validate(req.body) ||
      (await ownsCustomer(req.db, req.orgId, req.body.customer_id) ? null : 'Please choose a customer.');
    if (error) {
      const customers = await customerList(req.db, req.orgId);
      return res.status(400).render('admin/warranty-form', {
        pageScript: null, isNew: true, customers, error,
        warranty: { ...req.body },
      });
    }
    const { customer_id, job_id, item, type, provider, start_date, expires_on, coverage_notes } = req.body;
    await req.db.execute(
      `INSERT INTO warranties (org_id, customer_id, job_id, item, type, provider, start_date, expires_on, coverage_notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.orgId, customer_id, job_id || null, item.trim(), type || null, provider || null,
        start_date || null, expires_on || null, coverage_notes || null]
    );
    res.redirect(`${res.locals.basePath}/admin/warranties`);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/edit', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(
      'SELECT * FROM warranties WHERE id = ? AND org_id = ?',
      [req.params.id, req.orgId]
    );
    const warranty = rows[0];
    if (!warranty) return res.status(404).render('error', { message: 'Warranty not found' });
    const customers = await customerList(req.db, req.orgId);
    res.render('admin/warranty-form', { pageScript: null, isNew: false, customers, error: null, warranty });
  } catch (err) {
    next(err);
  }
});

router.post('/:id', async (req, res, next) => {
  try {
    const error = validate(req.body) ||
      (await ownsCustomer(req.db, req.orgId, req.body.customer_id) ? null : 'Please choose a customer.');
    if (error) {
      const customers = await customerList(req.db, req.orgId);
      return res.status(400).render('admin/warranty-form', {
        pageScript: null, isNew: false, customers, error,
        warranty: { id: req.params.id, ...req.body },
      });
    }
    const { customer_id, item, type, provider, start_date, expires_on, coverage_notes } = req.body;
    // Changing the expiry re-arms the reminder so a newly-relevant date can notify again.
    await req.db.execute(
      `UPDATE warranties SET customer_id=?, item=?, type=?, provider=?, start_date=?, expires_on=?,
        coverage_notes=?, reminder_sent_at = NULL WHERE id=? AND org_id=?`,
      [customer_id, item.trim(), type || null, provider || null, start_date || null,
        expires_on || null, coverage_notes || null, req.params.id, req.orgId]
    );
    res.redirect(`${res.locals.basePath}/admin/warranties`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/active', async (req, res, next) => {
  try {
    await req.db.execute(
      'UPDATE warranties SET active = ? WHERE id = ? AND org_id = ?',
      [req.body.active === '1' ? 1 : 0, req.params.id, req.orgId]
    );
    res.redirect(`${res.locals.basePath}/admin/warranties${req.query.all === '1' ? '?all=1' : ''}`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
