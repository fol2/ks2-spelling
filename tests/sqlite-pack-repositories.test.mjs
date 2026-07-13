import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { configureAndMigrateDatabase } from '../src/platform/database/migrate-database.js';
import { createSqlitePackRepositories } from '../src/platform/database/sqlite-pack-repositories.js';
import { createNodeSqliteConnection } from './helpers/node-sqlite-connection.mjs';

const PACK_METHODS = Object.freeze([
  'clearDownloadChunks',
  'completeDownloadChunk',
  'deleteDownloadJob',
  'flipActiveVersion',
  'getActiveVersion',
  'getDownloadJob',
  'listDownloadChunks',
  'listDownloadJobs',
  'listInstalledVersions',
  'registerAndFlipActiveVersion',
  'registerInstalledVersion',
  'replaceDownloadChunks',
  'retireInstalledVersion',
  'updateDownloadJob',
  'upsertDownloadJob',
]);

const SHA_A = 'a1'.repeat(32);
const SHA_B = '22'.repeat(32);
const SHA_C = 'c3'.repeat(32);

function downloadJob(overrides = {}) {
  return {
    jobId: 'download-b3-proof',
    packId: 'b3-sandbox-proof',
    version: '1.0.0-b3.1',
    manifestSha256: SHA_A,
    archiveName: 'b3-sandbox-proof.zip',
    archiveSha256: SHA_B,
    expectedBytes: 12,
    completedBytes: 0,
    etag: null,
    state: 'queued',
    updatedAt: 1_720_000_000_000,
    ...overrides,
  };
}

function downloadChunk(overrides = {}) {
  return {
    jobId: 'download-b3-proof',
    startByte: 0,
    endByteExclusive: 4,
    state: 'pending',
    chunkSha256: null,
    ...overrides,
  };
}

function installedVersion(overrides = {}) {
  return {
    packId: 'b3-sandbox-proof',
    version: '1.0.0-b3.1',
    manifestSha256: SHA_A,
    pathToken: 'b3-sandbox-proof-1.0.0-b3.1',
    activationMarkerSha256: SHA_C,
    state: 'ready',
    installedAt: 1_720_000_000_100,
    ...overrides,
  };
}

function activeVersion(version = installedVersion(), overrides = {}) {
  return {
    packId: version.packId,
    version: version.version,
    manifestSha256: version.manifestSha256,
    pathToken: version.pathToken,
    activatedAt: 1_720_000_000_200,
    ...overrides,
  };
}

function chunksFor(jobId = 'download-b3-proof') {
  return [
    downloadChunk({ jobId, startByte: 0, endByteExclusive: 4 }),
    downloadChunk({ jobId, startByte: 4, endByteExclusive: 8 }),
    downloadChunk({ jobId, startByte: 8, endByteExclusive: 12 }),
  ];
}

async function withDatabase(run) {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-spelling-pack-repository-'));
  const connection = createNodeSqliteConnection(join(directory, 'repository.sqlite'));
  try {
    await connection.open();
    await configureAndMigrateDatabase(connection);
    await run({ connection, repository: createSqlitePackRepositories(connection) });
  } finally {
    await connection.close().catch(() => {});
    await rm(directory, { force: true, recursive: true });
  }
}

async function rejectsCode(operation, code) {
  await assert.rejects(operation, (error) => {
    assert.equal(error?.code, code);
    assert.equal(error?.message, code);
    return true;
  });
}

function assertFrozenRecord(actual, expected) {
  assert.deepEqual(actual, expected);
  assert.equal(Object.isFrozen(actual), true);
}

function wrapConnection(connection, overrides = {}) {
  return Object.freeze({
    async open() {
      return connection.open();
    },
    async close() {
      return connection.close();
    },
    async execute(sql, values) {
      return connection.execute(sql, values);
    },
    async query(sql, values) {
      return connection.query(sql, values);
    },
    async begin() {
      return connection.begin();
    },
    async commit() {
      return connection.commit();
    },
    async rollback() {
      return connection.rollback();
    },
    async isTransactionActive() {
      return connection.isTransactionActive();
    },
    ...overrides,
  });
}

