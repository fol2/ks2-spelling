import assert from 'node:assert/strict';
import test from 'node:test';

import { createPackReconciler } from '../src/app/pack-reconciler.js';
import { projectActiveEntitlements } from '../src/domain/commerce/entitlement-access-projection.js';

const NOW = Date.parse('2026-07-14T00:00:00.000Z');
const PACK_ID = 'b3-sandbox-proof';

function row(version, index, overrides = {}) {
  return {
    packId: PACK_ID,
    version,
    manifestSha256: String(index).repeat(64),
    pathToken: `installed/${PACK_ID}/${version}`,
    activationMarkerSha256: String.fromCharCode(96 + index).repeat(64),
    state: 'ready',
    installedAt: NOW - (10 - index),
    ...overrides,
  };
}

function native(installed, overrides = {}) {
  return {
    packId: installed.packId,
    version: installed.version,
    manifestSha256: installed.manifestSha256,
    installedPathToken: installed.pathToken,
    activationMarkerSha256: installed.activationMarkerSha256,
    ...overrides,
  };
}

function reconcileHarness({
  installed = [], inventory = installed.map((item) => native(item)), active = null,
  jobs = [], entitled = true,
} = {}) {
  const events = [];
  let inventoryCalls = 0;
  const installedRows = structuredClone(installed);
  let activeRow = structuredClone(active);
  const jobRows = structuredClone(jobs);
  const packTransfer = {
    async inventoryInstalledVersions() {
      inventoryCalls += 1;
      return structuredClone(inventory);
    },
    async removeOwnedTemporaryState(request) {
      events.push(`remove:${request.packId}.${request.version}`);
      return { removed: true };
    },
  };
  const packRepository = {
    async listDownloadJobs() { return structuredClone(jobRows); },
    async listInstalledVersions() { return structuredClone(installedRows); },
    async getActiveVersion() { return structuredClone(activeRow); },
    async updateDownloadJob(command) {
      events.push(`job:${command.expectedState}->${command.state}`);
      const index = jobRows.findIndex((job) => job.jobId === command.jobId);
      assert.equal(jobRows[index].state, command.expectedState);
      jobRows[index] = { ...jobRows[index], state: command.state, updatedAt: command.updatedAt };
      return structuredClone(jobRows[index]);
    },
    async registerAndFlipActiveVersion({
      requiredEntitlementId, installedVersion, activeVersion,
    }) {
      events.push('register+flip');
      assert.equal(requiredEntitlementId, 'full-ks2');
      const existing = installedRows.find((row) => row.version === installedVersion.version);
      if (existing) assert.deepEqual(existing, installedVersion);
      else installedRows.push(structuredClone(installedVersion));
      activeRow = structuredClone(activeVersion);
      return structuredClone(activeRow);
    },
    async retireInstalledVersion({ version }) {
      events.push(`retire:${version}`);
      const match = installedRows.find((item) => item.version === version);
      match.state = 'retired';
      return structuredClone(match);
    },
  };
  return {
    events,
    dependencies: {
      packTransfer,
      packRepository,
      activeEntitlementProjection: async () => projectActiveEntitlements(entitled ? [{
        entitlementId: 'full-ks2',
        store: 'apple',
        productId: 'uk.eugnel.ks2spelling.fullks2',
        storeTransactionId: '2000001234567890',
        state: 'active',
        sealedRefreshHandle: 'b3rh1.1.nonce.ciphertext',
        refreshHandleVersion: 1,
        verifiedAt: NOW - 100,
        refreshedAt: NOW - 50,
        revocationAt: null,
      }] : []),
      clock: () => NOW,
    },
    snapshot: () => structuredClone({ active: activeRow, installed: installedRows, jobs: jobRows }),
    inventoryCalls: () => inventoryCalls,
  };
}

test('startup records an orphan staging failure durably before removing owned temporary state', async () => {
  const job = {
    jobId: `${PACK_ID}.1.0.0`, packId: PACK_ID, version: '1.0.0',
    manifestSha256: '1'.repeat(64), archiveName: `${PACK_ID}.zip`,
    archiveSha256: 'f'.repeat(64), expectedBytes: 10, completedBytes: 10,
    etag: 'etag', state: 'extracting', updatedAt: NOW - 10,
  };
  const harness = reconcileHarness({ jobs: [job] });
  const result = await createPackReconciler(harness.dependencies).reconcileAtStartup();
  assert.deepEqual(harness.events, [
    'job:extracting->failed',
    `remove:${PACK_ID}.1.0.0`,
  ]);
  assert.deepEqual(result.removedTemporary, [job.jobId]);
});

