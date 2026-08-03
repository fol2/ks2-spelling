import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createProductAppServices } from '../src/app/create-product-app-services.js';
import { createNodeSqliteConnection } from './helpers/node-sqlite-connection.mjs';

const PROFILE_ROWS =
  'SELECT learner_id, nickname, year_group, goal, colour, created_at, updated_at FROM learner_profiles ORDER BY learner_id';

function createLifecycle() {
  return Object.freeze({
    onPause: () => Object.freeze({ async remove() {} }),
    onResume: () => Object.freeze({ async remove() {} }),
    onStateChange: () => Object.freeze({ async remove() {} }),
    getState: () => Object.freeze({
      canonicalState: 'active',
      diagnosticStateChanges: Object.freeze([]),
    }),
    async dispose() {},
  });
}

function createHoldableConnectionFactory(databasePath) {
  const events = [];
  let nextHold = null;

  async function waitIfHeld(sql) {
    events.push(sql);
    const hold = nextHold;
    if (hold === null) return;
    hold.pattern.lastIndex = 0;
    if (!hold.pattern.test(sql)) return;
    nextHold = null;
    hold.sql = sql;
    events.push(`HOLD ${sql}`);
    hold.markReached();
    await hold.blocker;
    events.push(`CONTINUE ${sql}`);
  }

  return Object.freeze({
    events,
    holdNextMatching(pattern) {
      assert.equal(nextHold, null, 'Only one unmatched SQL hold may be armed.');
      let markReached;
      let unblock;
      const reached = new Promise((resolve) => { markReached = resolve; });
      const blocker = new Promise((resolve) => { unblock = resolve; });
      const hold = { blocker, markReached, pattern, sql: null };
      nextHold = hold;
      return Object.freeze({
        reached,
        release() {
          events.push(`RELEASE ${hold.sql}`);
          unblock();
        },
      });
    },
    async createConnection() {
      const connection = createNodeSqliteConnection(databasePath);
      return Object.freeze({
        async open() { return connection.open(); },
        async close() { return connection.close(); },
        async execute(sql, values) {
          await waitIfHeld(sql);
          return connection.execute(sql, values);
        },
        async query(sql, values) {
          await waitIfHeld(sql);
          return connection.query(sql, values);
        },
        async begin() { return connection.begin(); },
        async commit() { return connection.commit(); },
        async rollback() { return connection.rollback(); },
        async isTransactionActive() {
          return connection.isTransactionActive();
        },
      });
    },
  });
}

function profileDraft(nickname) {
  return {
    nickname,
    yearGroup: 'Y3',
    goal: 10,
    colour: '#2E7D8A',
  };
}

function profileRow(profile) {
  return {
    learner_id: profile.learnerId,
    nickname: profile.nickname,
    year_group: profile.yearGroup,
    goal: profile.goal,
    colour: profile.colour,
    created_at: profile.createdAt,
    updated_at: profile.updatedAt,
  };
}

async function queryProfiles(databasePath) {
  const connection = createNodeSqliteConnection(databasePath);
  await connection.open();
  try {
    return await connection.query(PROFILE_ROWS);
  } finally {
    await connection.close();
  }
}