test('pack repository exposes one frozen closed app-wide API', async () => {
  await withDatabase(async ({ repository }) => {
    assert.equal(Object.isFrozen(repository), true);
    assert.deepEqual(Object.keys(repository).toSorted(), PACK_METHODS);
    for (const method of PACK_METHODS) {
      assert.equal(typeof repository[method], 'function', method);
    }
  });
});

test('every pack method rejects extra authority, URL and learner fields', async () => {
  await withDatabase(async ({ repository }) => {
    const installed = installedVersion();
    const forbiddenCalls = [
      () => repository.getDownloadJob({ jobId: 'download-b3-proof', learnerId: 'learner-a' }),
      () => repository.listDownloadJobs({ capabilityUrl: 'https://example.invalid/' }),
      () => repository.upsertDownloadJob({ ...downloadJob(), capabilityUrl: 'https://example.invalid/' }),
      () =>
        repository.updateDownloadJob({
          jobId: 'download-b3-proof',
          expectedState: 'queued',
          state: 'downloading',
          etag: null,
          updatedAt: 1_720_000_000_001,
          childId: 'child-a',
        }),
      () => repository.deleteDownloadJob({ jobId: 'download-b3-proof', url: 'https://example.invalid/' }),
      () =>
        repository.replaceDownloadChunks({
          jobId: 'download-b3-proof',
          chunks: chunksFor(),
          learnerId: 'learner-a',
        }),
      () => repository.listDownloadChunks({ jobId: 'download-b3-proof', childId: 'child-a' }),
      () =>
        repository.completeDownloadChunk({
          jobId: 'download-b3-proof',
          startByte: 0,
          endByteExclusive: 4,
          chunkSha256: SHA_A,
          updatedAt: 1_720_000_000_002,
          capabilityUrl: 'https://example.invalid/',
        }),
      () =>
        repository.clearDownloadChunks({
          jobId: 'download-b3-proof',
          updatedAt: 1_720_000_000_003,
          monsterId: 'monster-a',
        }),
      () => repository.registerInstalledVersion({ ...installed, url: 'https://example.invalid/' }),
      () => repository.listInstalledVersions({ packId: installed.packId, learnerId: 'learner-a' }),
      () =>
        repository.retireInstalledVersion({
          packId: installed.packId,
          version: installed.version,
          childId: 'child-a',
        }),
      () => repository.getActiveVersion({ packId: installed.packId, learnerId: 'learner-a' }),
      () => repository.flipActiveVersion({ ...activeVersion(installed), capabilityUrl: 'https://example.invalid/' }),
      () =>
        repository.registerAndFlipActiveVersion({
          installedVersion: installed,
          activeVersion: activeVersion(installed),
          learnerId: 'learner-a',
        }),
    ];

    for (const call of forbiddenCalls) {
      await rejectsCode(call, 'sqlite_pack_input_invalid');
    }
    assert.deepEqual(await repository.listDownloadJobs(), []);
    assert.deepEqual(await repository.listInstalledVersions({ packId: installed.packId }), []);
  });
});

test('download jobs have exact app-wide records and deterministic ordering', async () => {
  await withDatabase(async ({ repository }) => {
    const second = downloadJob({
      jobId: 'download-a',
      packId: 'another-pack',
      archiveName: 'another-pack.zip',
      updatedAt: 1_720_000_000_001,
    });
    const first = downloadJob();

    assertFrozenRecord(await repository.upsertDownloadJob(first), first);
    assertFrozenRecord(await repository.upsertDownloadJob(second), second);
    assertFrozenRecord(await repository.getDownloadJob({ jobId: first.jobId }), first);
    assert.equal(await repository.getDownloadJob({ jobId: 'missing-job' }), null);

    const listed = await repository.listDownloadJobs();
    assert.deepEqual(listed, [second, first]);
    assert.equal(Object.isFrozen(listed), true);
    assert.equal(listed.every(Object.isFrozen), true);
    assert.deepEqual(Object.keys(listed[0]), [
      'jobId',
      'packId',
      'version',
      'manifestSha256',
      'archiveName',
      'archiveSha256',
      'expectedBytes',
      'completedBytes',
      'etag',
      'state',
      'updatedAt',
    ]);
    assert.equal(
      JSON.stringify(listed).match(/capability|https?:|learner|child|monster/giu),
      null,
    );
  });
});

