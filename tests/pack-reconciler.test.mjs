import assert from 'node:assert/strict';
import test from 'node:test';

import { createPackReconciler } from '../src/app/pack-reconciler.js';
import { projectActiveEntitlements } from '../src/domain/commerce/entitlement-access-projection.js';
import { B3_PACK_REGISTRY } from '../src/domain/packs/b3-pack-registry.js';

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
  jobs = [], entitled = true, lockedPackIds = [],
} = {}) {
  const events = [];
  let inventoryCalls = 0;
  const installedRows = structuredClone(installed);
  const activeRows = {};
  for (const row of Array.isArray(active) ? active : [active].filter(Boolean)) {
    activeRows[row.packId] = structuredClone(row);
  }
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
    async deleteDownloadJob(command) {
      events.push(`delete-job:${command.jobId}`);
      const index = jobRows.findIndex((job) => job.jobId === command.jobId);
      const existed = index !== -1;
      if (existed) jobRows.splice(index, 1);
      return existed;
    },
    async listDownloadJobs() { return structuredClone(jobRows); },
    // Both reads are per-pack in the real repository. A fake that ignores the
    // packId makes an N-pack reconciliation look like N copies of one pack,
    // which is exactly the divergence the shard tests below exercise.
    async listInstalledVersions({ packId }) {
      return structuredClone(installedRows.filter((item) => item.packId === packId));
    },
    async getActiveVersion({ packId }) {
      return activeRows[packId] ? structuredClone(activeRows[packId]) : null;
    },
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
      events.push(`register+flip:${activeVersion.packId}`);
      assert.equal(requiredEntitlementId, 'full-ks2');
      if (lockedPackIds.includes(activeVersion.packId)) {
        throw Object.assign(new Error('entitlement inactive'), {
          code: 'sqlite_pack_entitlement_inactive',
        });
      }
      const existing = installedRows.find((row) =>
        row.packId === installedVersion.packId &&
        row.version === installedVersion.version);
      if (existing) assert.deepEqual(existing, installedVersion);
      else installedRows.push(structuredClone(installedVersion));
      activeRows[activeVersion.packId] = structuredClone(activeVersion);
      return structuredClone(activeRows[activeVersion.packId]);
    },
    async retireInstalledVersion({ packId, version }) {
      events.push(`retire:${version}`);
      const match = installedRows.find((item) =>
        item.packId === packId && item.version === version);
      match.state = 'retired';
      return structuredClone(match);
    },
  };
  return {
    events,
    dependencies: {
      entitlementId: 'full-ks2',
      // The mechanics under test predate the E2.7 join flip; the harness pins
      // the reconciler to the registry's b3 row exactly as the B3 proof lane does.
      packIds: [PACK_ID],
      registry: B3_PACK_REGISTRY,
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
    snapshot: () => structuredClone({
      active: activeRows[PACK_ID] ?? null,
      activeByPackId: activeRows,
      installed: installedRows,
      jobs: jobRows,
    }),
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
  assert.deepEqual(harness.events, [`register+flip:${PACK_ID}`, 'job:extracting->ready']);
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
  assert.deepEqual(harness.events, [`register+flip:${PACK_ID}`]);
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

// E2.7 join flip: a sandbox device carrying prior b3-sandbox-proof state must
// start cleanly under the shard catalogue — deliberate retirement, not a crash.
test('startup retires registry-known uncatalogued pack state instead of throwing', async () => {
  const b3Installed = row('1.0.0-b3.1', 1);
  const b3Job = {
    jobId: `${PACK_ID}.1.0.0-b3.1`, packId: PACK_ID, version: '1.0.0-b3.1',
    manifestSha256: b3Installed.manifestSha256, archiveName: `${PACK_ID}.zip`,
    archiveSha256: 'f'.repeat(64), expectedBytes: 10, completedBytes: 10,
    etag: 'a'.repeat(32), state: 'ready', updatedAt: NOW - 10,
  };
  const harness = reconcileHarness({
    installed: [b3Installed],
    inventory: [native(b3Installed)],
    active: {
      packId: PACK_ID, version: b3Installed.version,
      manifestSha256: b3Installed.manifestSha256, pathToken: b3Installed.pathToken,
      activatedAt: NOW - 1,
    },
    jobs: [b3Job],
  });
  // The flipped catalogue join is the default pack set: no override.
  delete harness.dependencies.packIds;
  const result = await createPackReconciler(harness.dependencies).reconcileAtStartup();
  assert.deepEqual([...result.retiredPacks], [`${PACK_ID}.1.0.0-b3.1`]);
  // Staging first, then the row that names it: a native removal that rejects
  // must leave a job row to retry against, never orphaned bytes.
  assert.deepEqual(harness.events, [
    `remove:${PACK_ID}.1.0.0-b3.1`,
    `delete-job:${PACK_ID}.1.0.0-b3.1`,
  ]);
  // Every catalogued shard reports missing (nothing installed) and nothing crashed.
  assert.equal(result.accessLocked, false);
  assert.equal(result.readiness.length, 15);
  assert.ok(result.readiness.every(({ ready, version }) => ready === false && version === null));
  assert.deepEqual(harness.snapshot().jobs, []);
});

test('startup still fails closed on a genuinely foreign pack under the flipped catalogue', async () => {
  const foreign = row('1.0.0', 1, {
    packId: 'foreign-pack', pathToken: 'installed/foreign-pack/1.0.0',
  });
  const harness = reconcileHarness({ inventory: [native(foreign)] });
  delete harness.dependencies.packIds;
  await assert.rejects(
    createPackReconciler(harness.dependencies).reconcileAtStartup(),
    { code: 'PACK_RECONCILIATION_PACK_AUTHORITY_MISMATCH' },
  );
  assert.deepEqual(harness.events, []);
});

test('the explicit packIds override validates against the registry and entitlement', () => {
  const harness = reconcileHarness();
  assert.throws(
    () => createPackReconciler({ ...harness.dependencies, packIds: ['unregistered-pack'] }),
    /not registered/,
  );
  assert.throws(
    () => createPackReconciler({ ...harness.dependencies, packIds: [] }),
    /at least one tracked pack/,
  );
});

// --- E2.7 N-shard reconciliation -------------------------------------------
// The shipping catalogue reconciles 15 packs in one pass, so per-shard truth
// (installed, missing, locked) has to survive the loop rather than being
// flattened into one pack's answer.

const SHARD_IDS = Object.freeze(Array.from({ length: 15 }, (_, index) =>
  `full-ks2-shard-${String(index + 1).padStart(2, '0')}`));

function shardRow(packId, index) {
  return row('1.0.0', index, {
    packId,
    pathToken: `installed/${packId}/1.0.0`,
    manifestSha256: packId.slice(-2).repeat(32),
    activationMarkerSha256: `a${packId.slice(-2)}`.padEnd(4, 'f').repeat(16),
  });
}

function shardActive(installed) {
  return {
    packId: installed.packId,
    version: installed.version,
    manifestSha256: installed.manifestSha256,
    pathToken: installed.pathToken,
    activatedAt: NOW - 1,
  };
}

test('startup reports each shard on its own evidence, not the first shard fifteen times', async () => {
  const installedShards = [SHARD_IDS[0], SHARD_IDS[7], SHARD_IDS[14]]
    .map((packId, index) => shardRow(packId, index + 1));
  const harness = reconcileHarness({
    installed: installedShards,
    active: installedShards.map(shardActive),
  });
  delete harness.dependencies.packIds;
  const result = await createPackReconciler(harness.dependencies).reconcileAtStartup();
  assert.equal(result.readiness.length, 15);
  const ready = result.readiness.filter((entry) => entry.ready).map((entry) => entry.packId);
  assert.deepEqual(ready, [SHARD_IDS[0], SHARD_IDS[7], SHARD_IDS[14]]);
  for (const entry of result.readiness) {
    assert.equal(entry.version, ready.includes(entry.packId) ? '1.0.0' : null);
  }
  // Nothing was recovered or mutated: every installed shard was already active.
  assert.deepEqual(harness.events, []);
});

test('one shard locked mid-loop locks the rest of the pass and recovers nothing further', async () => {
  // Every shard has native bytes and a job to register, so without the lock
  // all fifteen would recover. The fourth shard's registration is refused
  // because the entitlement went inactive between packs.
  const installedShards = SHARD_IDS.map((packId, index) => shardRow(packId, index + 1));
  const harness = reconcileHarness({
    inventory: installedShards.map((item) => native(item)),
    jobs: installedShards.map((item) => ({
      jobId: `${item.packId}.1.0.0`, packId: item.packId, version: '1.0.0',
      manifestSha256: item.manifestSha256, archiveName: `${item.packId}.zip`,
      archiveSha256: 'f'.repeat(64), expectedBytes: 10, completedBytes: 10,
      etag: 'etag', state: 'extracting', updatedAt: NOW - 10,
    })),
    lockedPackIds: [SHARD_IDS[3]],
  });
  delete harness.dependencies.packIds;
  const result = await createPackReconciler(harness.dependencies).reconcileAtStartup();
  assert.equal(result.accessLocked, true);
  assert.deepEqual([...result.recovered], SHARD_IDS.slice(0, 3).map((packId) => `${packId}.1.0.0`));
  const registered = harness.events.filter((event) => event.startsWith('register+flip:'));
  assert.deepEqual(registered, SHARD_IDS.slice(0, 4).map((packId) => `register+flip:${packId}`));
  // The three registered before the lock stay ready; everything from the
  // locked shard on reports locked rather than ready.
  assert.deepEqual(
    result.readiness.map((entry) => entry.ready),
    SHARD_IDS.map((_, index) => index < 3),
  );
  assert.ok(result.readiness.every((entry, index) => entry.accessLocked === (index >= 3)));
});

function recoverableJob(item) {
  return {
    jobId: `${item.packId}.1.0.0`, packId: item.packId, version: '1.0.0',
    manifestSha256: item.manifestSha256, archiveName: `${item.packId}.zip`,
    archiveSha256: 'f'.repeat(64), expectedBytes: 10, completedBytes: 10,
    etag: 'etag', state: 'extracting', updatedAt: NOW - 10,
  };
}

test('an ambiguous native inventory aborts that shard only; the other fourteen reconcile', async () => {
  // Duplicate native rows mean the device cannot say which bytes belong to
  // that install — but the ambiguity is per (packId, version) and every match
  // downstream is per-pack, so the abort is scoped to the pack it names.
  const ambiguousShard = shardRow(SHARD_IDS[6], 7);
  const recoverable = [shardRow(SHARD_IDS[0], 1), shardRow(SHARD_IDS[7], 8)];
  const harness = reconcileHarness({
    inventory: [
      native(ambiguousShard), native(ambiguousShard),
      ...recoverable.map((item) => native(item)),
    ],
    // The ambiguous shard has exactly what the other two have: native bytes
    // and an extracting job. Only the duplicate row separates them.
    jobs: [ambiguousShard, ...recoverable].map(recoverableJob),
  });
  delete harness.dependencies.packIds;
  const result = await createPackReconciler(harness.dependencies).reconcileAtStartup();

  assert.deepEqual([...result.ambiguousPacks], [SHARD_IDS[6]]);
  // Nothing was registered, flipped, retired or removed for the ambiguous
  // shard, and it never reports ready.
  assert.deepEqual(
    harness.events.filter((event) => event.includes(SHARD_IDS[6])),
    [],
  );
  const ambiguousEntry = result.readiness.find((entry) => entry.packId === SHARD_IDS[6]);
  assert.deepEqual(ambiguousEntry, { packId: SHARD_IDS[6], version: null, ready: false, accessLocked: false });
  assert.equal(harness.snapshot().activeByPackId[SHARD_IDS[6]], undefined);
  // 1/15 blast radius: the two unambiguous shards still recovered.
  assert.deepEqual(
    [...result.recovered],
    [`${SHARD_IDS[0]}.1.0.0`, `${SHARD_IDS[7]}.1.0.0`],
  );
  assert.ok(result.readiness.filter((entry) => entry.ready).length === 2);
});

test('an ambiguous inventory blocks retirement of that pack before anything is deleted', async () => {
  // Validate-before-mutate, with a job that is genuinely retirable: under the
  // flipped catalogue the b3 pack is retired scope, so without the ambiguity
  // gate ahead of the retirement loop this job row and its staging would be
  // deleted on the strength of an inventory the device cannot trust.
  const b3Installed = row('1.0.0-b3.1', 1);
  const harness = reconcileHarness({
    installed: [b3Installed],
    inventory: [native(b3Installed), native(b3Installed)],
    jobs: [{
      jobId: `${PACK_ID}.1.0.0-b3.1`, packId: PACK_ID, version: '1.0.0-b3.1',
      manifestSha256: b3Installed.manifestSha256, archiveName: `${PACK_ID}.zip`,
      archiveSha256: 'f'.repeat(64), expectedBytes: 10, completedBytes: 10,
      etag: 'a'.repeat(32), state: 'ready', updatedAt: NOW - 10,
    }],
  });
  delete harness.dependencies.packIds;
  const result = await createPackReconciler(harness.dependencies).reconcileAtStartup();
  assert.deepEqual([...result.ambiguousPacks], [PACK_ID]);
  assert.deepEqual([...result.retiredPacks], []);
  assert.deepEqual(harness.events, []);
  assert.deepEqual(
    harness.snapshot().jobs.map((job) => job.jobId),
    [`${PACK_ID}.1.0.0-b3.1`],
  );
});

test('the B3 proof lane never retires the shards the live catalogue still sells', async () => {
  // The B3 composition pins packIds to the b3 row. Every shard job it sees is
  // outside its own pack set but inside the live catalogue join, so it must
  // leave them entirely alone instead of deleting fifteen jobs and wiping
  // their staging.
  const shardJobs = SHARD_IDS.map((packId) => ({
    jobId: `${packId}.1.0.0`, packId, version: '1.0.0',
    manifestSha256: '2'.repeat(64), archiveName: `${packId}.zip`,
    archiveSha256: 'f'.repeat(64), expectedBytes: 10, completedBytes: 0,
    etag: 'etag', state: 'queued', updatedAt: NOW - 10,
  }));
  const harness = reconcileHarness({ jobs: shardJobs });
  await assert.rejects(
    createPackReconciler(harness.dependencies).reconcileAtStartup(),
    { code: 'PACK_RECONCILIATION_PACK_AUTHORITY_MISMATCH' },
  );
  // Fails closed, and — the point of the fix — deletes nothing: the fifteen
  // jobs and their staging are still there.
  assert.deepEqual(harness.events, []);
  assert.deepEqual(
    harness.snapshot().jobs.map((job) => job.jobId),
    shardJobs.map((job) => job.jobId),
  );
});
