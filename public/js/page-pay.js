// Minimal Stripe Payment Element flow. Fetches a PaymentIntent client secret from the
// server for this invoice's token, mounts the Payment Element, confirms on submit.
(async function () {
  const { publishableKey, stripeAccount, token, basePath, nextStepsUrl } = window.CHO_HUB;
  // With Connect, the PaymentIntent lives on the contractor's connected account, so
  // Stripe.js needs the account id alongside the platform publishable key — without it
  // the client can't retrieve the intent and the Payment Element never mounts. Empty
  // string means the platform org, which takes no option at all.
  const stripe = stripeAccount ? Stripe(publishableKey, { stripeAccount }) : Stripe(publishableKey);

  const res = await fetch(`${basePath}/i/${token}/pay`, { method: 'POST' });
  const { clientSecret, error } = await res.json();
  if (error) {
    document.getElementById('payment-message').textContent = error;
    return;
  }

  const elements = stripe.elements({ clientSecret });
  const paymentElement = elements.create('payment');
  paymentElement.mount('#payment-element');

  document.getElementById('pay-button').addEventListener('click', async () => {
    const { error: confirmError } = await stripe.confirmPayment({
      elements,
      // Stripe requires an absolute URL here — nextStepsUrl from window.CHO_HUB is a
      // server-relative path (basePath + /i/:token/next-steps).
      confirmParams: { return_url: new URL(nextStepsUrl, window.location.origin).href },
    });
    if (confirmError) {
      document.getElementById('payment-message').textContent = confirmError.message;
    }
  });
})();
