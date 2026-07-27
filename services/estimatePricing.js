// Customer-facing money for an estimate, computed from its line items + tax/deposit
// settings. Shared by the create and update routes so the two can't drift.
//
// flatPrice (a number) turns the estimate into a fixed-price "package": the customer sees
// one total with no per-line pricing, and tax/subtotal collapse into that flat amount.
// flatPrice null/undefined = the normal itemized behavior (total = Σ lines + tax).
// Line items still keep their real quantities/prices for internal costing regardless.

function parseFlatPrice(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

function computeEstimateTotals(items, taxPercent, depositPercent, flatPrice) {
  const itemizedSubtotal = items.reduce((sum, i) => sum + i.quantity * i.unit_price, 0);
  const isFlat = flatPrice !== null && flatPrice !== undefined;

  const subtotal = isFlat ? flatPrice : itemizedSubtotal;
  const tax = isFlat ? 0 : itemizedSubtotal * (taxPercent / 100);
  const total = isFlat ? flatPrice : itemizedSubtotal + tax;
  const depositAmount = total * (depositPercent / 100);

  return { subtotal, tax, total, depositAmount };
}

module.exports = { computeEstimateTotals, parseFlatPrice };
