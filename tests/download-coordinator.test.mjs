import assert from 'node:assert/strict';
import test from 'node:test';

import { createDownloadCoordinator } from '../src/app/download-coordinator.js';
import { B3_DOWNLOAD_CHUNK_BYTES } from '../src/domain/packs/signed-download-access-contract.js';
import {
  ARCHIVE_ETAG, ARCHIVE_SHA, HANDLE, JOB_ID, PACK_ID, VERSION,
  authorisation, createHarness,
} from './helpers/range-fixture-server.mjs';

test('coordinator exposes a frozen closed lifecycle and queues one fixed-size plan', async () => {
  const harness = createHarness();
  const coordinator = createDownloadCoordinator(harness.dependencies);
  assert.equal(Object.isFrozen(coordinator), true);
  assert.deepEqual(Object.keys(coordinator), ['queue', 'resume', 'retry', 'cancelTemporary']);
  assert.equal(B3_DOWNLOAD_CHUNK_BYTES, 1_048_576);

  const result = await coordinator.queue({ sealedRefreshHandle: HANDLE });
  assert.equal(result.state, 'downloaded');
  assert.equal(result.job.completedBytes, 1_324);
  assert.deepEqual(harness.calls.downloads.map((request) => ({
    start: request.startByte,
    end: request.endByteExclusive,
    truncate: request.truncate,
  })), [{ start: 0, end: 1_324, truncate: true }]);
  assert.equal(harness.memory.snapshot().chunks[0].chunkSha256, ARCHIVE_SHA);
  assert.equal(harness.calls.inspections.length, 1);
});

test('completed downloads are duplicate-safe and never persist capability URLs', async () => {
  const harness = createHarness();
  const coordinator = createDownloadCoordinator(harness.dependencies);
  await coordinator.queue({ sealedRefreshHandle: HANDLE });
  await coordinator.resume({ sealedRefreshHandle: HANDLE });

  assert.equal(harness.calls.downloads.length, 1);
  const durable = JSON.stringify(harness.memory.snapshot());
  assert.equal(/https?:|expires|capability|b3rh1/iu.test(durable), false);
  assert.equal(harness.calls.gateway.length, 2, 'each current operation renews authorisation');
});

test('cancel removes only owned temporary state and its durable job', async () => {
  const harness = createHarness();
  const coordinator = createDownloadCoordinator(harness.dependencies);
  await coordinator.queue({ sealedRefreshHandle: HANDLE });
  assert.equal(await coordinator.cancelTemporary({ jobId: JOB_ID }), true);
  assert.deepEqual(harness.calls.removals, [{ packId: PACK_ID, version: VERSION }]);
  assert.deepEqual(harness.memory.snapshot(), { job: null, chunks: [] });
});

test('cancel deletes durable authority before native removal and is retry-safe at both failures', async () => {
  {
    const harness = createHarness();
    let deleteAttempts = 0;
    harness.dependencies.packRepository = {
      ...harness.dependencies.packRepository,
      async deleteDownloadJob(input) {
        deleteAttempts += 1;
        if (deleteAttempts === 1) throw new Error('delete failed');
        return harness.memory.repository.deleteDownloadJob(input);
      },
    };
    const coordinator = createDownloadCoordinator(harness.dependencies);
    await coordinator.queue({ sealedRefreshHandle: HANDLE });
    await assert.rejects(coordinator.cancelTemporary({ jobId: JOB_ID }), /delete failed/);
    assert.equal(harness.calls.removals.length, 0, 'native state remains while the job is durable');
    assert.notEqual(harness.memory.snapshot().job, null);
    assert.equal(await coordinator.cancelTemporary({ jobId: JOB_ID }), true);
    assert.equal(harness.calls.removals.length, 1);
  }

  {
    const harness = createHarness();
    let removalAttempts = 0;
    const original = harness.dependencies.packTransfer;
    harness.dependencies.packTransfer = {
      ...original,
      async removeOwnedTemporaryState(input) {
        removalAttempts += 1;
        if (removalAttempts === 1) throw new Error('removal failed');
        return original.removeOwnedTemporaryState(input);
      },
    };
    const coordinator = createDownloadCoordinator(harness.dependencies);
    await coordinator.queue({ sealedRefreshHandle: HANDLE });
    await assert.rejects(coordinator.cancelTemporary({ jobId: JOB_ID }), /removal failed/);
    assert.equal(harness.memory.snapshot().job, null, 'deleted jobs never point at missing staging');
    assert.equal(await coordinator.cancelTemporary({ jobId: JOB_ID }), false);
    assert.equal(harness.calls.removals.length, 1, 'retry removes the orphaned owned state');
  }
});

test('final archive SHA is integrity authority and mismatch preserves durable progress', async () => {
  const harness = createHarness({
    inspection: {
      archiveSha256: 'f'.repeat(64),
      manifestSha256: '39b6a788a3686d7cbf1fd4791bce45623af21ef53c60eabc03d955395856218a',
      extractedBytes: 1_082,
      fileCount: 2,
      stagingToken: `staging/${PACK_ID}/${VERSION}`,
    },
  });
  const coordinator = createDownloadCoordinator(harness.dependencies);
  await assert.rejects(
    coordinator.queue({ sealedRefreshHandle: HANDLE }),
    (error) => error?.code === 'DOWNLOAD_FINAL_INTEGRITY_MISMATCH',
  );
  const snapshot = harness.memory.snapshot();
  assert.equal(snapshot.job.state, 'downloading');
  assert.equal(snapshot.job.completedBytes, 0);
  assert.equal(snapshot.chunks[0].state, 'pending');
  assert.deepEqual(harness.calls.removals, [{ packId: PACK_ID, version: VERSION }]);
});

