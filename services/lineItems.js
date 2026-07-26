// Shared parser for the dynamic line-item form used by both the estimate builder and the
// estimate-template builder. Line fields arrive as parallel arrays (line_description[],
// line_quantity[], line_unit_price[], line_source[]) — zipped back together here, blank
// rows dropped, catalog source parsed into product_id / labor_rate_id.
//
// (Named distinctly from the estimate's own "description"/"quantity" fields on purpose —
// same-named inputs merge into one array on submit; see estimate-form.ejs.)

function normalizeArray(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function lineItemsFromBody(body) {
  const descriptions = normalizeArray(body.line_description);
  const quantities = normalizeArray(body.line_quantity);
  const unitPrices = normalizeArray(body.line_unit_price);
  const sources = normalizeArray(body.line_source); // '' | product:<id> | labor:<id>
  const items = [];
  for (let i = 0; i < descriptions.length; i++) {
    const description = (descriptions[i] || '').trim();
    if (!description) continue;
    let productId = null;
    let laborRateId = null;
    const src = sources[i] || '';
    if (src.startsWith('product:')) productId = parseInt(src.slice(8), 10) || null;
    else if (src.startsWith('labor:')) laborRateId = parseInt(src.slice(6), 10) || null;
    items.push({
      description,
      quantity: parseFloat(quantities[i]) || 0,
      unit_price: parseFloat(unitPrices[i]) || 0,
      product_id: productId,
      labor_rate_id: laborRateId,
    });
  }
  return items;
}

module.exports = { lineItemsFromBody, normalizeArray };
