import { createAppleStoreVerifier } from './apple-store-verifier.js';
import { createGoogleStoreVerifier } from './google-store-verifier.js';
import { createRedactedLogger } from './redacted-logging.js';
import { createPackAccessService } from './pack-access-service.js';
import {
  openRefreshHandle,
  parseRefreshHandleKeyring,
  resealRefreshHandle,
  sealRefreshHandle,
} from './refresh-handle.js';
import {
  applicationAuthority,
  assertExactStoreVerifier,
  assertHandleRequest,
  assertStoreResult,
  assertVerifyRequest,
  GatewayError,
  productAuthority,
  safeGatewayError,
} from './store-verifier-port.js';
import {
  MAX_GATEWAY_BODY_BYTES,
  gatewayJsonByteLength,
} from '../../src/platform/gateway/gateway-payload-limits.js';

const ALLOWED_ORIGINS = new Set(['capacitor://localhost', 'http://localhost']);
const ROUTES = new Map([
  ['/v1/entitlements/verify', 'verify'],
  ['/v1/entitlements/refresh', 'refresh'],
  ['/v1/transactions/complete', 'complete'],
  ['/v1/packs/authorise-download', 'authorise'],
]);
const WORKER_SCRIPT_AUTHORITY_SHA256 = '0'.repeat(64);
const ALLOWED_METHODS = new Set(['GET', 'POST', 'OPTIONS']);
const DOWNLOAD_REQUEST_HEADERS = new Set(['range', 'if-none-match']);

function defaultStoreVerifier(store, env, dependencies) {
  if (store === 'apple') {
    return createAppleStoreVerifier({
      applicationId: applicationAuthority(),
      environment: 'sandbox',
      issuerId: env.APPLE_IAP_ISSUER_ID,
      keyId: env.APPLE_IAP_KEY_ID,
      privateKey: env.APPLE_IAP_PRIVATE_KEY,
    });
  }
  if (store === 'google') {
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON);
    } catch {
      throw safeGatewayError('STORE_UNAVAILABLE');
    }
    return createGoogleStoreVerifier({
      applicationId: applicationAuthority(),
      environment: 'sandbox',
      serviceAccount,
      fetchImpl: dependencies.fetchImpl,
      clock: dependencies.clock,
    });
  }
  throw safeGatewayError('REQUEST_INVALID');
}

function corsHeaders(origin) {
  const headers = new Headers({ Vary: 'Origin', 'Cache-Control': 'no-store' });
  if (ALLOWED_ORIGINS.has(origin)) headers.set('Access-Control-Allow-Origin', origin);
  return headers;
}

function response(origin, status, body = null, extraHeaders = undefined) {
  const headers = corsHeaders(origin);
  if (extraHeaders) for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
  if (body === null) return new Response(null, { status, headers });
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers });
}

function hasOnlyRequestedHeaders(value, allowed) {
  if (value === null || value === '') return true;
  const names = value.split(',').map((name) => name.trim().toLowerCase());
  return names.every((name, index) =>
    name.length > 0 && allowed.has(name) && names.indexOf(name) === index);
}

function parseServerKeyring(env) {
  try {
    return parseRefreshHandleKeyring({
      current: env.ENTITLEMENT_HANDLE_KEY_CURRENT,
      previous: env.ENTITLEMENT_HANDLE_KEY_PREVIOUS,
    });
  } catch {
    throw safeGatewayError('GATEWAY_UNAVAILABLE');
  }
}

function hasUnapprovedRequestHeader(headers, routeHeaders = undefined) {
  for (const [rawName, value] of headers) {
    const name = rawName.toLowerCase();
    // Cloudflare overwrites the visitor protocol and appends its forwarding chain
    // before the request reaches the Worker. Neither value is entitlement authority.
    if (name === 'x-forwarded-proto') {
      if (value !== 'https') return true;
      continue;
    }
    if (name === 'x-forwarded-for') continue;
    if (
      ['origin', 'content-type', 'accept', 'accept-language', 'content-language',
        'content-length', 'accept-encoding', 'host', 'user-agent', 'connection', 'cdn-loop']
        .includes(name) || routeHeaders?.has(name) || name.startsWith('cf-') || name.startsWith('sec-')
    ) continue;
    return true;
  }
  return false;
}

async function enforceRateLimit(env) {
  if (typeof env?.GATEWAY_RATE_LIMIT?.limit !== 'function') throw safeGatewayError();
  let result;
  try {
    result = await env.GATEWAY_RATE_LIMIT.limit({ key: 'global' });
  } catch {
    throw safeGatewayError();
  }
  if (result?.success !== true) throw safeGatewayError('RATE_LIMITED');
}

