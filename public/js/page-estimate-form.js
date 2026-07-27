// Dynamic line-item builder for the estimate + template forms. Catalog data comes from
// window.CHO_HUB_CATALOG (embedded by the EJS). Totals/costing here are staff-facing
// feedback only — the server recomputes authoritatively on save.
(function () {
  const { products, laborRates, subcontractors = [] } = window.CHO_HUB_CATALOG;
  const tbody = document.getElementById('line-items-body');
  // Clone from the inert <template> — works even on a new estimate that server-rendered
  // zero rows.
  const template = document.getElementById('line-row-template');

  const flatToggle = document.getElementById('flat-toggle');
  const flatInput = document.getElementById('flat_price');
  const flatWrap = document.getElementById('flat-price-wrap');

  function sourceOptionsHtml() {
    let html = '<option value="">Custom</option>';
    if (products.length) {
      html += '<optgroup label="Products">';
      for (const p of products) {
        html += `<option value="product:${p.id}" data-description="${escapeAttr(p.name)}" data-price="${p.retail_price}" data-cost="${p.vendor_cost}">${escapeText(p.category)} &mdash; ${escapeText(p.name)}</option>`;
      }
      html += '</optgroup>';
    }
    if (laborRates.length) {
      html += '<optgroup label="Labor">';
      for (const l of laborRates) {
        // Own labor: the hourly_rate is what we charge (revenue); cost basis is the owner's
        // own time by default (0), editable per line if a tech is paid.
        html += `<option value="labor:${l.id}" data-description="${escapeAttr(l.name)}" data-price="${l.hourly_rate}" data-cost="0">${escapeText(l.name)} ($${Number(l.hourly_rate).toFixed(2)}/hr)</option>`;
      }
      html += '</optgroup>';
    }
    if (subcontractors.length) {
      html += '<optgroup label="Subcontractors">';
      for (const s of subcontractors) {
        // A sub's hourly_rate is our COST; pre-fill both price and cost to it so margin
        // starts at zero and staff mark the price up.
        const rate = s.hourly_rate != null ? Number(s.hourly_rate) : 0;
        const label = s.trade ? `${s.name} (${s.trade})` : s.name;
        html += `<option value="sub:${s.id}" data-description="${escapeAttr(label)}" data-price="${rate}" data-cost="${rate}">${escapeText(label)}</option>`;
      }
      html += '</optgroup>';
    }
    return html;
  }

  function escapeAttr(s) {
    return String(s).replace(/"/g, '&quot;');
  }
  function escapeText(s) {
    return String(s).replace(/</g, '&lt;');
  }

  function wireRow(row) {
    const sourceSelect = row.querySelector('.line-source');
    sourceSelect.innerHTML = sourceOptionsHtml();
    // Restore the catalog link when editing (data-source is set server-side).
    if (row.dataset.source) sourceSelect.value = row.dataset.source;

    sourceSelect.addEventListener('change', () => {
      const selected = sourceSelect.selectedOptions[0];
      if (selected && selected.dataset.description) {
        row.querySelector('.line-description').value = selected.dataset.description;
        row.querySelector('.line-price').value = selected.dataset.price;
        if (selected.dataset.cost !== undefined) {
          row.querySelector('.line-cost').value = selected.dataset.cost;
        }
        if (!row.querySelector('.line-quantity').value) {
          row.querySelector('.line-quantity').value = 1;
        }
      }
      recalculate();
    });

    row.querySelectorAll('.line-quantity, .line-price, .line-cost').forEach((input) => {
      input.addEventListener('input', recalculate);
    });

    // Hide-price: a checkbox is a UI control only; it writes the always-submitted hidden
    // input so the parallel arrays never misalign (see services/lineItems.js).
    const hideToggle = row.querySelector('.line-hide-toggle');
    const hideFlag = row.querySelector('.line-hide-price');
    if (hideToggle && hideFlag) {
      hideToggle.addEventListener('change', () => {
        hideFlag.value = hideToggle.checked ? '1' : '0';
      });
    }

    row.querySelector('.remove-line').addEventListener('click', () => {
      row.remove();
      recalculate();
    });
    const up = row.querySelector('.move-up');
    const down = row.querySelector('.move-down');
    if (up) up.addEventListener('click', () => {
      const prev = row.previousElementSibling;
      if (prev) tbody.insertBefore(row, prev);
    });
    if (down) down.addEventListener('click', () => {
      const next = row.nextElementSibling;
      if (next) tbody.insertBefore(next, row);
    });
  }

  function addRow() {
    const row = template.content.firstElementChild.cloneNode(true);
    tbody.appendChild(row);
    wireRow(row);
    return row;
  }

  function sourceCategory(value) {
    if (value.startsWith('product:')) return 'materials';
    if (value.startsWith('sub:')) return 'subcontractor';
    if (value.startsWith('labor:')) return 'labor';
    return 'other';
  }

  function money(n) {
    return `$${Number(n).toFixed(2)}`;
  }
  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function recalculate() {
    let subtotal = 0;
    const cost = { materials: 0, labor: 0, subcontractor: 0, other: 0 };
    document.querySelectorAll('.line-item-row').forEach((row) => {
      const qty = parseFloat(row.querySelector('.line-quantity').value) || 0;
      const price = parseFloat(row.querySelector('.line-price').value) || 0;
      const unitCost = parseFloat(row.querySelector('.line-cost').value) || 0;
      const lineTotal = qty * price;
      row.querySelector('.line-total').textContent = money(lineTotal);
      subtotal += lineTotal;
      cost[sourceCategory(row.querySelector('.line-source').value)] += qty * unitCost;
    });

    const isFlat = !!(flatToggle && flatToggle.checked && flatInput && flatInput.value !== '' && !Number.isNaN(parseFloat(flatInput.value)));
    const flatPrice = isFlat ? parseFloat(flatInput.value) : null;

    const taxPercent = parseFloat(document.getElementById('tax_percent').value) || 0;
    const tax = isFlat ? 0 : subtotal * (taxPercent / 100);
    const total = isFlat ? flatPrice : subtotal + tax;

    setText('summary-subtotal', money(subtotal));
    setText('summary-tax', money(tax));
    setText('summary-total', money(total));

    // Profitability panel (live).
    const totalCost = cost.materials + cost.labor + cost.subcontractor + cost.other;
    const revenue = isFlat ? flatPrice : subtotal;
    const profit = revenue - totalCost;
    setText('cost-revenue', money(revenue));
    setText('cost-materials', money(cost.materials));
    setText('cost-labor', money(cost.labor));
    setText('cost-sub', money(cost.subcontractor));
    setText('cost-other', money(cost.other));
    setText('cost-total', money(totalCost));
    setText('cost-profit', `${profit < 0 ? '-' : ''}${money(Math.abs(profit))}`);
    setText('cost-margin', revenue > 0 ? `${Math.round((profit / revenue) * 1000) / 10}%` : '—');
  }

  // Flat-package toggle. Show/hide by swapping Bootstrap's d-none/d-flex classes rather
  // than inline style.display — .d-flex is `display:flex !important`, which an inline
  // style can't override.
  function showFlatWrap(show) {
    if (!flatWrap) return;
    flatWrap.classList.toggle('d-flex', show);
    flatWrap.classList.toggle('d-none', !show);
  }
  if (flatToggle) {
    const syncFlat = () => {
      showFlatWrap(flatToggle.checked);
      if (!flatToggle.checked && flatInput) flatInput.value = '';
      recalculate();
    };
    flatToggle.addEventListener('change', syncFlat);
    if (flatInput) flatInput.addEventListener('input', recalculate);
    // Reflect server-rendered flat state on load.
    showFlatWrap(flatToggle.checked);
  }

  document.querySelectorAll('.line-item-row').forEach(wireRow);
  if (document.querySelectorAll('.line-item-row').length === 0) {
    addRow();
  }
  document.getElementById('add-line').addEventListener('click', addRow);
  document.getElementById('tax_percent').addEventListener('input', recalculate);
  recalculate();
})();