test('download-job upsert is idempotent but cannot replace immutable authority', async () => {
  await withDatabase(async ({ repository }) => {
    const original = downloadJob();
    assertFrozenRecord(await repository.upsertDownloadJob(original), original);
    assertFrozenRecord(await repository.upsertDownloadJob({ ...original }), original);

    for (const conflict of [
      { manifestSha256: SHA_C },
      { archiveSha256: SHA_C },
      { expectedBytes: 13 },
      { packId: 'different-pack' },
      { version: '1.0.1' },
      { archiveName: 'different.zip' },
      { completedBytes: 1 },
      { state: 'downloading' },
    ]) {
      await rejectsCode(
        () => repository.upsertDownloadJob({ ...original, ...conflict }),
        'sqlite_pack_job_conflict',
      );
    }

    assertFrozenRecord(await repository.getDownloadJob({ jobId: original.jobId }), original);
  });
});

test('job identity and storage tokens are safe, canonical and URL-free', async () => {
  await withDatabase(async ({ repository }) => {
    const invalidCases = [
      ['jobId', ''],
      ['jobId', 'Download-B3'],
      ['jobId', '../download'],
      ['jobId', 'x'.repeat(65)],
      ['packId', 'b3/proof'],
      ['packId', 'https://packs.example'],
      ['version', '1.0.0/B3'],
      ['version', '1.0.0%2fb3'],
      ['archiveName', '../proof.zip'],
      ['archiveName', 'proof.zip?cap=secret'],
      ['archiveName', 'proof'],
      ['archiveName', 'Proof.zip'],
      ['manifestSha256', SHA_A.toUpperCase()],
      ['manifestSha256', SHA_A.slice(1)],
      ['archiveSha256', `${SHA_B.slice(0, -1)}g`],
    ];

    for (const [field, value] of invalidCases) {
      await rejectsCode(
        () => repository.upsertDownloadJob(downloadJob({ [field]: value })),
        'sqlite_pack_input_invalid',
      );
    }

    for (const forbidden of [
      { capabilityUrl: 'https://b3-gateway.eugnel.uk/?cap=secret' },
      { url: 'https://b3-gateway.eugnel.uk/' },
      { learnerId: 'learner-a' },
      { childId: 'child-a' },
      { monsterId: 'monster-a' },
    ]) {
      await rejectsCode(
        () => repository.upsertDownloadJob({ ...downloadJob(), ...forbidden }),
        'sqlite_pack_input_invalid',
      );
    }
    assert.deepEqual(await repository.listDownloadJobs(), []);
  });
});

test('job byte counts, timestamps, ETags and exact input shapes fail closed', async () => {
  await withDatabase(async ({ repository }) => {
    for (const overrides of [
      { expectedBytes: 0 },
      { expectedBytes: -1 },
      { expectedBytes: 1.5 },
      { expectedBytes: Number.MAX_SAFE_INTEGER + 1 },
      { completedBytes: -1 },
      { completedBytes: 1 },
      { updatedAt: -1 },
      { updatedAt: 1.5 },
      { etag: '' },
      { etag: 'unsafe\r\netag' },
      { etag: 42 },
      { state: 'complete' },
    ]) {
      await rejectsCode(
        () => repository.upsertDownloadJob(downloadJob(overrides)),
        'sqlite_pack_input_invalid',
      );
    }

    await repository.upsertDownloadJob(downloadJob());
    for (const invalid of [
      { jobId: 'download-b3-proof', expectedState: 'queued', state: 'downloading', etag: null },
      {
        jobId: 'download-b3-proof',
        expectedState: 'queued',
        state: 'downloading',
        etag: null,
        updatedAt: 1_720_000_000_001,
        completedBytes: 0,
      },
    ]) {
      await rejectsCode(
        () => repository.updateDownloadJob(invalid),
        'sqlite_pack_input_invalid',
      );
    }
  });
});

