import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createFakeR2Bucket } from './helpers/fake-r2-bucket.mjs';

// E2.7: the gateway pack table is derived from the tracked downloadable-pack
// registry. Every shard authorises and downloads under its registry-exact
// object authority; shard objects declare EMPTY custom metadata (owner
// decision recorded in the 2026-08-13 hosting runbook), while the b3 row
// keeps its b3-* metadata (covered by gateway-pack-access.test.mjs).

const ORIGIN = 'capacitor://localhost';
const NOW_MS = 1_782_865_800_000;
const CAPABILITY_SECRET = Buffer.from(
  Array.from({ length: 32 }, (_, index) => index),
).toString('base64url');
const CURRENT = `v2:${Buffer.alloc(32, 2).toString('base64url')}`;
const PREVIOUS = `v1:${Buffer.alloc(32, 1).toString('base64url')}`;

const registry = JSON.parse(await readFile(
  new URL('../config/downloadable-pack-authorities.json', import.meta.url),
  'utf8',
));
const SHARDS = registry.packs;
assert.equal(SHARDS.length, 15);

const envelopeBytesByPackId = new Map(await Promise.all(SHARDS.map(async (row) => [
  row.packId,
  new Uint8Array(await readFile(new URL(
    `./fixtures/packs/full-ks2-shards/${row.packId}.signed-manifest.json`,
    import.meta.url,
  ))),
])));

let nonce = 60;

function shardBucketRecords({ archiveBytesFor = () => null } = {}) {
  const records = {};
  for (const row of SHARDS) {
    const envelope = envelopeBytesByPackId.get(row.packId);
    records[`packs/${row.packId}/${row.version}/signed-manifest.json`] = {
      bytes: envelope,
      etag: row.manifestEtag,
      httpMetadata: { contentType: 'application/json' },
    };
    const archiveBytes = archiveBytesFor(row);
    records[`packs/${row.packId}/${row.version}/${row.archiveName}`] = {
      bytes: archiveBytes ?? new Uint8Array(0),
      ...(archiveBytes ? {} : { declaredSize: row.archiveBytes }),
      etag: row.archiveEtag,
      httpMetadata: { contentType: 'application/zip' },
    };
  }
  return records;
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
      refresh: async () => ({ ...result, ...overrides.storeResult }),
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

function get(url, headers = {}) {
  return new Request(url, {
    method: 'GET',
    headers: { Origin: ORIGIN, ...headers },
    redirect: 'manual',
  });
}

async function authorise(handler, bucket, { packId, version }, envOverrides = {}) {
  return handler.fetch(post('/v1/packs/authorise-download', {
    sealedRefreshHandle: await sealedHandle(),
    packId,
    version,
  }), environment(bucket, envOverrides));
}

test('every registered shard authorises with registry-exact object authority', async () => {
  const { createGatewayHandler } = await import('../gateway/src/handler.js');
  const bucket = createFakeR2Bucket(shardBucketRecords());
  const handler = createGatewayHandler(dependencies());
  for (const row of SHARDS) {
    const response = await authorise(handler, bucket, row);
    assert.equal(response.status, 200, row.packId);
    const body = await response.json();
    assert.equal(body.packId, row.packId);
    assert.equal(body.version, row.version);
    assert.equal(body.signedEnvelopeSha256, row.manifestSha256);
    assert.equal(
      Buffer.from(body.signedManifestEnvelopeBase64, 'base64').byteLength,
      row.manifestBytes,
    );
    assert.deepEqual(body.objects, [
      {
        objectKind: 'manifest', sha256: row.manifestSha256,
        size: row.manifestBytes, etag: row.manifestEtag,
      },
      {
        objectKind: 'archive', sha256: row.archiveSha256,
        size: row.archiveBytes, etag: row.archiveEtag,
      },
    ]);
    assert.deepEqual({ ...body.archiveCapability, capabilityUrl: undefined }, {
      packId: row.packId,
      version: row.version,
      archiveName: row.archiveName,
      sha256: row.archiveSha256,
      compressedBytes: row.archiveBytes,
      etag: row.archiveEtag,
      capabilityUrl: undefined,
    });
    const capabilityUrl = new URL(body.archiveCapability.capabilityUrl);
    assert.equal(capabilityUrl.origin, 'https://b3-gateway.eugnel.uk');
    assert.equal(
      capabilityUrl.pathname,
      `/v1/packs/${row.packId}/${row.version}/${row.archiveName}`,
    );
  }
});

test('a shard capability downloads full and ranged bytes for exactly its own archive', async () => {
  const { createGatewayHandler } = await import('../gateway/src/handler.js');
  const row = SHARDS[0];
  const bucket = createFakeR2Bucket(shardBucketRecords({
    archiveBytesFor: (candidate) =>
      candidate.packId === row.packId ? new Uint8Array(candidate.archiveBytes) : null,
  }));
  const handler = createGatewayHandler(dependencies());
  const authorised = await authorise(handler, bucket, row);
  const { archiveCapability } = await authorised.json();

  const partial = await handler.fetch(
    get(archiveCapability.capabilityUrl, { Range: 'bytes=0-1048575' }),
    environment(bucket),
  );
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), `bytes 0-1048575/${row.archiveBytes}`);
  assert.equal(partial.headers.get('etag'), `"${row.archiveEtag}"`);
  assert.equal((await partial.arrayBuffer()).byteLength, 1_048_576);

  const overshoot = await handler.fetch(
    get(archiveCapability.capabilityUrl, { Range: `bytes=${row.archiveBytes}-` }),
    environment(bucket),
  );
  assert.equal(overshoot.status, 416);
  assert.equal(overshoot.headers.get('content-range'), `bytes */${row.archiveBytes}`);

  // The capability is object-bound: the same bearer token must not fetch a
  // different shard's archive path.
  const other = SHARDS[1];
  const cross = await handler.fetch(get(
    `https://b3-gateway.eugnel.uk/v1/packs/${other.packId}/${other.version}/${other.archiveName}${new URL(archiveCapability.capabilityUrl).search}`,
    { Range: 'bytes=0-99' },
  ), environment(bucket));
  assert.ok(cross.status >= 400);
});

