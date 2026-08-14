import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createProductAppServices } from '../src/app/create-product-app-services.js';
import { createNodeSqliteConnection } from './helpers/node-sqlite-connection.mjs';

const SNAPSHOT_QUERY = /^SELECT learner_id, snapshot_schema_version, revision, pack_id, catalogue_id, granted_entitlement_ids_json FROM spelling_aggregates WHERE learner_id = \?$/u;

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

function createArmableConnectionFactory(databasePath) {
  let failurePattern = null;

  function failIfArmed(sql) {
    if (failurePattern === null || !failurePattern.test(sql)) return;
    failurePattern = null;
    throw new Error('armed_sql_failure');
  }

  return Object.freeze({
    failNextQueryMatching(pattern) {
      failurePattern = pattern;
    },
    async createConnection() {
      const connection = createNodeSqliteConnection(databasePath);
      return Object.freeze({
        async open() { return connection.open(); },
        async close() { return connection.close(); },
        async execute(sql, values) {
          failIfArmed(sql);
          return connection.execute(sql, values);
        },
        async query(sql, values) {
          failIfArmed(sql);
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

async function queryDatabase(databasePath, sql, values = []) {
  const connection = createNodeSqliteConnection(databasePath);
  await connection.open();
  try {
    return await connection.query(sql, values);
  } finally {
    await connection.close();
  }
}

async function createHarness(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-spelling-post-commit-'));
  const databasePath = join(directory, 'product.sqlite');
  const connections = createArmableConnectionFactory(databasePath);
  let learnerSequence = 0;
  let backupImport = Object.freeze({ cancelled: true });
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
        backupImport = Object.freeze({
          cancelled: false,
          bytesBase64,
          sha256,
        });
        return Object.freeze({ presented: true });
      },
      async pickImport() {
        return backupImport;
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
    failNextQueryMatching: connections.failNextQueryMatching,
    services,
  });
}

async function prepareImportReplacement(services) {
  const imported = await services.controller.createProfile(
    profileDraft('Imported'),
  );
  await services.parentBackup.exportBackup();
  await services.controller.removeProfile(imported.learnerId);
  await services.controller.createProfile(profileDraft('Before'));
  await services.parentProgress.refresh();
}

test('an import stamps a post-commit epilogue failure without rolling back', async (t) => {
  const harness = await createHarness(t);
  await prepareImportReplacement(harness.services);
  // The epilogue's first durable read is the catalogue alignment that follows
  // every import: the imported aggregates may sit on the other side of the
  // entitlement switch from the ones they replaced.
  harness.failNextQueryMatching(
    /^SELECT learner_id, catalogue_id FROM spelling_aggregates ORDER BY learner_id$/u,
  );

  await assert.rejects(
    harness.services.parentBackup.importBackup(),
    (error) => {
      assert.equal(error.postCommit, true);
      return true;
    },
  );
  assert.deepEqual(
    await queryDatabase(
      harness.databasePath,
      'SELECT nickname FROM learner_profiles ORDER BY nickname',
    ),
    [{ nickname: 'Imported' }],
  );
});

test('an import failure before commit rolls back without a post-commit marker', async (t) => {
  const harness = await createHarness(t);
  await prepareImportReplacement(harness.services);
  harness.failNextQueryMatching(/^INSERT INTO learner_profiles \(/u);

  await assert.rejects(
    harness.services.parentBackup.importBackup(),
    (error) => {
      assert.equal(error.postCommit, undefined);
      return true;
    },
  );
  assert.deepEqual(
    await queryDatabase(
      harness.databasePath,
      'SELECT nickname FROM learner_profiles ORDER BY nickname',
    ),
    [{ nickname: 'Before' }],
  );
});

test('a reset stamps a post-commit learner reload failure after resetting data', async (t) => {
  const harness = await createHarness(t);
  const learner = await harness.services.controller.createProfile(
    profileDraft('Reset'),
  );
  await harness.services.learning.startRound({
    length: 5,
    mode: 'smart',
    yearFilter: 'core',
  });
  const [before] = await queryDatabase(
    harness.databasePath,
    'SELECT revision FROM spelling_aggregates WHERE learner_id = ?',
    [learner.learnerId],
  );
  assert.ok(before.revision > 0);
  await harness.services.parentProgress.refresh();
  harness.failNextQueryMatching(SNAPSHOT_QUERY);

  await assert.rejects(
    harness.services.parentAdministration.resetLearning(learner.learnerId),
    (error) => {
      assert.equal(error.postCommit, true);
      return true;
    },
  );
  assert.deepEqual(
    await queryDatabase(
      harness.databasePath,
      'SELECT revision FROM spelling_aggregates WHERE learner_id = ?',
      [learner.learnerId],
    ),
    [{ revision: 0 }],
  );
});

test('profile removal resolves when post-commit learner alignment fails', async (t) => {
  const harness = await createHarness(t);
  const removed = await harness.services.controller.createProfile(
    profileDraft('Removed'),
  );
  await harness.services.controller.createProfile(profileDraft('Remaining'));
  await harness.services.parentProgress.refresh();
  harness.failNextQueryMatching(SNAPSHOT_QUERY);

  assert.equal(
    await harness.services.controller.removeProfile(removed.learnerId),
    true,
  );
  assert.equal(
    harness.services.learning.getState().learnerId,
    removed.learnerId,
  );
  assert.deepEqual(
    await queryDatabase(
      harness.databasePath,
      'SELECT nickname FROM learner_profiles ORDER BY nickname',
    ),
    [{ nickname: 'Remaining' }],
  );
});

test('profile creation resolves once when post-commit alignment fails', async (t) => {
  const harness = await createHarness(t);
  const selected = await harness.services.controller.createProfile(
    profileDraft('Selected'),
  );
  await harness.services.parentProgress.refresh();
  harness.failNextQueryMatching(SNAPSHOT_QUERY);

  const profile = await harness.services.controller.createProfile(
    profileDraft('Once'),
  );
  assert.equal(profile.nickname, 'Once');
  assert.equal(
    harness.services.learning.getState().learnerId,
    selected.learnerId,
  );
  assert.equal(
    harness.services.learning.getState().actionError,
    'learning_load_failed',
  );
  assert.deepEqual(
    await queryDatabase(
      harness.databasePath,
      'SELECT COUNT(*) AS count FROM learner_profiles WHERE nickname = ?',
      ['Once'],
    ),
    [{ count: 1 }],
  );
});

test('profile selection stamps failed alignment and succeeds on retry', async (t) => {
  const harness = await createHarness(t);
  const first = await harness.services.controller.createProfile(
    profileDraft('First'),
  );
  const selected = await harness.services.controller.createProfile(
    profileDraft('Selected'),
  );
  await harness.services.parentProgress.refresh();
  harness.failNextQueryMatching(SNAPSHOT_QUERY);

  await assert.rejects(
    harness.services.controller.selectProfile(selected.learnerId),
    (error) => {
      assert.equal(error.postCommit, true);
      return true;
    },
  );
  assert.equal(harness.services.learning.getState().learnerId, first.learnerId);

  await harness.services.controller.selectProfile(selected.learnerId);
  assert.equal(
    harness.services.controller.getState().selectedLearnerId,
    selected.learnerId,
  );
  assert.equal(
    harness.services.learning.getState().learnerId,
    selected.learnerId,
  );
});

test('the UI contains truthful post-commit failure copy', async () => {
  const source = await readFile(
    new URL('../src/app/ProductApp.jsx', import.meta.url),
    'utf8',
  );
  assert.ok(source.includes(
    'The backup was imported, but this screen could not refresh. Close and reopen the app.',
  ));
  assert.ok(source.includes(
    'That learning was reset, but the app could not refresh the view. Close and reopen the app.',
  ));
});