test('inspector throw resets durable progress before owned cleanup and resumes from truncate zero', async () => {
  const harness = createHarness();
  const originalTransfer = harness.dependencies.packTransfer;
  let inspections = 0;
  harness.dependencies.packTransfer = {
    ...originalTransfer,
    async inspectAndExtract(input) {
      inspections += 1;
      if (inspections === 1) throw new Error('inspector failed');
      return originalTransfer.inspectAndExtract(input);
    },
  };
  const coordinator = createDownloadCoordinator(harness.dependencies);
  await assert.rejects(coordinator.queue({ sealedRefreshHandle: HANDLE }), /inspector failed/);
  assert.equal(harness.memory.snapshot().job.completedBytes, 0);
  assert.equal(harness.memory.snapshot().chunks[0].state, 'pending');
  assert.equal(harness.calls.removals.length, 1);

  await coordinator.resume({ sealedRefreshHandle: HANDLE });
  assert.deepEqual(harness.calls.downloads.map(({ startByte, truncate }) =>
    ({ startByte, truncate })), [
    { startByte: 0, truncate: true },
    { startByte: 0, truncate: true },
  ]);
});

test('cleanup failure after final mismatch leaves a reset ledger that safely redownloads', async () => {
  const harness = createHarness({
    inspection: {
      archiveSha256: 'f'.repeat(64),
      manifestSha256: '39b6a788a3686d7cbf1fd4791bce45623af21ef53c60eabc03d955395856218a',
      extractedBytes: 1_082,
      fileCount: 2,
      stagingToken: `staging/${PACK_ID}/${VERSION}`,
    },
  });
  const original = harness.dependencies.packTransfer;
  harness.dependencies.packTransfer = {
    ...original,
    async removeOwnedTemporaryState() { throw new Error('cleanup failed'); },
  };
  await assert.rejects(
    createDownloadCoordinator(harness.dependencies).queue({ sealedRefreshHandle: HANDLE }),
    /cleanup failed/,
  );
  assert.equal(harness.memory.snapshot().job.completedBytes, 0);
  assert.equal(harness.memory.snapshot().chunks[0].state, 'pending');
});

function rateLimited() {
  // The shape createHttpEntitlementGateway produces for a worker 429.
  return Object.assign(new Error('RATE_LIMITED'), {
    code: 'RATE_LIMITED', status: 429, retryable: true,
  });
}

test('a rate-limited gateway is survivable: nothing is mutated and the next attempt completes', async () => {
  const { isRecoverableExternalFailure } = await import('../src/app/commerce-runtime-support.js');
  assert.equal(isRecoverableExternalFailure(rateLimited()), true);
  const harness = createHarness({
    authoriseOutcomes: [rateLimited(), authorisation(), authorisation()],
  });
  const coordinator = createDownloadCoordinator(harness.dependencies);
  await assert.rejects(coordinator.queue({ sealedRefreshHandle: HANDLE }), {
    code: 'RATE_LIMITED',
  });
  // Authorisation precedes every job, chunk, network and native mutation, so a
  // 429 there leaves no durable trace at all.
  assert.equal(harness.memory.snapshot().job, null);
  assert.equal(harness.calls.downloads.length, 0);

  const result = await coordinator.queue({ sealedRefreshHandle: HANDLE });
  assert.equal(result.state, 'downloaded');
  assert.equal(harness.calls.downloads.length, 1);
});

test('a rate-limited range transfer keeps the durable plan and the retry re-enters the loop', async () => {
  const harness = createHarness({
    outcomes: [rateLimited(), {
      status: 206, startByte: 0, endByteExclusive: 1_324,
      totalBytes: 1_324, bytesWritten: 1_324, etag: ARCHIVE_ETAG,
    }],
    authoriseOutcomes: [authorisation(), authorisation(), authorisation()],
  });
  const coordinator = createDownloadCoordinator(harness.dependencies);
  await assert.rejects(coordinator.queue({ sealedRefreshHandle: HANDLE }), {
    code: 'RATE_LIMITED',
  });
  const interrupted = harness.memory.snapshot();
  assert.equal(interrupted.job.jobId, JOB_ID);
  assert.equal(interrupted.job.completedBytes, 0);
  assert.equal(interrupted.chunks.length, 1);
  assert.equal(interrupted.chunks[0].chunkSha256, null);

  const resumed = await coordinator.resume({ sealedRefreshHandle: HANDLE });
  assert.equal(resumed.state, 'downloaded');
  // Exactly one further range request: the loop resumed at the chunk the 429
  // interrupted rather than restarting or giving up.
  assert.equal(harness.calls.downloads.length, 2);
  assert.deepEqual(
    harness.calls.downloads.map((request) => request.startByte),
    [0, 0],
  );
});

test('a composition that forgets packAuthority cannot construct a coordinator', () => {
  const harness = createHarness();
  const elevenKeys = { ...harness.dependencies };
  delete elevenKeys.packAuthority;
  assert.equal(Object.keys(elevenKeys).length, 11);
  // No default pack since the join flip: an unnamed pack would silently bind
  // every download to catalogue entry zero.
  assert.throws(
    () => createDownloadCoordinator(elevenKeys),
    /Download coordinator dependencies are invalid/,
  );
  assert.throws(
    () => createDownloadCoordinator({ ...elevenKeys, packAuthority: undefined }),
    TypeError,
  );
});
