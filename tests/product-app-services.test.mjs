import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { aggregatePackStates } from '../src/app/create-product-commerce-workflow.js';
import { createProductAppServices } from '../src/app/create-product-app-services.js';
import { createUnavailableProductCommerceWorkflow } from '../src/app/unavailable-product-commerce-workflow.js';
import { isFullProductEntitled, hasEarnedFullProduct } from '../src/app/entitled-audio-switch.js';
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
    // A native runtime composes the live commerce workflow, whose coordinators
    // validate the full pack-transfer port surface up front.
    packTransfer: Object.freeze({
      async inventoryInstalledVersions() { return Object.freeze([]); },
      async removeOwnedTemporaryState() { return Object.freeze({ removed: false }); },
      async getFreeBytes() { return 1_073_741_824; },
      async downloadRange() {
        throw new Error('Pack downloads are outside this composition test.');
      },
      async inspectAndExtract() {
        throw new Error('Pack extraction is outside this composition test.');
      },
      async sealAndInstall() {
        throw new Error('Pack installation is outside this composition test.');
      },
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
    // The Word Bank detail reads one word's material and can practise it.
    'wordMaterial',
    'practiseWord',
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
    actionErrorDetail: null,
    downloadProgress: null,
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

  // A full-catalogue aggregate on a device that has already run activation is
  // brought back down to Starter *with its progress intact* — the aggregate
  // only holds Starter words, so the re-tag is provably lossless and there is
  // nothing here worth destroying.
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
  assert.ok(legacySnapshot.eventLog.length > 0);
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
  const assertRealignedToStarterKeepingProgress = (services) => {
    assert.equal(services.catalogueId, 'ks2-core:starter');
    assert.equal(services.learning.getState().learnerId, ben.learnerId);
    assert.equal(services.learning.getState().progress.length, 20);
    assert.equal(services.learning.getState().screen, 'practice');
    assert.equal(
      services.learning.getState().practice.sessionId,
      legacySnapshot.practiceSession.id,
    );
  };
  assertRealignedToStarterKeepingProgress(third);
  // A backup taken while the aggregate was full-catalogue realigns the same
  // way on import, and the import reports success rather than post-commit
  // because the composed catalogue did not have to change.
  assert.deepEqual(await third.parentBackup.importBackup(), {
    cancelled: false,
    learnerCount: 1,
    selectedLearnerId: ben.learnerId,
  });
  assertRealignedToStarterKeepingProgress(third);
  await third.dispose();

  const migratedConnection = createNodeSqliteConnection(databasePath);
  await migratedConnection.open();
  const migratedSnapshot = await createSQLiteSpellingSnapshotStore({
    connection: migratedConnection,
    cataloguesById: Object.freeze({
      [starterCatalogue.catalogueId]: starterCatalogue,
    }),
  }).read(ben.learnerId);
  // The realignment moved the two catalogue columns and nothing else: every
  // event, Monster, Camp and subject-state byte survives it.
  assert.deepEqual(
    { ...migratedSnapshot, catalogueId: null, grantedEntitlementIds: null },
    { ...legacySnapshot, catalogueId: null, grantedEntitlementIds: null },
  );
  assert.equal(migratedSnapshot.catalogueId, 'ks2-core:starter');
  assert.deepEqual(migratedSnapshot.grantedEntitlementIds, []);
  await migratedConnection.close();
});

// --- E2.7 composition: live commerce and the entitled audio switch ----------

function compositionOptions({ databasePath, ...overrides }) {
  return {
    runtime: Object.freeze({ isNativePlatform: true, platform: 'ios' }),
    connectionFactory: async () => createNodeSqliteConnection(databasePath),
    lifecycle: createLifecycle(),
    bundledStarterAudio: Object.freeze({
      async checkAvailability() { return Object.freeze({ version: '1.0.0' }); },
      async readInstalledAudio() { throw new Error('starter-source'); },
    }),
    parentBiometrics: Object.freeze({
      async getAvailability() { return Object.freeze({ available: false, type: 'none' }); },
      async authenticate() { throw new Error('Biometrics unavailable in this test.'); },
    }),
    learningBackupFiles: Object.freeze({
      async presentExport() { return Object.freeze({ presented: true }); },
      async pickImport() { return Object.freeze({ cancelled: true }); },
    }),
    localDataProtection: Object.freeze({
      async applyPolicy() {
        return Object.freeze({
          automaticBackupDisabled: true,
          platformProtection: 'ios-complete',
        });
      },
    }),
    now: () => 1_000,
    random: () => 0.25,
    createLearnerId: () => 'learner-composition',
    ...overrides,
  };
}

