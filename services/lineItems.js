// Shared parser for the dynamic line-item form used by both the estimate builder and the
// estimate-template builder. Line fields arrive as parallel arrays (line_description[],
// line_quantity[], line_unit_price[], line_unit_cost[], line_source[], line_hide_price[])
// — zipped back together here, blank rows dropped, catalog source parsed into
// product_id / labor_rate_id / subcontractor_id.
//
// (Named distinctly from the estimate's own "description"/"quantity" fields on purpose —
// same-named inputs merge into one array on submit; see estimate-form.ejs.)
//
// hide_price is submitted via an always-present hidden input (value "0"/"1"), NOT a bare
// checkbox — an unchecked checkbox submits nothing, which would misalign the parallel
// arrays. Every rendered row therefore contributes exactly one value to every array, so
// index i lines up across all of them even when blank rows are later skipped.

function normalizeArray(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function lineItemsFromBody(body) {
  const descriptions = normalizeArray(body.line_description);
  const quantities = normalizeArray(body.line_quantity);
  const unitPrices = normalizeArray(body.line_unit_price);
  const unitCosts = normalizeArray(body.line_unit_cost);
  const sources = normalizeArray(body.line_source); // '' | product:<id> | labor:<id> | sub:<id>
  const hidePrices = normalizeArray(body.line_hide_price); // '0' | '1'
  const items = [];
  for (let i = 0; i < descriptions.length; i++) {
    const description = (descriptions[i] || '').trim();
    if (!description) continue;
    let productId = null;
    let laborRateId = null;
    let subcontractorId = null;
    const src = sources[i] || '';
    if (src.startsWith('product:')) productId = parseInt(src.slice(8), 10) || null;
    else if (src.startsWith('labor:')) laborRateId = parseInt(src.slice(6), 10) || null;
    else if (src.startsWith('sub:')) subcontractorId = parseInt(src.slice(4), 10) || null;
    items.push({
      description,
      quantity: parseFloat(quantities[i]) || 0,
      unit_price: parseFloat(unitPrices[i]) || 0,
      unit_cost: parseFloat(unitCosts[i]) || 0,
      product_id: productId,
      labor_rate_id: laborRateId,
      subcontractor_id: subcontractorId,
      hide_price: hidePrices[i] === '1' || hidePrices[i] === 'on' ? 1 : 0,
    });
  }
  return items;
}

module.exports = { lineItemsFromBody, normalizeArray };