test('startup preserves a fully downloaded verified archive and staging for later activation', async () => {
  const job = {
    jobId: `${PACK_ID}.1.0.0`, packId: PACK_ID, version: '1.0.0',
    manifestSha256: '1'.repeat(64), archiveName: `${PACK_ID}.zip`,
    archiveSha256: 'f'.repeat(64), expectedBytes: 10, completedBytes: 10,
    etag: 'etag', state: 'downloaded', updatedAt: NOW - 10,
  };
  const harness = reconcileHarness({ jobs: [job] });
  const before = harness.snapshot();
  const result = await createPackReconciler(harness.dependencies).reconcileAtStartup();
  assert.deepEqual(harness.events, []);
  assert.deepEqual(result.removedTemporary, []);
  assert.deepEqual(harness.snapshot(), before);
});

test('startup completes an unambiguous native rename left before DB registration', async () => {
  const orphan = row('2.0.0', 2);
  const job = {
    jobId: `${PACK_ID}.2.0.0`, packId: PACK_ID, version: '2.0.0',
    manifestSha256: orphan.manifestSha256, archiveName: `${PACK_ID}.zip`,
    archiveSha256: 'f'.repeat(64), expectedBytes: 10, completedBytes: 10,
    etag: 'etag', state: 'extracting', updatedAt: NOW - 10,
  };
  const harness = reconcileHarness({ inventory: [native(orphan)], jobs: [job] });
  const result = await createPackReconciler(harness.dependencies).reconcileAtStartup();
  assert.deepEqual(harness.events, ['register+flip', 'job:extracting->ready']);
  assert.equal(harness.snapshot().active.version, '2.0.0');
  assert.equal(result.readiness[0].ready, true);
});

test('missing or corrupt active marker rolls back to the newest previous ready and verified version', async () => {
  const previous = row('1.0.0', 1);
  const corrupt = row('2.0.0', 2);
  const harness = reconcileHarness({
    installed: [previous, corrupt],
    inventory: [native(previous), native(corrupt, { activationMarkerSha256: 'f'.repeat(64) })],
    active: {
      packId: PACK_ID, version: corrupt.version,
      manifestSha256: corrupt.manifestSha256, pathToken: corrupt.pathToken,
      activatedAt: NOW - 1,
    },
  });
  const result = await createPackReconciler(harness.dependencies).reconcileAtStartup();
  assert.deepEqual(harness.events, ['register+flip']);
  assert.equal(result.readiness[0].version, '1.0.0');
  assert.equal(result.readiness[0].ready, true);
});

test('startup rejects foreign native or durable job authority before any mutation', async () => {
  const foreign = row('1.0.0', 1, {
    packId: 'foreign-pack', pathToken: 'installed/foreign-pack/1.0.0',
  });
  const foreignJob = {
    jobId: 'foreign-pack.1.0.0', packId: 'foreign-pack', version: '1.0.0',
    manifestSha256: foreign.manifestSha256, archiveName: 'foreign-pack.zip',
    archiveSha256: 'f'.repeat(64), expectedBytes: 10, completedBytes: 10,
    etag: 'etag', state: 'extracting', updatedAt: NOW - 10,
  };
  for (const options of [
    { inventory: [native(foreign)] },
    { jobs: [foreignJob] },
  ]) {
    const harness = reconcileHarness(options);
    const before = harness.snapshot();
    await assert.rejects(
      createPackReconciler(harness.dependencies).reconcileAtStartup(),
      { code: 'PACK_RECONCILIATION_PACK_AUTHORITY_MISMATCH' },
    );
    assert.deepEqual(harness.events, []);
    assert.deepEqual(harness.snapshot(), before);
  }
});