test('chunk plans must exactly cover the expected archive without gaps or overlap', async () => {
  await withDatabase(async ({ repository }) => {
    await repository.upsertDownloadJob(downloadJob());

    for (const chunks of [
      [],
      chunksFor().slice(0, 2),
      [downloadChunk({ startByte: 1, endByteExclusive: 4 }), ...chunksFor().slice(1)],
      [
        downloadChunk({ startByte: 0, endByteExclusive: 5 }),
        downloadChunk({ startByte: 4, endByteExclusive: 8 }),
        downloadChunk({ startByte: 8, endByteExclusive: 12 }),
      ],
      [
        downloadChunk({ startByte: 0, endByteExclusive: 3 }),
        downloadChunk({ startByte: 4, endByteExclusive: 8 }),
        downloadChunk({ startByte: 8, endByteExclusive: 12 }),
      ],
      [downloadChunk({ startByte: 0, endByteExclusive: 13 })],
      [downloadChunk({ startByte: 0, endByteExclusive: Number.MAX_SAFE_INTEGER + 1 })],
      [downloadChunk({ startByte: 0, endByteExclusive: 12, state: 'complete' })],
      [downloadChunk({ startByte: 0, endByteExclusive: 12, chunkSha256: SHA_A })],
      chunksFor('different-job'),
    ]) {
      await rejectsCode(
        () =>
          repository.replaceDownloadChunks({
            jobId: 'download-b3-proof',
            chunks,
          }),
        'sqlite_pack_chunk_plan_invalid',
      );
      assert.deepEqual(
        await repository.listDownloadChunks({ jobId: 'download-b3-proof' }),
        [],
      );
    }
  });
});

test('chunk replacement is atomic, ordered, frozen and idempotent', async () => {
  await withDatabase(async ({ repository }) => {
    await repository.upsertDownloadJob(downloadJob());
    const reverse = chunksFor().toReversed();

    const first = await repository.replaceDownloadChunks({
      jobId: 'download-b3-proof',
      chunks: reverse,
    });
    assert.deepEqual(first, chunksFor());
    assert.equal(Object.isFrozen(first), true);
    assert.equal(first.every(Object.isFrozen), true);

    assert.deepEqual(
      await repository.replaceDownloadChunks({
        jobId: 'download-b3-proof',
        chunks: chunksFor(),
      }),
      chunksFor(),
    );
    assertFrozenRecord(await repository.getDownloadJob({ jobId: 'download-b3-proof' }), downloadJob());
  });
});

test('completing chunks derives completed bytes atomically and replay never double-counts', async () => {
  await withDatabase(async ({ repository }) => {
    await repository.upsertDownloadJob(downloadJob());
    await repository.replaceDownloadChunks({
      jobId: 'download-b3-proof',
      chunks: chunksFor(),
    });
    await repository.updateDownloadJob({
      jobId: 'download-b3-proof',
      expectedState: 'queued',
      state: 'downloading',
      etag: '"transport-cache-tag"',
      updatedAt: 1_720_000_000_001,
    });

    const complete = {
      jobId: 'download-b3-proof',
      startByte: 0,
      endByteExclusive: 4,
      chunkSha256: SHA_A,
      updatedAt: 1_720_000_000_002,
    };
    assertFrozenRecord(
      await repository.completeDownloadChunk(complete),
      downloadChunk({ state: 'complete', chunkSha256: SHA_A }),
    );
    assertFrozenRecord(
      await repository.completeDownloadChunk({ ...complete }),
      downloadChunk({ state: 'complete', chunkSha256: SHA_A }),
    );
    assert.deepEqual(await repository.getDownloadJob({ jobId: 'download-b3-proof' }),
      downloadJob({
        completedBytes: 4,
        etag: '"transport-cache-tag"',
        state: 'downloading',
        updatedAt: 1_720_000_000_002,
      }),
    );

    await rejectsCode(
      () => repository.completeDownloadChunk({ ...complete, chunkSha256: SHA_B }),
      'sqlite_pack_chunk_conflict',
    );
    await rejectsCode(
      () =>
        repository.completeDownloadChunk({
          ...complete,
          startByte: 4,
          endByteExclusive: 8,
          chunkSha256: SHA_A.toUpperCase(),
        }),
      'sqlite_pack_input_invalid',
    );
    await rejectsCode(
      () =>
        repository.completeDownloadChunk({
          ...complete,
          startByte: 4,
          endByteExclusive: 9,
        }),
      'sqlite_pack_chunk_conflict',
    );
    assert.equal(
      (await repository.getDownloadJob({ jobId: 'download-b3-proof' })).completedBytes,
      4,
    );
  });
});

