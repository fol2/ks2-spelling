import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createFakeR2Bucket } from './helpers/fake-r2-bucket.mjs';

const ORIGIN = 'capacitor://localhost';
const NOW_MS = 1_782_865_800_000;
const PACK_ID = 'b3-sandbox-proof';
const VERSION = '1.0.0-b3.1';
const ARCHIVE_NAME = 'b3-sandbox-proof.zip';
const ARCHIVE_KEY = `packs/${PACK_ID}/${VERSION}/${ARCHIVE_NAME}`;
const MANIFEST_KEY = `packs/${PACK_ID}/${VERSION}/signed-manifest.json`;
const CAPABILITY_SECRET = Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString('base64url');
const KNOWN_CAPABILITY_URL = `https://b3-gateway.eugnel.uk/v1/packs/${PACK_ID}/${VERSION}/${ARCHIVE_NAME}?expires=1782866400&cap=qd_LNx8OsL4YJTLIdugx-Mkg_3dJYuEqwpOzdazrC7U`;
const CURRENT = `v2:${Buffer.alloc(32, 2).toString('base64url')}`;
const PREVIOUS = `v1:${Buffer.alloc(32, 1).toString('base64url')}`;
const ARCHIVE_AUTHORITY = {
  bytes: 1324,
  sha256: '4c2ca2eb4d4bb7ac3347b66e3483dcb6aa71b41958704733bfc471c970ce7664',
  etag: '913d2b2485ca6cd31d467bd7228d7e75',
  metadata: {
    'b3-role': 'archive',
    'b3-sha256': '4c2ca2eb4d4bb7ac3347b66e3483dcb6aa71b41958704733bfc471c970ce7664',
    'b3-size': '1324',
  },
};
const MANIFEST_AUTHORITY = {
  bytes: 1135,
  sha256: '39b6a788a3686d7cbf1fd4791bce45623af21ef53c60eabc03d955395856218a',
  etag: 'c76b2858b8345814279a1c92ae64e365',
  metadata: {
    'b3-role': 'signed-manifest',
    'b3-sha256': '39b6a788a3686d7cbf1fd4791bce45623af21ef53c60eabc03d955395856218a',
    'b3-size': '1135',
    'b3-envelope-sha256': '39b6a788a3686d7cbf1fd4791bce45623af21ef53c60eabc03d955395856218a',
  },
};
const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL('../', import.meta.url));

let nonce = 20;
let fixtureDirectory;

before(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), 'ks2-task10-pack-'));
  await execFileAsync(
    process.execPath,
    ['scripts/build-b3-proof-pack.mjs', '--output-directory', fixtureDirectory],
    { cwd: ROOT },
  );
});

after(async () => {
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
});

async function fixtureBucket() {
  const [archive, manifest] = await Promise.all([
    readFile(join(fixtureDirectory, 'b3-sandbox-proof.zip')),
    readFile(join(fixtureDirectory, 'signed-manifest.json')),
  ]);
  return createFakeR2Bucket({
    [ARCHIVE_KEY]: {
      bytes: archive,
      etag: ARCHIVE_AUTHORITY.etag,
      customMetadata: ARCHIVE_AUTHORITY.metadata,
      httpMetadata: { contentType: 'application/zip' },
    },
    [MANIFEST_KEY]: {
      bytes: manifest,
      etag: MANIFEST_AUTHORITY.etag,
      customMetadata: MANIFEST_AUTHORITY.metadata,
      httpMetadata: { contentType: 'application/json' },
    },
  });
}

function environment(bucket, overrides = {}) {
  return {
    GATEWAY_RATE_LIMIT: { limit: async () => ({ success: true }) },
    ENTITLEMENT_HANDLE_KEY_CURRENT: CURRENT,
    ENTITLEMENT_HANDLE_KEY_PREVIOUS: PREVIOUS,
    R2_CAPABILITY_HMAC_KEY: CAPABILITY_SECRET,
    WORKER_VERSION_METADATA: { id: 'worker-version-test' },
    PACKS: bucket,
    ...overrides,
  };
}