test('an entitlement revoked at the checked registration boundary locks recovery without mutation', async () => {
  const orphan = row('2.0.0', 2);
  const job = {
    jobId: `${PACK_ID}.2.0.0`, packId: PACK_ID, version: '2.0.0',
    manifestSha256: orphan.manifestSha256, archiveName: `${PACK_ID}.zip`,
    archiveSha256: 'f'.repeat(64), expectedBytes: 10, completedBytes: 10,
    etag: 'etag', state: 'extracting', updatedAt: NOW - 10,
  };
  const harness = reconcileHarness({ inventory: [native(orphan)], jobs: [job] });
  harness.dependencies.packRepository.registerAndFlipActiveVersion = async () => {
    throw Object.assign(new Error('sqlite_pack_entitlement_inactive'), {
      code: 'sqlite_pack_entitlement_inactive',
    });
  };
  const before = harness.snapshot();
  const result = await createPackReconciler(harness.dependencies).reconcileAtStartup();
  assert.equal(result.accessLocked, true);
  assert.deepEqual(harness.events, []);
  assert.deepEqual(harness.snapshot(), before);
});

test('an entitlement revoked at the checked rollback boundary retains the previous pointer and bytes', async () => {
  const previous = row('1.0.0', 1);
  const corrupt = row('2.0.0', 2);
  const harness = reconcileHarness({
    installed: [previous, corrupt],
    inventory: [native(previous), native(corrupt, { activationMarkerSha256: 'f'.repeat(64) })],
    active: {
      packId: PACK_ID, version: corrupt.version,
      manifestSha256: corrupt.manifestSha256, pathToken: corrupt.pathToken,
      activatedAt: NOW - 1,
    },
  });
  harness.dependencies.packRepository.registerAndFlipActiveVersion = async () => {
    throw Object.assign(new Error('sqlite_pack_entitlement_inactive'), {
      code: 'sqlite_pack_entitlement_inactive',
    });
  };
  const before = harness.snapshot();
  const result = await createPackReconciler(harness.dependencies).reconcileAtStartup();
  assert.equal(result.accessLocked, true);
  assert.deepEqual(harness.events, []);
  assert.deepEqual(harness.snapshot(), before);
});

test('a DB-only active pointer to a missing native path is visible and fails closed to no-pack', async () => {
  const missing = row('2.0.0', 2);
  const active = {
    packId: PACK_ID, version: missing.version,
    manifestSha256: missing.manifestSha256, pathToken: missing.pathToken,
    activatedAt: NOW - 1,
  };
  const harness = reconcileHarness({ installed: [missing], inventory: [], active });
  const result = await createPackReconciler(harness.dependencies).reconcileAtStartup();
  assert.deepEqual(harness.events, []);
  assert.equal(result.readiness[0].ready, false);
  assert.equal(result.readiness[0].version, null);
  assert.deepEqual(harness.snapshot().active, active, 'ambiguous stale pointer is not rewritten');
});

test('tied rollback candidates are ambiguous and never change the active pointer', async () => {
  const left = row('1.0.0', 1, { installedAt: NOW - 10 });
  const right = row('2.0.0', 2, { installedAt: NOW - 10 });
  const harness = reconcileHarness({ installed: [left, right], active: null });
  const result = await createPackReconciler(harness.dependencies).reconcileAtStartup();
  assert.deepEqual(harness.events, []);
  assert.equal(result.readiness[0].ready, false);
  assert.equal(harness.snapshot().active, null);
});

test('multiple unregistered native recovery candidates remain inert and recoverable on ambiguity', async () => {
  const left = row('1.0.0', 1);
  const right = row('2.0.0', 2);
  const jobs = [left, right].map((item) => ({
    jobId: `${PACK_ID}.${item.version}`, packId: PACK_ID, version: item.version,
    manifestSha256: item.manifestSha256, archiveName: `${PACK_ID}.zip`,
    archiveSha256: 'f'.repeat(64), expectedBytes: 10, completedBytes: 10,
    etag: 'etag', state: 'extracting', updatedAt: NOW - 10,
  }));
  const harness = reconcileHarness({ inventory: [native(left), native(right)], jobs });
  const result = await createPackReconciler(harness.dependencies).reconcileAtStartup();
  assert.deepEqual(harness.events, []);
  assert.equal(result.readiness[0].ready, false);
  assert.equal(harness.snapshot().active, null);
  assert.deepEqual(harness.snapshot().jobs.map((job) => job.state), ['extracting', 'extracting']);
});

