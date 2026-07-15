import assert from 'node:assert/strict';
import test from 'node:test';

import { createDownloadCoordinator } from '../src/app/download-coordinator.js';
import { assertSignedDownloadAccess } from '../src/domain/packs/signed-download-access-contract.js';
import {
  ARCHIVE_ETAG, ARCHIVE_SHA, ENVELOPE_SHA, HANDLE, JOB_ID, NOW, PACK_ID, VERSION,
  authorisation, capabilityUrl, createHarness, createRangeFixtureServer,
} from './helpers/range-fixture-server.mjs';

function job(overrides = {}) {
  return {
    jobId: JOB_ID, packId: PACK_ID, version: VERSION,
    manifestSha256: ENVELOPE_SHA, archiveName: `${PACK_ID}.zip`,
    archiveSha256: ARCHIVE_SHA, expectedBytes: 1_324, completedBytes: 1_000,
    etag: ARCHIVE_ETAG, state: 'downloading', updatedAt: NOW - 10,
    ...overrides,
  };
}

function resumeChunks() {
  return [
    { jobId: JOB_ID, startByte: 0, endByteExclusive: 1_000, state: 'complete', chunkSha256: ARCHIVE_SHA },
    { jobId: JOB_ID, startByte: 1_000, endByteExclusive: 1_324, state: 'pending', chunkSha256: null },
  ];
}

test('resume skips durable complete chunks and sends an exact 206 range', async () => {
  const harness = createHarness({
    initialJob: job(), initialChunks: resumeChunks(),
    outcomes: [{ status: 206, startByte: 1_000, endByteExclusive: 1_324, totalBytes: 1_324, bytesWritten: 324, etag: ARCHIVE_ETAG }],
  });
  const result = await createDownloadCoordinator(harness.dependencies)
    .resume({ sealedRefreshHandle: HANDLE });
  assert.equal(result.state, 'downloaded');
  assert.deepEqual(harness.calls.downloads.map(({ startByte, endByteExclusive, truncate }) =>
    ({ startByte, endByteExclusive, truncate })), [
    { startByte: 1_000, endByteExclusive: 1_324, truncate: false },
  ]);
});

test('expired capability renews signed authority and retries the same chunk', async () => {
  const expired = Object.assign(new Error('expired'), { code: 'PACK_CAPABILITY_EXPIRED' });
  const renewed = authorisation();
  renewed.archiveCapability.capabilityUrl = capabilityUrl({ cap: 'B'.repeat(43) });
  const harness = createHarness({
    initialJob: job(), initialChunks: resumeChunks(),
    authoriseOutcomes: [authorisation(), renewed],
    outcomes: [expired, { status: 206, startByte: 1_000, endByteExclusive: 1_324, totalBytes: 1_324, bytesWritten: 324, etag: ARCHIVE_ETAG }],
  });
  await createDownloadCoordinator(harness.dependencies).retry({ sealedRefreshHandle: HANDLE });
  assert.equal(harness.calls.gateway.length, 2);
  assert.equal(harness.calls.downloads.length, 2);
  assert.notEqual(harness.calls.downloads[0].capabilityUrl, harness.calls.downloads[1].capabilityUrl);
  assert.equal(JSON.stringify(harness.memory.snapshot()).includes('BBBB'), false);
});

test('capability renewal is bounded to one fresh authority per operation', async () => {
  const expired = () => Object.assign(new Error('expired'), { code: 'PACK_CAPABILITY_EXPIRED' });
  const harness = createHarness({
    initialJob: job(), initialChunks: resumeChunks(),
    authoriseOutcomes: [authorisation(), authorisation()],
    outcomes: [expired(), expired()],
  });
  await assert.rejects(
    createDownloadCoordinator(harness.dependencies).retry({ sealedRefreshHandle: HANDLE }),
    (error) => error?.code === 'DOWNLOAD_CAPABILITY_RENEWAL_EXHAUSTED',
  );
  assert.equal(harness.calls.gateway.length, 2);
  assert.equal(harness.calls.downloads.length, 2);
  assert.equal(harness.memory.snapshot().job.completedBytes, 1_000);
});

