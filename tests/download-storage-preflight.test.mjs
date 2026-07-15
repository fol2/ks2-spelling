import assert from 'node:assert/strict';
import test from 'node:test';

import { createDownloadCoordinator, requiredFreeBytes } from '../src/app/download-coordinator.js';
import { HANDLE, createHarness } from './helpers/range-fixture-server.mjs';

test('storage preflight uses the exact bounded formula', () => {
  assert.equal(requiredFreeBytes({
    remainingCompressedBytes: 10,
    fullExtractedBytes: 20,
    stagingMetadataBytes: 3,
  }), 36);
  assert.equal(requiredFreeBytes({
    remainingCompressedBytes: 1_324,
    fullExtractedBytes: 1_082,
    stagingMetadataBytes: 65_536,
  }), Math.ceil(1_324 + 1_082 + 65_536 + (1_324 + 1_082) * 0.10));
});

test('low storage stops before archive access and preserves the durable queued authority', async () => {
  const harness = createHarness({ freeBytes: 1 });
  const coordinator = createDownloadCoordinator(harness.dependencies);
  await assert.rejects(
    coordinator.queue({ sealedRefreshHandle: HANDLE }),
    (error) => error?.code === 'DOWNLOAD_STORAGE_INSUFFICIENT' && error.requiredBytes === 68_183,
  );
  assert.equal(harness.calls.gateway.length, 1);
  assert.equal(harness.calls.downloads.length, 0);
  assert.equal(harness.calls.inspections.length, 0);
  assert.equal(harness.memory.snapshot().job.state, 'downloading');
});

test('storage arithmetic rejects negative and unsafe inputs', () => {
  for (const input of [
    { remainingCompressedBytes: -1, fullExtractedBytes: 1, stagingMetadataBytes: 1 },
    { remainingCompressedBytes: Number.MAX_SAFE_INTEGER, fullExtractedBytes: 1, stagingMetadataBytes: 1 },
  ]) {
    assert.throws(() => requiredFreeBytes(input), /invalid|overflow/i);
  }
});