function workflowFor(snapshot) {
  const frozen = Object.freeze({
    displayPrice: '£4.99',
    syncFailed: false,
    ...snapshot,
  });
  return Object.freeze({
    async start() { return frozen; },
    async refresh() { return frozen; },
    async purchase() { return frozen; },
    async restore() { return frozen; },
    async download() { return frozen; },
    async recover() { return frozen; },
    async dispose() {},
  });
}

function countingPackTransfer() {
  const calls = { inventory: 0 };
  return {
    calls,
    port: Object.freeze({
      async inventoryInstalledVersions() {
        calls.inventory += 1;
        return Object.freeze([]);
      },
      async removeOwnedTemporaryState() { return Object.freeze({ removed: false }); },
      async getFreeBytes() { return 1_073_741_824; },
      async downloadRange() { throw new Error('outside this composition test'); },
      async inspectAndExtract() { throw new Error('outside this composition test'); },
      async sealAndInstall() { throw new Error('outside this composition test'); },
    }),
  };
}

test('a native runtime composes the live commerce workflow, a web runtime the unavailable one', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-composition-live-'));
  t.after(() => rm(directory, { force: true, recursive: true }));

  const live = countingPackTransfer();
  const nativeServices = await createProductAppServices(compositionOptions({
    databasePath: join(directory, 'native.sqlite'),
    packTransfer: live.port,
  }));
  t.after(() => nativeServices.dispose());
  await nativeServices.parentCommerce.refresh();
  // Only the live workflow reconciles native pack inventory; the unavailable
  // workflow returns a constant snapshot and never reaches the device. The
  // published snapshot is identical for both, so this is the evidence that
  // separates them.
  assert.ok(live.calls.inventory > 0);

  const web = countingPackTransfer();
  const webServices = await createProductAppServices(compositionOptions({
    databasePath: join(directory, 'web.sqlite'),
    runtime: Object.freeze({ isNativePlatform: false, platform: 'web' }),
    packTransfer: web.port,
  }));
  t.after(() => webServices.dispose());
  await webServices.parentCommerce.refresh();
  assert.equal(web.calls.inventory, 0);
  await assert.rejects(webServices.parentCommerce.purchase(), {
    code: 'product_commerce_release_authority_unavailable',
  });
});

test('playback follows the entitlement: installed shards serve the full catalogue, anything else stays on Starter', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-composition-audio-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const fullCatalogue = await loadFullSpellingCatalogue();
  const starterCatalogue = loadStarterSpellingCatalogue();
  const shardSource = Object.freeze({
    async readInstalledAudio() { throw new Error('shard-source'); },
  });
  const play = (services, catalogue) => services.audio.play({
    version: '1.0.0',
    runtimeItemId: catalogue.items[0].runtimeItemId,
    sentence: catalogue.items[0].sentencePrompts[0].text,
    voiceId: 'Sulafat',
    kind: 'sentence',
  });

  const entitled = await createProductAppServices(compositionOptions({
    databasePath: join(directory, 'entitled.sqlite'),
    installedAudio: shardSource,
    commerceWorkflow: workflowFor({
      entitlementState: 'active',
      packState: 'installed',
    }),
  }));
  t.after(() => entitled.dispose());
  await entitled.parentCommerce.refresh();
  await assert.rejects(play(entitled, fullCatalogue), /shard-source/);

  for (const snapshot of [
    { entitlementState: 'none', packState: 'missing' },
    { entitlementState: 'active', packState: 'downloading' },
    { entitlementState: 'revoked', packState: 'locked' },
  ]) {
    const services = await createProductAppServices(compositionOptions({
      databasePath: join(directory, `${snapshot.entitlementState}-${snapshot.packState}.sqlite`),
      installedAudio: shardSource,
      commerceWorkflow: workflowFor(snapshot),
    }));
    t.after(() => services.dispose());
    await services.parentCommerce.refresh();
    // A half-installed or revoked device must never serve the Full catalogue.
    await assert.rejects(play(services, starterCatalogue), /starter-source/);
  }
});

// --- E2.7b: entitlement-driven catalogue activation -------------------------

const YACHT = 'ks2-core:yacht'; // audio lives in full-ks2-shard-15

