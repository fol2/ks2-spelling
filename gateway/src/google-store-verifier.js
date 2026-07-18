import { safeGatewayError } from './store-verifier-port.js';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const API_ORIGIN = 'https://androidpublisher.googleapis.com';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

function isUnavailableStatus(status) {
  return status === 401 || status === 403 || status === 408 || status === 429 ||
    (status >= 300 && status < 400) || status >= 500;
}

function fail(code = 'PROOF_REJECTED') {
  throw safeGatewayError(code);
}

function base64url(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function pemBytes(value) {
  if (typeof value !== 'string') fail('STORE_UNAVAILABLE');
  const pemLabel = 'PRIVATE KEY';
  const encoded = value
    .replace(`-----BEGIN ${pemLabel}-----`, '')
    .replace(`-----END ${pemLabel}-----`, '')
    .replace(/\s/g, '');
  try {
    return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  } catch {
    fail('STORE_UNAVAILABLE');
  }
}

async function signServiceAccountJwt(serviceAccount, clock) {
  const now = Math.floor(clock() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: SCOPE,
    aud: TOKEN_ENDPOINT,
    iat: now,
    exp: now + 3600,
  }));
  const input = `${header}.${claim}`;
  let key;
  try {
    key = await crypto.subtle.importKey(
      'pkcs8', pemBytes(serviceAccount.private_key),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
    );
  } catch {
    fail('STORE_UNAVAILABLE');
  }
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input));
  return `${input}.${base64url(new Uint8Array(signature))}`;
}

function assertServiceAccount(value) {
  if (
    value === null || typeof value !== 'object' || Array.isArray(value) ||
    typeof value.client_email !== 'string' || value.client_email.length === 0 ||
    typeof value.private_key !== 'string' || value.private_key.length === 0 ||
    value.token_uri !== TOKEN_ENDPOINT
  ) fail('STORE_UNAVAILABLE');
  return value;
}

async function safeJson(response, credentialRequest = false) {
  if (!(response instanceof Response) || !response.ok) {
    const status = response?.status;
    fail(credentialRequest || isUnavailableStatus(status)
      ? 'STORE_UNAVAILABLE'
      : 'PROOF_REJECTED');
  }
  try {
    return await response.json();
  } catch {
    fail('STORE_UNAVAILABLE');
  }
}

function validatePurchase(value, productId) {
  if (
    value === null || typeof value !== 'object' ||
    !Array.isArray(value.productLineItem) || value.productLineItem.length !== 1 ||
    value.productLineItem[0]?.productId !== productId ||
    value.testPurchaseContext?.fopType !== 'TEST' ||
    !['PURCHASED', 'PENDING', 'CANCELLED'].includes(value.purchaseStateContext?.purchaseState)
  ) fail(value?.productLineItem?.[0]?.productId !== productId ? 'PRODUCT_MISMATCH' : 'PROOF_REJECTED');
  const state = value.purchaseStateContext.purchaseState;
  if (state !== 'PENDING' && (typeof value.orderId !== 'string' || !/^GPA\.[0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{5}$/.test(value.orderId))) {
    fail('STORE_TRANSACTION_ID_INVALID');
  }
  if (state === 'PENDING' && value.orderId !== undefined && value.orderId !== null) fail();
  return value;
}

export function createGoogleStoreVerifier(options) {
  if (
    options === null || typeof options !== 'object' || options.applicationId !== 'uk.eugnel.ks2spelling' ||
    options.environment !== 'sandbox' || typeof options.fetchImpl !== 'function' || typeof options.clock !== 'function'
  ) fail('STORE_UNAVAILABLE');
  const serviceAccount = assertServiceAccount(options.serviceAccount);
  const jwtSigner = options.jwtSigner ?? (() => signServiceAccountJwt(serviceAccount, options.clock));
  const fetchImpl = (url, init) => Reflect.apply(options.fetchImpl, globalThis, [url, init]);
  let cachedToken = null;

  async function accessToken() {
    const now = Math.floor(options.clock() / 1000);
    if (cachedToken && cachedToken.expiresAt > now + 60) return cachedToken.value;
    let assertion;
    try {
      assertion = await jwtSigner();
    } catch {
      fail('STORE_UNAVAILABLE');
    }
    const response = await fetchImpl(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
      redirect: 'manual',
    }).catch(() => fail('STORE_UNAVAILABLE'));
    const body = await safeJson(response, true);
    if (
      typeof body.access_token !== 'string' || body.access_token.length === 0 ||
      !Number.isSafeInteger(body.expires_in) || body.expires_in < 1 || body.expires_in > 3600
    ) fail('STORE_UNAVAILABLE');
    cachedToken = { value: body.access_token, expiresAt: now + body.expires_in };
    return cachedToken.value;
  }

  async function query(productId, opaqueProof) {
    if (productId !== 'full_ks2' || typeof opaqueProof !== 'string' || opaqueProof.length === 0) fail('PRODUCT_MISMATCH');
    const token = await accessToken();
    const url = `${API_ORIGIN}/androidpublisher/v3/applications/${encodeURIComponent(options.applicationId)}/purchases/productsv2/tokens/${encodeURIComponent(opaqueProof)}`;
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'manual',
    }).catch(() => fail('STORE_UNAVAILABLE'));
    return validatePurchase(await safeJson(response), productId);
  }

  function result(productId, opaqueProof, purchase, extra = {}) {
    const state = purchase.purchaseStateContext.purchaseState.toLowerCase();
    return Object.freeze({
      store: 'google', productId, environment: 'sandbox', applicationId: options.applicationId,
      entitlementId: 'full-ks2',
      state: state === 'purchased' ? 'active' : state === 'cancelled' ? 'revoked' : state,
      storeTransactionId: purchase.orderId ?? null, opaqueProof, ...extra,
    });
  }

  async function verify({ productId, opaqueProof }) {
    return result(productId, opaqueProof, await query(productId, opaqueProof));
  }

  async function complete({ productId, opaqueProof }) {
    const purchase = await query(productId, opaqueProof);
    if (purchase.purchaseStateContext.purchaseState !== 'PURCHASED') fail('PROOF_REJECTED');
    const pending = purchase.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING';
    if (
      !pending && purchase.acknowledgementState !== 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED'
    ) fail();
    if (pending) {
      const token = await accessToken();
      const url = `${API_ORIGIN}/androidpublisher/v3/applications/${encodeURIComponent(options.applicationId)}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(opaqueProof)}:acknowledge`;
      const response = await fetchImpl(url, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: '{}', redirect: 'manual',
      }).catch(() => fail('STORE_UNAVAILABLE'));
      if (!(response instanceof Response) || !response.ok) {
        const status = response?.status;
        fail(isUnavailableStatus(status)
          ? 'STORE_UNAVAILABLE'
          : 'PROOF_REJECTED');
      }
    }
    return result(productId, opaqueProof, purchase, { acknowledged: true });
  }

  return Object.freeze({ verify, refresh: verify, complete });
}