async function readJson(request) {
  const contentType = request.headers.get('content-type');
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType ?? '')) {
    throw safeGatewayError('REQUEST_INVALID');
  }
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    if (
      !/^(?:0|[1-9][0-9]*)$/.test(contentLength) ||
      Number(contentLength) > MAX_GATEWAY_BODY_BYTES
    ) {
      throw safeGatewayError('REQUEST_INVALID');
    }
  }
  const reader = request.body?.getReader();
  if (!reader) throw safeGatewayError('REQUEST_INVALID');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw safeGatewayError('REQUEST_INVALID');
      size += value.byteLength;
      if (size > MAX_GATEWAY_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw safeGatewayError('REQUEST_INVALID');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw safeGatewayError('REQUEST_INVALID');
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw safeGatewayError('REQUEST_INVALID');
  }
}

function contextFor(store) {
  return Object.freeze({
    store,
    productId: productAuthority(store).productId,
    environment: 'sandbox',
    applicationId: applicationAuthority(),
  });
}

async function openOpaqueHandle(handle, keyring) {
  for (const store of ['apple', 'google']) {
    const context = contextFor(store);
    try {
      return Object.freeze({ context, payload: await openRefreshHandle(handle, context, { keyring }) });
    } catch (error) {
      if (!(error instanceof GatewayError) || error.code !== 'HANDLE_INVALID') throw error;
    }
  }
  throw safeGatewayError('HANDLE_INVALID');
}

function safeIdentity(result, sealedRefreshHandle, refreshHandleVersion, env, dependencies) {
  const workerVersionId = env?.WORKER_VERSION_METADATA?.id;
  if (typeof workerVersionId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(workerVersionId)) {
    throw safeGatewayError();
  }
  const identity = Object.freeze({
    store: result.store,
    productId: result.productId,
    environment: result.environment,
    applicationId: result.applicationId,
    entitlementId: result.entitlementId,
    state: result.state,
    storeTransactionId: result.storeTransactionId,
    sealedRefreshHandle,
    refreshHandleVersion,
    traceId: dependencies.randomUUID(),
    workerVersionId,
    workerScriptAuthoritySha256: WORKER_SCRIPT_AUTHORITY_SHA256,
  });
  if (gatewayJsonByteLength(identity) > MAX_GATEWAY_BODY_BYTES) throw safeGatewayError();
  return identity;
}

