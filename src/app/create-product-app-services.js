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
import { createSQLiteParentSecurityRepository } from '../platform/database/sqlite-parent-security-repository.js';
import {
  createSQLiteLearningBackupRepository,
} from '../platform/database/sqlite-learning-backup-repository.js';
import { createCapacitorInstalledAudio } from '../platform/audio/capacitor-installed-audio.js';
import { InstalledAudioPlugin } from '../platform/audio/capacitor-installed-audio-plugin.js';
import { createCapacitorAppLifecycle } from '../platform/lifecycle/capacitor-app-lifecycle.js';
import { createCapacitorPackTransfer } from '../platform/pack-transfer/capacitor-pack-transfer.js';
import {
  PackTransferPlugin,
} from '../platform/pack-transfer/capacitor-pack-transfer-plugin.js';
import {
  createCapacitorParentBiometrics,
} from '../platform/security/capacitor-parent-biometrics.js';
import {
  ParentAccessPlugin,
} from '../platform/security/capacitor-parent-access-plugin.js';
import {
  createCapacitorLocalDataProtection,
} from '../platform/security/capacitor-local-data-protection.js';
import {
  LocalDataProtectionPlugin,
} from '../platform/security/capacitor-local-data-protection-plugin.js';
import {
  createCapacitorLearningBackupFiles,
} from '../platform/backup/capacitor-learning-backup-files.js';
import {
  LearningBackupFilePlugin,
} from '../platform/backup/capacitor-learning-backup-file-plugin.js';
import {
  createProductCommerceWorkflow,
  createUnavailableProductCommerceWorkflow,
} from './create-product-commerce-workflow.js';
import {
  createDatabaseGatedRepository,
} from './database-gated-repository.js';
import { createDatabaseLifecycleCoordinator } from './database-lifecycle-coordinator.js';
import { createParentBackupService } from './parent-backup-service.js';
import {
  createParentCommerceController,
} from './parent-commerce-controller.js';
import {
  createParentProgressController,
} from './parent-progress-controller.js';
import { createParentSecurityController } from './parent-security-controller.js';
import { createProductAudioPlayer } from './product-audio-player.js';
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
    async reload() {
      await profileController.reload();
      await alignSelectedLearner();
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
  const localDataProtection = options.localDataProtection ??
    createCapacitorLocalDataProtection({
      LocalDataProtection: LocalDataProtectionPlugin,
    });
  let lifecycle = null;
  let coordinator = null;
  let controller = null;
  let learning = null;
  let audio = null;
  let audioAvailability = null;
  let parent = null;
  let parentBackup = null;
  let parentCommerce = null;
  let parentProgress = null;
  let dataPolicy = null;

  try {
    const initialDataProtection = await localDataProtection.applyPolicy({
      databaseName: DATABASE_NAME,
    });
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
    const gatedPackRepository = createDatabaseGatedRepository(
      packRepository,
      gate,
    );
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
    const verifiedDataProtection = await localDataProtection.applyPolicy({
      databaseName: DATABASE_NAME,
    });
    if (
      initialDataProtection.automaticBackupDisabled !==
        verifiedDataProtection.automaticBackupDisabled ||
      initialDataProtection.platformProtection !==
        verifiedDataProtection.platformProtection
    ) {
      throw new Error('local_data_protection_changed_during_bootstrap');
    }
    dataPolicy = Object.freeze({
      applicationEncryption: 'none',
      ...verifiedDataProtection,
    });
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
    const parentRepository = createSQLiteParentSecurityRepository({
      connection,
      gate,
    });
    const parentBiometrics = options.parentBiometrics ??
      createCapacitorParentBiometrics({ ParentAccess: ParentAccessPlugin });
    parent = await createParentSecurityController({
      repository: parentRepository,
      biometrics: parentBiometrics,
      lifecycle,
      pinCrypto: options.parentPinCrypto,
      now,
    });
    const installedAudio = options.installedAudio ??
      createCapacitorInstalledAudio({ InstalledAudio: InstalledAudioPlugin });
    audio = options.audio ?? createProductAudioPlayer({
      catalogue,
      installedAudio,
    });
    audioAvailability = createStarterPackAvailabilityController({
      packRepository: gatedPackRepository,
      packTransfer,
    });
    await audioAvailability.refresh().catch(() => undefined);
    parentProgress = createParentProgressController({
      profileRepository: profileStore.profiles,
      snapshotStore: createDatabaseGatedRepository(Object.freeze({
        async read(learnerId) {
          return snapshotStore.read(learnerId);
        },
      }), gate),
      catalogue,
      now,
    });
    void parentProgress.refresh().catch(() => undefined);
    const commerceWorkflow = options.commerceWorkflow ?? (
      options.runtime
        ? createProductCommerceWorkflow({
            runtime: options.runtime,
            connection,
            commandGate: gate,
            packRepository,
            packTransfer,
            clock: now,
          })
        : createUnavailableProductCommerceWorkflow()
    );
    parentCommerce = createParentCommerceController({
      workflow: commerceWorkflow,
    });
    void parentCommerce.start().catch(() => undefined);
    const parentAdministration = Object.freeze({
      async resetLearning(learnerId) {
        await profileStore.administration.resetLearning(learnerId);
        if (learning.getState().learnerId === learnerId) {
          await learning.selectLearner(learnerId);
        }
        await parentProgress.refresh();
        return true;
      },
    });
    const learningBackupRepository = createSQLiteLearningBackupRepository({
      connection,
      gate,
      cataloguesById,
      now,
    });
    const learningBackupFiles = options.learningBackupFiles ??
      createCapacitorLearningBackupFiles({
        LearningBackupFile: LearningBackupFilePlugin,
      });
    parentBackup = createParentBackupService({
      repository: learningBackupRepository,
      files: learningBackupFiles,
      afterImport: async () => {
        await controller.reload();
        await parentProgress.refresh();
      },
      now,
    });
    let disposePromise;
    return Object.freeze({
      mode: 'product',
      databaseName: DATABASE_NAME,
      schemaVersion: SCHEMA_VERSION,
      dataPolicy,
      controller,
      learning,
      audio,
      audioAvailability,
      parent,
      parentProgress,
      parentCommerce,
      parentAdministration,
      parentBackup,
      dispose() {
        disposePromise ??= disposeAll([
          () => parentCommerce.dispose(),
          () => parentProgress.dispose(),
          () => parent.dispose(),
          () => audio.dispose(),
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
        parent && (() => parent.dispose()),
        parentCommerce && (() => parentCommerce.dispose()),
        parentProgress && (() => parentProgress.dispose()),
        audio && (() => audio.dispose()),
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
