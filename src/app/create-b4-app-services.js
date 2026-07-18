import { loadStarterSpellingCatalogue } from '../domain/spelling/index.js';
import { seedB2Learners } from '../platform/database/b2-seed.js';
import { createCapacitorSqliteConnection } from '../platform/database/capacitor-sqlite-connection.js';
import { createDatabaseCommandGate } from '../platform/database/database-command-gate.js';
import { configureAndMigrateDatabase } from '../platform/database/migrate-database.js';
import { DATABASE_NAME } from '../platform/database/schema-v1.js';
import { SCHEMA_VERSION } from '../platform/database/schema-v2.js';
import { createSQLiteSpellingCommandRepository } from '../platform/database/sqlite-spelling-command-repository.js';
import { createSQLiteSpellingSnapshotStore } from '../platform/database/sqlite-spelling-snapshot-store.js';
import { createCapacitorAppLifecycle } from '../platform/lifecycle/capacitor-app-lifecycle.js';
import { B4_PRODUCT_IDENTIFIER, B4_START_TIMESTAMP } from './b4-round-contract.js';
import { createB4LocalAudioPlayer } from './b4-local-audio.js';
import { createB4RoundController } from './b4-round-controller.js';
import { createDatabaseLifecycleCoordinator } from './database-lifecycle-coordinator.js';
import { createSwitchableSqlConnection } from './switchable-sql-connection.js';

function successfulRepository(repository, onSuccess) {
  return Object.freeze({
    async runCommandTransaction(learnerId, planner) {
      const result = await repository.runCommandTransaction(learnerId, planner);
      onSuccess();
      return result;
    },
  });
}

async function disposeAll(parts) {
  const failures = [];
  for (const part of parts) {
    if (!part) continue;
    try {
      await part();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'B4 service disposal failed.');
}

export async function createB4AppServices(options = {}) {
  const connectionFactory = options.connectionFactory ?? (() => createCapacitorSqliteConnection());
  const migrate = options.migrate ?? configureAndMigrateDatabase;
  const seed = options.seed ?? seedB2Learners;
  const connection = createSwitchableSqlConnection(connectionFactory);
  const catalogue = loadStarterSpellingCatalogue();
  const cataloguesById = Object.freeze({ [catalogue.catalogueId]: catalogue });
  let lifecycle = null;
  let coordinator = null;
  let controller = null;
  let playAudio = null;
  try {
    await connection.open();
    await migrate(connection);
    await seed(connection);
    const snapshotStore = createSQLiteSpellingSnapshotStore({ connection, cataloguesById });
    const learner = await snapshotStore.read('learner-a');
    const gate = createDatabaseCommandGate();
    let timestampIndex = learner.revision;
    const baseRepository = createSQLiteSpellingCommandRepository({
      connection,
      gate,
      store: snapshotStore,
      cataloguesById,
      now: () => B4_START_TIMESTAMP + timestampIndex,
    });
    const repository = successfulRepository(baseRepository, () => { timestampIndex += 1; });
    lifecycle = options.lifecycle ?? (options.lifecycleFactory ?? createCapacitorAppLifecycle)();
    const audioManifest = options.audioManifest ?? (
      await import('../../config/b4-audio-manifest.json', { with: { type: 'json' } })
    ).default;
    playAudio = options.playAudio ?? createB4LocalAudioPlayer({
      createAudioElement: options.createAudioElement,
    });
    coordinator = createDatabaseLifecycleCoordinator({
      lifecycle,
      commandGate: gate,
      createConnection: async () => connection,
      migrate,
      rehydrateSelectedLearner: async (_connection, learnerId) => snapshotStore.read(learnerId),
      selectedLearnerId: 'learner-a',
    });
    await connection.close();
    await coordinator.start();
    controller = createB4RoundController({
      catalogue,
      repository,
      snapshotStore,
      audioManifest,
      playAudio,
      lifecycle,
    });
    let disposePromise;
    return Object.freeze({
      mode: B4_PRODUCT_IDENTIFIER,
      serviceMode: 'b4',
      productIdentifier: B4_PRODUCT_IDENTIFIER,
      databaseName: DATABASE_NAME,
      schemaVersion: SCHEMA_VERSION,
      controller,
      snapshotStore,
      dispose() {
        disposePromise ??= disposeAll([
          () => controller.dispose(),
          () => coordinator.dispose(),
          () => lifecycle.dispose(),
          () => connection.close(),
        ]);
        return disposePromise;
      },
    });
  } catch (error) {
    try {
      await disposeAll([
        controller && (() => controller.dispose()),
        !controller && playAudio?.dispose && (() => playAudio.dispose()),
        coordinator && (() => coordinator.dispose()),
        lifecycle && (() => lifecycle.dispose()),
        () => connection.close(),
      ]);
    } catch (cleanupError) {
      error.cause = cleanupError;
    }
    throw error;
  }
}
