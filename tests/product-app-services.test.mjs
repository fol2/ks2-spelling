import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createProductAppServices } from '../src/app/create-product-app-services.js';
import { createProductLearningController } from '../src/app/product-learning-controller.js';
import {
  loadFullSpellingCatalogue,
  loadStarterSpellingCatalogue,
} from '../src/domain/spelling/index.js';
import { createDatabaseCommandGate } from '../src/platform/database/database-command-gate.js';
import { configureAndMigrateDatabase } from '../src/platform/database/migrate-database.js';
import { createSQLiteSpellingCommandRepository } from '../src/platform/database/sqlite-spelling-command-repository.js';
import { createSQLiteLearningBackupRepository } from '../src/platform/database/sqlite-learning-backup-repository.js';
import { createSQLiteSpellingSnapshotStore } from '../src/platform/database/sqlite-spelling-snapshot-store.js';
import { createNodeSqliteConnection } from './helpers/node-sqlite-connection.mjs';

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

test('production services persist profile CRUD and selected learner across a clean restart', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-spelling-product-'));
  const databasePath = join(directory, 'product.sqlite');
  t.after(() => rm(directory, { force: true, recursive: true }));
  let timestamp = 100;
  let learnerSequence = 0;
  let backupImport = null;
  const protectionCalls = [];
  const options = {
    runtime: Object.freeze({
      isNativePlatform: true,
      platform: 'ios',
    }),
    connectionFactory: async () => createNodeSqliteConnection(databasePath),
    lifecycle: createLifecycle(),
    packTransfer: Object.freeze({
      async inventoryInstalledVersions() { return Object.freeze([]); },
    }),
    bundledStarterAudio: Object.freeze({
      async checkAvailability() {
        return Object.freeze({ version: '1.0.0' });
      },
      async readInstalledAudio() {
        throw new Error('Audio playback is outside this composition test.');
      },
    }),
    parentBiometrics: Object.freeze({
      async getAvailability() {
        return Object.freeze({ available: false, type: 'none' });
      },
      async authenticate() {
        throw new Error('Biometrics unavailable in this test.');
      },
    }),
    learningBackupFiles: Object.freeze({
      async presentExport() {
        return Object.freeze({ presented: true });
      },
      async pickImport() {
        return backupImport ?? Object.freeze({ cancelled: true });
      },
    }),
    localDataProtection: Object.freeze({
      async applyPolicy(request) {
        protectionCalls.push(structuredClone(request));
        return Object.freeze({
          automaticBackupDisabled: true,
          platformProtection: 'ios-complete',
        });
      },
    }),
    now: () => timestamp,
    random: () => 0.25,
    createLearnerId() {
      learnerSequence += 1;
      return `learner-${learnerSequence}`;
    },
  };
  const fullCatalogue = await loadFullSpellingCatalogue();

  const first = await createProductAppServices(options);
  assert.equal(first.mode, 'product');
  assert.equal(first.databaseName, 'ks2-spelling');
  assert.equal(first.schemaVersion, 2);
  assert.deepEqual(first.dataPolicy, {
    applicationEncryption: 'none',
    automaticBackupDisabled: true,
    platformProtection: 'ios-complete',
  });
  assert.deepEqual(protectionCalls, [
    { databaseName: 'ks2-spelling' },
    { databaseName: 'ks2-spelling' },
  ]);
  assert.deepEqual(Object.keys(first.controller), [
    'getState',
    'subscribe',
    'createProfile',
    'editProfile',
    'selectProfile',
    'removeProfile',
    'reload',
    'dispose',
  ]);
  assert.deepEqual(first.audioAvailability.getState(), {
    status: 'ready',
    activeVersion: '1.0.0',
    actionError: null,
  });
  assert.deepEqual(Object.keys(first.learning), [
    'getState',
    'subscribe',
    'selectLearner',
    'showScreen',
    'startRound',
    'submitAnswer',
    'continueRound',
    'skipWord',
    'savePrefs',
    'endRound',
    'dispose',
  ]);
  assert.deepEqual(Object.keys(first.audio), ['play', 'dispose']);
  assert.deepEqual(Object.keys(first.parent), [
    'getState',
    'subscribe',
    'setPin',
    'unlockWithPin',
    'unlockWithBiometrics',
    'setBiometricsEnabled',
    'lock',
    'dispose',
  ]);
  assert.deepEqual(Object.keys(first.parentAdministration), ['resetLearning']);
  assert.deepEqual(Object.keys(first.parentBackup), [
    'exportBackup',
    'importBackup',
  ]);
  assert.deepEqual(Object.keys(first.parentProgress), [
    'getState',
    'subscribe',
    'refresh',
    'dispose',
  ]);
  assert.deepEqual(Object.keys(first.parentCommerce), [
    'getState',
    'subscribe',
    'start',
    'refresh',
    'purchase',
    'restore',
    'download',
    'recover',
    'dispose',
  ]);
  await first.parentCommerce.refresh();
  assert.deepEqual(first.parentCommerce.getState(), {
    status: 'offline',
    displayPrice: '',
    entitlementState: 'none',
    packState: 'missing',
    action: null,
    actionError: null,
  });
  assert.deepEqual(first.parent.getState(), {
    status: 'setup-required',
    biometric: {
      available: false,
      type: 'none',
      enabled: false,
    },
    attemptsRemaining: 5,
    lockedUntil: 0,
    actionError: null,
  });
  assert.equal(first.learning.getState().screen, 'profiles');
  assert.equal(first.learning.getState().learnerId, null);
  assert.deepEqual(first.controller.getState(), {
    status: 'ready',
    profiles: [],
    selectedLearnerId: null,
    actionError: null,
  });

  const ada = await first.controller.createProfile({
    nickname: 'Ada',
    yearGroup: 'Y3',
    goal: 10,
    colour: '#2E7D8A',
  });
  assert.equal(ada.learnerId, 'learner-1');
  assert.equal(first.learning.getState().screen, 'home');
  assert.equal(first.learning.getState().learnerId, ada.learnerId);
  timestamp = 200;
  const ben = await first.controller.createProfile({
    nickname: 'Ben',
    yearGroup: 'Y5',
    goal: 12,
    colour: '#A7633B',
  });
  assert.equal(ben.learnerId, 'learner-2');
  await first.controller.selectProfile(ada.learnerId);
  timestamp = 300;
  await first.controller.editProfile({
    learnerId: ada.learnerId,
    nickname: 'Ada Updated',
    yearGroup: 'Y4',
    goal: 15,
    colour: '#2E7D8A',
  });
  timestamp = 400;
  await first.controller.removeProfile(ada.learnerId);
  assert.deepEqual(first.controller.getState(), {
    status: 'ready',
    profiles: [{
      ...ben,
      createdAt: 200,
      updatedAt: 200,
    }],
    selectedLearnerId: ben.learnerId,
    actionError: null,
  });
  assert.equal(first.learning.getState().learnerId, ben.learnerId);
  assert.deepEqual(first.learning.getState().vocabularySets, [
    { id: 'core', label: 'All', count: 213 },
    { id: 'y3-4', label: 'Y3–4', count: 109 },
    { id: 'y5-6', label: 'Y5–6', count: 104 },
  ]);
  await first.learning.startRound({
    length: 5,
    mode: 'smart',
    yearFilter: 'y5-6',
  });
  assert.equal(first.learning.getState().screen, 'practice');
  assert.equal(
    fullCatalogue.items.find(
      ({ runtimeItemId }) =>
        runtimeItemId === first.learning.getState().practice.runtimeItemId,
    ).yearBand,
    '5-6',
  );
  const activeSessionId = first.learning.getState().practice.sessionId;
  await first.parentProgress.refresh();
  assert.deepEqual(first.parentProgress.getState(), {
    status: 'ready',
    learners: [{
      learnerId: ben.learnerId,
      nickname: 'Ben',
      yearGroup: 'Y5',
      colour: '#A7633B',
      publishedItemCount: 213,
      secureItemCount: 0,
      dueItemCount: 0,
      troubleItemCount: 0,
      correctCount: 0,
      wrongCount: 0,
      accuracyPercent: null,
      guardianDueCount: 0,
      wobblingDueCount: 0,
      nextGuardianReviewDay: null,
      recentRevisionSessions: [],
    }],
    actionError: null,
  });
  await first.dispose();

  const second = await createProductAppServices({
    ...options,
    lifecycle: createLifecycle(),
  });
  assert.equal(second.controller.getState().selectedLearnerId, ben.learnerId);
  assert.deepEqual(
    second.controller.getState().profiles.map(({ nickname }) => nickname),
    ['Ben'],
  );
  assert.equal(second.learning.getState().screen, 'practice');
  assert.equal(second.learning.getState().learnerId, ben.learnerId);
  assert.equal(second.learning.getState().practice.sessionId, activeSessionId);
  await second.parentAdministration.resetLearning(ben.learnerId);
  assert.equal(second.learning.getState().screen, 'home');
  assert.equal(second.learning.getState().practice, null);
  assert.equal(second.learning.getState().progress.length, 213);
  assert.ok(
    second.learning.getState().progress.every(
      ({ attempts, dueDay, lastResult }) =>
        attempts === 0 && dueDay === null && lastResult === null,
    ),
  );
  assert.deepEqual(second.learning.getState().vocabularySets, [
    { id: 'core', label: 'All', count: 213 },
    { id: 'y3-4', label: 'Y3–4', count: 109 },
    { id: 'y5-6', label: 'Y5–6', count: 104 },
  ]);
  assert.equal(protectionCalls.length, 4);
  await second.dispose();

  const legacyConnection = createNodeSqliteConnection(databasePath);
  await legacyConnection.open();
  await configureAndMigrateDatabase(legacyConnection);
  await legacyConnection.execute(
    'UPDATE spelling_aggregates SET catalogue_id = ? WHERE learner_id = ?',
    ['ks2-core:starter', ben.learnerId],
  );
  const starterCatalogue = loadStarterSpellingCatalogue();
  const legacyCatalogues = Object.freeze({
    [starterCatalogue.catalogueId]: starterCatalogue,
  });
  const legacyGate = createDatabaseCommandGate();
  const legacySnapshots = createSQLiteSpellingSnapshotStore({
    connection: legacyConnection,
    cataloguesById: legacyCatalogues,
  });
  const legacyLearning = createProductLearningController({
    repository: createSQLiteSpellingCommandRepository({
      connection: legacyConnection,
      gate: legacyGate,
      store: legacySnapshots,
      cataloguesById: legacyCatalogues,
      now: () => 500,
    }),
    snapshotStore: legacySnapshots,
    catalogue: starterCatalogue,
    initialSnapshot: await legacySnapshots.read(ben.learnerId),
    random: () => 0.25,
  });
  await legacyLearning.startRound({
    length: 5,
    mode: 'smart',
    yearFilter: 'core',
  });
  await legacyLearning.submitAnswer('definitely wrong');
  await legacyLearning.submitAnswer('still wrong');
  const legacyRuntimeItemId =
    legacyLearning.getState().practice.runtimeItemId;
  await legacyLearning.submitAnswer(
    starterCatalogue.items.find(
      ({ runtimeItemId }) => runtimeItemId === legacyRuntimeItemId,
    ).target,
  );
  await legacyLearning.continueRound();
  const legacyState = legacyLearning.getState();
  const legacySnapshot = await legacySnapshots.read(ben.learnerId);
  const legacyBackup = await createSQLiteLearningBackupRepository({
    connection: legacyConnection,
    gate: legacyGate,
    cataloguesById: legacyCatalogues,
    now: () => 600,
  }).exportBackup();
  backupImport = Object.freeze({
    cancelled: false,
    bytesBase64: Buffer.from(legacyBackup, 'utf8').toString('base64'),
    sha256: createHash('sha256').update(legacyBackup).digest('hex'),
  });
  assert.ok(legacySnapshot.revision > 0);
  assert.equal(legacyState.practice.progress.checked, 1);
  await legacyLearning.dispose();
  await legacyConnection.close();

  const third = await createProductAppServices({
    ...options,
    lifecycle: createLifecycle(),
  });
  const metProgress = (rows) => rows.filter(({ attempts }) => attempts > 0);
  assert.equal(third.learning.getState().screen, 'practice');
  assert.deepEqual(third.learning.getState().practice, legacyState.practice);
  assert.deepEqual(
    metProgress(third.learning.getState().progress),
    metProgress(legacyState.progress),
  );
  assert.deepEqual(await third.parentBackup.importBackup(), {
    cancelled: false,
    learnerCount: 1,
    selectedLearnerId: ben.learnerId,
  });
  assert.equal(third.learning.getState().screen, 'practice');
  assert.deepEqual(third.learning.getState().practice, legacyState.practice);
  assert.deepEqual(
    metProgress(third.learning.getState().progress),
    metProgress(legacyState.progress),
  );
  await third.dispose();

  const promotedConnection = createNodeSqliteConnection(databasePath);
  await promotedConnection.open();
  const promotedSnapshot = await createSQLiteSpellingSnapshotStore({
    connection: promotedConnection,
    cataloguesById: Object.freeze({
      [fullCatalogue.catalogueId]: fullCatalogue,
    }),
  }).read(ben.learnerId);
  assert.deepEqual(promotedSnapshot, {
    ...legacySnapshot,
    catalogueId: 'ks2-core:full',
  });
  await promotedConnection.close();
});