test('native corrupt-marker inventory rejection fails closed before DB, file or history mutation', async () => {
  const current = row('2.0.0', 2);
  const active = {
    packId: PACK_ID, version: current.version,
    manifestSha256: current.manifestSha256, pathToken: current.pathToken,
    activatedAt: NOW - 1,
  };
  const harness = reconcileHarness({ installed: [current], active });
  harness.dependencies.packTransfer.inventoryInstalledVersions = async () => {
    throw Object.assign(new Error('corrupt activation marker'), { code: 'PACK_TRANSFER_REJECTED' });
  };
  const before = harness.snapshot();
  await assert.rejects(
    createPackReconciler(harness.dependencies).reconcileAtStartup(),
    { code: 'PACK_TRANSFER_REJECTED' },
  );
  assert.deepEqual(harness.events, []);
  assert.deepEqual(harness.snapshot(), before);
});

test('revocation locks access while retaining installed bytes, history and active pointer', async () => {
  const current = row('2.0.0', 2);
  const active = {
    packId: PACK_ID, version: current.version,
    manifestSha256: current.manifestSha256, pathToken: current.pathToken,
    activatedAt: NOW - 1,
  };
  const harness = reconcileHarness({ installed: [current], active, entitled: false });
  const before = harness.snapshot();
  const result = await createPackReconciler(harness.dependencies).reconcileAtStartup();
  assert.equal(result.accessLocked, true);
  assert.equal(result.readiness[0].ready, false);
  assert.deepEqual(harness.events, []);
  assert.deepEqual(harness.snapshot(), before);
});

test('retirement preserves exactly the active version and newest previous ready version', async () => {
  const versions = [row('1.0.0', 1), row('2.0.0', 2), row('3.0.0', 3)];
  const active = {
    packId: PACK_ID, version: '1.0.0', manifestSha256: '1'.repeat(64),
    pathToken: `installed/${PACK_ID}/1.0.0`, activatedAt: NOW - 1,
  };
  const harness = reconcileHarness({ installed: versions, active });
  const result = await createPackReconciler(harness.dependencies)
    .retireOldVersions({ packId: PACK_ID, keepVersions: 2 });
  assert.deepEqual(result.retired, ['2.0.0']);
  assert.deepEqual(harness.events, ['retire:2.0.0']);
  assert.equal(harness.inventoryCalls(), 1);
});

test('retirement validates fixed pack native and database authority before any mutation', async () => {
  const versions = [row('1.0.0', 1), row('2.0.0', 2), row('3.0.0', 3)];
  const active = {
    packId: PACK_ID, version: '3.0.0', manifestSha256: '3'.repeat(64),
    pathToken: `installed/${PACK_ID}/3.0.0`, activatedAt: NOW - 1,
  };
  const variants = [
    versions.slice(1).map((item) => native(item)),
    versions.map((item) => native(item)).concat(native(row('4.0.0', 4))),
    versions.map((item) => native(item)).map((item, index) =>
      index === 1 ? { ...item, activationMarkerSha256: 'f'.repeat(64) } : item),
    versions.map((item) => native(item)).concat(native(versions[0])),
  ];
  for (const inventory of variants) {
    const harness = reconcileHarness({ installed: versions, active, inventory });
    const before = harness.snapshot();
    await assert.rejects(
      createPackReconciler(harness.dependencies)
        .retireOldVersions({ packId: PACK_ID, keepVersions: 2 }),
      { code: 'PACK_RECONCILIATION_RETIREMENT_AUTHORITY_MISMATCH' },
    );
    assert.deepEqual(harness.events, []);
    assert.deepEqual(harness.snapshot(), before);
  }
});

test('retirement rejects foreign pack input and never retires the sole valid rollback', async () => {
  const activeRow = row('3.0.0', 3);
  const rollback = row('2.0.0', 2);
  const active = {
    packId: PACK_ID, version: activeRow.version, manifestSha256: activeRow.manifestSha256,
    pathToken: activeRow.pathToken, activatedAt: NOW - 1,
  };
  const harness = reconcileHarness({ installed: [rollback, activeRow], active });
  await assert.rejects(
    createPackReconciler(harness.dependencies)
      .retireOldVersions({ packId: 'foreign-pack', keepVersions: 2 }),
    { code: 'PACK_RECONCILIATION_PACK_AUTHORITY_MISMATCH' },
  );
  const result = await createPackReconciler(harness.dependencies)
    .retireOldVersions({ packId: PACK_ID, keepVersions: 2 });
  assert.deepEqual(result.retired, []);
  assert.deepEqual(harness.events, []);
});
