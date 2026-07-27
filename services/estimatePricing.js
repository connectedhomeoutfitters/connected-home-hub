// Customer-facing money for an estimate, computed from its line items + tax/deposit
// settings. Shared by the create and update routes so the two can't drift.
//
// flatPrice (a number) turns the estimate into a fixed-price "package": the customer sees
// one package price with no per-line pricing. flatPrice null/undefined = the normal
// itemized behavior (total = Σ lines + tax on the whole subtotal). Line items still keep
// their real quantities/prices for internal costing regardless.
//
// Tax:
//   - itemized: taxed on the whole subtotal (unchanged historical behavior).
//   - flat package: the flat price is pre-tax, and sales tax is added ONLY on the taxable
//     GOODS inside the package — taxableBase = Σ(qty × price) of the taxable product lines
//     (routes compute it from products.taxable). So total = flat price + tax on taxable
//     goods. Deposit is a % of that tax-inclusive total, same as itemized.

function parseFlatPrice(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

// taxableBase is only consulted in flat mode; ignored (and can be omitted) for itemized.
function computeEstimateTotals(items, taxPercent, depositPercent, flatPrice, taxableBase = 0) {
  const itemizedSubtotal = items.reduce((sum, i) => sum + i.quantity * i.unit_price, 0);
  const isFlat = flatPrice !== null && flatPrice !== undefined;

  const subtotal = isFlat ? flatPrice : itemizedSubtotal;
  const tax = isFlat
    ? (Number(taxableBase) || 0) * (taxPercent / 100)
    : itemizedSubtotal * (taxPercent / 100);
  const total = isFlat ? flatPrice + tax : itemizedSubtotal + tax;
  const depositAmount = total * (depositPercent / 100);

  return { subtotal, tax, total, depositAmount };
}

module.exports = { computeEstimateTotals, parseFlatPrice };