export function createGatewayHandler(injected = {}) {
  const dependencies = Object.freeze({
    fetchImpl: injected.fetchImpl ?? fetch,
    clock: injected.clock ?? Date.now,
    randomUUID: injected.randomUUID ?? (() => crypto.randomUUID()),
    randomBytes: injected.randomBytes ?? ((length) => crypto.getRandomValues(new Uint8Array(length))),
    logger: injected.logger ?? createRedactedLogger(),
    createStoreVerifier: injected.createStoreVerifier,
  });
  const packAccess = createPackAccessService({ clock: dependencies.clock });

  async function verifier(store, env) {
    const candidate = dependencies.createStoreVerifier
      ? await dependencies.createStoreVerifier(store, env)
      : defaultStoreVerifier(store, env, dependencies);
    return assertExactStoreVerifier(candidate);
  }

  async function operate(operation, requestBody, env) {
    const keyring = parseServerKeyring(env);
    if (operation === 'verify') {
      const submitted = assertVerifyRequest(requestBody);
      const result = assertStoreResult(
        await (await verifier(submitted.store, env)).verify(submitted),
        submitted,
      );
      if (result.state === 'pending' || result.state === 'cancelled') {
        throw safeGatewayError('REQUEST_INVALID');
      }
      const payload = {
        store: result.store,
        productId: result.productId,
        environment: result.environment,
        applicationId: result.applicationId,
        storeTransactionId: result.storeTransactionId,
        opaqueProof: result.opaqueProof,
        issuedAt: Math.floor(dependencies.clock() / 1000),
      };
      const sealed = await sealRefreshHandle(payload, {
        keyring,
        randomBytes: dependencies.randomBytes,
      });
      assertHandleRequest({ sealedRefreshHandle: sealed });
      return safeIdentity(result, sealed, keyring.current.version, env, dependencies);
    }

    const { sealedRefreshHandle } = assertHandleRequest(requestBody);
    const opened = await openOpaqueHandle(sealedRefreshHandle, keyring);
    const storeVerifier = await verifier(opened.context.store, env);
    const result = assertStoreResult(
      await storeVerifier[operation]({
        productId: opened.payload.productId,
        opaqueProof: opened.payload.opaqueProof,
      }),
      opened.context,
    );
    if (result.state === 'pending' || result.state === 'cancelled') {
      throw safeGatewayError('STORE_UNAVAILABLE');
    }
    if (result.storeTransactionId !== opened.payload.storeTransactionId) {
      throw safeGatewayError('STORE_TRANSACTION_ID_INVALID');
    }
    const resealed = await resealRefreshHandle(sealedRefreshHandle, opened.context, {
      keyring,
      randomBytes: dependencies.randomBytes,
    });
    return safeIdentity(
      result,
      resealed.sealedRefreshHandle,
      resealed.refreshHandleVersion,
      env,
      dependencies,
    );
  }

  return Object.freeze({
    async fetch(request, env) {
      const origin = request.headers.get('origin') ?? '';
      const url = new URL(request.url);
      const isDownloadPath = packAccess.matchesDownloadPath(url.pathname);
      const isDownloadNamespace = packAccess.matchesDownloadNamespace(url.pathname);
      const downloadCache = isDownloadNamespace ? { 'Cache-Control': 'private, no-store' } : undefined;
      const reply = (status, body = null, extraHeaders = undefined) => response(
        origin,
        status,
        body,
        { ...downloadCache, ...extraHeaders },
      );
      if (!ALLOWED_ORIGINS.has(origin)) return reply(403, { code: 'REQUEST_INVALID', retryable: false });
      if (!ALLOWED_METHODS.has(request.method)) return reply(403, { code: 'REQUEST_INVALID', retryable: false });

      if (request.method === 'OPTIONS') {
        const requestedMethod = request.headers.get('access-control-request-method');
        const requestedHeaders = request.headers.get('access-control-request-headers');
        const allowedHeaders = isDownloadPath
          ? new Set(['range', 'if-none-match'])
          : new Set(['content-type']);
        const validTarget = isDownloadPath
          ? packAccess.matchesDownloadRequest(url) && requestedMethod === 'GET'
          : url.search === '' && ROUTES.has(url.pathname) && ALLOWED_METHODS.has(requestedMethod);
        if (
          url.username !== '' || url.password !== '' || url.hash !== '' || !validTarget ||
          !hasOnlyRequestedHeaders(requestedHeaders, allowedHeaders)
        ) return reply(403, { code: 'REQUEST_INVALID', retryable: false });
        return reply(204, null, {
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': isDownloadPath ? 'Range, If-None-Match' : 'Content-Type',
        });
      }

      try {
        if (request.method === 'POST' || request.method === 'GET') await enforceRateLimit(env);
        const isDownload = packAccess.matchesDownloadPath(url.pathname) && request.method === 'GET';
        const isCanonicalDownload = request.method === 'GET' && packAccess.matchesDownloadRequest(url);
        if ((!isDownload && url.search !== '') || url.username !== '' || url.password !== '' || url.hash !== '') {
          return reply(403, { code: 'REQUEST_INVALID', retryable: false });
        }
        if (hasUnapprovedRequestHeader(
          request.headers,
          isCanonicalDownload ? DOWNLOAD_REQUEST_HEADERS : undefined,
        )) {
          return reply(403, { code: 'REQUEST_INVALID', retryable: false });
        }
        if (isDownload) {
          const streamed = await packAccess.download({ request, url, env, origin });
          dependencies.logger.info('gateway_request', {
            operation: 'download',
            status: streamed.status,
            retryable: false,
          });
          return new Response(streamed.body, { status: streamed.status, headers: streamed.headers });
        }
        const operation = ROUTES.get(url.pathname);
        if (!operation) return reply(404, { code: 'REQUEST_INVALID', retryable: false });
        if (request.method !== 'POST') return reply(405, { code: 'REQUEST_INVALID', retryable: false });
        const body = await readJson(request);
        let result;
        if (operation === 'authorise') {
          const input = packAccess.assertAuthoriseRequest(body);
          packAccess.assertBindings(env);
          const identity = await operate('refresh', { sealedRefreshHandle: input.sealedRefreshHandle }, env);
          result = await packAccess.authorise({ request: input, identity, env });
        } else {
          result = await operate(operation, body, env);
        }
        dependencies.logger.info('gateway_request', {
          operation,
          status: 200,
          store: result.store,
          retryable: false,
        });
        return reply(200, result);
      } catch (error) {
        const safe = error instanceof GatewayError ? error : safeGatewayError();
        dependencies.logger.error('gateway_error', {
          operation: ROUTES.get(url.pathname),
          status: safe.status,
          retryable: safe.retryable,
        });
        return reply(safe.status, { code: safe.code, retryable: safe.retryable });
      }
    },
  });
}

const worker = createGatewayHandler();
export default worker;