test('download state transitions require CAS and complete chunk coverage, not ETag', async () => {
  await withDatabase(async ({ repository }) => {
    await repository.upsertDownloadJob(downloadJob());
    await repository.replaceDownloadChunks({ jobId: 'download-b3-proof', chunks: chunksFor() });

    await rejectsCode(
      () =>
        repository.updateDownloadJob({
          jobId: 'download-b3-proof',
          expectedState: 'downloading',
          state: 'downloaded',
          etag: '"looks-complete"',
          updatedAt: 1_720_000_000_001,
        }),
      'sqlite_pack_job_conflict',
    );
    await repository.updateDownloadJob({
      jobId: 'download-b3-proof',
      expectedState: 'queued',
      state: 'downloading',
      etag: '"looks-complete"',
      updatedAt: 1_720_000_000_001,
    });
    await rejectsCode(
      () =>
        repository.updateDownloadJob({
          jobId: 'download-b3-proof',
          expectedState: 'downloading',
          state: 'downloaded',
          etag: '"looks-complete"',
          updatedAt: 1_720_000_000_002,
        }),
      'sqlite_pack_download_incomplete',
    );

    for (const [index, chunk] of chunksFor().entries()) {
      await repository.completeDownloadChunk({
        jobId: chunk.jobId,
        startByte: chunk.startByte,
        endByteExclusive: chunk.endByteExclusive,
        chunkSha256: [SHA_A, SHA_B, SHA_C][index],
        updatedAt: 1_720_000_000_002 + index,
      });
    }
    const downloaded = await repository.updateDownloadJob({
      jobId: 'download-b3-proof',
      expectedState: 'downloading',
      state: 'downloaded',
      etag: null,
      updatedAt: 1_720_000_000_010,
    });
    assert.equal(downloaded.completedBytes, downloaded.expectedBytes);
    assert.equal(downloaded.etag, null);

    for (const [from, to] of [
      ['downloaded', 'ready'],
      ['downloaded', 'queued'],
      ['downloaded', 'downloading'],
    ]) {
      await rejectsCode(
        () =>
          repository.updateDownloadJob({
            jobId: 'download-b3-proof',
            expectedState: from,
            state: to,
            etag: null,
            updatedAt: 1_720_000_000_011,
          }),
        'sqlite_pack_job_transition_invalid',
      );
    }
    await repository.updateDownloadJob({
      jobId: 'download-b3-proof',
      expectedState: 'downloaded',
      state: 'extracting',
      etag: null,
      updatedAt: 1_720_000_000_011,
    });
    await repository.updateDownloadJob({
      jobId: 'download-b3-proof',
      expectedState: 'extracting',
      state: 'ready',
      etag: null,
      updatedAt: 1_720_000_000_012,
    });
  });
});

test('failed jobs may retry; clearing chunks atomically resets derived progress', async () => {
  await withDatabase(async ({ repository }) => {
    await repository.upsertDownloadJob(downloadJob());
    await repository.replaceDownloadChunks({ jobId: 'download-b3-proof', chunks: chunksFor() });
    await repository.updateDownloadJob({
      jobId: 'download-b3-proof',
      expectedState: 'queued',
      state: 'downloading',
      etag: '"old"',
      updatedAt: 1_720_000_000_001,
    });
    await repository.completeDownloadChunk({
      jobId: 'download-b3-proof',
      startByte: 0,
      endByteExclusive: 4,
      chunkSha256: SHA_A,
      updatedAt: 1_720_000_000_002,
    });
    await repository.updateDownloadJob({
      jobId: 'download-b3-proof',
      expectedState: 'downloading',
      state: 'failed',
      etag: '"old"',
      updatedAt: 1_720_000_000_003,
    });
    await repository.updateDownloadJob({
      jobId: 'download-b3-proof',
      expectedState: 'failed',
      state: 'queued',
      etag: null,
      updatedAt: 1_720_000_000_004,
    });

    assert.deepEqual(
      await repository.clearDownloadChunks({
        jobId: 'download-b3-proof',
        updatedAt: 1_720_000_000_005,
      }),
      [],
    );
    assert.deepEqual(await repository.listDownloadChunks({ jobId: 'download-b3-proof' }), []);
    assert.deepEqual(
      await repository.getDownloadJob({ jobId: 'download-b3-proof' }),
      downloadJob({ updatedAt: 1_720_000_000_005 }),
    );
    assert.deepEqual(
      await repository.clearDownloadChunks({
        jobId: 'download-b3-proof',
        updatedAt: 1_720_000_000_005,
      }),
      [],
    );
  });
});

