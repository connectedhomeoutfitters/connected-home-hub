// Searchable customer picker. Hand-rolled rather than pulling in Tom Select / Choices —
// same reasoning as the plain-CSS report bars and the library-free calendar, and it avoids
// vendoring a script under this app's strict CSP.
//
// Results come from GET /admin/customers/search (org-scoped, LIMIT 20), so the page never
// contains the customer list and this scales to any tenant size.
//
// The picker submits a hidden input holding the id, exactly like the <select> it replaced.
// The visible text box is a search field, never the submitted value — if the user types
// something and picks nothing, the id stays empty and the form fails validation rather than
// silently submitting a half-entered name.
(function () {
  'use strict';

  var DEBOUNCE_MS = 200;

  function init(root) {
    var input = root.querySelector('[data-picker-input]');
    var hidden = root.querySelector('[data-picker-value]');
    var list = root.querySelector('[data-picker-results]');
    var hint = root.querySelector('[data-picker-hint]');
    var url = input.getAttribute('data-picker-url');
    var required = input.hasAttribute('data-picker-required');
    var timer = null;
    var items = [];
    var active = -1;
    // What the box said when a real selection was last made, so we can tell "user edited
    // the text and abandoned it" from "user never touched it".
    var chosenLabel = input.value;

    function close() {
      list.classList.add('d-none');
      input.setAttribute('aria-expanded', 'false');
      active = -1;
    }

    function validity() {
      // Text present but no id = an abandoned search. Block submission with a clear reason
      // rather than posting a null customer.
      var bad = required && !hidden.value;
      hint.classList.toggle('d-none', !bad || !input.value);
      input.classList.toggle('is-invalid', bad && !!input.value);
      input.setCustomValidity(bad ? 'Choose a customer from the list.' : '');
    }

    function choose(item) {
      hidden.value = item.id;
      input.value = item.name;
      chosenLabel = item.name;
      close();
      validity();
      root.dispatchEvent(new CustomEvent('customer:selected', { bubbles: true, detail: item }));
    }

    function render() {
      list.innerHTML = '';
      if (!items.length) {
        var li = document.createElement('li');
        li.className = 'cho-picker-empty';
        li.textContent = 'No matches';
        list.appendChild(li);
      } else {
        items.forEach(function (item, i) {
          var li = document.createElement('li');
          li.className = 'cho-picker-item' + (i === active ? ' active' : '');
          li.setAttribute('role', 'option');
          // textContent, not innerHTML — customer names are user data and must never be
          // parsed as markup.
          var name = document.createElement('span');
          name.className = 'cho-picker-name';
          name.textContent = item.name;
          li.appendChild(name);
          if (item.email || item.phone) {
            var meta = document.createElement('span');
            meta.className = 'cho-picker-meta';
            meta.textContent = [item.email, item.phone].filter(Boolean).join(' · ');
            li.appendChild(meta);
          }
          li.addEventListener('mousedown', function (e) { e.preventDefault(); choose(item); });
          list.appendChild(li);
        });
      }
      list.classList.remove('d-none');
      input.setAttribute('aria-expanded', 'true');
    }

    function search() {
      fetch(url + '?q=' + encodeURIComponent(input.value.trim()), {
        headers: { 'Accept': 'application/json' }, credentials: 'same-origin',
      })
        .then(function (r) { return r.ok ? r.json() : []; })
        .then(function (rows) { items = rows || []; active = -1; render(); })
        .catch(function () { close(); });
    }

    input.addEventListener('input', function () {
      // Any edit invalidates the previous selection — otherwise editing the name of a
      // chosen customer would submit the old id under a different-looking label.
      if (input.value !== chosenLabel) hidden.value = '';
      validity();
      clearTimeout(timer);
      timer = setTimeout(search, DEBOUNCE_MS);
    });

    input.addEventListener('focus', function () { if (!input.value) search(); });
    input.addEventListener('blur', function () { setTimeout(function () { close(); validity(); }, 120); });

    input.addEventListener('keydown', function (e) {
      if (list.classList.contains('d-none')) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active += (e.key === 'ArrowDown' ? 1 : -1);
        if (active < 0) active = items.length - 1;
        if (active >= items.length) active = 0;
        render();
      } else if (e.key === 'Enter' && active >= 0) {
        e.preventDefault();
        choose(items[active]);
      } else if (e.key === 'Escape') {
        close();
      }
    });

    validity();
  }

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-picker]').forEach(init);
  });
})();
