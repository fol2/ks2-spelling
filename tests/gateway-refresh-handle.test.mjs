import assert from 'node:assert/strict';
import test from 'node:test';

const CURRENT = `v2:${Buffer.alloc(32, 2).toString('base64url')}`;
const PREVIOUS = `v1:${Buffer.alloc(32, 1).toString('base64url')}`;
const CONTEXT = Object.freeze({
  store: 'google',
  productId: 'full_ks2',
  environment: 'sandbox',
  applicationId: 'uk.eugnel.ks2spelling',
});
const PAYLOAD = Object.freeze({
  ...CONTEXT,
  storeTransactionId: 'GPA.1234-5678-9012-34567',
  opaqueProof: 'opaque-google-purchase-token',
  issuedAt: 1_782_865_800,
});

test('refresh handle key records are closed, canonical, distinct 32-byte versions', async () => {
  const { parseRefreshHandleKeyring } = await import('../gateway/src/refresh-handle.js');
  const keyring = parseRefreshHandleKeyring({ current: CURRENT, previous: PREVIOUS });
  assert.deepEqual({ current: keyring.current.version, previous: keyring.previous.version }, {
    current: 2,
    previous: 1,
  });

  for (const [current, previous] of [
    [`v0:${Buffer.alloc(32).toString('base64url')}`, PREVIOUS],
    [`v01:${Buffer.alloc(32).toString('base64url')}`, PREVIOUS],
    [`v2:${Buffer.alloc(31).toString('base64url')}`, PREVIOUS],
    [`v2:${Buffer.alloc(32).toString('base64')}=`, PREVIOUS],
    [`v2147483648:${Buffer.alloc(32).toString('base64url')}`, PREVIOUS],
    [CURRENT, `v2:${Buffer.alloc(32, 3).toString('base64url')}`],
    [CURRENT, `v1:${Buffer.alloc(32, 2).toString('base64url')}`],
  ]) {
    assert.throws(() => parseRefreshHandleKeyring({ current, previous }), /refresh handle/i);
  }
});

test('worst-case Apple proof, handle request and success response fit the shared byte budget', async () => {
  const {
    MAX_GATEWAY_BODY_BYTES,
    MAX_OPAQUE_PROOF_CHARS,
    MAX_SEALED_REFRESH_HANDLE_CHARS,
    gatewayJsonByteLength,
  } = await import('../src/platform/gateway/gateway-payload-limits.js');
  const {
    createNonceRegistry,
    parseRefreshHandleKeyring,
    sealRefreshHandle,
  } = await import('../gateway/src/refresh-handle.js');
  const keyring = parseRefreshHandleKeyring({
    current: `v2147483647:${Buffer.alloc(32, 2).toString('base64url')}`,
    previous: `v2147483646:${Buffer.alloc(32, 1).toString('base64url')}`,
  });
  const handle = await sealRefreshHandle({
    store: 'apple',
    productId: 'uk.eugnel.ks2spelling.fullks2',
    environment: 'sandbox',
    applicationId: 'uk.eugnel.ks2spelling',
    storeTransactionId: '9'.repeat(32),
    opaqueProof: 'p'.repeat(MAX_OPAQUE_PROOF_CHARS),
    issuedAt: Number.MAX_SAFE_INTEGER,
  }, {
    keyring,
    randomBytes: () => new Uint8Array(12).fill(11),
    nonceRegistry: createNonceRegistry(),
  });
  assert.equal(handle.length, 64_412);
  assert.ok(handle.length <= MAX_SEALED_REFRESH_HANDLE_CHARS);
  assert.equal(gatewayJsonByteLength({ sealedRefreshHandle: handle }), 64_438);
  const success = {
    store: 'apple', productId: 'uk.eugnel.ks2spelling.fullks2', environment: 'sandbox',
    applicationId: 'uk.eugnel.ks2spelling', entitlementId: 'full-ks2', state: 'revoked',
    storeTransactionId: '9'.repeat(32), sealedRefreshHandle: handle,
    refreshHandleVersion: 2_147_483_647,
    traceId: 'ffffffff-ffff-4fff-bfff-ffffffffffff', workerVersionId: 'w'.repeat(128),
    workerScriptAuthoritySha256: 'f'.repeat(64),
  };
  assert.equal(gatewayJsonByteLength(success), 64_992);
  assert.ok(gatewayJsonByteLength(success) <= MAX_GATEWAY_BODY_BYTES);
});