function activationOptions(directory, name, snapshot) {
  let clock = 1_000;
  return compositionOptions({
    databasePath: join(directory, `${name}.sqlite`),
    // A moving clock: identical timestamps collide the engine's deterministic
    // event IDs once a test writes more than one event.
    now: () => (clock += 1),
    commerceWorkflow: workflowFor(snapshot),
  });
}

async function readStoredSnapshot(databasePath, learnerId) {
  const connection = createNodeSqliteConnection(databasePath);
  await connection.open();
  try {
    return await createSQLiteSpellingSnapshotStore({
      connection,
      cataloguesById: Object.freeze({
        [loadStarterSpellingCatalogue().catalogueId]: loadStarterSpellingCatalogue(),
        [(await loadFullSpellingCatalogue()).catalogueId]:
          await loadFullSpellingCatalogue(),
      }),
    }).read(learnerId);
  } finally {
    await connection.close();
  }
}

function withoutCatalogueTag(snapshot) {
  return { ...snapshot, catalogueId: null, grantedEntitlementIds: null };
}

async function seedLearner(services) {
  await services.controller.createProfile({
    nickname: 'Ada',
    yearGroup: 'Y5',
    goal: 10,
    colour: '#2E7D8A',
  });
  await services.learning.startRound({
    length: 5,
    mode: 'smart',
    yearFilter: 'core',
  });
  await services.learning.submitAnswer('definitely wrong');
  return 'learner-composition';
}

test('the full catalogue publishes exactly the grant the re-tag writes', async () => {
  // The alignment writes '["full-ks2"]' into the aggregate; the Guardian and
  // Camp projections only unlock when the snapshot's grant covers every
  // entitlement the catalogue names. A vendored catalogue that added a second
  // entitlement would silently leave both features locked on a paid device.
  assert.deepEqual((await loadFullSpellingCatalogue()).entitlementIds, ['full-ks2']);
  assert.deepEqual(loadStarterSpellingCatalogue().entitlementIds, []);
});

test('an entitled device with every shard installed practises the full KS2 catalogue, carrying its Starter learning across unchanged', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-activation-up-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const databasePath = join(directory, 'upgrade.sqlite');
  const options = (snapshot) => ({
    ...activationOptions(directory, 'upgrade', snapshot),
    databasePath,
    connectionFactory: async () => createNodeSqliteConnection(databasePath),
  });

  const unentitled = await createProductAppServices(
    options({ entitlementState: 'none', packState: 'missing' }),
  );
  assert.equal(unentitled.catalogueId, 'ks2-core:starter');
  assert.equal(unentitled.learning.getState().packSize, 20);
  const learnerId = await seedLearner(unentitled);
  assert.ok(
    !unentitled.learning.getState().progress.some(
      ({ runtimeItemId }) => runtimeItemId === YACHT,
    ),
    'a Starter device must not publish a shard-15 word',
  );
  const unentitledMission = unentitled.learning.getState().revisionMission;
  await unentitled.dispose();
  const beforeUpgrade = await readStoredSnapshot(databasePath, learnerId);
  assert.equal(beforeUpgrade.catalogueId, 'ks2-core:starter');

  const entitled = await createProductAppServices(
    options({ entitlementState: 'active', packState: 'installed' }),
  );
  t.after(() => entitled.dispose());
  // The purchase delivers the words, not just the audio.
  assert.equal(entitled.catalogueId, 'ks2-core:full');
  assert.equal(entitled.learning.getState().packSize, 213);
  assert.ok(
    entitled.learning.getState().progress.some(
      ({ runtimeItemId }) => runtimeItemId === YACHT,
    ),
    'an entitled device must be able to reach a shard-15 word',
  );
  // The Guardian Mission and Camp projections read the grant off the snapshot,
  // not off the catalogue, so the re-tag has to move both columns. Camp credit
  // reads 'unavailable' for exactly as long as the grant is missing, whatever
  // the learner's progress.
  assert.equal(
    unentitledMission.campCreditState,
    'unavailable',
  );
  assert.notEqual(
    entitled.learning.getState().revisionMission.campCreditState,
    'unavailable',
  );
  // Continuity: the round the learner was mid-way through is still live.
  assert.equal(entitled.learning.getState().learnerId, learnerId);
  assert.equal(entitled.learning.getState().screen, 'practice');
  const afterUpgrade = await readStoredSnapshot(databasePath, learnerId);
  assert.deepEqual(
    withoutCatalogueTag(afterUpgrade),
    withoutCatalogueTag(beforeUpgrade),
  );
  assert.equal(afterUpgrade.catalogueId, 'ks2-core:full');
  assert.deepEqual(afterUpgrade.grantedEntitlementIds, ['full-ks2']);
});

