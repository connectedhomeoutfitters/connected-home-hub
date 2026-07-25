// Dynamic line-item builder for the estimate form. Catalog data comes from
// window.CHO_HUB_CATALOG (embedded by views/admin/estimate-form.ejs). Totals here are
// for staff feedback only — the server recomputes authoritatively on save.
(function () {
  const { products, laborRates } = window.CHO_HUB_CATALOG;
  const tbody = document.getElementById('line-items-body');
  const rowTemplate = document.querySelector('.line-item-row');

  function sourceOptionsHtml() {
    let html = '<option value="">Custom</option>';
    if (products.length) {
      html += '<optgroup label="Products">';
      for (const p of products) {
        html += `<option value="product:${p.id}" data-description="${escapeAttr(p.name)}" data-price="${p.retail_price}">${escapeText(p.category)} &mdash; ${escapeText(p.name)}</option>`;
      }
      html += '</optgroup>';
    }
    if (laborRates.length) {
      html += '<optgroup label="Labor">';
      for (const l of laborRates) {
        html += `<option value="labor:${l.id}" data-description="${escapeAttr(l.name)}" data-price="${l.hourly_rate}">${escapeText(l.name)} ($${Number(l.hourly_rate).toFixed(2)}/hr)</option>`;
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

    sourceSelect.addEventListener('change', () => {
      const selected = sourceSelect.selectedOptions[0];
      if (selected && selected.dataset.description) {
        row.querySelector('.line-description').value = selected.dataset.description;
        row.querySelector('.line-price').value = selected.dataset.price;
        if (!row.querySelector('.line-quantity').value) {
          row.querySelector('.line-quantity').value = 1;
        }
        recalculate();
      }
    });

    row.querySelectorAll('.line-quantity, .line-price').forEach((input) => {
      input.addEventListener('input', recalculate);
    });

    row.querySelector('.remove-line').addEventListener('click', () => {
      row.remove();
      recalculate();
    });
  }

  function addRow() {
    const row = rowTemplate.cloneNode(true);
    row.querySelectorAll('input').forEach((input) => { input.value = ''; });
    tbody.appendChild(row);
    wireRow(row);
    return row;
  }

  function recalculate() {
    let subtotal = 0;
    document.querySelectorAll('.line-item-row').forEach((row) => {
      const qty = parseFloat(row.querySelector('.line-quantity').value) || 0;
      const price = parseFloat(row.querySelector('.line-price').value) || 0;
      const lineTotal = qty * price;
      row.querySelector('.line-total').textContent = `$${lineTotal.toFixed(2)}`;
      subtotal += lineTotal;
    });
    const taxPercent = parseFloat(document.getElementById('tax_percent').value) || 0;
    const tax = subtotal * (taxPercent / 100);
    const total = subtotal + tax;
    document.getElementById('summary-subtotal').textContent = `$${subtotal.toFixed(2)}`;
    document.getElementById('summary-tax').textContent = `$${tax.toFixed(2)}`;
    document.getElementById('summary-total').textContent = `$${total.toFixed(2)}`;
  }

  document.querySelectorAll('.line-item-row').forEach(wireRow);
  if (document.querySelectorAll('.line-item-row').length === 0) {
    addRow();
  }
  document.getElementById('add-line').addEventListener('click', addRow);
  document.getElementById('tax_percent').addEventListener('input', recalculate);
  recalculate();
})();