test('AES-GCM handle binds prefix, version, context, payload and exact AAD', async () => {
  const {
    openRefreshHandle,
    parseRefreshHandleKeyring,
    sealRefreshHandle,
  } = await import('../gateway/src/refresh-handle.js');
  const keyring = parseRefreshHandleKeyring({ current: CURRENT, previous: PREVIOUS });
  const handle = await sealRefreshHandle(PAYLOAD, {
    keyring,
    randomBytes: () => Uint8Array.from({ length: 12 }, (_, index) => index + 1),
  });
  assert.match(handle, /^b3rh1\.2\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(await openRefreshHandle(handle, CONTEXT, { keyring }), {
    format: 'b3rh1',
    keyVersion: 2,
    ...PAYLOAD,
  });
  for (const context of [
    { ...CONTEXT, productId: 'wrong' },
    { ...CONTEXT, store: 'apple' },
    { ...CONTEXT, environment: 'production' },
    { ...CONTEXT, applicationId: 'other.app' },
  ]) {
    await assert.rejects(openRefreshHandle(handle, context, { keyring }), /refresh handle/i);
  }
  const parts = handle.split('.');
  await assert.rejects(openRefreshHandle(['b3rh2', ...parts.slice(1)].join('.'), CONTEXT, { keyring }));
  await assert.rejects(openRefreshHandle([parts[0], '1', ...parts.slice(2)].join('.'), CONTEXT, { keyring }));
});

test('previous-key handle opens and reseals under current version', async () => {
  const {
    parseRefreshHandleKeyring,
    resealRefreshHandle,
    sealRefreshHandle,
  } = await import('../gateway/src/refresh-handle.js');
  const keyring = parseRefreshHandleKeyring({ current: CURRENT, previous: PREVIOUS });
  const oldKeyring = parseRefreshHandleKeyring({
    current: PREVIOUS,
    previous: `v3:${Buffer.alloc(32, 3).toString('base64url')}`,
  });
  const oldHandle = await sealRefreshHandle(PAYLOAD, {
    keyring: oldKeyring,
    randomBytes: () => new Uint8Array(12).fill(7),
  });
  const result = await resealRefreshHandle(oldHandle, CONTEXT, {
    keyring,
    randomBytes: () => new Uint8Array(12).fill(8),
  });
  assert.equal(result.refreshHandleVersion, 2);
  assert.equal(result.rotated, true);
  assert.match(result.sealedRefreshHandle, /^b3rh1\.2\./);
  assert.deepEqual(result.payload, { format: 'b3rh1', keyVersion: 1, ...PAYLOAD });
});

test('nonce generation retries collisions and 10,000 handles remain unique', async () => {
  const { createNonceRegistry, parseRefreshHandleKeyring, sealRefreshHandle } = await import(
    '../gateway/src/refresh-handle.js'
  );
  const keyring = parseRefreshHandleKeyring({ current: CURRENT, previous: PREVIOUS });
  const registry = createNonceRegistry({ maxEntries: 12_000, maxAttempts: 4 });
  let counter = 0;
  const randomBytes = () => {
    const bytes = new Uint8Array(12);
    new DataView(bytes.buffer).setBigUint64(4, BigInt(counter++));
    return bytes;
  };
  const handles = new Set();
  for (let index = 0; index < 10_000; index += 1) {
    handles.add(await sealRefreshHandle({ ...PAYLOAD, issuedAt: index + 1 }, {
      keyring,
      randomBytes,
      nonceRegistry: registry,
    }));
  }
  assert.equal(handles.size, 10_000);

  let calls = 0;
  const collisionRegistry = createNonceRegistry({ maxEntries: 8, maxAttempts: 3 });
  const colliding = () => new Uint8Array(12).fill(calls++ < 2 ? 5 : 6);
  await sealRefreshHandle(PAYLOAD, { keyring, randomBytes: colliding, nonceRegistry: collisionRegistry });
  const retried = await sealRefreshHandle(PAYLOAD, {
    keyring,
    randomBytes: colliding,
    nonceRegistry: collisionRegistry,
  });
  assert.match(retried, /^b3rh1\.2\./);
});
