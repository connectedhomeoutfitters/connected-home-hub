'use strict';
// Pushes a paid invoice into the tenant's Connected Home Ledger Business Workspace as a
// business income transaction. Phase 5 of docs/adr/0001-multi-tenancy.md.
//
// Fire-and-forget by design: this runs inside the Stripe webhook handler, and Ledger being
// slow or down must never stop a payment being reconciled here. Nothing in this module
// throws. A push that doesn't happen is recoverable — invoices.ledger_synced_at stays NULL
// and `backfillOrg()` can replay it — whereas a webhook that fails leaves the customer's
// invoice unpaid in the UI, which is far worse.

const db = require('../config/db');
const scopedDb = require('../config/scopedDb');

const TIMEOUT_MS = 8000;

function ledgerBaseUrl() {
  return (process.env.LEDGER_URL || 'https://connectedhomeledger.com').replace(/\/$/, '');
}

// Only orgs that came from Ledger have somewhere to post; standalone Hub customers don't.
async function syncTargetFor(orgId) {
  const [[org]] = await db.execute(
    'SELECT id, name, ledger_workspace_id, ledger_sync_enabled FROM orgs WHERE id = ?', [orgId]
  );
  if (!org) return { ok: false, reason: 'no_org' };
  if (!org.ledger_workspace_id) return { ok: false, reason: 'not_linked' };
  if (!org.ledger_sync_enabled) return { ok: false, reason: 'disabled' };
  if (!process.env.HUB_SSO_SECRET && !process.env.LEDGER_SSO_SECRET) return { ok: false, reason: 'no_secret' };
  return { ok: true, org };
}

async function postToLedger(body) {
  const secret = process.env.LEDGER_SSO_SECRET || process.env.HUB_SSO_SECRET;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${ledgerBaseUrl()}/integrations/hub/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-secret': secret },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON error page */ }
    return { status: res.status, ok: res.ok, json, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Push one paid invoice. Safe to call repeatedly: Ledger dedups on a deterministic
 * external id, and we skip anything already stamped locally.
 * Returns a short result object; never throws.
 */
async function pushPaidInvoice(orgId, invoiceId) {
  try {
    const target = await syncTargetFor(orgId);
    if (!target.ok) return { synced: false, reason: target.reason };

    const sdb = scopedDb(orgId);
    const [[inv]] = await sdb.execute(
      `SELECT i.*, c.name AS customer_name, e.title AS estimate_title
         FROM invoices i
         JOIN customers c ON c.id = i.customer_id AND c.org_id = i.org_id
         LEFT JOIN estimates e ON e.id = i.estimate_id AND e.org_id = i.org_id
        WHERE i.id = ? AND i.org_id = ?`,
      [invoiceId, orgId]
    );
    if (!inv) return { synced: false, reason: 'no_invoice' };
    if (inv.status !== 'paid') return { synced: false, reason: 'not_paid' };
    if (inv.ledger_synced_at) return { synced: false, reason: 'already_synced' };

    // Net of refunds — posting the gross would overstate their income.
    const [[net]] = await sdb.execute(
      `SELECT COALESCE(SUM(p.amount - p.amount_refunded), 0) AS net
         FROM payments p WHERE p.invoice_id = ? AND p.org_id = ? AND p.status = 'succeeded'`,
      [invoiceId, orgId]
    );
    const amount = Number(net.net);
    if (!(amount > 0)) return { synced: false, reason: 'nothing_collected' };

    const paidOn = (inv.paid_at ? new Date(inv.paid_at) : new Date()).toISOString().slice(0, 10);
    const what = inv.estimate_title || inv.description || `${inv.type} invoice`;

    const result = await postToLedger({
      workspace_id: target.org.ledger_workspace_id,
      // Stable and unique per invoice — this is what makes a redelivery idempotent.
      external_id: `invoice:${orgId}:${invoiceId}`,
      amount,
      date: paidOn,
      description: `${inv.customer_name} — ${what}`.slice(0, 500),
      invoice_type: inv.type,
      notes: `Imported from ConnectedWorkOS invoice #${invoiceId} (${inv.type}).`,
    });

    if (!result.ok) {
      console.error(`[ledgerSync] invoice ${invoiceId}: Ledger returned ${result.status} ${result.text.slice(0, 120)}`);
      return { synced: false, reason: `http_${result.status}` };
    }

    // Stamp even on a duplicate — Ledger already has it, so this invoice is done.
    await sdb.execute(
      'UPDATE invoices SET ledger_synced_at = NOW(), ledger_transaction_id = ? WHERE id = ? AND org_id = ?',
      [result.json?.transaction_id ?? null, invoiceId, orgId]
    );

    return {
      synced: true,
      duplicate: !!result.json?.duplicate,
      transactionId: result.json?.transaction_id ?? null,
      amount,
    };
  } catch (err) {
    // Never let a bookkeeping push break the caller — this runs inside the payment webhook.
    console.error(`[ledgerSync] invoice ${invoiceId} push failed:`, err.message);
    return { synced: false, reason: 'error' };
  }
}

/**
 * Replays every paid-but-unsynced invoice for an org — for when Ledger was down, sync was
 * switched on after the fact, or an org was linked later. Idempotent.
 */
async function backfillOrg(orgId, { limit = 200 } = {}) {
  const target = await syncTargetFor(orgId);
  if (!target.ok) return { attempted: 0, synced: 0, reason: target.reason };

  const [rows] = await scopedDb(orgId).execute(
    `SELECT id FROM invoices
      WHERE org_id = ? AND status = 'paid' AND ledger_synced_at IS NULL
      ORDER BY paid_at LIMIT ${Number(limit) || 200}`,
    [orgId]
  );

  let synced = 0;
  for (const r of rows) {
    const res = await pushPaidInvoice(orgId, r.id);
    if (res.synced) synced += 1;
  }
  return { attempted: rows.length, synced };
}

module.exports = { pushPaidInvoice, backfillOrg, syncTargetFor, ledgerBaseUrl };