test('a partial install, a revocation and a device that never bought all keep the Starter catalogue', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-activation-gate-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  for (const snapshot of [
    { entitlementState: 'none', packState: 'missing' },
    { entitlementState: 'active', packState: 'queued' },
    { entitlementState: 'active', packState: 'downloading' },
    // One shard short of the set: aggregatePackStates never reports
    // 'installed' until every shard is in, which is what makes the catalogue
    // switch and the audio switch share one all-or-nothing rule.
    { entitlementState: 'active', packState: 'failed' },
    { entitlementState: 'revoked', packState: 'locked' },
  ]) {
    const services = await createProductAppServices(activationOptions(
      directory,
      `${snapshot.entitlementState}-${snapshot.packState}`,
      snapshot,
    ));
    t.after(() => services.dispose());
    assert.equal(
      services.catalogueId,
      'ks2-core:starter',
      `${snapshot.entitlementState}/${snapshot.packState} must stay on Starter`,
    );
    assert.equal(services.learning.getState().packSize, 20);
  }
});

test('one shard short never aggregates to installed, so a partial install can never open the full catalogue', () => {
  const installed = Array.from({ length: 15 }, () => 'installed');
  assert.equal(aggregatePackStates('active', installed), 'installed');
  assert.equal(isFullProductEntitled({
    entitlementState: 'active',
    packState: aggregatePackStates('active', installed),
  }), true);
  assert.equal(hasEarnedFullProduct({
    entitlementState: 'active',
    packState: 'installed',
  }), true);
  assert.equal(hasEarnedFullProduct({
    entitlementState: 'revoked',
    packState: 'locked',
  }), true);
  assert.equal(hasEarnedFullProduct({
    entitlementState: 'none',
    packState: 'missing',
  }), false);
  for (const short of ['missing', 'queued', 'downloading', 'failed']) {
    const oneShort = [...installed.slice(0, 14), short];
    assert.notEqual(aggregatePackStates('active', oneShort), 'installed');
    assert.equal(isFullProductEntitled({
      entitlementState: 'active',
      packState: aggregatePackStates('active', oneShort),
    }), false);
  }
});

test('revocation parks full-catalogue learning behind Starter, and restoring the purchase returns the learner to it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-activation-down-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const databasePath = join(directory, 'revocation.sqlite');
  const options = (snapshot) => ({
    ...activationOptions(directory, 'revocation', snapshot),
    databasePath,
    connectionFactory: async () => createNodeSqliteConnection(databasePath),
  });
  const starterItemIds = new Set(
    loadStarterSpellingCatalogue().items.map(({ runtimeItemId }) => runtimeItemId),
  );

  const entitled = await createProductAppServices(
    options({ entitlementState: 'active', packState: 'installed' }),
  );
  assert.equal(entitled.catalogueId, 'ks2-core:full');
  const learnerId = await seedLearner(entitled);
  // Practise a word that exists only in the full catalogue: that is what makes
  // the aggregate impossible to show under Starter without parking it.
  let reachedFullOnlyWord = false;
  for (let step = 0; step < 20 && !reachedFullOnlyWord; step += 1) {
    if (!starterItemIds.has(entitled.learning.getState().practice.runtimeItemId)) {
      reachedFullOnlyWord = true;
      break;
    }
    await entitled.learning.skipWord();
    if (entitled.learning.getState().practice === null) break;
  }
  assert.ok(reachedFullOnlyWord, 'the round must reach a full-catalogue-only word');
  await entitled.learning.submitAnswer('definitely wrong');
  await entitled.dispose();
  const earned = await readStoredSnapshot(databasePath, learnerId);
  assert.equal(earned.catalogueId, 'ks2-core:full');

  const revoked = await createProductAppServices(
    options({ entitlementState: 'revoked', packState: 'locked' }),
  );
  // Acceptance criterion 1: revoked composes Starter. The paid history is
  // parked, not destroyed, so a later restore can put it back.
  assert.equal(revoked.catalogueId, 'ks2-core:starter');
  assert.equal(revoked.learning.getState().packSize, 20);
  const parkedWorkingCopy = await readStoredSnapshot(databasePath, learnerId);
  assert.equal(parkedWorkingCopy.catalogueId, 'ks2-core:starter');
  await revoked.dispose();

  const restored = await createProductAppServices(
    options({ entitlementState: 'active', packState: 'installed' }),
  );
  t.after(() => restored.dispose());
  assert.equal(restored.catalogueId, 'ks2-core:full');
  assert.equal(restored.learning.getState().packSize, 213);
  assert.deepEqual(await readStoredSnapshot(databasePath, learnerId), earned);
});