test('shard authorise fails closed on metadata, size and envelope drift', async () => {
  const { createGatewayHandler } = await import('../gateway/src/handler.js');
  const row = SHARDS[2];
  const manifestKey = `packs/${row.packId}/${row.version}/signed-manifest.json`;
  const archiveKey = `packs/${row.packId}/${row.version}/${row.archiveName}`;
  for (const mutate of [
    // Shard objects must carry EMPTY custom metadata — a b3-style label is drift.
    (bucket) => { bucket.records.get(manifestKey).customMetadata = { 'b3-role': 'signed-manifest' }; },
    (bucket) => { bucket.records.get(archiveKey).customMetadata = { 'b3-role': 'archive' }; },
    (bucket) => { bucket.records.get(archiveKey).declaredSize = row.archiveBytes - 1; },
    (bucket) => { bucket.records.get(archiveKey).etag = 'drifted'; },
    (bucket) => { bucket.records.get(manifestKey).etag = 'drifted'; },
    (bucket) => { bucket.records.get(manifestKey).bytes[0] ^= 1; },
  ]) {
    const bucket = createFakeR2Bucket(shardBucketRecords());
    mutate(bucket);
    const response = await authorise(createGatewayHandler(dependencies()), bucket, row);
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /packs\/|drifted|b3rh1|opaque-token/);
  }
});

test('a non-entitled identity cannot authorise any shard', async () => {
  const { createGatewayHandler } = await import('../gateway/src/handler.js');
  const bucket = createFakeR2Bucket(shardBucketRecords());
  const handler = createGatewayHandler(dependencies({ storeResult: { state: 'revoked' } }));
  for (const row of [SHARDS[0], SHARDS[14]]) {
    const response = await authorise(handler, bucket, row);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { code: 'ENTITLEMENT_REVOKED', retryable: false });
  }
  assert.equal(bucket.calls.length, 0);
});

test('unknown packs and drifted versions are rejected before any R2 work', async () => {
  const { createGatewayHandler } = await import('../gateway/src/handler.js');
  const bucket = createFakeR2Bucket(shardBucketRecords());
  const handler = createGatewayHandler(dependencies());
  for (const request of [
    { packId: 'full-ks2-shard-16', version: '1.0.0' },
    { packId: 'full-ks2-shard-1', version: '1.0.0' },
    { packId: SHARDS[0].packId, version: '2.0.0' },
    { packId: SHARDS[0].packId, version: '1.0.0-b3.1' },
  ]) {
    const response = await authorise(handler, bucket, request);
    assert.ok(response.status >= 400, JSON.stringify(request));
  }
  assert.equal(bucket.calls.length, 0);
});