function dependencies(overrides = {}) {
  const result = {
    store: 'google', productId: 'full_ks2', environment: 'sandbox',
    applicationId: 'uk.eugnel.ks2spelling', entitlementId: 'full-ks2', state: 'active',
    storeTransactionId: 'GPA.1234-5678-9012-34567', opaqueProof: 'opaque-token',
  };
  return {
    randomUUID: () => '05c095a1-f5de-4e39-a38f-f466de9a256a',
    clock: () => NOW_MS,
    randomBytes: (length) => new Uint8Array(length).fill((nonce += 1) % 255),
    createStoreVerifier: () => ({
      verify: async () => result,
      refresh: async () => {
        overrides.onRefresh?.();
        return { ...result, ...overrides.storeResult };
      },
      complete: async () => ({ ...result, acknowledged: true }),
    }),
    ...overrides,
  };
}

async function sealedHandle() {
  const { parseRefreshHandleKeyring, sealRefreshHandle } = await import('../gateway/src/refresh-handle.js');
  return sealRefreshHandle({
    store: 'google', productId: 'full_ks2', environment: 'sandbox',
    applicationId: 'uk.eugnel.ks2spelling',
    storeTransactionId: 'GPA.1234-5678-9012-34567',
    opaqueProof: 'opaque-token', issuedAt: Math.floor(NOW_MS / 1000),
  }, {
    keyring: parseRefreshHandleKeyring({ current: CURRENT, previous: PREVIOUS }),
    randomBytes: (length) => new Uint8Array(length).fill((nonce += 1) % 255),
  });
}

