import { loadStarterSpellingCatalogue } from '../domain/spelling/index.js';
import { createCapacitorSqliteConnection } from '../platform/database/capacitor-sqlite-connection.js';
import { createDatabaseCommandGate } from '../platform/database/database-command-gate.js';
import { configureAndMigrateDatabase } from '../platform/database/migrate-database.js';
import { DATABASE_NAME } from '../platform/database/schema-v1.js';
import { SCHEMA_VERSION } from '../platform/database/schema-v2.js';
import {
  createSQLiteSpellingProfileStore,
  readSQLiteSelectedLearnerId,
} from '../platform/database/sqlite-spelling-profile-store.js';
import { createSQLiteSpellingSnapshotStore } from '../platform/database/sqlite-spelling-snapshot-store.js';
import { createCapacitorAppLifecycle } from '../platform/lifecycle/capacitor-app-lifecycle.js';
import { createDatabaseLifecycleCoordinator } from './database-lifecycle-coordinator.js';
import { createProductProfileController } from './product-profile-controller.js';
import { createSwitchableSqlConnection } from './switchable-sql-connection.js';

function defaultLearnerId() {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('product_profile_id_source_unavailable');
  }
  return `learner-${globalThis.crypto.randomUUID().toLowerCase()}`;
}

async function disposeAll(parts) {
  const failures = [];
  for (const dispose of parts) {
    if (!dispose) continue;
    try {
      await dispose();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Product service disposal failed.');
  }
}

export async function createProductAppServices(options = {}) {
  const connectionFactory =
    options.connectionFactory ?? (() => createCapacitorSqliteConnection());
  const migrate = options.migrate ?? configureAndMigrateDatabase;
  const now = options.now ?? Date.now;
  const createLearnerId = options.createLearnerId ?? defaultLearnerId;
  const connection = createSwitchableSqlConnection(connectionFactory);
  const gate = createDatabaseCommandGate();
  const catalogue = loadStarterSpellingCatalogue();
  const cataloguesById = Object.freeze({ [catalogue.catalogueId]: catalogue });
  let lifecycle = null;
  let coordinator = null;
  let controller = null;

  try {
    await connection.open();
    await migrate(connection);
    const profileStore = createSQLiteSpellingProfileStore({
      connection,
      gate,
      now,
    });
    const snapshotStore = createSQLiteSpellingSnapshotStore({
      connection,
      cataloguesById,
    });
    lifecycle =
      options.lifecycle ?? (options.lifecycleFactory ?? createCapacitorAppLifecycle)();
    coordinator = createDatabaseLifecycleCoordinator({
      lifecycle,
      commandGate: gate,
      createConnection: async () => connection,
      migrate,
      resolveSelectedLearnerId: readSQLiteSelectedLearnerId,
      rehydrateSelectedLearner: async (_connection, learnerId) => {
        await snapshotStore.read(learnerId);
      },
    });

    await connection.close();
    await coordinator.start();
    const [initialProfiles, initialSelectedLearnerId] = await Promise.all([
      profileStore.profiles.listProfiles(),
      profileStore.selection.readSelectedLearnerId(),
    ]);
    controller = createProductProfileController({
      profiles: profileStore.profiles,
      selection: profileStore.selection,
      initialProfiles,
      initialSelectedLearnerId,
      createLearnerId,
    });
    let disposePromise;
    return Object.freeze({
      mode: 'product',
      databaseName: DATABASE_NAME,
      schemaVersion: SCHEMA_VERSION,
      controller,
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
