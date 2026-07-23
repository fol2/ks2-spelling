import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCapacitorLearningBackupFiles,
} from '../src/platform/backup/capacitor-learning-backup-files.js';

const MAXIMUM_BYTES = 5_242_880;
const BACKUP = '{"backup":true}';
const SHA256 = 'a'.repeat(64);

test('learning backup file port exposes bounded export and import operations', async () => {
  const calls = [];
  const files = createCapacitorLearningBackupFiles({
    LearningBackupFile: {
      async presentExport(request) {
        calls.push(['export', structuredClone(request)]);
        return { presented: true };
      },
      async pickImport(request) {
        calls.push(['import', structuredClone(request)]);
        return {
          cancelled: false,
          bytesBase64: btoa(BACKUP),
          sha256: SHA256,
        };
      },
    },
  });

  assert.deepEqual(Object.keys(files), ['presentExport', 'pickImport']);
  assert.deepEqual(
    await files.presentExport({
      fileName: 'ks2-spelling-backup-20260723-123456.json',
      bytesBase64: btoa(BACKUP),
      sha256: SHA256,
    }),
    { presented: true },
  );
  assert.deepEqual(
    await files.pickImport({ maximumBytes: MAXIMUM_BYTES }),
    {
      cancelled: false,
      bytesBase64: btoa(BACKUP),
      sha256: SHA256,
    },
  );
  assert.deepEqual(calls, [
    ['export', {
      fileName: 'ks2-spelling-backup-20260723-123456.json',
      bytesBase64: btoa(BACKUP),
      sha256: SHA256,
    }],
    ['import', { maximumBytes: MAXIMUM_BYTES }],
  ]);
});

test('learning backup file port rejects widened requests and malformed native data', async () => {
  let calls = 0;
  const files = createCapacitorLearningBackupFiles({
    LearningBackupFile: {
      async presentExport() {
        calls += 1;
        return { presented: false };
      },
      async pickImport() {
        calls += 1;
        return { cancelled: true, bytesBase64: '' };
      },
    },
  });

  await assert.rejects(
    files.presentExport({
      fileName: '../backup.json',
      bytesBase64: btoa(BACKUP),
      sha256: SHA256,
    }),
    /backup/i,
  );
  await assert.rejects(
    files.presentExport({
      fileName: 'ks2-spelling-backup-20260723-123456.json',
      bytesBase64: btoa(BACKUP),
      sha256: SHA256,
      learnerId: 'learner-a',
    }),
    /backup/i,
  );
  await assert.rejects(
    files.pickImport({ maximumBytes: MAXIMUM_BYTES - 1 }),
    /backup/i,
  );
  assert.equal(calls, 0);

  await assert.rejects(
    files.presentExport({
      fileName: 'ks2-spelling-backup-20260723-123456.json',
      bytesBase64: btoa(BACKUP),
      sha256: SHA256,
    }),
    /backup/i,
  );
  await assert.rejects(
    files.pickImport({ maximumBytes: MAXIMUM_BYTES }),
    /backup/i,
  );
  assert.equal(calls, 2);
});