test('deleting a job cascades chunks and replay is idempotent', async () => {
  await withDatabase(async ({ repository }) => {
    await repository.upsertDownloadJob(downloadJob());
    await repository.replaceDownloadChunks({ jobId: 'download-b3-proof', chunks: chunksFor() });

    assert.equal(await repository.deleteDownloadJob({ jobId: 'download-b3-proof' }), true);
    assert.equal(await repository.deleteDownloadJob({ jobId: 'download-b3-proof' }), false);
    assert.equal(await repository.getDownloadJob({ jobId: 'download-b3-proof' }), null);
    assert.deepEqual(await repository.listDownloadChunks({ jobId: 'download-b3-proof' }), []);
  });
});

test('installed versions expose exact records, safe tokens and idempotent registration', async () => {
  await withDatabase(async ({ repository }) => {
    const original = installedVersion();
    assertFrozenRecord(await repository.registerInstalledVersion(original), original);
    assertFrozenRecord(await repository.registerInstalledVersion({ ...original }), original);

    const listed = await repository.listInstalledVersions({ packId: original.packId });
    assert.deepEqual(listed, [original]);
    assert.equal(Object.isFrozen(listed), true);
    assert.equal(listed.every(Object.isFrozen), true);
    assert.deepEqual(Object.keys(listed[0]), [
      'packId',
      'version',
      'manifestSha256',
      'pathToken',
      'activationMarkerSha256',
      'state',
      'installedAt',
    ]);

    for (const invalid of [
      installedVersion({ pathToken: '../installed/path' }),
      installedVersion({ pathToken: 'https://files.example/pack' }),
      installedVersion({ pathToken: 'UPPER' }),
      installedVersion({ activationMarkerSha256: SHA_C.toUpperCase() }),
      installedVersion({ state: 'retired' }),
      { ...installedVersion(), capabilityUrl: 'https://example.invalid/' },
      { ...installedVersion(), learnerId: 'learner-a' },
    ]) {
      await rejectsCode(
        () => repository.registerInstalledVersion(invalid),
        'sqlite_pack_input_invalid',
      );
    }

    await rejectsCode(
      () => repository.registerInstalledVersion({ ...original, pathToken: 'different-token' }),
      'sqlite_pack_version_conflict',
    );
    assert.deepEqual(await repository.listInstalledVersions({ packId: original.packId }), [original]);
  });
});

test('active pointers require a ready matching installed version and preserve exact authority', async () => {
  await withDatabase(async ({ repository }) => {
    const installed = installedVersion();
    const active = activeVersion(installed);

    await rejectsCode(
      () => repository.flipActiveVersion(active),
      'sqlite_pack_version_not_ready',
    );
    await repository.registerInstalledVersion(installed);
    for (const mismatch of [
      { manifestSha256: SHA_B },
      { pathToken: 'different-token' },
      { version: '1.0.1' },
    ]) {
      await rejectsCode(
        () => repository.flipActiveVersion({ ...active, ...mismatch }),
        'sqlite_pack_activation_conflict',
      );
    }

    assertFrozenRecord(await repository.flipActiveVersion(active), active);
    assertFrozenRecord(await repository.flipActiveVersion({ ...active }), active);
    assertFrozenRecord(await repository.getActiveVersion({ packId: installed.packId }), active);
    assert.equal(await repository.getActiveVersion({ packId: 'missing-pack' }), null);
  });
});