function post(path, body) {
  return new Request(`https://b3-gateway.eugnel.uk${path}`, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function get(capabilityUrl, headers = {}) {
  return new Request(capabilityUrl, {
    method: 'GET',
    headers: { Origin: ORIGIN, ...headers },
    redirect: 'manual',
  });
}

async function authorise(handler, bucket, envOverrides = {}) {
  const response = await handler.fetch(post('/v1/packs/authorise-download', {
    sealedRefreshHandle: await sealedHandle(),
    packId: PACK_ID,
    version: VERSION,
  }), environment(bucket, envOverrides));
  return response;
}

test('live active handle authorises only the tracked signed manifest and archive', async () => {
  const { createGatewayHandler } = await import('../gateway/src/handler.js');
  const { validateAuthoriseResponse } = await import('../src/platform/gateway/entitlement-gateway-port.js');
  const bucket = await fixtureBucket();
  const response = await authorise(createGatewayHandler(dependencies()), bucket);
  assert.equal(response.status, 200);
  const body = await response.json();
  validateAuthoriseResponse(body, { packId: PACK_ID, version: VERSION });
  assert.equal(Buffer.from(body.signedManifestEnvelopeBase64, 'base64').byteLength, MANIFEST_AUTHORITY.bytes);
  assert.equal(body.signedEnvelopeSha256, MANIFEST_AUTHORITY.sha256);
  assert.deepEqual(body.objects, [
    { objectKind: 'manifest', sha256: MANIFEST_AUTHORITY.sha256, size: MANIFEST_AUTHORITY.bytes, etag: MANIFEST_AUTHORITY.etag },
    { objectKind: 'archive', sha256: ARCHIVE_AUTHORITY.sha256, size: ARCHIVE_AUTHORITY.bytes, etag: ARCHIVE_AUTHORITY.etag },
  ]);
  assert.deepEqual({ ...body.archiveCapability, capabilityUrl: undefined }, {
    packId: PACK_ID,
    version: VERSION,
    archiveName: ARCHIVE_NAME,
    sha256: ARCHIVE_AUTHORITY.sha256,
    compressedBytes: ARCHIVE_AUTHORITY.bytes,
    etag: ARCHIVE_AUTHORITY.etag,
    capabilityUrl: undefined,
  });
  const capabilityUrl = new URL(body.archiveCapability.capabilityUrl);
  assert.equal(capabilityUrl.origin, 'https://b3-gateway.eugnel.uk');
  assert.equal(capabilityUrl.pathname, `/v1/packs/${PACK_ID}/${VERSION}/${ARCHIVE_NAME}`);
  assert.equal(capabilityUrl.searchParams.get('expires'), String(Math.floor(NOW_MS / 1000) + 600));
  assert.match(capabilityUrl.searchParams.get('cap'), /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(bucket.calls.map(({ operation, key }) => [operation, key]), [
    ['get', MANIFEST_KEY],
    ['head', ARCHIVE_KEY],
  ]);
});

test('authorise rejects unsealed, revoked, arbitrary and drifted authority without issuing access', async () => {
  const { createGatewayHandler } = await import('../gateway/src/handler.js');
  const invalidBucket = await fixtureBucket();
  const invalidHandler = createGatewayHandler(dependencies());
  for (const body of [
    { sealedRefreshHandle: 'raw-store-proof', packId: PACK_ID, version: VERSION },
    { sealedRefreshHandle: await sealedHandle(), packId: '../private', version: VERSION },
    { sealedRefreshHandle: await sealedHandle(), packId: PACK_ID, version: '9.9.9' },
    { sealedRefreshHandle: await sealedHandle(), packId: PACK_ID, version: VERSION, objectKey: ARCHIVE_KEY },
  ]) {
    const response = await invalidHandler.fetch(post('/v1/packs/authorise-download', body), environment(invalidBucket));
    assert.ok(response.status >= 400);
  }
  assert.equal(invalidBucket.calls.length, 0);

  const revokedBucket = await fixtureBucket();
  const revoked = await authorise(createGatewayHandler(dependencies({ storeResult: { state: 'revoked' } })), revokedBucket);
  assert.equal(revoked.status, 403);
  assert.deepEqual(await revoked.json(), { code: 'ENTITLEMENT_REVOKED', retryable: false });
  assert.equal(revokedBucket.calls.length, 0);

  for (const mutate of [
    (bucket) => { bucket.records.get(MANIFEST_KEY).bytes[0] ^= 1; },
    (bucket) => { bucket.records.get(MANIFEST_KEY).etag = 'drifted'; },
    (bucket) => { bucket.records.get(MANIFEST_KEY).customMetadata['b3-size'] = '1'; },
    (bucket) => { bucket.records.get(ARCHIVE_KEY).bytes = bucket.records.get(ARCHIVE_KEY).bytes.slice(1); },
    (bucket) => { bucket.records.get(ARCHIVE_KEY).etag = 'drifted'; },
    (bucket) => { bucket.records.get(ARCHIVE_KEY).customMetadata['b3-sha256'] = '0'.repeat(64); },
  ]) {
    const bucket = await fixtureBucket();
    mutate(bucket);
    const response = await authorise(createGatewayHandler(dependencies()), bucket);
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /packs\/|drifted|b3rh1|opaque-token/);
  }
});

test('rate limit and required private bindings fail before capability or R2 work', async () => {
  const { createGatewayHandler } = await import('../gateway/src/handler.js');
  const bucket = await fixtureBucket();
  const handler = createGatewayHandler(dependencies());
  const limited = await handler.fetch(
    get(`https://b3-gateway.eugnel.uk/v1/packs/${PACK_ID}/${VERSION}/${ARCHIVE_NAME}?expires=1&cap=invalid`),
    environment(bucket, { GATEWAY_RATE_LIMIT: { limit: async () => ({ success: false }) } }),
  );
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('cache-control'), 'private, no-store');
  assert.equal(bucket.calls.length, 0);

  const missingRateLimit = await handler.fetch(
    get(`https://b3-gateway.eugnel.uk/v1/packs/${PACK_ID}/${VERSION}/${ARCHIVE_NAME}?expires=1&cap=invalid`),
    environment(bucket, { GATEWAY_RATE_LIMIT: undefined }),
  );
  assert.equal(missingRateLimit.status, 503);
  assert.equal(missingRateLimit.headers.get('cache-control'), 'private, no-store');
  assert.equal(bucket.calls.length, 0);

  const missingDownloadR2 = await handler.fetch(
    get(KNOWN_CAPABILITY_URL),
    environment(undefined, { PACKS: undefined }),
  );
  assert.equal(missingDownloadR2.status, 503);
  assert.equal(missingDownloadR2.headers.get('cache-control'), 'private, no-store');
  const missingDownloadSecret = await handler.fetch(
    get(KNOWN_CAPABILITY_URL),
    environment(bucket, { R2_CAPABILITY_HMAC_KEY: undefined }),
  );
  assert.equal(missingDownloadSecret.status, 503);
  assert.equal(missingDownloadSecret.headers.get('cache-control'), 'private, no-store');
  assert.equal(bucket.calls.length, 0);

  let liveVerifications = 0;
  const bindingHandler = createGatewayHandler(dependencies({
    onRefresh: () => { liveVerifications += 1; },
  }));
  const missingR2 = await authorise(bindingHandler, undefined, { PACKS: undefined });
  assert.equal(missingR2.status, 503);
  const missingSecret = await authorise(bindingHandler, bucket, { R2_CAPABILITY_HMAC_KEY: undefined });
  assert.equal(missingSecret.status, 503);
  assert.equal(liveVerifications, 0);
  assert.equal(bucket.calls.length, 0);

  let bodyReads = 0;
  const limitedAuthorise = {
    method: 'POST',
    url: 'https://b3-gateway.eugnel.uk/v1/packs/authorise-download',
    headers: new Headers({ Origin: ORIGIN, 'Content-Type': 'application/json' }),
    get body() {
      bodyReads += 1;
      throw new Error('rate-limited body must not be read');
    },
  };
  const limitedPost = await bindingHandler.fetch(limitedAuthorise, environment(bucket, {
    GATEWAY_RATE_LIMIT: { limit: async () => ({ success: false }) },
  }));
  assert.equal(limitedPost.status, 429);
  assert.equal(bodyReads, 0);
  assert.equal(liveVerifications, 0);
  assert.equal(bucket.calls.length, 0);
});

test('private archive GET streams full and single ranges with exact immutable headers', async () => {
  const { createGatewayHandler } = await import('../gateway/src/handler.js');
  const bucket = await fixtureBucket();
  const handler = createGatewayHandler(dependencies());
  const authorised = await authorise(handler, bucket);
  const { archiveCapability } = await authorised.json();
  bucket.calls.length = 0;
  bucket.counters.streamStarts = 0;

  const full = await handler.fetch(get(archiveCapability.capabilityUrl), environment(bucket));
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('cache-control'), 'private, no-store');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(full.headers.get('content-type'), 'application/zip');
  assert.equal(full.headers.get('content-length'), String(ARCHIVE_AUTHORITY.bytes));
  assert.equal(full.headers.get('etag'), `"${ARCHIVE_AUTHORITY.etag}"`);
  assert.equal(full.headers.get('access-control-expose-headers'), 'Accept-Ranges, Content-Range, ETag');
  assert.equal(full.headers.has('location'), false);
  assert.equal((await full.arrayBuffer()).byteLength, ARCHIVE_AUTHORITY.bytes);

  const partial = await handler.fetch(get(archiveCapability.capabilityUrl, { Range: 'bytes=100-199' }), environment(bucket));
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), `bytes 100-199/${ARCHIVE_AUTHORITY.bytes}`);
  assert.equal(partial.headers.get('content-length'), '100');
  assert.equal((await partial.arrayBuffer()).byteLength, 100);

  const suffix = await handler.fetch(get(archiveCapability.capabilityUrl, { Range: 'bytes=-10' }), environment(bucket));
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers.get('content-range'), `bytes ${ARCHIVE_AUTHORITY.bytes - 10}-${ARCHIVE_AUTHORITY.bytes - 1}/${ARCHIVE_AUTHORITY.bytes}`);
  assert.equal((await suffix.arrayBuffer()).byteLength, 10);
  assert.equal(bucket.counters.streamStarts, 3);
  assert.equal(bucket.calls.filter(({ operation }) => operation === 'get').length, 3);
});

