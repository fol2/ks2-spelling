import assert from 'node:assert/strict';
import test from 'node:test';

const ORIGIN = 'capacitor://localhost';
const CURRENT = `v2:${Buffer.alloc(32, 2).toString('base64url')}`;
const PREVIOUS = `v1:${Buffer.alloc(32, 1).toString('base64url')}`;

function env(overrides = {}) {
  return {
    GATEWAY_RATE_LIMIT: { limit: async () => ({ success: true }) },
    ENTITLEMENT_HANDLE_KEY_CURRENT: CURRENT,
    ENTITLEMENT_HANDLE_KEY_PREVIOUS: PREVIOUS,
    WORKER_VERSION_METADATA: { id: 'worker-version-test' },
    ...overrides,
  };
}

function request(path, body, headers = {}) {
  return new Request(`https://b3-gateway.eugnel.uk${path}`, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function dependencies(counters = {}) {
  const result = {
    store: 'google', productId: 'full_ks2', environment: 'sandbox',
    applicationId: 'uk.eugnel.ks2spelling', entitlementId: 'full-ks2', state: 'active',
    storeTransactionId: 'GPA.1234-5678-9012-34567', opaqueProof: 'opaque-token',
  };
  return {
    randomUUID: () => '05c095a1-f5de-4e39-a38f-f466de9a256a',
    clock: () => 1_782_865_800_000,
    randomBytes: () => new Uint8Array(12).fill(4),
    createStoreVerifier: () => ({
      verify: async () => { counters.upstream = (counters.upstream ?? 0) + 1; return result; },
      refresh: async () => { counters.upstream = (counters.upstream ?? 0) + 1; return result; },
      complete: async () => { counters.upstream = (counters.upstream ?? 0) + 1; return { ...result, acknowledged: true }; },
    }),
  };
}

test('gateway exposes exact receipt-once and handle-only POST routes with safe metadata', async () => {
  const { createGatewayHandler } = await import('../gateway/src/handler.js');
  const handler = createGatewayHandler(dependencies());
  const verified = await handler.fetch(request('/v1/entitlements/verify', {
    store: 'google', environment: 'sandbox', productId: 'full_ks2', opaqueProof: 'opaque-token',
  }), env());
  assert.equal(verified.status, 200);
  assert.equal(verified.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(verified.headers.get('vary'), 'Origin');
  const body = await verified.json();
  assert.deepEqual(Object.keys(body).sort(), [
    'applicationId', 'entitlementId', 'environment', 'productId', 'refreshHandleVersion',
    'sealedRefreshHandle', 'state', 'store', 'storeTransactionId', 'traceId',
    'workerScriptAuthoritySha256', 'workerVersionId',
  ].sort());
  assert.match(body.sealedRefreshHandle, /^b3rh1\.2\./);
  assert.equal(body.workerVersionId, 'worker-version-test');
  assert.match(body.workerScriptAuthoritySha256, /^[0-9a-f]{64}$/);

  for (const path of ['/v1/entitlements/refresh', '/v1/transactions/complete']) {
    const response = await handler.fetch(request(path, { sealedRefreshHandle: body.sealedRefreshHandle }), env());
    assert.equal(response.status, 200);
  }
  const unknown = await handler.fetch(request('/v1/admin', {}), env());
  assert.equal(unknown.status, 404);
});

test('rate limit runs before body read, cryptography and upstream; missing binding fails closed', async () => {
  const { createGatewayHandler } = await import('../gateway/src/handler.js');
  const counters = { upstream: 0 };
  const handler = createGatewayHandler(dependencies(counters));
  let bodyReads = 0;
  const limitedRequest = {
    method: 'POST',
    url: 'https://b3-gateway.eugnel.uk/v1/entitlements/verify',
    headers: new Headers({ Origin: ORIGIN, 'Content-Type': 'application/json' }),
    get body() { bodyReads += 1; throw new Error('body must remain unread'); },
  };
  const limited = await handler.fetch(limitedRequest, env({
    GATEWAY_RATE_LIMIT: { limit: async () => ({ success: false }) },
  }));
  assert.equal(limited.status, 429);
  assert.equal(bodyReads, 0);
  assert.equal(counters.upstream, 0);

  const missing = await handler.fetch(request('/v1/entitlements/verify', '{}'), env({ GATEWAY_RATE_LIMIT: undefined }));
  assert.equal(missing.status, 503);
  assert.equal(counters.upstream, 0);
});

test('server keyring configuration is retryable while a client handle remains permanently invalid', async () => {
  const { createGatewayHandler } = await import('../gateway/src/handler.js');
  const counters = { upstream: 0 };
  const handler = createGatewayHandler(dependencies(counters));
  for (const keyringOverride of [
    { ENTITLEMENT_HANDLE_KEY_CURRENT: undefined },
    { ENTITLEMENT_HANDLE_KEY_CURRENT: 'not-a-key-record' },
    { ENTITLEMENT_HANDLE_KEY_PREVIOUS: CURRENT },
  ]) {
    const result = await handler.fetch(request('/v1/entitlements/verify', {
      store: 'google', environment: 'sandbox', productId: 'full_ks2', opaqueProof: 'opaque-token',
    }), env(keyringOverride));
    assert.equal(result.status, 503);
    assert.deepEqual(await result.json(), { code: 'GATEWAY_UNAVAILABLE', retryable: true });
  }
  assert.equal(counters.upstream, 0);

  const clientFailure = await handler.fetch(request('/v1/entitlements/refresh', {
    sealedRefreshHandle: 'b3rh1.2.invalid.client-handle',
  }), env());
  assert.equal(clientFailure.status, 400);
  assert.deepEqual(await clientFailure.json(), { code: 'HANDLE_INVALID', retryable: false });
  assert.equal(counters.upstream, 0);
});

test('gateway enforces exact CORS preflight and request boundary', async () => {
  const { createGatewayHandler } = await import('../gateway/src/handler.js');
  const handler = createGatewayHandler(dependencies());
  const preflight = await handler.fetch(new Request('https://b3-gateway.eugnel.uk/v1/entitlements/verify', {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'Content-Type',
    },
  }), env());
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost');
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'Content-Type');
  assert.equal(preflight.headers.has('access-control-allow-credentials'), false);

  const getPreflight = await handler.fetch(new Request('https://b3-gateway.eugnel.uk/v1/entitlements/verify', {
    method: 'OPTIONS',
    headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET' },
  }), env());
  assert.equal(getPreflight.status, 204);

  for (const bad of [
    new Request('https://b3-gateway.eugnel.uk/v1/entitlements/verify', { method: 'OPTIONS', headers: { Origin: 'https://evil.test', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type' } }),
    new Request('https://b3-gateway.eugnel.uk/v1/entitlements/verify', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'Content-Type' } }),
    new Request('https://b3-gateway.eugnel.uk/v1/entitlements/verify', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Authorization' } }),
  ]) {
    assert.equal((await handler.fetch(bad, env())).status, 403);
  }

  const deleted = await handler.fetch(new Request('https://b3-gateway.eugnel.uk/v1/entitlements/verify', {
    method: 'DELETE', headers: { Origin: ORIGIN },
  }), env());
  assert.equal(deleted.status, 403);

  const counters = { upstream: 0 };
  const closedHandler = createGatewayHandler(dependencies(counters));
  const customHeader = await closedHandler.fetch(request('/v1/entitlements/verify', {
    store: 'google', environment: 'sandbox', productId: 'full_ks2', opaqueProof: 'opaque-token',
  }, { 'X-Bad': 'client-authority' }), env());
  assert.equal(customHeader.status, 403);
  assert.equal(counters.upstream, 0);

  const edgeCounters = { upstream: 0 };
  const edgeDependencies = dependencies(edgeCounters);
  edgeDependencies.randomBytes = () => new Uint8Array(12).fill(12);
  const edgeHandler = createGatewayHandler(edgeDependencies);
  const edgeRequest = await edgeHandler.fetch(request('/v1/entitlements/verify', {
    store: 'google', environment: 'sandbox', productId: 'full_ks2', opaqueProof: 'opaque-token',
  }, {
    'X-Forwarded-Proto': 'https',
    'X-Forwarded-For': '203.0.113.10',
    'CF-Connecting-IP': '203.0.113.10',
    'CF-Ray': '230b030023ae2822-LHR',
  }), env());
  assert.equal(edgeRequest.status, 200);
  assert.equal(edgeCounters.upstream, 1);

  const wrongProtocol = await edgeHandler.fetch(request('/v1/entitlements/verify', {
    store: 'google', environment: 'sandbox', productId: 'full_ks2', opaqueProof: 'opaque-token',
  }, { 'X-Forwarded-Proto': 'http' }), env());
  assert.equal(wrongProtocol.status, 403);
  assert.equal(edgeCounters.upstream, 1);

  let bodyReads = 0;
  let rateLimits = 0;
  const queryRequest = {
    method: 'POST',
    url: 'https://b3-gateway.eugnel.uk/v1/entitlements/verify?learnerId=child&progress=private',
    headers: new Headers({ Origin: ORIGIN, 'Content-Type': 'application/json' }),
    get body() { bodyReads += 1; throw new Error('query rejection must not read body'); },
  };
  const queryResponse = await closedHandler.fetch(queryRequest, env({
    GATEWAY_RATE_LIMIT: { limit: async () => { rateLimits += 1; return { success: true }; } },
  }));
  assert.equal(queryResponse.status, 403);
  assert.equal(rateLimits, 1);
  assert.equal(bodyReads, 0);
  assert.equal(counters.upstream, 0);
  assert.doesNotMatch(await queryResponse.text(), /learnerId|progress|b3rh1|traceId/);
});

test('POST body is exact JSON, sandbox-only and at most 64 KiB', async () => {
  const { createGatewayHandler } = await import('../gateway/src/handler.js');
  const handler = createGatewayHandler(dependencies());
  for (const candidate of [
    request('/v1/entitlements/verify', '{}', { 'Content-Type': 'text/plain' }),
    request('/v1/entitlements/verify', '{'),
    request('/v1/entitlements/verify', 'x'.repeat(65_537)),
    request('/v1/entitlements/verify', { store: 'google', environment: 'production', productId: 'full_ks2', opaqueProof: 'x' }),
    request('/v1/entitlements/verify', { store: 'google', environment: 'sandbox', productId: 'full_ks2', opaqueProof: 'x', entitlementId: 'full-ks2' }),
  ]) {
    assert.equal((await handler.fetch(candidate, env())).status, 400);
  }
});

test('a native-pending proof can never mint a gateway entitlement or handle', async () => {
  const { createGatewayHandler } = await import('../gateway/src/handler.js');
  const activeDependencies = dependencies();
  activeDependencies.randomBytes = () => new Uint8Array(12).fill(8);
  const active = await createGatewayHandler(activeDependencies).fetch(request('/v1/entitlements/verify', {
    store: 'google', environment: 'sandbox', productId: 'full_ks2', opaqueProof: 'opaque-token',
  }), env());
  assert.equal(active.status, 200);
  const { sealedRefreshHandle } = await active.json();

  const pending = dependencies();
  pending.createStoreVerifier = () => ({
    verify: async () => ({
      store: 'google', productId: 'full_ks2', environment: 'sandbox',
      applicationId: 'uk.eugnel.ks2spelling', entitlementId: 'full-ks2', state: 'pending',
      storeTransactionId: null, opaqueProof: 'pending-token',
    }),
    refresh: async () => ({
      store: 'google', productId: 'full_ks2', environment: 'sandbox',
      applicationId: 'uk.eugnel.ks2spelling', entitlementId: 'full-ks2', state: 'pending',
      storeTransactionId: null, opaqueProof: 'pending-token',
    }),
    complete: async () => assert.fail('must not complete'),
  });
  const handler = createGatewayHandler(pending);
  const response = await handler.fetch(request('/v1/entitlements/verify', {
    store: 'google', environment: 'sandbox', productId: 'full_ks2', opaqueProof: 'pending-token',
  }), env());
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.deepEqual(body, { code: 'REQUEST_INVALID', retryable: false });
  assert.doesNotMatch(JSON.stringify(body), /pending-token|b3rh1/);

  const refreshed = await handler.fetch(request('/v1/entitlements/refresh', {
    sealedRefreshHandle,
  }), env());
  assert.equal(refreshed.status, 503);
  const refreshBody = await refreshed.json();
  assert.deepEqual(refreshBody, { code: 'STORE_UNAVAILABLE', retryable: true });
  assert.doesNotMatch(JSON.stringify(refreshBody), /pending-token|b3rh1/);
});

test('every issued near-limit refresh handle round-trips within the 64 KiB body contract', async () => {
  const { createGatewayHandler } = await import('../gateway/src/handler.js');
  function largeProofDependencies(opaqueProof, nonceByte, counters = {}) {
    const injected = dependencies();
    injected.randomBytes = () => {
      counters.cryptography = (counters.cryptography ?? 0) + 1;
      return new Uint8Array(12).fill(nonceByte);
    };
    injected.createStoreVerifier = () => {
      const result = {
        store: 'google', productId: 'full_ks2', environment: 'sandbox',
        applicationId: 'uk.eugnel.ks2spelling', entitlementId: 'full-ks2', state: 'active',
        storeTransactionId: 'GPA.1234-5678-9012-34567', opaqueProof,
      };
      return {
        verify: async () => {
          counters.upstream = (counters.upstream ?? 0) + 1;
          return result;
        },
        refresh: async () => {
          counters.upstream = (counters.upstream ?? 0) + 1;
          return result;
        },
        complete: async () => {
          counters.upstream = (counters.upstream ?? 0) + 1;
          return { ...result, acknowledged: true };
        },
      };
    };
    return injected;
  }

  const nearLimitProof = 'p'.repeat(48_000);
  const handler = createGatewayHandler(largeProofDependencies(nearLimitProof, 9));
  const verified = await handler.fetch(request('/v1/entitlements/verify', {
    store: 'google', environment: 'sandbox', productId: 'full_ks2', opaqueProof: nearLimitProof,
  }), env());
  assert.equal(verified.status, 200);
  const verifiedBody = await verified.json();
  assert.ok(new TextEncoder().encode(JSON.stringify(verifiedBody)).byteLength <= 65_536);
  const refreshJson = JSON.stringify({ sealedRefreshHandle: verifiedBody.sealedRefreshHandle });
  assert.ok(new TextEncoder().encode(refreshJson).byteLength <= 65_536);
  const refreshed = await handler.fetch(request('/v1/entitlements/refresh', {
    sealedRefreshHandle: verifiedBody.sealedRefreshHandle,
  }), env());
  assert.equal(refreshed.status, 200);
  const completed = await handler.fetch(request('/v1/transactions/complete', {
    sealedRefreshHandle: verifiedBody.sealedRefreshHandle,
  }), env());
  assert.equal(completed.status, 200);

  const overLimitCounters = { upstream: 0, cryptography: 0 };
  const tooLargeProof = 'p'.repeat(48_001);
  const rejected = await createGatewayHandler(
    largeProofDependencies(tooLargeProof, 10, overLimitCounters),
  ).fetch(
    request('/v1/entitlements/verify', {
      store: 'google', environment: 'sandbox', productId: 'full_ks2', opaqueProof: tooLargeProof,
    }),
    env(),
  );
  assert.equal(rejected.status, 400);
  assert.deepEqual(await rejected.json(), { code: 'REQUEST_INVALID', retryable: false });
  assert.deepEqual(overLimitCounters, { upstream: 0, cryptography: 0 });
});
