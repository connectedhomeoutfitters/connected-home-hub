// Internal (staff-only) profitability breakdown for an estimate or template, from its
// line items. Never shown to customers.
//
// Cost basis per line = quantity × unit_cost, grouped into a category derived from which
// catalog source the line links to. Revenue = flat_price when the estimate/template is a
// fixed-price package, otherwise the sum of line revenue (quantity × unit_price).

function lineCategory(item) {
  if (item.product_id) return 'materials';
  if (item.subcontractor_id) return 'subcontractor';
  if (item.labor_rate_id) return 'labor';
  return 'other';
}

// flatPrice: pass the estimate/template's flat_price (or null/undefined for itemized).
function computeCosting(items, flatPrice = null) {
  const cost = { materials: 0, labor: 0, subcontractor: 0, other: 0 };
  const revenueByCat = { materials: 0, labor: 0, subcontractor: 0, other: 0 };
  let itemizedRevenue = 0;

  for (const it of items) {
    const qty = Number(it.quantity) || 0;
    const lineRevenue = qty * (Number(it.unit_price) || 0);
    const lineCost = qty * (Number(it.unit_cost) || 0);
    const cat = lineCategory(it);
    itemizedRevenue += lineRevenue;
    revenueByCat[cat] += lineRevenue;
    cost[cat] += lineCost;
  }

  const isFlat = flatPrice !== null && flatPrice !== undefined && String(flatPrice) !== '';
  const revenue = isFlat ? Number(flatPrice) : itemizedRevenue;
  const totalCost = cost.materials + cost.labor + cost.subcontractor + cost.other;
  const profit = revenue - totalCost;

  return {
    isFlat,
    revenue,
    itemizedRevenue,
    revenueByCat,
    cost,
    totalCost,
    profit,
    marginPct: revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : null,
    hasCost: totalCost > 0,
  };
}

module.exports = { computeCosting, lineCategory };
