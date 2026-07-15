import assert from 'node:assert/strict';
import test from 'node:test';

const SHA = 'a'.repeat(64);
const CAPABILITY = `https://b3-gateway.eugnel.uk/v1/packs/b3-sandbox-proof/1.0.0-b3.1/b3-sandbox-proof.zip?expires=1783900800&cap=${'A'.repeat(43)}`;

function nativePlugin(overrides = {}) {
  return {
    getFreeBytes: async () => ({ freeBytes: 9_000_000 }),
    downloadRange: async () => ({
      status: 206,
      startByte: 0,
      endByteExclusive: 100,
      totalBytes: 1_324,
      bytesWritten: 100,
      etag: 'fixed-etag',
    }),
    inspectAndExtract: async () => ({
      archiveSha256: SHA,
      manifestSha256: SHA,
      extractedBytes: 1_082,
      fileCount: 2,
      stagingToken: 'staging/b3-sandbox-proof/1.0.0-b3.1',
    }),
    sealAndInstall: async () => ({
      installedPathToken: 'installed/b3-sandbox-proof/1.0.0-b3.1',
      activationMarkerSha256: SHA,
    }),
    inventoryInstalledVersions: async () => ({ versions: [] }),
    removeOwnedTemporaryState: async () => ({ removed: true }),
    ...overrides,
  };
}

test('Capacitor PackTransfer exposes the exact six-method port and validates native results', async () => {
  const { createCapacitorPackTransfer } = await import(
    '../src/platform/pack-transfer/capacitor-pack-transfer.js'
  );
  const calls = [];
  const transfer = createCapacitorPackTransfer({
    PackTransfer: nativePlugin({
      downloadRange: async (request) => {
        calls.push(request);
        return {
          status: 206,
          startByte: 0,
          endByteExclusive: 100,
          totalBytes: 1_324,
          bytesWritten: 100,
          etag: 'fixed-etag',
        };
      },
    }),
  });
  assert.deepEqual(Reflect.ownKeys(transfer), [
    'getFreeBytes',
    'downloadRange',
    'inspectAndExtract',
    'sealAndInstall',
    'inventoryInstalledVersions',
    'removeOwnedTemporaryState',
  ]);
  assert.equal(await transfer.getFreeBytes(), 9_000_000);
  const request = {
    capabilityUrl: CAPABILITY,
    packId: 'b3-sandbox-proof',
    version: '1.0.0-b3.1',
    archiveName: 'b3-sandbox-proof.zip',
    startByte: 0,
    endByteExclusive: 100,
    truncate: false,
  };
  assert.deepEqual(await transfer.downloadRange(request), {
    status: 206,
    startByte: 0,
    endByteExclusive: 100,
    totalBytes: 1_324,
    bytesWritten: 100,
    etag: 'fixed-etag',
  });
  assert.deepEqual(calls, [request]);
  assert.equal(Object.isFrozen(transfer), true);
});
test('Capacitor PackTransfer validates every request before invoking native code', async () => {
  const { createCapacitorPackTransfer } = await import(
    '../src/platform/pack-transfer/capacitor-pack-transfer.js'
  );
  let calls = 0;
  const transfer = createCapacitorPackTransfer({
    PackTransfer: nativePlugin({ downloadRange: async () => { calls += 1; } }),
  });
  for (const capabilityUrl of [
    CAPABILITY.replace('https:', 'http:'),
    CAPABILITY.replace('b3-gateway.eugnel.uk', 'evil.example'),
    `${CAPABILITY}&extra=1`,
    CAPABILITY.replace('?expires=', '?cap=').replace('&cap=', '&expires='),
  ]) {
    await assert.rejects(transfer.downloadRange({
      capabilityUrl,
      packId: 'b3-sandbox-proof',
      version: '1.0.0-b3.1',
      archiveName: 'b3-sandbox-proof.zip',
      startByte: 0,
      endByteExclusive: 100,
      truncate: false,
    }), /capability/i);
  }
  assert.equal(calls, 0);
});

test('Capacitor PackTransfer closes native response shapes and redacts native errors', async () => {
  const { createCapacitorPackTransfer } = await import(
    '../src/platform/pack-transfer/capacitor-pack-transfer.js'
  );
  const leaking = createCapacitorPackTransfer({
    PackTransfer: nativePlugin({ getFreeBytes: async () => ({ freeBytes: 1, path: '/private' }) }),
  });
  await assert.rejects(leaking.getFreeBytes(), /closed|fields/i);

  const failing = createCapacitorPackTransfer({
    PackTransfer: nativePlugin({ getFreeBytes: async () => { throw new Error('secret URL'); } }),
  });
  await assert.rejects(
    failing.getFreeBytes(),
    (error) => error.code === 'PACK_TRANSFER_NATIVE_FAILURE' && !error.message.includes('secret'),
  );
});

test('Capacitor PackTransfer preserves only the two safe download recovery codes', async () => {
  const { createCapacitorPackTransfer } = await import(
    '../src/platform/pack-transfer/capacitor-pack-transfer.js'
  );
  const request = {
    capabilityUrl: CAPABILITY,
    packId: 'b3-sandbox-proof',
    version: '1.0.0-b3.1',
    archiveName: 'b3-sandbox-proof.zip',
    startByte: 0,
    endByteExclusive: 100,
    truncate: false,
  };
  for (const code of ['PACK_CAPABILITY_EXPIRED', 'PACK_RANGE_NOT_SATISFIABLE']) {
    const transfer = createCapacitorPackTransfer({
      PackTransfer: nativePlugin({
        downloadRange: async () => {
          throw Object.assign(new Error('private native detail'), { code });
        },
      }),
    });
    await assert.rejects(
      transfer.downloadRange(request),
      (error) => error.code === code && !error.message.includes('private native detail'),
    );
  }

  for (const code of ['PACK_TRANSFER_REJECTED', 'PRIVATE_NATIVE_CODE', '', undefined]) {
    const transfer = createCapacitorPackTransfer({
      PackTransfer: nativePlugin({
        downloadRange: async () => {
          throw Object.assign(new Error('secret capability URL'), { code });
        },
      }),
    });
    await assert.rejects(
      transfer.downloadRange(request),
      (error) => error.code === 'PACK_TRANSFER_NATIVE_FAILURE'
        && !error.message.includes('secret capability URL'),
    );
  }
});
