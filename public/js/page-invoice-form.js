// Line-item entry on the manual invoice form.
//
// Kept separate from page-estimate-form.js on purpose: that one carries the catalog
// picker, per-line costing, hide-price and flat-rate package logic, none of which apply to
// an invoice. An invoice records what is being charged, not how the job was priced.
//
// A real file rather than an inline block — the CSP's `script-src 'self'` (no unsafe-inline)
// silently no-ops an unnonced inline script, and inline on* handlers are blocked outright
// by script-src-attr 'none'. See CLAUDE.md.
(function () {
  'use strict';

  var body = document.getElementById('line-items-body');
  var template = document.getElementById('line-row-template');
  var addBtn = document.getElementById('add-line');
  if (!body || !template || !addBtn) return;

  var totalCell = document.getElementById('lines-total');
  var amountInput = document.getElementById('inv-amount');
  var amountHelp = document.getElementById('inv-amount-help');

  function money(n) {
    return '$' + (Math.round(n * 100) / 100).toFixed(2);
  }

  function recalc() {
    var rows = body.querySelectorAll('.line-item-row');
    var total = 0;

    rows.forEach(function (row) {
      var qty = parseFloat(row.querySelector('[name="line_quantity"]').value) || 0;
      var price = parseFloat(row.querySelector('[name="line_unit_price"]').value) || 0;
      // Round per line before summing, matching services/invoicing.js#lineItemsTotal.
      // If the browser and the server round differently the customer sees one total and
      // gets charged another.
      var amount = Math.round(qty * price * 100) / 100;
      row.querySelector('.line-amount').textContent = money(amount);
      total += amount;
    });

    if (totalCell) totalCell.textContent = money(total);

    // Once there are lines they own the total, so the plain amount field would only
    // mislead. The server applies the same rule; this just makes it visible.
    var itemised = rows.length > 0;
    if (amountInput) {
      amountInput.disabled = itemised;
      if (itemised) amountInput.value = '';
    }
    if (amountHelp) {
      amountHelp.textContent = itemised
        ? 'Taken from the line items below.'
        : 'Or itemise below and this is worked out for you.';
    }
  }

  function addRow() {
    body.appendChild(template.content.cloneNode(true));
    var rows = body.querySelectorAll('.line-item-row');
    var last = rows[rows.length - 1];
    last.querySelector('[name="line_description"]').focus();
    recalc();
  }

  addBtn.addEventListener('click', addRow);

  // Delegated, so rows added later are covered without rebinding.
  body.addEventListener('input', recalc);
  body.addEventListener('click', function (e) {
    var btn = e.target.closest('.remove-line');
    if (!btn) return;
    btn.closest('.line-item-row').remove();
    recalc();
  });

  recalc();
})();