test('ETag, 206 range and truncation mismatch fail without marking a chunk complete', async () => {
  for (const outcome of [
    { status: 206, startByte: 999, endByteExclusive: 1_324, totalBytes: 1_324, bytesWritten: 325, etag: ARCHIVE_ETAG },
    { status: 206, startByte: 1_000, endByteExclusive: 1_324, totalBytes: 1_324, bytesWritten: 324, etag: 'changed-etag' },
    { status: 206, startByte: 1_000, endByteExclusive: 1_323, totalBytes: 1_324, bytesWritten: 323, etag: ARCHIVE_ETAG },
  ]) {
    const harness = createHarness({ initialJob: job(), initialChunks: resumeChunks(), outcomes: [outcome] });
    await assert.rejects(
      createDownloadCoordinator(harness.dependencies).resume({ sealedRefreshHandle: HANDLE }),
      (error) => error?.code === 'DOWNLOAD_RANGE_AUTHORITY_MISMATCH',
    );
    assert.equal(harness.memory.snapshot().job.completedBytes, 0);
    assert.equal(harness.memory.snapshot().chunks[0].state, 'pending');
  }
});

test('a real local HTTP fixture proves the coordinator emits the exact resumable Range', async (t) => {
  const server = await createRangeFixtureServer(Buffer.alloc(1_324, 7), { etag: ARCHIVE_ETAG });
  t.after(() => server.close());
  const harness = createHarness({ initialJob: job(), initialChunks: resumeChunks() });
  harness.dependencies.packTransfer = {
    ...harness.dependencies.packTransfer,
    async downloadRange(request) {
      harness.calls.downloads.push(structuredClone(request));
      const response = await fetch(`${server.origin}/archive.zip`, {
        headers: { Range: `bytes=${request.startByte}-${request.endByteExclusive - 1}` },
      });
      const body = new Uint8Array(await response.arrayBuffer());
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
      return {
        status: response.status,
        startByte: Number(match[1]),
        endByteExclusive: Number(match[2]) + 1,
        totalBytes: Number(match[3]),
        bytesWritten: body.byteLength,
        etag: response.headers.get('etag'),
      };
    },
  };
  await createDownloadCoordinator(harness.dependencies).resume({ sealedRefreshHandle: HANDLE });
  assert.deepEqual(server.requests, [{ method: 'GET', range: 'bytes=1000-1323' }]);
  assert.equal(harness.memory.snapshot().job.state, 'downloaded');
});

test('416 clears stale completion, renews authority and restarts at zero with truncate', async () => {
  const rangeError = Object.assign(new Error('range'), { code: 'PACK_RANGE_NOT_SATISFIABLE' });
  const harness = createHarness({
    initialJob: job(), initialChunks: resumeChunks(),
    authoriseOutcomes: [authorisation(), authorisation()],
    outcomes: [rangeError, { status: 206, startByte: 0, endByteExclusive: 1_324, totalBytes: 1_324, bytesWritten: 1_324, etag: ARCHIVE_ETAG }],
  });
  await createDownloadCoordinator(harness.dependencies).resume({ sealedRefreshHandle: HANDLE });
  assert.equal(harness.calls.gateway.length, 2);
  assert.equal(harness.calls.downloads[1].startByte, 0);
  assert.equal(harness.calls.downloads[1].truncate, true);
  assert.ok(harness.memory.writes.some(([kind]) => kind === 'clear'));
});

test('ignored non-zero Range response clears chunks and reissues from zero with truncate', async () => {
  const harness = createHarness({
    initialJob: job(), initialChunks: resumeChunks(),
    outcomes: [
      { status: 200, startByte: 0, endByteExclusive: 1_324, totalBytes: 1_324, bytesWritten: 1_324, etag: ARCHIVE_ETAG },
      { status: 200, startByte: 0, endByteExclusive: 1_324, totalBytes: 1_324, bytesWritten: 1_324, etag: ARCHIVE_ETAG },
    ],
  });
  await createDownloadCoordinator(harness.dependencies).resume({ sealedRefreshHandle: HANDLE });
  assert.deepEqual(harness.calls.downloads.map(({ startByte, truncate }) => ({ startByte, truncate })), [
    { startByte: 1_000, truncate: false },
    { startByte: 0, truncate: true },
  ]);
  assert.equal(harness.memory.snapshot().job.completedBytes, 1_324);
});

test('restart from a non-zero range reruns storage preflight for the full archive', async () => {
  const harness = createHarness({
    initialJob: job(), initialChunks: resumeChunks(), freeBytes: 67_500,
    outcomes: [
      { status: 200, startByte: 0, endByteExclusive: 1_324, totalBytes: 1_324, bytesWritten: 1_324, etag: ARCHIVE_ETAG },
    ],
  });
  await assert.rejects(
    createDownloadCoordinator(harness.dependencies).resume({ sealedRefreshHandle: HANDLE }),
    (error) => error?.code === 'DOWNLOAD_STORAGE_INSUFFICIENT',
  );
  assert.equal(harness.calls.downloads.length, 1);
  assert.equal(harness.memory.snapshot().job.completedBytes, 0);
});

