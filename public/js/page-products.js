// Client-side search / filter / sort for the product catalog table. The catalog is small,
// so this stays entirely in the browser — no server round-trips. Rows carry data-category,
// data-vendor, and data-search (lowercased) attributes; numeric cells carry data-sort.
(function () {
  const table = document.getElementById('products-table');
  if (!table) return;
  const tbody = table.querySelector('tbody');
  const allRows = Array.from(tbody.querySelectorAll('tr'));
  const searchInput = document.getElementById('prod-search');
  const categorySelect = document.getElementById('prod-category');
  const vendorSelect = document.getElementById('prod-vendor');
  const countEl = document.getElementById('prod-count');

  // Populate the filter dropdowns from the rendered rows.
  function fillSelect(select, values) {
    const uniq = [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
    for (const v of uniq) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      select.appendChild(opt);
    }
  }
  fillSelect(categorySelect, allRows.map((r) => r.dataset.category));
  fillSelect(vendorSelect, allRows.map((r) => r.dataset.vendor));

  function applyFilters() {
    const q = (searchInput.value || '').trim().toLowerCase();
    const cat = categorySelect.value;
    const ven = vendorSelect.value;
    let shown = 0;
    for (const row of allRows) {
      const show =
        (!q || (row.dataset.search || '').includes(q)) &&
        (!cat || row.dataset.category === cat) &&
        (!ven || row.dataset.vendor === ven);
      row.style.display = show ? '' : 'none';
      if (show) shown++;
    }
    if (countEl) countEl.textContent = shown === allRows.length ? `${shown} products` : `${shown} of ${allRows.length}`;
  }

  // Column sorting — click a header to sort, click again to reverse.
  const headers = Array.from(table.querySelectorAll('th.sortable'));
  let sortCol = null;
  let sortDir = 1;

  function cellValue(row, col, type) {
    const cell = row.children[col];
    if (!cell) return type === 'num' ? 0 : '';
    if (type === 'num') {
      const ds = cell.dataset.sort;
      return parseFloat(ds != null ? ds : cell.textContent.replace(/[^0-9.-]/g, '')) || 0;
    }
    return cell.textContent.trim().toLowerCase();
  }

  function sortRows(col, type, dir) {
    allRows
      .slice()
      .sort((a, b) => {
        const va = cellValue(a, col, type);
        const vb = cellValue(b, col, type);
        if (va < vb) return -1 * dir;
        if (va > vb) return 1 * dir;
        return 0;
      })
      .forEach((r) => tbody.appendChild(r)); // re-append in sorted order; display state persists
  }

  headers.forEach((th) => {
    th.style.cursor = 'pointer';
    th.style.userSelect = 'none';
    const caret = document.createElement('span');
    caret.className = 'sort-caret text-muted';
    caret.style.marginLeft = '4px';
    th.appendChild(caret);
    th.addEventListener('click', () => {
      const col = parseInt(th.dataset.col, 10);
      if (sortCol === col) sortDir = -sortDir;
      else { sortCol = col; sortDir = 1; }
      headers.forEach((h) => { h.querySelector('.sort-caret').textContent = ''; });
      caret.textContent = sortDir > 0 ? '▲' : '▼';
      sortRows(col, th.dataset.type, sortDir);
    });
  });

  searchInput.addEventListener('input', applyFilters);
  categorySelect.addEventListener('change', applyFilters);
  vendorSelect.addEventListener('change', applyFilters);
  applyFilters();
})();
