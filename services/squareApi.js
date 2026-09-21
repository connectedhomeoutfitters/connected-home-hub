'use strict';
// Thin client for the handful of Square REST endpoints ConnectedWorkOS uses. Deliberately
// not the `square` npm SDK: the surface we need is eight calls, the SDK's money types are
// BigInt (a footgun next to our DECIMAL columns), and a new native-free dependency still
// has to be installed on the NAS before PM2's watch mode restarts into it (see CLAUDE.md).
// Plain fetch keeps every request visible in one file.
//
// Two environments, chosen by SQUARE_ENV, with entirely separate hosts, credentials and
// test sellers. Nothing in sandbox can touch a real card.
//
// Tokens: every call after OAuth is made with the TENANT's access token (Bearer), obtained
// in routes/admin/squareConnect.js and kept sealed in orgs.square_access_token. Our own
// application secret is used only to obtain, refresh and revoke those tokens
// (Authorization: Client <secret>).

const ENVS = {
  production: {
    api: 'https://connect.squareup.com',
    authorize: 'https://connect.squareup.com/oauth2/authorize',
    sdk: 'https://web.squarecdn.com/v1/square.js',
  },
  sandbox: {
    api: 'https://connect.squareupsandbox.com',
    authorize: 'https://connect.squareupsandbox.com/oauth2/authorize',
    sdk: 'https://sandbox.web.squarecdn.com/v1/square.js',
  },
};

// Permissions requested at OAuth. PAYMENTS_WRITE covers refunds; MERCHANT_PROFILE_READ is
// for the business name and locations. Nothing that reads their customers, inventory or
// bank details.
const SCOPES = ['MERCHANT_PROFILE_READ', 'PAYMENTS_READ', 'PAYMENTS_WRITE'];

function env() {
  const name = (process.env.SQUARE_ENV || 'sandbox').trim().toLowerCase();
  return name === 'production' ? 'production' : 'sandbox';
}

function config() {
  const name = env();
  const applicationId = (process.env.SQUARE_APPLICATION_ID || '').trim();
  const secret = (process.env.SQUARE_APPLICATION_SECRET || '').trim();
  return {
    env: name,
    applicationId,
    secret,
    configured: !!(applicationId && secret),
    ...ENVS[name],
  };
}

class SquareError extends Error {
  constructor(message, { status, errors, path } = {}) {
    super(message);
    this.name = 'SquareError';
    this.status = status;
    this.errors = errors || [];
    this.path = path;
  }
}

async function request(method, path, { token, clientAuth, body } = {}) {
  const cfg = config();
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  else if (clientAuth) headers.Authorization = `Client ${cfg.secret}`;
  // Pin the API version when asked to; otherwise the application's default version from
  // the Developer Console applies.
  const version = (process.env.SQUARE_API_VERSION || '').trim();
  if (version) headers['Square-Version'] = version;

  const res = await fetch(`${cfg.api}${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = {};
  try { json = await res.json(); } catch { /* empty or non-JSON body */ }
  if (!res.ok) {
    const errors = json.errors || [];
    const first = errors[0];
    const msg = first
      ? `${first.category}/${first.code}${first.detail ? `: ${first.detail}` : ''}`
      : (json.message || json.error_description || `HTTP ${res.status}`);
    throw new SquareError(msg, { status: res.status, errors, path });
  }
  return json;
}

// --- OAuth --------------------------------------------------------------------------

function authorizeUrl({ state }) {
  const cfg = config();
  const params = new URLSearchParams({
    client_id: cfg.applicationId,
    scope: SCOPES.join(' '),
    state,
  });
  // `session=false` makes Square show a login page even if a seller is already signed in,
  // so a shared browser can't silently authorise the wrong account. In the sandbox there
  // is no login page — the test seller's dashboard must already be open — so it's omitted.
  if (cfg.env === 'production') params.set('session', 'false');
  return `${cfg.authorize}?${params.toString()}`;
}

async function obtainToken(code) {
  const cfg = config();
  return request('POST', '/oauth2/token', {
    body: { client_id: cfg.applicationId, client_secret: cfg.secret, code, grant_type: 'authorization_code' },
  });
}

async function refreshToken(refresh) {
  const cfg = config();
  return request('POST', '/oauth2/token', {
    body: { client_id: cfg.applicationId, client_secret: cfg.secret, refresh_token: refresh, grant_type: 'refresh_token' },
  });
}

async function revokeMerchant(merchantId) {
  const cfg = config();
  return request('POST', '/oauth2/revoke', {
    clientAuth: true,
    body: { client_id: cfg.applicationId, merchant_id: merchantId },
  });
}

// --- Merchant / locations -----------------------------------------------------------

async function getMerchant(token, merchantId) {
  const { merchant } = await request('GET', `/v2/merchants/${encodeURIComponent(merchantId)}`, { token });
  return merchant;
}

async function listLocations(token) {
  const { locations } = await request('GET', '/v2/locations', { token });
  return (locations || []).filter((l) => l.status === 'ACTIVE');
}

// --- Payments / refunds ---------------------------------------------------------------

// Square money is an integer in the currency's smallest unit — cents for USD.
function money(amount, currency = 'USD') {
  return { amount: Math.round(Number(amount) * 100), currency };
}

async function createPayment(token, body) {
  const { payment } = await request('POST', '/v2/payments', { token, body });
  return payment;
}

async function getPayment(token, paymentId) {
  const { payment } = await request('GET', `/v2/payments/${encodeURIComponent(paymentId)}`, { token });
  return payment;
}

async function refundPayment(token, body) {
  const { refund } = await request('POST', '/v2/refunds', { token, body });
  return refund;
}

async function getRefund(token, refundId) {
  const { refund } = await request('GET', `/v2/refunds/${encodeURIComponent(refundId)}`, { token });
  return refund;
}

module.exports = {
  config, env, SCOPES, SquareError, authorizeUrl,
  obtainToken, refreshToken, revokeMerchant,
  getMerchant, listLocations,
  money, createPayment, getPayment, refundPayment, getRefund,
};