test('private archive GET implements 304 and 416 without returning archive bytes', async () => {
  const { createGatewayHandler } = await import('../gateway/src/handler.js');
  const bucket = await fixtureBucket();
  const handler = createGatewayHandler(dependencies());
  const authorised = await authorise(handler, bucket);
  const { archiveCapability } = await authorised.json();
  bucket.calls.length = 0;
  bucket.counters.streamStarts = 0;

  const notModified = await handler.fetch(get(archiveCapability.capabilityUrl, {
    'If-None-Match': `"${ARCHIVE_AUTHORITY.etag}"`,
  }), environment(bucket));
  assert.equal(notModified.status, 304);
  assert.equal(notModified.headers.get('etag'), `"${ARCHIVE_AUTHORITY.etag}"`);
  assert.equal(notModified.headers.get('cache-control'), 'private, no-store');
  assert.equal(notModified.headers.get('access-control-expose-headers'), 'Accept-Ranges, Content-Range, ETag');
  assert.equal(await notModified.text(), '');

  for (const range of ['bytes=1324-', 'bytes=20-10', 'bytes=-0', 'bytes=0-1,4-5', 'bytes=01-2']) {
    const response = await handler.fetch(get(archiveCapability.capabilityUrl, { Range: range }), environment(bucket));
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get('content-range'), `bytes */${ARCHIVE_AUTHORITY.bytes}`);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(await response.text(), '');
  }
  assert.equal(bucket.calls.filter(({ operation }) => operation === 'get').length, 0);
  assert.equal(bucket.counters.streamStarts, 0);
});

