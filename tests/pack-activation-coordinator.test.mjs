import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createPackActivationCoordinator } from '../src/app/pack-activation-coordinator.js';
import { configureAndMigrateDatabase } from '../src/platform/database/migrate-database.js';
import { createSqlitePackRepositories } from '../src/platform/database/sqlite-pack-repositories.js';
import {
  ARCHIVE_ETAG,
  ARCHIVE_SHA,
  ENVELOPE_SHA,
  JOB_ID,
  NOW,
  PACK_ID,
  VERSION,
  realManifestVerifier,
} from './helpers/range-fixture-server.mjs';
import { activationHarness } from './helpers/pack-activation-harness.mjs';
import { createNodeSqliteConnection } from './helpers/node-sqlite-connection.mjs';

test('activation re-verifies the signed envelope then uses native seal and one SQLite registration+flip', async () => {
  const harness = activationHarness();
  const result = await createPackActivationCoordinator(harness.dependencies)
    .activate(harness.input);

  assert.equal(result.state, 'ready');
  assert.equal(result.active.version, VERSION);
  assert.deepEqual(harness.calls, [
    'inventory',
    'job:downloaded->extracting',
    'extract',
    'seal',
    'register+flip',
    'job:extracting->ready',
  ]);
  assert.equal(harness.snapshot().job.state, 'ready');
});

test('manifest and durable download authority mismatch fail before native extraction or activation', async () => {
  const harness = activationHarness();
  const input = { ...harness.input, packId: 'foreign-pack' };
  await assert.rejects(
    createPackActivationCoordinator(harness.dependencies).activate(input),
    (error) => error?.code === 'PACK_ACTIVATION_MANIFEST_AUTHORITY_MISMATCH',
  );
  assert.deepEqual(harness.calls, []);
  assert.equal(harness.snapshot().active.version, '0.9.0');
});

test('activation requires the exact verified manifest entitlement authority', async () => {
  const harness = activationHarness();
  const manifestVerifier = async (input) => {
    const verified = await realManifestVerifier(input);
    return { ...verified, manifest: { ...verified.manifest, requiredEntitlementId: 'foreign' } };
  };
  await assert.rejects(
    createPackActivationCoordinator({ ...harness.dependencies, manifestVerifier })
      .activate(harness.input),
    { code: 'PACK_ACTIVATION_MANIFEST_AUTHORITY_MISMATCH' },
  );
  assert.deepEqual(harness.calls, []);
});

test('activation is idempotently recoverable when native rename completed before SQLite registration', async () => {
  const harness = activationHarness({ sealFailure: 'lost-result-after-rename' });
  const coordinator = createPackActivationCoordinator(harness.dependencies);
  await assert.rejects(coordinator.activate(harness.input), {
    code: 'PACK_TRANSFER_NATIVE_FAILURE',
  });
  assert.equal(harness.snapshot().active.version, '0.9.0');
  assert.equal(harness.snapshot().inventory[0].version, VERSION);

  const result = await coordinator.activate(harness.input);
  assert.equal(result.active.version, VERSION);
  assert.equal(harness.calls.filter((call) => call === 'seal').length, 1);
});

test('activation replay after the atomic DB flip reuses the durable timestamps and only completes the job', async () => {
  let crashed = false;
  const harness = activationHarness({
    crashInjector(point) {
      if (!crashed && point === 'afterDatabaseRegisterAndFlip') {
        crashed = true;
        throw Object.assign(new Error('crash'), { code: 'INJECTED_CRASH' });
      }
    },
  });
  const coordinator = createPackActivationCoordinator(harness.dependencies);
  await assert.rejects(coordinator.activate(harness.input), { code: 'INJECTED_CRASH' });
  const durable = harness.snapshot();
  assert.equal(durable.active.version, VERSION);
  assert.equal(durable.job.state, 'extracting');

  await coordinator.activate(harness.input);
  const replayed = harness.snapshot();
  assert.deepEqual(replayed.installedRows, durable.installedRows);
  assert.deepEqual(replayed.active, durable.active);
  assert.equal(replayed.job.state, 'ready');
  assert.equal(
    harness.calls.filter((call) => call === 'register+flip').length,
    2,
    'replay re-checks entitlement in the idempotent SQLite transaction',
  );
});