test('a genuine pre-E2.5 full-catalogue aggregate on a device that never bought is repaired to Starter', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-activation-devera-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const databasePath = join(directory, 'stale.sqlite');
  const options = (snapshot) => ({
    ...activationOptions(directory, 'stale', snapshot),
    databasePath,
    connectionFactory: async () => createNodeSqliteConnection(databasePath),
  });
  const starterItemIds = new Set(
    loadStarterSpellingCatalogue().items.map(({ runtimeItemId }) => runtimeItemId),
  );

  const entitled = await createProductAppServices(
    options({ entitlementState: 'active', packState: 'installed' }),
  );
  assert.equal(entitled.catalogueId, 'ks2-core:full');
  const learnerId = await seedLearner(entitled);
  for (let step = 0; step < 20; step += 1) {
    if (!starterItemIds.has(entitled.learning.getState().practice.runtimeItemId)) {
      break;
    }
    await entitled.learning.skipWord();
  }
  assert.ok(
    !starterItemIds.has(entitled.learning.getState().practice.runtimeItemId),
    'the unpaid residue must hold a word Starter cannot represent',
  );
  await entitled.dispose();
  const beforeRepair = await readStoredSnapshot(databasePath, learnerId);
  assert.ok(beforeRepair.revision > 0);

  const repaired = await createProductAppServices(
    options({ entitlementState: 'none', packState: 'missing' }),
  );
  t.after(() => repaired.dispose());
  assert.equal(repaired.catalogueId, 'ks2-core:starter');
  assert.equal(repaired.learning.getState().packSize, 20);
  const afterRepair = await readStoredSnapshot(databasePath, learnerId);
  assert.equal(afterRepair.catalogueId, 'ks2-core:starter');
  assert.equal(afterRepair.revision, 0);
  assert.deepEqual(afterRepair.eventLog, []);
  assert.deepEqual(afterRepair.grantedEntitlementIds, []);
});