test('retirement is idempotent but never retires the active version', async () => {
  await withDatabase(async ({ repository }) => {
    const old = installedVersion();
    const newer = installedVersion({
      version: '1.0.1',
      manifestSha256: SHA_B,
      pathToken: 'b3-sandbox-proof-1.0.1',
      activationMarkerSha256: SHA_A,
      installedAt: 1_720_000_000_300,
    });
    await repository.registerAndFlipActiveVersion({
      installedVersion: old,
      activeVersion: activeVersion(old),
    });
    await repository.registerInstalledVersion(newer);

    await rejectsCode(
      () => repository.retireInstalledVersion({ packId: old.packId, version: old.version }),
      'sqlite_pack_version_active',
    );
    assertFrozenRecord(
      await repository.retireInstalledVersion({ packId: newer.packId, version: newer.version }),
      { ...newer, state: 'retired' },
    );
    assertFrozenRecord(
      await repository.retireInstalledVersion({ packId: newer.packId, version: newer.version }),
      { ...newer, state: 'retired' },
    );
  });
});

test('combined registration and active flip are atomic and replay-safe', async () => {
  await withDatabase(async ({ repository }) => {
    const first = installedVersion();
    const second = installedVersion({
      version: '1.0.1',
      manifestSha256: SHA_B,
      pathToken: 'b3-sandbox-proof-1.0.1',
      activationMarkerSha256: SHA_A,
      installedAt: 1_720_000_000_300,
    });
    const firstActive = activeVersion(first);
    const secondActive = activeVersion(second, { activatedAt: 1_720_000_000_400 });

    assertFrozenRecord(
      await repository.registerAndFlipActiveVersion({
        installedVersion: first,
        activeVersion: firstActive,
      }),
      firstActive,
    );
    assertFrozenRecord(
      await repository.registerAndFlipActiveVersion({
        installedVersion: first,
        activeVersion: firstActive,
      }),
      firstActive,
    );
    assertFrozenRecord(
      await repository.registerAndFlipActiveVersion({
        installedVersion: second,
        activeVersion: secondActive,
      }),
      secondActive,
    );
    await rejectsCode(
      () =>
        repository.registerAndFlipActiveVersion({
          installedVersion: first,
          activeVersion: firstActive,
        }),
      'sqlite_pack_activation_conflict',
    );
    await rejectsCode(
      () =>
        repository.registerAndFlipActiveVersion({
          installedVersion: first,
          activeVersion: {
            ...firstActive,
            activatedAt: secondActive.activatedAt,
          },
        }),
      'sqlite_pack_activation_conflict',
    );
    assert.deepEqual(
      (await repository.listInstalledVersions({ packId: first.packId })).map(({ version }) => version),
      ['1.0.0-b3.1', '1.0.1'],
    );
    assertFrozenRecord(await repository.getActiveVersion({ packId: first.packId }), secondActive);
  });
});

test('combined activation rollback preserves the previous active version', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-spelling-pack-rollback-'));
  const base = createNodeSqliteConnection(join(directory, 'rollback.sqlite'));
  await base.open();
  await configureAndMigrateDatabase(base);
  let failNextActiveWrite = false;
  const connection = wrapConnection(base, {
    async execute(sql, values) {
      if (failNextActiveWrite && /(?:INSERT|UPDATE).*active_pack_versions/iu.test(sql)) {
        failNextActiveWrite = false;
        const error = new Error('injected_active_pointer_failure');
        error.code = 'injected_active_pointer_failure';
        throw error;
      }
      return base.execute(sql, values);
    },
  });
  const repository = createSqlitePackRepositories(connection);
  try {
    const first = installedVersion();
    const firstActive = activeVersion(first);
    await repository.registerAndFlipActiveVersion({
      installedVersion: first,
      activeVersion: firstActive,
    });

    const second = installedVersion({
      version: '1.0.1',
      manifestSha256: SHA_B,
      pathToken: 'b3-sandbox-proof-1.0.1',
      activationMarkerSha256: SHA_A,
      installedAt: 1_720_000_000_300,
    });
    failNextActiveWrite = true;
    await assert.rejects(
      () =>
        repository.registerAndFlipActiveVersion({
          installedVersion: second,
          activeVersion: activeVersion(second, { activatedAt: 1_720_000_000_400 }),
        }),
      /injected_active_pointer_failure/,
    );

    assert.deepEqual(await repository.listInstalledVersions({ packId: first.packId }), [first]);
    assertFrozenRecord(await repository.getActiveVersion({ packId: first.packId }), firstActive);
    assert.equal(await base.isTransactionActive(), false);
  } finally {
    await base.close().catch(() => {});
    await rm(directory, { force: true, recursive: true });
  }
});

