import assert from 'node:assert/strict';
import test from 'node:test';

import { createDownloadCoordinator } from '../src/app/download-coordinator.js';
import { B3_DOWNLOAD_CHUNK_BYTES } from '../src/domain/packs/signed-download-access-contract.js';
import {
  ARCHIVE_SHA, HANDLE, JOB_ID, PACK_ID, VERSION,
  authorisation, createHarness, createShardHarness,
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

test('a rate-limited range transfer aborts the transfer by design and stays resumable across chunks', async () => {
  // The design, stated plainly: RATE_LIMITED is NOT retried inside the
  // transfer loop. download-coordinator.js rethrows everything that is not a
  // capability/range fault, so a 429 ends the attempt with the durable job and
  // chunk ledger intact, and recovery is an explicit resume — the Parent
  // card's "Resume download" button. See deliberate call 12.
  const harness = await createShardHarness({
    failAtDownload: (request, callNumber) => callNumber === 4 ? rateLimited() : null,
  });
  const CHUNK = B3_DOWNLOAD_CHUNK_BYTES;
  assert.ok(harness.chunkCount > 1, 'the resume fixture must span several chunks');
  const coordinator = createDownloadCoordinator(harness.dependencies);
  await assert.rejects(coordinator.queue({ sealedRefreshHandle: HANDLE }), {
    code: 'RATE_LIMITED',
  });
  // No in-loop retry: the coordinator made exactly the four requests, the
  // fourth being the refused one, and then stopped.
  assert.equal(harness.calls.downloads.length, 4);
  const interrupted = harness.memory.snapshot();
  assert.equal(interrupted.job.state, 'downloading');
  assert.equal(interrupted.job.completedBytes, 3 * CHUNK);
  assert.equal(interrupted.chunks.length, harness.chunkCount);
  assert.deepEqual(
    interrupted.chunks.slice(0, 4).map((chunk) => chunk.state),
    ['complete', 'complete', 'complete', 'pending'],
  );

  const resumed = await coordinator.resume({ sealedRefreshHandle: HANDLE });
  assert.equal(resumed.state, 'downloaded');
  // The resume picked up at the chunk the 429 interrupted. Three completed
  // chunks were never re-fetched: with a single-chunk fixture this assertion
  // would hold just as well for a restart from byte 0, which is why the
  // fixture is a real ~30 MiB shard.
  assert.equal(harness.calls.downloads.length, harness.chunkCount + 1);
  assert.equal(harness.calls.downloads[4].startByte, 3 * CHUNK);
  assert.deepEqual(
    harness.calls.downloads.map((request) => request.startByte),
    [
      ...Array.from({ length: 4 }, (_, index) => index * CHUNK),
      ...Array.from({ length: harness.chunkCount - 3 }, (_, index) => (index + 3) * CHUNK),
    ],
  );
  // Every byte of the archive is accounted for exactly once in the ledger.
  const chunks = harness.memory.snapshot().chunks;
  assert.ok(chunks.every((chunk) => chunk.state === 'complete'));
  assert.equal(chunks.at(-1).endByteExclusive, harness.row.archiveBytes);
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