test('the real SQLite repository accepts the exact native installed path and atomically flips active', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-activation-sqlite-'));
  const connection = createNodeSqliteConnection(join(directory, 'activation.sqlite'));
  try {
    await connection.open();
    await configureAndMigrateDatabase(connection);
    await connection.execute(
      'INSERT INTO app_entitlements (entitlement_id, store, product_id, state, sealed_refresh_handle, refresh_handle_version, verified_at, refreshed_at, revocation_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)',
      [
        'full-ks2', 'apple', 'uk.eugnel.ks2spelling.fullks2', 'active',
        'sealed-refresh-handle', 1, NOW - 100, NOW - 100,
      ],
    );
    await connection.execute(
      'INSERT INTO pack_download_jobs (job_id, pack_id, version, manifest_sha256, archive_name, archive_sha256, expected_bytes, completed_bytes, etag, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        JOB_ID, PACK_ID, VERSION, ENVELOPE_SHA, `${PACK_ID}.zip`, ARCHIVE_SHA,
        1_324, 1_324, ARCHIVE_ETAG, 'downloaded', NOW - 10,
      ],
    );
    const harness = activationHarness();
    const packRepository = createSqlitePackRepositories(connection);
    const result = await createPackActivationCoordinator({
      ...harness.dependencies,
      packRepository,
    }).activate(harness.input);
    assert.equal(result.active.pathToken, `installed/${PACK_ID}/${VERSION}`);
    assert.equal(
      (await packRepository.getActiveVersion({ packId: PACK_ID })).version,
      VERSION,
    );
    assert.equal((await packRepository.getDownloadJob({ jobId: JOB_ID })).state, 'ready');
  } finally {
    await connection.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('revocation immediately before the SQLite flip returns access locked and retains native bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-activation-revoked-'));
  const connection = createNodeSqliteConnection(join(directory, 'activation.sqlite'));
  try {
    await connection.open();
    await configureAndMigrateDatabase(connection);
    await connection.execute(
      'INSERT INTO app_entitlements (entitlement_id, store, product_id, state, sealed_refresh_handle, refresh_handle_version, verified_at, refreshed_at, revocation_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)',
      [
        'full-ks2', 'apple', 'uk.eugnel.ks2spelling.fullks2', 'active',
        'sealed-refresh-handle', 1, NOW - 100, NOW - 100,
      ],
    );
    await connection.execute(
      'INSERT INTO pack_download_jobs (job_id, pack_id, version, manifest_sha256, archive_name, archive_sha256, expected_bytes, completed_bytes, etag, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        JOB_ID, PACK_ID, VERSION, ENVELOPE_SHA, `${PACK_ID}.zip`, ARCHIVE_SHA,
        1_324, 1_324, ARCHIVE_ETAG, 'downloaded', NOW - 10,
      ],
    );
    const harness = activationHarness();
    const repository = createSqlitePackRepositories(connection);
    let revoked = false;
    const packRepository = {
      ...repository,
      async registerAndFlipActiveVersion(input) {
        if (!revoked) {
          revoked = true;
          await connection.execute(
            'UPDATE app_entitlements SET state = ?, sealed_refresh_handle = NULL, refresh_handle_version = NULL, revocation_at = ? WHERE entitlement_id = ?',
            ['revoked', NOW, 'full-ks2'],
          );
        }
        return repository.registerAndFlipActiveVersion(input);
      },
    };
    const result = await createPackActivationCoordinator({
      ...harness.dependencies,
      packRepository,
    }).activate(harness.input);
    assert.equal(result.state, 'access-locked');
    assert.equal((await repository.getDownloadJob({ jobId: JOB_ID })).state, 'extracting');
    assert.equal(await repository.getActiveVersion({ packId: PACK_ID }), null);
    assert.equal(harness.snapshot().inventory.length, 1, 'installed native bytes are retained');
  } finally {
    await connection.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('activation advances beyond durable job and active timestamps when the wall clock rolls back', async () => {
  const durableFloor = NOW + 10_000;
  const harness = activationHarness({
    jobUpdatedAt: durableFloor - 1,
    activeActivatedAt: durableFloor,
  });
  await createPackActivationCoordinator(harness.dependencies).activate(harness.input);
  const snapshot = harness.snapshot();
  assert.ok(snapshot.active.activatedAt > durableFloor);
  assert.ok(snapshot.job.updatedAt > snapshot.active.activatedAt);
});
