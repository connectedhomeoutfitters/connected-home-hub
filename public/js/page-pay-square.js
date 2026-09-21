// Square Web Payments SDK flow — the Square counterpart of page-pay.js.
//
// The card field is an iframe Square hosts, so card numbers never touch our page or our
// server. On submit we ask the SDK for a one-time token and POST it to /i/:token/pay,
// which charges it via Square's CreatePayment and answers with where to go next.
(async function () {
  var cfg = window.CHO_HUB;
  var messageEl = document.getElementById('payment-message');
  var button = document.getElementById('pay-button');

  function fail(msg) {
    messageEl.textContent = msg;
    button.disabled = false;
    button.textContent = button.getAttribute('data-label') || button.textContent;
  }

  if (!window.Square) {
    // The SDK script didn't load — almost always a CSP block (see server.js). Say so
    // rather than leaving a blank space where the card field should be.
    fail('The payment form could not be loaded. Please refresh, or contact us to arrange payment.');
    return;
  }

  var card;
  try {
    var payments = window.Square.payments(cfg.applicationId, cfg.locationId);
    card = await payments.card();
    await card.attach('#card-container');
  } catch (err) {
    fail('The payment form could not be loaded: ' + (err && err.message ? err.message : err));
    return;
  }
  button.setAttribute('data-label', button.textContent);
  button.disabled = false;

  button.addEventListener('click', async function () {
    messageEl.textContent = '';
    button.disabled = true;
    button.textContent = 'Processing…';

    var result;
    try {
      result = await card.tokenize();
    } catch (err) {
      return fail('Could not read the card details. Please check them and try again.');
    }
    if (result.status !== 'OK') {
      var detail = result.errors && result.errors[0] && result.errors[0].message;
      return fail(detail || 'Please check the card details and try again.');
    }

    var res, body;
    try {
      res = await fetch(cfg.basePath + '/i/' + cfg.token + '/pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: result.token }),
      });
      body = await res.json();
    } catch (err) {
      return fail('The payment could not be sent. Please check your connection and try again.');
    }

    if (body.error) return fail(body.error);
    if (body.status === 'completed') {
      window.location.href = body.nextStepsUrl;
      return;
    }
    // Rare: Square approved but hasn't completed yet. The webhook will finish it.
    messageEl.className = 'text-muted mt-2';
    messageEl.textContent = 'Your payment is being processed. You will receive a receipt by email once it completes.';
  });
})();