async function createHarness(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-spelling-backup-race-'));
  const databasePath = join(directory, 'product.sqlite');
  const connections = createHoldableConnectionFactory(databasePath);
  let importResponse = Object.freeze({ cancelled: true });
  let pickImportCalls = 0;
  let presentExportCalls = 0;
  let learnerSequence = 0;
  const services = await createProductAppServices({
    connectionFactory: connections.createConnection,
    lifecycle: createLifecycle(),
    bundledStarterAudio: Object.freeze({
      async checkAvailability() {
        return Object.freeze({ version: '1.0.0' });
      },
      async readInstalledAudio() {
        throw new Error('Audio playback is outside this test.');
      },
    }),
    parentBiometrics: Object.freeze({
      async getAvailability() {
        return Object.freeze({ available: false, type: 'none' });
      },
      async authenticate() {
        throw new Error('Biometrics are unavailable in this test.');
      },
    }),
    learningBackupFiles: Object.freeze({
      async presentExport({ bytesBase64, sha256 }) {
        presentExportCalls += 1;
        importResponse = Object.freeze({
          cancelled: false,
          bytesBase64,
          sha256,
        });
        return Object.freeze({ presented: true });
      },
      async pickImport() {
        pickImportCalls += 1;
        return importResponse;
      },
    }),
    localDataProtection: Object.freeze({
      async applyPolicy() {
        return Object.freeze({
          automaticBackupDisabled: true,
          platformProtection: 'ios-complete',
        });
      },
    }),
    now: () => 100,
    random: () => 0.25,
    createLearnerId() {
      learnerSequence += 1;
      return `learner-${learnerSequence}`;
    },
  });
  await services.parentProgress.refresh();
  t.after(async () => {
    try {
      await services.dispose();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
  return Object.freeze({
    databasePath,
    events: connections.events,
    holdNextMatching: connections.holdNextMatching,
    observeImportValidation() {
      const response = importResponse;
      let markValidated;
      let sha256Reads = 0;
      const validated = new Promise((resolve) => { markValidated = resolve; });
      importResponse = Object.freeze({
        cancelled: response.cancelled,
        bytesBase64: response.bytesBase64,
        get sha256() {
          sha256Reads += 1;
          if (sha256Reads === 2) markValidated();
          return response.sha256;
        },
      });
      return validated;
    },
    pickImportCalls: () => pickImportCalls,
    presentExportCalls: () => presentExportCalls,
    setImportResponse(response) {
      importResponse = response;
    },
    services,
  });
}

async function prepareImportReplacement(harness) {
  const imported = await harness.services.controller.createProfile(
    profileDraft('Imported'),
  );
  await harness.services.parentBackup.exportBackup();
  await harness.services.controller.removeProfile(imported.learnerId);
  await harness.services.controller.createProfile(profileDraft('Before'));
  await harness.services.parentProgress.refresh();
  return [profileRow(imported)];
}

test('two concurrent imports join one picker and one replacement', async (t) => {
  const harness = await createHarness(t);
  const backupProfiles = await prepareImportReplacement(harness);

  const first = harness.services.parentBackup.importBackup();
  const second = harness.services.parentBackup.importBackup();
  const results = await Promise.all([first, second]);

  assert.equal(first, second);
  assert.equal(results[0], results[1]);
  assert.deepEqual(await queryProfiles(harness.databasePath), backupProfiles);
  assert.equal(harness.pickImportCalls(), 1);
  assert.equal(
    harness.events.filter((event) => event === 'DELETE FROM learner_profiles').length,
    1,
  );
});

test('the import join clears after settlement', async (t) => {
  const harness = await createHarness(t);
  const backupProfiles = await prepareImportReplacement(harness);

  const first = harness.services.parentBackup.importBackup();
  const joined = harness.services.parentBackup.importBackup();
  await Promise.all([first, joined]);
  const third = harness.services.parentBackup.importBackup();
  await third;

  assert.equal(first, joined);
  assert.notEqual(third, first);
  assert.equal(harness.pickImportCalls(), 2);
  assert.deepEqual(await queryProfiles(harness.databasePath), backupProfiles);
});

test('two concurrent exports join one presentation', async (t) => {
  const harness = await createHarness(t);

  const first = harness.services.parentBackup.exportBackup();
  const second = harness.services.parentBackup.exportBackup();
  const results = await Promise.all([first, second]);

  assert.equal(first, second);
  assert.equal(results[0], results[1]);
  assert.deepEqual(results[0], { presented: true });
  assert.equal(harness.presentExportCalls(), 1);
});

test('a cancelled pick clears the import join', async (t) => {
  const harness = await createHarness(t);

  const first = harness.services.parentBackup.importBackup();
  const second = harness.services.parentBackup.importBackup();
  const cancelled = await Promise.all([first, second]);
  await harness.services.parentBackup.exportBackup();
  const later = harness.services.parentBackup.importBackup();
  const imported = await later;

  assert.equal(first, second);
  assert.equal(cancelled[0], cancelled[1]);
  assert.deepEqual(cancelled[0], { cancelled: true });
  assert.notEqual(later, first);
  assert.equal(imported.cancelled, false);
  assert.equal(harness.pickImportCalls(), 2);
});

test('a failed import rejects joined callers and clears the join', async (t) => {
  const harness = await createHarness(t);
  harness.setImportResponse(Object.freeze({
    cancelled: false,
    bytesBase64: btoa('{}'),
    sha256: '0'.repeat(64),
  }));

  const first = harness.services.parentBackup.importBackup();
  const second = harness.services.parentBackup.importBackup();
  const failures = await Promise.allSettled([first, second]);
  await harness.services.parentBackup.exportBackup();
  const later = harness.services.parentBackup.importBackup();
  const imported = await later;

  assert.equal(first, second);
  assert.equal(failures[0].status, 'rejected');
  assert.equal(failures[1].status, 'rejected');
  assert.equal(failures[0].reason, failures[1].reason);
  assert.equal(failures[0].reason.code, 'parent_backup_hash_mismatch');
  assert.notEqual(later, first);
  assert.equal(imported.cancelled, false);
  assert.equal(harness.pickImportCalls(), 2);
});

test('the gate keeps a pre-import profile write ahead of replacement', async (t) => {
  const harness = await createHarness(t);
  const backupProfiles = await prepareImportReplacement(harness);
  const profileInsert = harness.holdNextMatching(
    /^INSERT INTO learner_profiles \(/u,
  );
  const profileWrite = harness.services.controller.createProfile(
    profileDraft('Poison'),
  );
  await profileInsert.reached;
  const importDelete = harness.holdNextMatching(/^DELETE FROM learner_profiles$/u);
  const importValidated = harness.observeImportValidation();

  const importBackup = harness.services.parentBackup.importBackup();
  await importValidated;
  // Repository invocation reaches gate.run() before this continuation resumes.
  assert.equal(harness.pickImportCalls(), 1);
  profileInsert.release();
  await importDelete.reached;
  importDelete.release();
  await Promise.all([profileWrite, importBackup]);

  const profileReleaseIndex = harness.events.findIndex((event) =>
    event.startsWith('RELEASE INSERT INTO learner_profiles'));
  const importDeleteIndex = harness.events.indexOf('HOLD DELETE FROM learner_profiles');
  assert.ok(profileReleaseIndex >= 0);
  assert.ok(importDeleteIndex > profileReleaseIndex);
  assert.deepEqual(await queryProfiles(harness.databasePath), backupProfiles);
});