test('importing full-catalogue learning onto a device that never bought does not unlock the paid catalogue', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-activation-import-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const starterItemIds = new Set(
    loadStarterSpellingCatalogue().items.map(({ runtimeItemId }) => runtimeItemId),
  );

  // Source device: entitled, with learning on a word only the full catalogue
  // publishes.
  const sourcePath = join(directory, 'source.sqlite');
  const source = await createProductAppServices({
    ...activationOptions(directory, 'source', {
      entitlementState: 'active',
      packState: 'installed',
    }),
    databasePath: sourcePath,
    connectionFactory: async () => createNodeSqliteConnection(sourcePath),
  });
  assert.equal(source.catalogueId, 'ks2-core:full');
  const learnerId = await seedLearner(source);
  for (let step = 0; step < 20; step += 1) {
    if (!starterItemIds.has(source.learning.getState().practice.runtimeItemId)) break;
    await source.learning.skipWord();
  }
  assert.ok(
    !starterItemIds.has(source.learning.getState().practice.runtimeItemId),
    'the source device must hold learning outside the Starter catalogue',
  );
  await source.dispose();

  const sourceConnection = createNodeSqliteConnection(sourcePath);
  await sourceConnection.open();
  const backup = await createSQLiteLearningBackupRepository({
    connection: sourceConnection,
    gate: createDatabaseCommandGate(),
    cataloguesById: Object.freeze({
      [loadStarterSpellingCatalogue().catalogueId]: loadStarterSpellingCatalogue(),
      [(await loadFullSpellingCatalogue()).catalogueId]:
        await loadFullSpellingCatalogue(),
    }),
    now: () => 9_000,
  }).exportBackup();
  await sourceConnection.close();

  const targetPath = join(directory, 'target.sqlite');
  const targetOptions = (snapshot) => ({
    ...activationOptions(directory, 'target', snapshot),
    databasePath: targetPath,
    connectionFactory: async () => createNodeSqliteConnection(targetPath),
    learningBackupFiles: Object.freeze({
      async presentExport() { return Object.freeze({ presented: true }); },
      async pickImport() {
        return Object.freeze({
          cancelled: false,
          bytesBase64: Buffer.from(backup, 'utf8').toString('base64'),
          sha256: createHash('sha256').update(backup).digest('hex'),
        });
      },
    }),
  });
  const target = await createProductAppServices(targetOptions({
    entitlementState: 'none',
    packState: 'missing',
  }));
  t.after(() => target.dispose());
  assert.equal(target.catalogueId, 'ks2-core:starter');

  // Gap 5: the unsigned file cannot raise the catalogue. The import commits,
  // the child stays on Starter, and Guardian/Camp stay locked.
  assert.deepEqual(await target.parentBackup.importBackup(), {
    cancelled: false,
    learnerCount: 1,
    selectedLearnerId: learnerId,
  });
  assert.equal(target.catalogueId, 'ks2-core:starter');
  assert.equal(target.learning.getState().packSize, 20);
  const imported = await readStoredSnapshot(targetPath, learnerId);
  assert.equal(imported.catalogueId, 'ks2-core:starter');
  assert.deepEqual(imported.grantedEntitlementIds, []);

  const reopened = await createProductAppServices(targetOptions({
    entitlementState: 'none',
    packState: 'missing',
  }));
  t.after(() => reopened.dispose());
  assert.equal(reopened.catalogueId, 'ks2-core:starter');
  assert.equal(reopened.learning.getState().packSize, 20);

  const purchased = await createProductAppServices(targetOptions({
    entitlementState: 'active',
    packState: 'installed',
  }));
  t.after(() => purchased.dispose());
  assert.equal(purchased.catalogueId, 'ks2-core:full');
  assert.equal(purchased.learning.getState().packSize, 213);
  assert.ok(
    purchased.learning.getState().progress.some(
      ({ runtimeItemId }) => runtimeItemId === YACHT,
    ),
  );
});

test('importing full-catalogue learning onto a device that never bought parks the history, and a later purchase restores it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-activation-import-park-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const starterItemIds = new Set(
    loadStarterSpellingCatalogue().items.map(({ runtimeItemId }) => runtimeItemId),
  );

  const sourcePath = join(directory, 'source.sqlite');
  const source = await createProductAppServices({
    ...activationOptions(directory, 'source', {
      entitlementState: 'active',
      packState: 'installed',
    }),
    databasePath: sourcePath,
    connectionFactory: async () => createNodeSqliteConnection(sourcePath),
  });
  assert.equal(source.catalogueId, 'ks2-core:full');
  const learnerId = await seedLearner(source);
  let reachedFullOnlyWord = false;
  for (let step = 0; step < 20 && !reachedFullOnlyWord; step += 1) {
    if (!starterItemIds.has(source.learning.getState().practice.runtimeItemId)) {
      reachedFullOnlyWord = true;
      break;
    }
    await source.learning.skipWord();
    if (source.learning.getState().practice === null) break;
  }
  assert.ok(reachedFullOnlyWord, 'the round must reach a full-catalogue-only word');
  const practisedItemId = source.learning.getState().practice.runtimeItemId;
  await source.learning.submitAnswer('definitely wrong');
  await source.dispose();
  const earned = await readStoredSnapshot(sourcePath, learnerId);
  assert.equal(earned.catalogueId, 'ks2-core:full');
  assert.ok(earned.revision > 0);
  assert.equal(
    earned.practiceSession?.state?.session?.currentRuntimeItemId,
    practisedItemId,
  );
  assert.equal(
    earned.practiceSession.state.session.statusByRuntimeItemId[practisedItemId]
      .hadWrong,
    true,
  );

  const sourceConnection = createNodeSqliteConnection(sourcePath);
  await sourceConnection.open();
  const backup = await createSQLiteLearningBackupRepository({
    connection: sourceConnection,
    gate: createDatabaseCommandGate(),
    cataloguesById: Object.freeze({
      [loadStarterSpellingCatalogue().catalogueId]: loadStarterSpellingCatalogue(),
      [(await loadFullSpellingCatalogue()).catalogueId]:
        await loadFullSpellingCatalogue(),
    }),
    now: () => 9_000,
  }).exportBackup();
  await sourceConnection.close();

  const targetPath = join(directory, 'target.sqlite');
  const targetOptions = (snapshot) => ({
    ...activationOptions(directory, 'target', snapshot),
    databasePath: targetPath,
    connectionFactory: async () => createNodeSqliteConnection(targetPath),
    learningBackupFiles: Object.freeze({
      async presentExport() { return Object.freeze({ presented: true }); },
      async pickImport() {
        return Object.freeze({
          cancelled: false,
          bytesBase64: Buffer.from(backup, 'utf8').toString('base64'),
          sha256: createHash('sha256').update(backup).digest('hex'),
        });
      },
    }),
  });
  const target = await createProductAppServices(targetOptions({
    entitlementState: 'none',
    packState: 'missing',
  }));
  t.after(() => target.dispose());
  assert.deepEqual(await target.parentBackup.importBackup(), {
    cancelled: false,
    learnerCount: 1,
    selectedLearnerId: learnerId,
  });
  // Gap 5 still holds: the unsigned file cannot raise the catalogue.
  assert.equal(target.catalogueId, 'ks2-core:starter');
  assert.equal(target.learning.getState().packSize, 20);
  assert.ok(
    !target.learning.getState().progress.some(
      ({ runtimeItemId }) => runtimeItemId === practisedItemId,
    ),
    'a never-entitled device must not publish the imported Full-only word',
  );
  const parkedWorkingCopy = await readStoredSnapshot(targetPath, learnerId);
  assert.equal(parkedWorkingCopy.catalogueId, 'ks2-core:starter');
  assert.equal(parkedWorkingCopy.revision, 0);

  const purchased = await createProductAppServices(targetOptions({
    entitlementState: 'active',
    packState: 'installed',
  }));
  t.after(() => purchased.dispose());
  assert.equal(purchased.catalogueId, 'ks2-core:full');
  assert.equal(purchased.learning.getState().packSize, 213);
  // Wiping instead of parking (preserveUnentitledFull: false) retags an empty
  // Starter row on purchase. Yacht would still appear in progress; the parked
  // snapshot is the history.
  assert.deepEqual(await readStoredSnapshot(targetPath, learnerId), earned);
  assert.equal(
    purchased.learning.getState().practice.runtimeItemId,
    practisedItemId,
  );
  assert.equal(purchased.learning.getState().screen, 'practice');
});