test('download route rejects expired, overlong, mutated and non-canonical bearer queries before R2', async () => {
  const { createGatewayHandler } = await import('../gateway/src/handler.js');
  const bucket = await fixtureBucket();
  const handler = createGatewayHandler(dependencies());
  const authorised = await authorise(handler, bucket);
  const { archiveCapability } = await authorised.json();
  const valid = new URL(archiveCapability.capabilityUrl);
  const cap = valid.searchParams.get('cap');
  const expires = Number(valid.searchParams.get('expires'));
  bucket.calls.length = 0;
  const candidates = [
    `${valid.origin}${valid.pathname}?expires=${expires - 601}&cap=${cap}`,
    `${valid.origin}${valid.pathname}?expires=${expires + 1}&cap=${cap}`,
    `${valid.origin}${valid.pathname}?expires=0${expires}&cap=${cap}`,
    `${valid.origin}${valid.pathname}?cap=${cap}&expires=${expires}`,
    `${valid.origin}${valid.pathname}?expires=${expires}&cap=${cap}&extra=1`,
    `${valid.origin}${valid.pathname}?expires=${expires}&cap=${cap}&cap=${cap}`,
    `${valid.origin}${valid.pathname}?expires=${expires}&cap=${cap.slice(0, -1)}A`,
    `${valid.origin}/v1/packs/${PACK_ID}/${VERSION}/../${ARCHIVE_NAME}?expires=${expires}&cap=${cap}`,
    `${valid.origin}/v1/packs/${PACK_ID}/${VERSION}/private.zip?expires=${expires}&cap=${cap}`,
  ];
  for (const url of candidates) {
    const response = await handler.fetch(get(url), environment(bucket));
    assert.ok(response.status >= 400, url);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.has('location'), false);
    assert.doesNotMatch(await response.text(), /expires|cap=|b3rh1|packs\//i);
  }
  assert.equal(bucket.calls.length, 0);
});