test('resume repairs a downloading job whose chunk ledger was cleared by an interrupted restart', async () => {
  const harness = createHarness({
    initialJob: job({ completedBytes: 0 }),
    initialChunks: [],
    outcomes: [{
      status: 206, startByte: 0, endByteExclusive: 1_324,
      totalBytes: 1_324, bytesWritten: 1_324, etag: ARCHIVE_ETAG,
    }],
  });
  const result = await createDownloadCoordinator(harness.dependencies)
    .resume({ sealedRefreshHandle: HANDLE });
  assert.equal(result.state, 'downloaded');
  assert.equal(harness.calls.downloads[0].startByte, 0);
  assert.equal(harness.calls.downloads[0].truncate, true);
});

test('every durable restart boundary self-repairs on the next resume', async (t) => {
  const ignored = () => ({
    status: 200, startByte: 0, endByteExclusive: 1_324,
    totalBytes: 1_324, bytesWritten: 1_324, etag: ARCHIVE_ETAG,
  });
  const zero = () => ({
    status: 206, startByte: 0, endByteExclusive: 1_324,
    totalBytes: 1_324, bytesWritten: 1_324, etag: ARCHIVE_ETAG,
  });
  const boundaries = [
    ['clear', (name) => name === 'clear'],
    ['downloading-to-failed', (name, input) =>
      name === 'update' && input.expectedState === 'downloading' && input.state === 'failed'],
    ['failed-to-queued', (name, input) =>
      name === 'update' && input.expectedState === 'failed' && input.state === 'queued'],
    ['replace-plan', (name) => name === 'replace'],
    ['queued-to-downloading', (name, input) =>
      name === 'update' && input.expectedState === 'queued' && input.state === 'downloading'],
  ];

  for (const [label, shouldFail] of boundaries) {
    await t.test(label, async () => {
      const harness = createHarness({
        initialJob: job(), initialChunks: resumeChunks(),
        outcomes: [ignored(), ignored(), zero()],
      });
      const original = harness.dependencies.packRepository;
      let injected = false;
      const invoke = async (name, input) => {
        if (!injected && shouldFail(name, input)) {
          injected = true;
          throw new Error(`restart crash at ${label}`);
        }
        return original[{
          clear: 'clearDownloadChunks',
          update: 'updateDownloadJob',
          replace: 'replaceDownloadChunks',
        }[name]](input);
      };
      harness.dependencies.packRepository = {
        ...original,
        clearDownloadChunks: (input) => invoke('clear', input),
        updateDownloadJob: (input) => invoke('update', input),
        replaceDownloadChunks: (input) => invoke('replace', input),
      };
      const coordinator = createDownloadCoordinator(harness.dependencies);
      await assert.rejects(
        coordinator.resume({ sealedRefreshHandle: HANDLE }),
        new RegExp(`restart crash at ${label}`),
      );
      const result = await coordinator.resume({ sealedRefreshHandle: HANDLE });
      assert.equal(result.state, 'downloaded');
      assert.equal(harness.memory.snapshot().job.completedBytes, 1_324);
      assert.equal(harness.calls.downloads.at(-1).startByte, 0);
      assert.equal(harness.calls.downloads.at(-1).truncate, true);
    });
  }
});

test('capability contract rejects every non-canonical credential, origin, port, path and query shape', () => {
  const nowUnixSeconds = Math.floor(NOW / 1_000);
  assert.equal(assertSignedDownloadAccess({ capabilityUrl: capabilityUrl(), nowUnixSeconds }).expiresAtUnixSeconds, nowUnixSeconds + 600);
  for (const value of [
    capabilityUrl().replace('https://', 'http://'),
    capabilityUrl().replace('b3-gateway.eugnel.uk', 'user:pass@b3-gateway.eugnel.uk'),
    capabilityUrl().replace('b3-gateway.eugnel.uk', 'b3-gateway.eugnel.uk:443'),
    capabilityUrl() + '#fragment',
    capabilityUrl().replace('/v1/', '/v2/'),
    capabilityUrl().replace('?expires=', '?cap=' + 'A'.repeat(43) + '&expires='),
    capabilityUrl() + '&cap=' + 'A'.repeat(43),
    capabilityUrl({ expires: nowUnixSeconds }),
    capabilityUrl({ expires: nowUnixSeconds + 601 }),
    capabilityUrl({ cap: 'a'.repeat(42) }),
  ]) {
    assert.throws(
      () => assertSignedDownloadAccess({ capabilityUrl: value, nowUnixSeconds }),
      (error) => error?.code === 'DOWNLOAD_CAPABILITY_INVALID',
    );
  }
});