test('reverting the catalogue switch to an unconditional Starter reset fails this guard', async () => {
  const { readFile } = await import('node:fs/promises');
  const composition = await readFile(
    new URL('../src/app/create-product-app-services.js', import.meta.url),
    'utf8',
  );
  const audio = await readFile(
    new URL('../src/app/entitled-audio-switch.js', import.meta.url),
    'utf8',
  );
  // One entitlement authority, not a second signal, and both columns closed
  // together: earned devices park, never-entitled imports cannot raise the
  // catalogue. preserveUnentitledFull is also guarded behaviourally by the
  // park-and-restore import test above. Deleting any of these leaves the suite
  // green only if those composition tests are also deleted.
  assert.match(audio, /export function isFullProductEntitled/);
  assert.match(audio, /export function hasEarnedFullProduct/);
  assert.match(composition, /isFullProductEntitled\(commerceState\)/);
  assert.match(composition, /hasEarnedFullProduct\(commerceState\)/);
  assert.match(composition, /preserveUnentitledFull: true/);
  assert.doesNotMatch(composition, /resetFullCatalogueLearning/);
});

test('a store bridge whose start never settles cannot stop the app opening: composition falls through to Starter', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-commerce-hang-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  let startCalls = 0;
  let released = () => {};
  // Never settles while composition runs — the pathological Capacitor bridge.
  // Released in t.after so the pending promise cannot outlive the test.
  const hangingWorkflow = Object.freeze({
    ...createUnavailableProductCommerceWorkflow(),
    async start() {
      startCalls += 1;
      await new Promise((resolve) => { released = resolve; });
    },
  });
  t.after(() => released());

  const services = await createProductAppServices(compositionOptions({
    databasePath: join(directory, 'hang.sqlite'),
    commerceWorkflow: hangingWorkflow,
    commerceStartTimeoutMs: 25,
  }));
  t.after(() => services.dispose());

  // Composition completed at all: without the bound this await never returns.
  assert.equal(startCalls, 1);
  // And it completed on the safe side of the switch, not merely completed.
  assert.equal(services.catalogueId, 'ks2-core:starter');
  assert.equal(services.parentCommerce.getState().entitlementState, 'none');
});