test('transactional writes require native begin acknowledgement before the first write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-spelling-pack-begin-ack-'));
  const base = createNodeSqliteConnection(join(directory, 'begin-ack.sqlite'));
  await base.open();
  await configureAndMigrateDatabase(base);
  const writes = [];
  const connection = wrapConnection(base, {
    async begin() {},
    async execute(sql, values) {
      writes.push({ sql, values });
      return base.execute(sql, values);
    },
  });
  const repository = createSqlitePackRepositories(connection);
  try {
    const installed = installedVersion();
    await rejectsCode(
      () =>
        repository.registerAndFlipActiveVersion({
          installedVersion: installed,
          activeVersion: activeVersion(installed),
        }),
      'sqlite_transaction_state_invalid',
    );
    assert.deepEqual(writes, []);
    assert.deepEqual(await repository.listInstalledVersions({ packId: installed.packId }), []);
    assert.equal(await repository.getActiveVersion({ packId: installed.packId }), null);
  } finally {
    await base.close().catch(() => {});
    await rm(directory, { force: true, recursive: true });
  }
});

// The cross-repository case is intentionally here rather than in a connection
// implementation test: app-wide repositories sharing one physical connection
// must share the same transaction serialiser, irrespective of factory order.
test('commerce and pack transactions sharing one connection are serialised', async () => {
  const { createSqliteCommerceRepositories } = await import(
    '../src/platform/database/sqlite-commerce-repositories.js'
  );
  const directory = await mkdtemp(join(tmpdir(), 'ks2-spelling-app-wide-serialisation-'));
  const base = createNodeSqliteConnection(join(directory, 'serialisation.sqlite'));
  await base.open();
  await configureAndMigrateDatabase(base);
  let activeTransactions = 0;
  let maximumActiveTransactions = 0;
  const connection = wrapConnection(base, {
    async begin() {
      await new Promise((resolve) => setImmediate(resolve));
      await base.begin();
      activeTransactions += 1;
      maximumActiveTransactions = Math.max(maximumActiveTransactions, activeTransactions);
    },
    async commit() {
      await new Promise((resolve) => setImmediate(resolve));
      await base.commit();
      activeTransactions -= 1;
    },
    async rollback() {
      try {
        await base.rollback();
      } finally {
        activeTransactions = Math.max(0, activeTransactions - 1);
      }
    },
  });
  const commerce = createSqliteCommerceRepositories(connection);
  const packs = createSqlitePackRepositories(connection);
  try {
    await commerce.observeTransaction({
      journalId: 'journal-b3-proof',
      store: 'apple',
      productId: 'uk.eugnel.ks2spelling.fullks2',
      observationState: 'purchased',
      opaqueProof: 'opaque-proof',
      observedAt: 1_720_000_000_000,
    });
    await commerce.markVerified({
      journalId: 'journal-b3-proof',
      verifiedAt: 1_720_000_000_050,
    });
    const installed = installedVersion();

    await Promise.all([
      commerce.commitEntitlementAndReadyToComplete({
        journalId: 'journal-b3-proof',
        entitlementId: 'full-ks2',
        storeTransactionId: '1234567890',
        sealedRefreshHandle: 'sealed-refresh-handle',
        refreshHandleVersion: 1,
        committedAt: 1_720_000_000_100,
      }),
      packs.registerAndFlipActiveVersion({
        installedVersion: installed,
        activeVersion: activeVersion(installed),
      }),
    ]);

    assert.equal(maximumActiveTransactions, 1);
    assert.equal(activeTransactions, 0);
    assertFrozenRecord(await packs.getActiveVersion({ packId: installed.packId }), activeVersion(installed));
  } finally {
    await base.close().catch(() => {});
    await rm(directory, { force: true, recursive: true });
  }
});
