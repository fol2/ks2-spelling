import { assertB3GatewayAuthority } from '../../domain/commerce/commerce-contracts.js';
import {
  assertClosedRecord,
  assertExactPort,
  assertPromise,
  assertSafeInteger,
  fail,
} from '../commerce/store-port.js';
import {
  ENTITLEMENT_GATEWAY_METHODS,
  validateAuthoriseRequest,
  validateAuthoriseResponse,
  validateHandleRequest,
  validateIdentityResponse,
  validateVerifyRequest,
} from './entitlement-gateway-port.js';

const MAX_BODY_BYTES = 65_536;
const SAFE_ERROR_CODES = new Set([
  'PROOF_REJECTED',
  'PRODUCT_MISMATCH',
  'STORE_TRANSACTION_ID_INVALID',
  'HANDLE_INVALID',
  'ENTITLEMENT_REVOKED',
  'PACK_NOT_FOUND',
  'REQUEST_INVALID',
  'RATE_LIMITED',
  'STORE_UNAVAILABLE',
  'GATEWAY_UNAVAILABLE',
]);
const ROUTES = Object.freeze({
  verifyTransaction: '/v1/entitlements/verify',
  completeTransaction: '/v1/transactions/complete',
  refreshEntitlement: '/v1/entitlements/refresh',
  authorisePackDownload: '/v1/packs/authorise-download',
});

export class EntitlementGatewayError extends Error {
  constructor(code, status, retryable) {
    super('The entitlement gateway request failed.');
    Object.defineProperties(this, {
      code: { value: code, enumerable: true },
      status: { value: status, enumerable: true },
      retryable: { value: retryable, enumerable: true },
    });
  }
}

function gatewayError(code, status = null, retryable = false) {
  return new EntitlementGatewayError(code, status, retryable);
}

function isTransientStatus(status) {
  return status === 429 || (Number.isInteger(status) && status >= 500);
}

function invalidResponse(status = null) {
  return gatewayError('GATEWAY_RESPONSE_INVALID', status, isTransientStatus(status));
}

function validateOptions(options) {
  const keys = Reflect.ownKeys(options ?? {});
  const expected = options && Object.hasOwn(options, 'timeoutMs')
    ? ['authority', 'fetchImpl', 'timeoutMs']
    : ['authority', 'fetchImpl'];
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    fail('HTTP entitlement gateway options', 'must contain exactly the approved fields');
  }
  assertClosedRecord(options, expected, 'HTTP entitlement gateway options');
  assertB3GatewayAuthority(options.authority);
  if (typeof options.fetchImpl !== 'function') fail('Gateway fetch implementation');
  const timeoutMs = options.timeoutMs ?? 10_000;
  assertSafeInteger(timeoutMs, 'Gateway timeout', { min: 1, max: 10_000 });
  return { fetchImpl: options.fetchImpl, timeoutMs };
}

function parseContentLength(response) {
  const raw = response.headers?.get?.('content-length');
  if (raw === null || raw === undefined) return null;
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) throw invalidResponse(response.status);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > MAX_BODY_BYTES) {
    throw invalidResponse(response.status);
  }
  return value;
}

async function readJson(response, signal) {
  const contentType = response.headers?.get?.('content-type');
  if (
    typeof contentType !== 'string' ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)
  ) {
    throw invalidResponse(response.status);
  }
  const declaredLength = parseContentLength(response);
  let bytes;
  const reader = response.body?.getReader?.();
  if (reader) {
    const cancelReader = () => {
      void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener('abort', cancelReader, { once: true });
    const chunks = [];
    let byteLength = 0;
    try {
      while (true) {
        const readPromise = reader.read();
        assertPromise(readPromise, 'Gateway response body reader');
        const result = await readPromise;
        if (result.done) break;
        if (!(result.value instanceof Uint8Array)) throw invalidResponse(response.status);
        byteLength += result.value.byteLength;
        if (byteLength > MAX_BODY_BYTES) {
          const cancelPromise = reader.cancel();
          assertPromise(cancelPromise, 'Gateway response body cancellation');
          await cancelPromise.catch(() => undefined);
          throw invalidResponse(response.status);
        }
        chunks.push(result.value);
      }
    } catch (error) {
      if (error instanceof EntitlementGatewayError) throw error;
      throw gatewayError('GATEWAY_OFFLINE', null, true);
    } finally {
      signal.removeEventListener('abort', cancelReader);
    }
    bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } else {
    if (declaredLength === null) throw invalidResponse(response.status);
    let textPromise;
    try {
      textPromise = response.text();
    } catch {
      throw invalidResponse(response.status);
    }
    assertPromise(textPromise, 'Gateway response text');
    let text;
    try {
      text = await textPromise;
    } catch {
      throw gatewayError('GATEWAY_OFFLINE', null, true);
    }
    bytes = new TextEncoder().encode(text);
  }
  const byteLength = bytes.byteLength;
  if (byteLength > MAX_BODY_BYTES || (declaredLength !== null && declaredLength !== byteLength)) {
    throw invalidResponse(response.status);
  }
  let body;
  try {
    body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw invalidResponse(response.status);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw invalidResponse(response.status);
  }
}

