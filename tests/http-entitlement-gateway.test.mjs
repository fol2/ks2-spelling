import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const AUTHORITY_URL = new URL('../config/b3-gateway-authority.json', import.meta.url);

async function authority() {
  return JSON.parse(await readFile(AUTHORITY_URL, 'utf8'));
}

function verifiedResponse(extra = {}) {
  return {
    store: 'google',
    productId: 'full_ks2',
    environment: 'sandbox',
    applicationId: 'uk.eugnel.ks2spelling',
    entitlementId: 'full-ks2',
    state: 'active',
    storeTransactionId: 'GPA.1234-5678-9012-34567',
    sealedRefreshHandle: 'b3rh1.1.nonce.ciphertext',
    refreshHandleVersion: 1,
    traceId: '05c095a1-f5de-4e39-a38f-f466de9a256a',
    workerVersionId: 'worker-version-1',
    workerScriptAuthoritySha256: 'a'.repeat(64),
    ...extra,
  };
}

function authorisedResponse(extra = {}) {
  const manifestSha256 = 'b'.repeat(64);
  const archiveSha256 = 'c'.repeat(64);
  return {
    ...verifiedResponse(),
    packId: 'b3-sandbox-proof',
    version: '1.0.0-b3.1',
    signedManifestEnvelopeBase64: 'e30=',
    signedEnvelopeSha256: manifestSha256,
    objects: [
      { objectKind: 'manifest', sha256: manifestSha256, size: 2, etag: 'manifest-etag' },
      { objectKind: 'archive', sha256: archiveSha256, size: 16, etag: 'archive-etag' },
    ],
    archiveCapability: {
      packId: 'b3-sandbox-proof',
      version: '1.0.0-b3.1',
      archiveName: 'b3-sandbox-proof.zip',
      sha256: archiveSha256,
      compressedBytes: 16,
      etag: 'archive-etag',
      capabilityUrl: 'memory-only-capability',
    },
    ...extra,
  };
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    ...init,
  });
}

test('HTTP gateway posts exact closed bodies to the tracked HTTPS routes', async () => {
  const { createHttpEntitlementGateway } = await import(
    '../src/platform/gateway/http-entitlement-gateway.js'
  );
  const calls = [];
  const gateway = createHttpEntitlementGateway({
    authority: await authority(),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(verifiedResponse());
    },
  });
  const request = {
    store: 'google',
    environment: 'sandbox',
    productId: 'full_ks2',
    opaqueProof: 'opaque-test-token',
  };
  assert.deepEqual(await gateway.verifyTransaction(request), verifiedResponse());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://b3-gateway.eugnel.uk/v1/entitlements/verify');
  assert.deepEqual(JSON.parse(calls[0].options.body), request);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.equal(calls[0].options.referrer, '');
  assert.equal(calls[0].options.referrerPolicy, 'no-referrer');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.deepEqual(calls[0].options.headers, {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  });
});

test('HTTP gateway route mapping is fixed and never accepts a caller path', async () => {
  const { createHttpEntitlementGateway } = await import(
    '../src/platform/gateway/http-entitlement-gateway.js'
  );
  const paths = [];
  const gateway = createHttpEntitlementGateway({
    authority: await authority(),
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      paths.push(path);
      return jsonResponse(
        path === '/v1/packs/authorise-download'
          ? authorisedResponse()
          : verifiedResponse(),
      );
    },
  });
  const handle = { sealedRefreshHandle: 'b3rh1.1.nonce.ciphertext' };
  await gateway.completeTransaction(handle);
  await gateway.refreshEntitlement(handle);
  await assert.rejects(
    gateway.authorisePackDownload({
      ...handle,
      packId: 'b3-sandbox-proof',
      version: '1.0.0-b3.1',
      path: '/admin',
    }),
    /closed|fields/i,
  );
  await gateway.authorisePackDownload({
    ...handle,
    packId: 'b3-sandbox-proof',
    version: '1.0.0-b3.1',
  });
  assert.deepEqual(paths, [
    '/v1/transactions/complete',
    '/v1/entitlements/refresh',
    '/v1/packs/authorise-download',
  ]);
});