test('every malformed request in the closed packs namespace retains private cache policy', async () => {
  const { createGatewayHandler } = await import('../gateway/src/handler.js');
  const bucket = await fixtureBucket();
  const handler = createGatewayHandler(dependencies());
  const capabilityQuery = '?expires=1782866400&cap=qd_LNx8OsL4YJTLIdugx-Mkg_3dJYuEqwpOzdazrC7U';
  const requests = [
    new Request(`https://b3-gateway.eugnel.uk/v1/packs${capabilityQuery}`, {
      method: 'GET', headers: { Origin: ORIGIN },
    }),
    new Request(`https://b3-gateway.eugnel.uk/v1/packs/${PACK_ID}${capabilityQuery}`, {
      method: 'GET', headers: { Origin: ORIGIN },
    }),
    new Request(`https://b3-gateway.eugnel.uk/v1/packs/${PACK_ID}/${VERSION}/private.zip${capabilityQuery}`, {
      method: 'GET', headers: { Origin: ORIGIN },
    }),
    new Request(`https://b3-gateway.eugnel.uk/v1/packs/${PACK_ID}/malformed`, {
      method: 'DELETE', headers: { Origin: ORIGIN },
    }),
    new Request(`https://b3-gateway.eugnel.uk/v1/packs/${PACK_ID}/malformed`, {
      method: 'GET', headers: { Origin: 'https://evil.test' },
    }),
  ];
  for (const request of requests) {
    const response = await handler.fetch(request, environment(bucket));
    assert.ok(response.status >= 400);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.doesNotMatch(await response.text(), /expires|cap=|packs\//i);
  }
  assert.equal(bucket.calls.length, 0);
});

test('capability GET preflight accepts only canonical query, GET and conditional range headers', async () => {
  const { createGatewayHandler } = await import('../gateway/src/handler.js');
  const bucket = await fixtureBucket();
  const handler = createGatewayHandler(dependencies());
  const authorised = await authorise(handler, bucket);
  const { archiveCapability } = await authorised.json();
  bucket.calls.length = 0;

  const accepted = await handler.fetch(new Request(archiveCapability.capabilityUrl, {
    method: 'OPTIONS',
    headers: {
      Origin: ORIGIN,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'Range, If-None-Match',
    },
  }), environment(bucket));
  assert.equal(accepted.status, 204);
  assert.equal(accepted.headers.get('cache-control'), 'private, no-store');
  assert.equal(accepted.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
  assert.equal(accepted.headers.get('access-control-allow-headers'), 'Range, If-None-Match');

  const capabilityUrl = new URL(archiveCapability.capabilityUrl);
  const reversedQuery = `${capabilityUrl.origin}${capabilityUrl.pathname}?cap=${capabilityUrl.searchParams.get('cap')}&expires=${capabilityUrl.searchParams.get('expires')}`;
  for (const [url, method, headers] of [
    [reversedQuery, 'GET', 'Range'],
    [archiveCapability.capabilityUrl, 'POST', 'Range'],
    [archiveCapability.capabilityUrl, 'GET', 'Authorization'],
    [`${archiveCapability.capabilityUrl}&extra=1`, 'GET', 'Range'],
  ]) {
    const rejected = await handler.fetch(new Request(url, {
      method: 'OPTIONS',
      headers: {
        Origin: ORIGIN,
        'Access-Control-Request-Method': method,
        'Access-Control-Request-Headers': headers,
      },
    }), environment(bucket));
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers.get('cache-control'), 'private, no-store');
  }
  assert.equal(bucket.calls.length, 0);
});

test('actual conditional headers require the canonical archive GET query', async () => {
  const { createGatewayHandler } = await import('../gateway/src/handler.js');
  const bucket = await fixtureBucket();
  const handler = createGatewayHandler(dependencies());
  const canonical = new URL(KNOWN_CAPABILITY_URL);
  const reversedQuery = `${canonical.origin}${canonical.pathname}?cap=${canonical.searchParams.get('cap')}&expires=${canonical.searchParams.get('expires')}`;

  for (const headers of [
    { Range: 'bytes=0-99' },
    { 'If-None-Match': `"${ARCHIVE_AUTHORITY.etag}"` },
  ]) {
    const response = await handler.fetch(get(reversedQuery, headers), environment(bucket));
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
  assert.equal(bucket.calls.length, 0);
});

test('capability path early origin, method and header failures retain private cache policy', async () => {
  const { createGatewayHandler } = await import('../gateway/src/handler.js');
  const bucket = await fixtureBucket();
  const handler = createGatewayHandler(dependencies());
  const candidates = [
    new Request(KNOWN_CAPABILITY_URL, { method: 'GET', headers: { Origin: 'https://evil.test' } }),
    new Request(KNOWN_CAPABILITY_URL, { method: 'DELETE', headers: { Origin: ORIGIN } }),
    new Request(KNOWN_CAPABILITY_URL, { method: 'GET', headers: { Origin: ORIGIN, 'X-Private': 'no' } }),
  ];
  for (const request of candidates) {
    const response = await handler.fetch(request, environment(bucket));
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.doesNotMatch(await response.text(), /expires|cap=|packs\//i);
  }
  assert.equal(bucket.calls.length, 0);
});

test('Wrangler exposes only the named private PACKS binding and no public R2 endpoint', async () => {
  const wrangler = JSON.parse(await readFile(new URL('../gateway/wrangler.jsonc', import.meta.url), 'utf8'));
  assert.deepEqual(wrangler.r2_buckets, [{
    binding: 'PACKS',
    bucket_name: 'ks2-spelling-b3-sandbox-packs',
  }]);
  assert.equal(wrangler.workers_dev, false);
  const text = JSON.stringify(wrangler);
  assert.doesNotMatch(text, /r2\.dev|public_bucket|custom_domain/i);
});
