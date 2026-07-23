import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createParentBackupService,
} from '../src/app/parent-backup-service.js';

async function sha256(value) {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

test('Parent backup service exports and imports bounded bytes through the native file port', async () => {
  const backupBytes = '{"backup":true}';
  const exports = [];
  const imports = [];
  const afterImports = [];
  const service = createParentBackupService({
    repository: Object.freeze({
      async exportBackup() {
        return backupBytes;
      },
      async importBackup(bytes) {
        imports.push(bytes);
        return Object.freeze({
          learnerCount: 2,
          selectedLearnerId: 'learner-b',
        });
      },
    }),
    files: Object.freeze({
      async presentExport(request) {
        exports.push(structuredClone(request));
        return Object.freeze({ presented: true });
      },
      async pickImport(request) {
        assert.deepEqual(request, { maximumBytes: 5_242_880 });
        return Object.freeze({
          cancelled: false,
          bytesBase64: btoa(backupBytes),
          sha256: await sha256(backupBytes),
        });
      },
    }),
    async afterImport(result) {
      afterImports.push(structuredClone(result));
    },
    now: () => Date.UTC(2026, 6, 23, 12, 34, 56),
  });

  assert.deepEqual(Object.keys(service), [
    'exportBackup',
    'importBackup',
  ]);
  assert.deepEqual(await service.exportBackup(), { presented: true });
  assert.deepEqual(exports, [{
    fileName: 'ks2-spelling-backup-20260723-123456.json',
    bytesBase64: btoa(backupBytes),
    sha256: await sha256(backupBytes),
  }]);
  assert.deepEqual(await service.importBackup(), {
    cancelled: false,
    learnerCount: 2,
    selectedLearnerId: 'learner-b',
  });
  assert.deepEqual(imports, [backupBytes]);
  assert.deepEqual(afterImports, [{
    learnerCount: 2,
    selectedLearnerId: 'learner-b',
  }]);
});

test('Parent backup service preserves cancellation and rejects native byte tampering', async () => {
  let importCalls = 0;
  const repository = Object.freeze({
    async exportBackup() {
      return '{}';
    },
    async importBackup() {
      importCalls += 1;
      return Object.freeze({ learnerCount: 0, selectedLearnerId: null });
    },
  });
  const cancelled = createParentBackupService({
    repository,
    files: Object.freeze({
      async presentExport() {
        return Object.freeze({ presented: true });
      },
      async pickImport() {
        return Object.freeze({ cancelled: true });
      },
    }),
    afterImport: async () => {},
    now: () => 0,
  });
  assert.deepEqual(await cancelled.importBackup(), { cancelled: true });

  const tampered = createParentBackupService({
    repository,
    files: Object.freeze({
      async presentExport() {
        return Object.freeze({ presented: true });
      },
      async pickImport() {
        return Object.freeze({
          cancelled: false,
          bytesBase64: btoa('{}'),
          sha256: '0'.repeat(64),
        });
      },
    }),
    afterImport: async () => {},
    now: () => 0,
  });
  await assert.rejects(tampered.importBackup(), /backup|hash/i);
  assert.equal(importCalls, 0);
});