test('HTTP gateway authority freezes both native CORS origins and rejects drift', async () => {
  const { createHttpEntitlementGateway } = await import(
    '../src/platform/gateway/http-entitlement-gateway.js'
  );
  const approved = await authority();
  assert.deepEqual(approved.allowedOrigins, ['capacitor://localhost', 'http://localhost']);
  for (const mutate of [
    (value) => { value.allowedOrigins = ['*']; },
    (value) => { value.publicSandboxOrigin = 'https://example.com'; },
    (value) => { value.publicSandboxOrigin += '/v1'; },
  ]) {
    const candidate = structuredClone(approved);
    mutate(candidate);
    assert.throws(
      () => createHttpEntitlementGateway({ authority: candidate, fetchImpl: fetch }),
      /gateway authority/i,
    );
  }
});

test('HTTP gateway aborts at timeout and maps transport failures to safe retryable errors', async () => {
  const { createHttpEntitlementGateway } = await import(
    '../src/platform/gateway/http-entitlement-gateway.js'
  );
  const request = {
    store: 'google', environment: 'sandbox', productId: 'full_ks2', opaqueProof: 'token',
  };
  let aborted = false;
  const timed = createHttpEntitlementGateway({
    authority: await authority(),
    timeoutMs: 5,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(new DOMException('secret token must not leak', 'AbortError'));
      }, { once: true });
    }),
  });
  await assert.rejects(timed.verifyTransaction(request), (error) => {
    assert.deepEqual(Object.keys(error), ['code', 'status', 'retryable']);
    assert.equal(error.code, 'GATEWAY_TIMEOUT');
    assert.equal(error.status, null);
    assert.equal(error.retryable, true);
    assert.doesNotMatch(error.message, /token|secret/i);
    return true;
  });
  assert.equal(aborted, true);

  const offline = createHttpEntitlementGateway({
    authority: await authority(),
    fetchImpl: async () => { throw new TypeError('DNS leaked https://secret.invalid/?cap=x'); },
  });
  await assert.rejects(offline.verifyTransaction(request), (error) => {
    assert.equal(error.code, 'GATEWAY_OFFLINE');
    assert.equal(error.retryable, true);
    assert.doesNotMatch(error.message, /DNS|secret|cap=/i);
    return true;
  });
});

test('HTTP gateway deadline covers a stalled response body and cancels its reader', async () => {
  const { createHttpEntitlementGateway } = await import(
    '../src/platform/gateway/http-entitlement-gateway.js'
  );
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const gateway = createHttpEntitlementGateway({
    authority: await authority(),
    timeoutMs: 5,
    fetchImpl: async () => new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });
  await assert.rejects(
    gateway.verifyTransaction({
      store: 'google', environment: 'sandbox', productId: 'full_ks2', opaqueProof: 'token',
    }),
    ({ code }) => code === 'GATEWAY_TIMEOUT',
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(cancelled, true);
});

test('HTTP gateway rejects redirects, malformed, oversized, non-JSON and open responses', async () => {
  const { createHttpEntitlementGateway } = await import(
    '../src/platform/gateway/http-entitlement-gateway.js'
  );
  const request = {
    store: 'google', environment: 'sandbox', productId: 'full_ks2', opaqueProof: 'token',
  };
  const responses = [
    new Response('', { status: 302, headers: { location: 'https://evil.invalid' } }),
    new Response('{', { status: 200, headers: { 'content-type': 'application/json' } }),
    new Response('x'.repeat(65_537), { status: 200, headers: { 'content-type': 'application/json' } }),
    new Response('{}', { status: 200, headers: { 'content-type': 'text/plain' } }),
    jsonResponse(verifiedResponse({ learnerId: 'learner-a' })),
    jsonResponse(verifiedResponse({ transactionRef: 'native-ref' })),
  ];
  for (const response of responses) {
    const gateway = createHttpEntitlementGateway({
      authority: await authority(),
      fetchImpl: async () => response,
    });
    await assert.rejects(gateway.verifyTransaction(request), (error) => {
      assert.deepEqual(Object.keys(error), ['code', 'status', 'retryable']);
      assert.doesNotMatch(error.message, /evil|learner|native-ref/i);
      return true;
    });
  }
});

test('HTTP gateway rejects synchronous fetches and Content-Length lies', async () => {
  const { createHttpEntitlementGateway } = await import(
    '../src/platform/gateway/http-entitlement-gateway.js'
  );
  const request = {
    store: 'google', environment: 'sandbox', productId: 'full_ks2', opaqueProof: 'token',
  };
  const synchronous = createHttpEntitlementGateway({
    authority: await authority(),
    fetchImpl: () => jsonResponse(verifiedResponse()),
  });
  await assert.rejects(
    synchronous.verifyTransaction(request),
    ({ code }) => code === 'GATEWAY_OFFLINE',
  );

  const body = JSON.stringify(verifiedResponse());
  const lying = createHttpEntitlementGateway({
    authority: await authority(),
    fetchImpl: async () => new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-length': String(new TextEncoder().encode(body).byteLength + 1),
      },
    }),
  });
  await assert.rejects(
    lying.verifyTransaction(request),
    ({ code }) => code === 'GATEWAY_RESPONSE_INVALID',
  );
});

