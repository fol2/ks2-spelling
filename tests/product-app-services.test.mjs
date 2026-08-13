import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createProductAppServices } from '../src/app/create-product-app-services.js';
import {
  loadFullSpellingCatalogue,
  loadStarterSpellingCatalogue,
} from '../src/domain/spelling/index.js';
import { createDatabaseCommandGate } from '../src/platform/database/database-command-gate.js';
import { configureAndMigrateDatabase } from '../src/platform/database/migrate-database.js';
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
  const starterCatalogue = loadStarterSpellingCatalogue();
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
    'startGuardianMission',
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
    { id: 'core', label: 'Core', count: 20 },
    { id: 'y3-4', label: 'Y3–4', count: 20 },
  ]);
  await first.learning.startRound({
    length: 5,
    mode: 'smart',
    yearFilter: 'y3-4',
  });
  assert.equal(first.learning.getState().screen, 'practice');
  assert.equal(
    starterCatalogue.items.find(
      ({ runtimeItemId }) =>
        runtimeItemId === first.learning.getState().practice.runtimeItemId,
    ).yearBand,
    '3-4',
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
      publishedItemCount: 20,
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
  assert.equal(second.learning.getState().progress.length, 20);
  assert.ok(
    second.learning.getState().progress.every(
      ({ attempts, dueDay, lastResult }) =>
        attempts === 0 && dueDay === null && lastResult === null,
    ),
  );
  assert.deepEqual(second.learning.getState().vocabularySets, [
    { id: 'core', label: 'Core', count: 20 },
    { id: 'y3-4', label: 'Y3–4', count: 20 },
  ]);
  assert.equal(protectionCalls.length, 4);

  // Rebuild real learning progress so the migration below has something to
  // wipe: two misses and a hit on one starter word.
  await second.learning.startRound({
    length: 5,
    mode: 'smart',
    yearFilter: 'core',
  });
  await second.learning.submitAnswer('definitely wrong');
  await second.learning.submitAnswer('still wrong');
  const playedRuntimeItemId = second.learning.getState().practice.runtimeItemId;
  await second.learning.submitAnswer(
    starterCatalogue.items.find(
      ({ runtimeItemId }) => runtimeItemId === playedRuntimeItemId,
    ).target,
  );
  await second.learning.continueRound();
  assert.equal(second.learning.getState().practice.progress.checked, 1);
  await second.dispose();

  // A dev-era TestFlight build promoted every learner to the full catalogue
  // and granted 'full-ks2' unconditionally. Recreate that stored state, then
  // prove the next startup degrades it cleanly to a fresh Starter aggregate
  // (owner decision: reset — no production users exist).
  const legacyConnection = createNodeSqliteConnection(databasePath);
  await legacyConnection.open();
  await configureAndMigrateDatabase(legacyConnection);
  await legacyConnection.execute(
    'UPDATE spelling_aggregates SET catalogue_id = ?, granted_entitlement_ids_json = ? WHERE learner_id = ?',
    ['ks2-core:full', '["full-ks2"]', ben.learnerId],
  );
  const legacyCatalogues = Object.freeze({
    [starterCatalogue.catalogueId]: starterCatalogue,
    [fullCatalogue.catalogueId]: fullCatalogue,
  });
  const legacySnapshots = createSQLiteSpellingSnapshotStore({
    connection: legacyConnection,
    cataloguesById: legacyCatalogues,
  });
  const legacySnapshot = await legacySnapshots.read(ben.learnerId);
  assert.equal(legacySnapshot.catalogueId, 'ks2-core:full');
  assert.deepEqual(legacySnapshot.grantedEntitlementIds, ['full-ks2']);
  assert.ok(legacySnapshot.revision > 0);
  const legacyBackup = await createSQLiteLearningBackupRepository({
    connection: legacyConnection,
    gate: createDatabaseCommandGate(),
    cataloguesById: legacyCatalogues,
    now: () => 600,
  }).exportBackup();
  backupImport = Object.freeze({
    cancelled: false,
    bytesBase64: Buffer.from(legacyBackup, 'utf8').toString('base64'),
    sha256: createHash('sha256').update(legacyBackup).digest('hex'),
  });
  await legacyConnection.close();

  const third = await createProductAppServices({
    ...options,
    lifecycle: createLifecycle(),
  });
  const assertDegradedToStarter = (services) => {
    assert.equal(services.learning.getState().screen, 'home');
    assert.equal(services.learning.getState().learnerId, ben.learnerId);
    assert.equal(services.learning.getState().practice, null);
    assert.equal(services.learning.getState().progress.length, 20);
    assert.ok(
      services.learning.getState().progress.every(
        ({ attempts }) => attempts === 0,
      ),
    );
  };
  assertDegradedToStarter(third);
  // Importing a backup taken on the dev-era build degrades the same way.
  assert.deepEqual(await third.parentBackup.importBackup(), {
    cancelled: false,
    learnerCount: 1,
    selectedLearnerId: ben.learnerId,
  });
  assertDegradedToStarter(third);
  await third.dispose();

  const migratedConnection = createNodeSqliteConnection(databasePath);
  await migratedConnection.open();
  const migratedSnapshot = await createSQLiteSpellingSnapshotStore({
    connection: migratedConnection,
    cataloguesById: Object.freeze({
      [starterCatalogue.catalogueId]: starterCatalogue,
    }),
  }).read(ben.learnerId);
  assert.equal(migratedSnapshot.catalogueId, 'ks2-core:starter');
  assert.deepEqual(migratedSnapshot.grantedEntitlementIds, []);
  assert.equal(migratedSnapshot.revision, 0);
  await migratedConnection.close();
});
