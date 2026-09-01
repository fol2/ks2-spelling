import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createFakeR2Bucket } from './helpers/fake-r2-bucket.mjs';

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
const SHARD = registry.packs[0];
const envelope = new Uint8Array(await readFile(new URL(
  `./fixtures/packs/full-ks2-shards/${SHARD.packId}.signed-manifest.json`,
  import.meta.url,
)));

let nonce = 80;

function sandboxBucket() {
  return createFakeR2Bucket({
    [`packs/${SHARD.packId}/${SHARD.version}/signed-manifest.json`]: {
      bytes: envelope,
      etag: SHARD.manifestEtag,
      httpMetadata: { contentType: 'application/json' },
    },
    [`packs/${SHARD.packId}/${SHARD.version}/${SHARD.archiveName}`]: {
      bytes: new Uint8Array(0),
      declaredSize: SHARD.archiveBytes,
      etag: SHARD.archiveEtag,
      httpMetadata: { contentType: 'application/zip' },
    },
  });
}

function environment(bucket) {
  return {
    GATEWAY_RATE_LIMIT: { limit: async () => ({ success: true }) },
    ENTITLEMENT_HANDLE_KEY_CURRENT: CURRENT,
    ENTITLEMENT_HANDLE_KEY_PREVIOUS: PREVIOUS,
    GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: '{"declared":true}',
    R2_CAPABILITY_HMAC_KEY: CAPABILITY_SECRET,
    WORKER_VERSION_METADATA: { id: 'worker-version-test' },
    PACKS: bucket,
  };
}

function dependencies() {
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
      refresh: async () => result,
      complete: async () => ({ ...result, acknowledged: true }),
    }),
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
  return new Request(`https://ks2-gateway.eugnel.uk${path}`, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('the production worker refuses sandbox-signed shard objects instead of issuing access', async () => {
  const { createGatewayHandler } = await import('../gateway/src/handler.js');
  const handler = createGatewayHandler({ ...dependencies(), releaseChannel: 'production' });
  const bucket = sandboxBucket();
  const response = await handler.fetch(post('/v1/packs/authorise-download', {
    sealedRefreshHandle: await sealedHandle(),
    packId: SHARD.packId,
    version: SHARD.version,
  }), environment(bucket));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { code: 'GATEWAY_UNAVAILABLE', retryable: true });
});

test('the production worker does not serve the B3 proof pack', async () => {
  const { createGatewayHandler } = await import('../gateway/src/handler.js');
  const handler = createGatewayHandler({ ...dependencies(), releaseChannel: 'production' });
  const response = await handler.fetch(post('/v1/packs/authorise-download', {
    sealedRefreshHandle: await sealedHandle(),
    packId: 'b3-sandbox-proof',
    version: '1.0.0-b3.1',
  }), environment(sandboxBucket()));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { code: 'REQUEST_INVALID', retryable: false });
});

test('the production entry selects the production pack channel', async () => {
  const production = await import('../gateway/src/handler-production.js');
  const sandbox = await import('../gateway/src/handler.js');
  assert.equal(typeof production.default.fetch, 'function');
  assert.equal(typeof sandbox.createGatewayHandler, 'function');
  const source = await readFile(new URL('../gateway/src/handler-production.js', import.meta.url), 'utf8');
  assert.match(source, /releaseChannel: 'production'/u);
});

test('production pack access serves Full KS2 shards and refuses the B3 proof pack', async () => {
  const { createPackAccessService } = await import('../gateway/src/pack-access-service.js');
  const { PRODUCTION_PACK_REGISTRY } = await import(
    '../src/domain/packs/production-pack-registry.js'
  );
  const production = createPackAccessService({ releaseChannel: 'production' });
  const sandbox = createPackAccessService({ releaseChannel: 'sandbox' });
  const shard = PRODUCTION_PACK_REGISTRY[0];
  assert.deepEqual(
    production.assertAuthoriseRequest({
      sealedRefreshHandle: 'b3rh1.1.test-nonce.test-ciphertext',
      packId: shard.packId,
      version: shard.version,
    }),
    {
      sealedRefreshHandle: 'b3rh1.1.test-nonce.test-ciphertext',
      packId: shard.packId,
      version: shard.version,
    },
  );
  assert.equal(
    production.matchesDownloadPath(
      `/v1/packs/${shard.packId}/${shard.version}/${shard.archiveName}`,
    ),
    true,
  );
  assert.equal(
    production.matchesDownloadPath('/v1/packs/b3-sandbox-proof/1.0.0-b3.1/b3-sandbox-proof.zip'),
    false,
  );
  assert.equal(
    sandbox.matchesDownloadPath('/v1/packs/b3-sandbox-proof/1.0.0-b3.1/b3-sandbox-proof.zip'),
    true,
  );
  assert.throws(
    () => production.assertAuthoriseRequest({
      sealedRefreshHandle: 'b3rh1.1.test-nonce.test-ciphertext',
      packId: 'b3-sandbox-proof',
      version: '1.0.0-b3.1',
    }),
    (error) => error.code === 'REQUEST_INVALID' && error.retryable === false,
  );
});