test('HTTP gateway keeps 429 and 5xx retryable without treating them as proof rejection', async () => {
  const { createHttpEntitlementGateway } = await import(
    '../src/platform/gateway/http-entitlement-gateway.js'
  );
  const request = {
    store: 'google', environment: 'sandbox', productId: 'full_ks2', opaqueProof: 'token',
  };
  for (const [status, body] of [
    [429, { code: 'RATE_LIMITED', retryable: true }],
    [503, { code: 'GATEWAY_UNAVAILABLE', retryable: true }],
  ]) {
    const gateway = createHttpEntitlementGateway({
      authority: await authority(),
      fetchImpl: async () => jsonResponse(body, { status }),
    });
    await assert.rejects(gateway.verifyTransaction(request), (error) => {
      assert.equal(error.status, status);
      assert.equal(error.retryable, true);
      assert.notEqual(error.code, 'PROOF_REJECTED');
      return true;
    });
  }
});

test('HTTP gateway accepts only closed safe error codes and never logs endpoints or secrets', async () => {
  const { createHttpEntitlementGateway } = await import(
    '../src/platform/gateway/http-entitlement-gateway.js'
  );
  const original = { log: console.log, warn: console.warn, error: console.error };
  const logged = [];
  console.log = (...values) => logged.push(values);
  console.warn = (...values) => logged.push(values);
  console.error = (...values) => logged.push(values);
  try {
    const gateway = createHttpEntitlementGateway({
      authority: await authority(),
      fetchImpl: async () => jsonResponse(
        { code: 'PROOF_REJECTED', retryable: false },
        { status: 422 },
      ),
    });
    await assert.rejects(
      gateway.verifyTransaction({
        store: 'google', environment: 'sandbox', productId: 'full_ks2', opaqueProof: 'secret-token',
      }),
      (error) => error.code === 'PROOF_REJECTED' && error.status === 422 && !error.retryable,
    );
    assert.deepEqual(logged, []);
  } finally {
    Object.assign(console, original);
  }

  for (const body of [
    { code: 'UNKNOWN_INTERNAL_SECRET', retryable: false },
    { code: 'PROOF_REJECTED', retryable: false, detail: 'raw proof' },
  ]) {
    const gateway = createHttpEntitlementGateway({
      authority: await authority(),
      fetchImpl: async () => jsonResponse(body, { status: 400 }),
    });
    await assert.rejects(
      gateway.verifyTransaction({
        store: 'google', environment: 'sandbox', productId: 'full_ks2', opaqueProof: 'token',
      }),
      ({ code }) => code === 'GATEWAY_RESPONSE_INVALID',
    );
  }
});
