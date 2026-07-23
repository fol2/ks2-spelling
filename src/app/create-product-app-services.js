import { loadStarterSpellingCatalogue } from '../domain/spelling/index.js';
import { createCapacitorSqliteConnection } from '../platform/database/capacitor-sqlite-connection.js';
import { createDatabaseCommandGate } from '../platform/database/database-command-gate.js';
import { configureAndMigrateDatabase } from '../platform/database/migrate-database.js';
import { DATABASE_NAME } from '../platform/database/schema-v1.js';
import { SCHEMA_VERSION } from '../platform/database/schema-v2.js';
import { createSqlitePackRepositories } from '../platform/database/sqlite-pack-repositories.js';
import {
  createSQLiteSpellingProfileStore,
  readSQLiteSelectedLearnerId,
} from '../platform/database/sqlite-spelling-profile-store.js';
import { createSQLiteSpellingCommandRepository } from '../platform/database/sqlite-spelling-command-repository.js';
import { createSQLiteSpellingSnapshotStore } from '../platform/database/sqlite-spelling-snapshot-store.js';
import { createCapacitorAppLifecycle } from '../platform/lifecycle/capacitor-app-lifecycle.js';
import { createCapacitorPackTransfer } from '../platform/pack-transfer/capacitor-pack-transfer.js';
import {
  PackTransferPlugin,
} from '../platform/pack-transfer/capacitor-pack-transfer-plugin.js';
import { createDatabaseLifecycleCoordinator } from './database-lifecycle-coordinator.js';
import { createProductLearningController } from './product-learning-controller.js';
import { createProductProfileController } from './product-profile-controller.js';
import {
  createStarterPackAvailabilityController,
} from './starter-pack-availability-controller.js';
import { createSwitchableSqlConnection } from './switchable-sql-connection.js';

function defaultLearnerId() {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('product_profile_id_source_unavailable');
  }
  return `learner-${globalThis.crypto.randomUUID().toLowerCase()}`;
}

function defaultProductRandom() {
  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new Error('product_random_source_unavailable');
  }
  const value = new Uint32Array(1);
  globalThis.crypto.getRandomValues(value);
  return value[0] / 4_294_967_296;
}

function linkProfileAndLearningControllers(profileController, learningController) {
  async function alignSelectedLearner() {
    await learningController.selectLearner(
      profileController.getState().selectedLearnerId,
    );
  }

  return Object.freeze({
    getState: () => profileController.getState(),
    subscribe: (listener) => profileController.subscribe(listener),
    async createProfile(draft) {
      const profile = await profileController.createProfile(draft);
      await alignSelectedLearner();
      return profile;
    },
    editProfile: (draft) => profileController.editProfile(draft),
    async selectProfile(learnerId) {
      const selected = await profileController.selectProfile(learnerId);
      await alignSelectedLearner();
      return selected;
    },
    async removeProfile(learnerId) {
      const removed = await profileController.removeProfile(learnerId);
      await alignSelectedLearner();
      return removed;
    },
    dispose: () => profileController.dispose(),
  });
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
  const random = options.random ?? defaultProductRandom;
  const createLearnerId = options.createLearnerId ?? defaultLearnerId;
  const connection = createSwitchableSqlConnection(connectionFactory);
  const gate = createDatabaseCommandGate();
  const catalogue = loadStarterSpellingCatalogue();
  const cataloguesById = Object.freeze({ [catalogue.catalogueId]: catalogue });
  let lifecycle = null;
  let coordinator = null;
  let controller = null;
  let learning = null;
  let audioAvailability = null;

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
    const commandRepository = createSQLiteSpellingCommandRepository({
      connection,
      gate,
      store: snapshotStore,
      cataloguesById,
      now,
    });
    const packRepository = createSqlitePackRepositories(connection);
    const packTransfer = options.packTransfer ??
      createCapacitorPackTransfer({ PackTransfer: PackTransferPlugin });
    lifecycle =
      options.lifecycle ?? (options.lifecycleFactory ?? createCapacitorAppLifecycle)();
    coordinator = createDatabaseLifecycleCoordinator({
      lifecycle,
      commandGate: gate,
      createConnection: async () => connection,
      migrate,
      resolveSelectedLearnerId: readSQLiteSelectedLearnerId,
      rehydrateSelectedLearner: async (_connection, learnerId) => {
        if (learning) {
          await learning.selectLearner(learnerId);
        } else {
          await snapshotStore.read(learnerId);
        }
      },
    });

    await connection.close();
    await coordinator.start();
    const [initialProfiles, initialSelectedLearnerId] = await Promise.all([
      profileStore.profiles.listProfiles(),
      profileStore.selection.readSelectedLearnerId(),
    ]);
    const initialSnapshot = initialSelectedLearnerId === null
      ? null
      : await snapshotStore.read(initialSelectedLearnerId);
    learning = createProductLearningController({
      repository: commandRepository,
      snapshotStore,
      catalogue,
      initialSnapshot,
      random,
    });
    const profileController = createProductProfileController({
      profiles: profileStore.profiles,
      selection: profileStore.selection,
      initialProfiles,
      initialSelectedLearnerId,
      createLearnerId,
    });
    controller = linkProfileAndLearningControllers(
      profileController,
      learning,
    );
    audioAvailability = createStarterPackAvailabilityController({
      packRepository,
      packTransfer,
    });
    await audioAvailability.refresh().catch(() => undefined);
    let disposePromise;
    return Object.freeze({
      mode: 'product',
      databaseName: DATABASE_NAME,
      schemaVersion: SCHEMA_VERSION,
      controller,
      learning,
      audioAvailability,
      dispose() {
        disposePromise ??= disposeAll([
          () => audioAvailability.dispose(),
          () => learning.dispose(),
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
        audioAvailability && (() => audioAvailability.dispose()),
        learning && (() => learning.dispose()),
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