function validateErrorResponse(body, status) {
  try {
    assertClosedRecord(body, ['code', 'retryable'], 'Gateway error response');
  } catch {
    throw invalidResponse(status);
  }
  const permanent = new Set([
    'PROOF_REJECTED',
    'PRODUCT_MISMATCH',
    'STORE_TRANSACTION_ID_INVALID',
    'HANDLE_INVALID',
    'ENTITLEMENT_REVOKED',
    'PACK_NOT_FOUND',
    'REQUEST_INVALID',
  ]);
  const transientStatusMatches =
    (body.code === 'RATE_LIMITED' && status === 429) ||
    ((body.code === 'STORE_UNAVAILABLE' || body.code === 'GATEWAY_UNAVAILABLE') &&
      status >= 500);
  const transientCode =
    body.code === 'RATE_LIMITED' ||
    body.code === 'STORE_UNAVAILABLE' ||
    body.code === 'GATEWAY_UNAVAILABLE';
  if (
    !SAFE_ERROR_CODES.has(body.code) ||
    typeof body.retryable !== 'boolean' ||
    (permanent.has(body.code) && body.retryable) ||
    (transientCode && (!body.retryable || !transientStatusMatches)) ||
    (isTransientStatus(status) && (!body.retryable || !transientCode)) ||
    (!isTransientStatus(status) && body.retryable)
  ) {
    throw invalidResponse(status);
  }
  throw gatewayError(body.code, status, body.retryable);
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs, consume) {
  const controller = new AbortController();
  let timedOut = false;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(gatewayError('GATEWAY_TIMEOUT', null, true));
    }, timeoutMs);
  });
  try {
    const operation = (async () => {
      let fetchPromise;
      try {
        fetchPromise = fetchImpl(url, { ...options, signal: controller.signal });
      } catch {
        throw gatewayError('GATEWAY_OFFLINE', null, true);
      }
      assertPromise(fetchPromise, 'Gateway fetch implementation');
      const response = await fetchPromise;
      return consume(response, controller.signal);
    })();
    return await Promise.race([operation, timeout]);
  } catch (error) {
    if (error instanceof EntitlementGatewayError) throw error;
    if (timedOut || error?.name === 'AbortError') {
      throw gatewayError('GATEWAY_TIMEOUT', null, true);
    }
    throw gatewayError('GATEWAY_OFFLINE', null, true);
  } finally {
    clearTimeout(timer);
  }
}

export function createHttpEntitlementGateway(options) {
  const { fetchImpl, timeoutMs } = validateOptions(options);
  const origin = options.authority.publicSandboxOrigin;

  async function post(route, body, validateResponse) {
    return fetchWithTimeout(
      fetchImpl,
      `${origin}${route}`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        referrer: '',
        referrerPolicy: 'no-referrer',
      },
      timeoutMs,
      async (response, signal) => {
        if (!response || typeof response.status !== 'number') throw invalidResponse();
        if (response.status >= 300 && response.status < 400) {
          throw gatewayError('GATEWAY_REDIRECT_REJECTED', response.status, false);
        }
        if (response.status === 204 || response.status < 200 || response.status >= 300) {
          const bodyValue = await readJson(response, signal);
          validateErrorResponse(bodyValue, response.status);
        }
        if (response.status !== 200) throw invalidResponse(response.status);
        const value = await readJson(response, signal);
        try {
          return validateResponse(value);
        } catch (error) {
          if (error instanceof EntitlementGatewayError) throw error;
          throw invalidResponse(response.status);
        }
      },
    );
  }

  const gateway = {
    async verifyTransaction(request) {
      const input = validateVerifyRequest(request);
      return post(
        ROUTES.verifyTransaction,
        input,
        (value) => validateIdentityResponse(value, input),
      );
    },

    async completeTransaction(request) {
      const input = validateHandleRequest(request, 'Transaction completion request');
      return post(
        ROUTES.completeTransaction,
        input,
        (value) => validateIdentityResponse(value),
      );
    },

    async refreshEntitlement(request) {
      const input = validateHandleRequest(request, 'Entitlement refresh request');
      return post(
        ROUTES.refreshEntitlement,
        input,
        (value) => validateIdentityResponse(value),
      );
    },

    async authorisePackDownload(request) {
      const input = validateAuthoriseRequest(request);
      return post(
        ROUTES.authorisePackDownload,
        input,
        (value) => validateAuthoriseResponse(value, input),
      );
    },
  };
  assertExactPort(gateway, ENTITLEMENT_GATEWAY_METHODS, 'EntitlementGatewayPort');
  return Object.freeze(gateway);
}
