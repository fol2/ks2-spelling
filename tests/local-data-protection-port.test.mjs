import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCapacitorLocalDataProtection,
} from '../src/platform/security/capacitor-local-data-protection.js';

test('local data protection applies one closed database policy', async () => {
  const calls = [];
  const protection = createCapacitorLocalDataProtection({
    LocalDataProtection: {
      async applyDatabasePolicy(request) {
        calls.push(structuredClone(request));
        return {
          automaticBackupDisabled: true,
          platformProtection: 'ios-complete',
        };
      },
    },
  });

  assert.deepEqual(Object.keys(protection), ['applyPolicy']);
  assert.deepEqual(
    await protection.applyPolicy({ databaseName: 'ks2-spelling' }),
    {
      automaticBackupDisabled: true,
      platformProtection: 'ios-complete',
    },
  );
  assert.deepEqual(calls, [{ databaseName: 'ks2-spelling' }]);
});

test('local data protection rejects widened requests and unproved native policy', async () => {
  let calls = 0;
  const protection = createCapacitorLocalDataProtection({
    LocalDataProtection: {
      async applyDatabasePolicy() {
        calls += 1;
        return {
          automaticBackupDisabled: false,
          platformProtection: 'unknown',
        };
      },
    },
  });

  await assert.rejects(
    protection.applyPolicy({
      databaseName: 'ks2-spelling',
      databasePath: '/tmp/database',
    }),
    /data protection/i,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    protection.applyPolicy({ databaseName: 'ks2-spelling' }),
    /data protection/i,
  );
  assert.equal(calls, 1);
});

test('local data protection reports the explicit iOS Simulator limitation', async () => {
  const protection = createCapacitorLocalDataProtection({
    LocalDataProtection: {
      async applyDatabasePolicy() {
        return {
          automaticBackupDisabled: true,
          platformProtection: 'ios-simulator-protection-unobservable',
        };
      },
    },
  });

  assert.deepEqual(
    await protection.applyPolicy({ databaseName: 'ks2-spelling' }),
    {
      automaticBackupDisabled: true,
      platformProtection: 'ios-simulator-protection-unobservable',
    },
  );
});
