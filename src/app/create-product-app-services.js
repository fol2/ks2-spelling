// The Starter audio evidence doubles as the runtime playback manifest: the
// player only reads schemaVersion/status/catalogueId/assetCount and each
// asset's {assetPath, sha256, byteSize}. A trimmed runtime manifest would
// live in config/, which is frozen for this slice (config/packs/
// ks2-core.audio.json records runtimeManifestTarget: null).
import starterAudioEvidence from '../../reports/c1/starter-audio-evidence.json' with { type: 'json' };
import {
  loadFullSpellingCatalogue,
  loadStarterSpellingCatalogue,
  validateSpellingCommandSnapshotV1,
} from '../domain/spelling/index.js';
import {
  createCapacitorInstalledAudio,
} from '../platform/audio/capacitor-installed-audio.js';
import {
  InstalledAudioPlugin,
} from '../platform/audio/capacitor-installed-audio-plugin.js';
import { canonicalJson } from '../platform/database/canonical-json.js';
import { createCapacitorSqliteConnection } from '../platform/database/capacitor-sqlite-connection.js';
import { createCapacitorHaptics } from '../platform/haptics/capacitor-haptics.js';
import { createDatabaseCommandGate } from '../platform/database/database-command-gate.js';
import { configureAndMigrateDatabase } from '../platform/database/migrate-database.js';
import { DATABASE_NAME } from '../platform/database/schema-v1.js';
import { SCHEMA_VERSION } from '../platform/database/schema-v2.js';
import {
  createSQLiteSpellingProfileStore,
  readSQLiteSelectedLearnerId,
} from '../platform/database/sqlite-spelling-profile-store.js';
import { createSQLiteSpellingCommandRepository } from '../platform/database/sqlite-spelling-command-repository.js';
import { createSQLiteSpellingSnapshotStore } from '../platform/database/sqlite-spelling-snapshot-store.js';
import { createSQLiteParentSecurityRepository } from '../platform/database/sqlite-parent-security-repository.js';
import {
  createSQLiteRoundBaselineStore,
} from '../platform/database/sqlite-round-baseline-store.js';
import {
  createSQLiteLearningBackupRepository,
} from '../platform/database/sqlite-learning-backup-repository.js';
import {
  createSQLiteSoundPrefsStore,
} from '../platform/database/sqlite-sound-prefs-store.js';
import { createCapacitorAppLifecycle } from '../platform/lifecycle/capacitor-app-lifecycle.js';
import { createSfxEngine } from './sfx/sfx-engine.js';
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
  createSqlitePackRepositories,
} from '../platform/database/sqlite-pack-repositories.js';
import {
  createCapacitorPackTransfer,
} from '../platform/pack-transfer/capacitor-pack-transfer.js';
import {
  PackTransferPlugin,
} from '../platform/pack-transfer/capacitor-pack-transfer-plugin.js';
import {
  createProductCommerceWorkflow,
} from './create-product-commerce-workflow.js';
import {
  createUnavailableProductCommerceWorkflow,
} from './unavailable-product-commerce-workflow.js';
import {
  createDatabaseGatedRepository,
} from './database-gated-repository.js';
import { createBundledStarterAudio } from './bundled-starter-audio.js';
import { createDatabaseLifecycleCoordinator } from './database-lifecycle-coordinator.js';
import {
  createEntitledAudioSwitch,
  isFullProductEntitled,
} from './entitled-audio-switch.js';
// ponytail: the Full player's asset evidence (config/full-audio-manifest.json,
// ~1.7 MB) is a static import, so it parses at startup even for a device that
// never buys. Move this module behind a dynamic import chunk if startup cost
// ever shows up on the low-end device budget.
import { createFullProductAudioPlayer } from './full-product-audio.js';
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

// The one entitlement the full catalogue publishes. The profile store writes
// the same grant into the aggregate when it re-tags; a composition test pins
// the vendored catalogue to it so the two can never drift apart silently.
const FULL_ENTITLEMENT_ID = 'full-ks2';

// The gateway bounds its own calls, but nothing bounds the Capacitor store
// bridge — and this await sits on the startup path, so a bridge that never
// settles would stop the app opening rather than merely leaving commerce
// unavailable. When the bound wins, the un-started snapshot reads
// none/missing, which composes Starter: the same safe state as a device that
// never bought, and one the Parent card already has copy for.
const COMMERCE_START_TIMEOUT_MS = 8_000;

async function settleWithin(promise, milliseconds) {
  let timer = null;
  try {
    await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(resolve, milliseconds); }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Whether a learner's stored aggregate can be re-tagged to `catalogue` without
 * losing anything. The catalogue contract is the oracle rather than a
 * hand-written subset check: every progress key, event, Monster track and Camp
 * record is resolved against the catalogue's items, so a snapshot that carries
 * a word the target does not publish fails here instead of being silently
 * trimmed. Requiring the validated form to come back byte-identical closes the
 * other half — a normalisation that quietly rewrote the aggregate would not
 * count as representable either.
 */
function createCatalogueRepresentationCheck({ snapshotStore, cataloguesById }) {
  return async function canRepresent(learnerId, catalogueId) {
    const catalogue = cataloguesById[catalogueId];
    if (!catalogue) return false;
    // Read outside the guard: a database that cannot be read is not the same
    // answer as an aggregate that cannot be expressed, and swallowing the
    // first would quietly deny an entitled family the words they bought.
    const stored = await snapshotStore.read(learnerId);
    const candidate = {
      ...stored,
      catalogueId,
      grantedEntitlementIds: catalogue.entitlementIds.includes(FULL_ENTITLEMENT_ID)
        ? [FULL_ENTITLEMENT_ID]
        : [],
    };
    try {
      const validated = validateSpellingCommandSnapshotV1(candidate, catalogue);
      return canonicalJson(validated) === canonicalJson(candidate);
    } catch {
      return false;
    }
  };
}

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

async function runPostCommit(work) {
  try {
    return await work();
  } catch (error) {
    try {
      error.postCommit = true;
    } catch {
      // A frozen or primitive throw cannot carry the marker; re-throw as-is.
    }
    throw error;
  }
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
      // The profile is committed, and creation does not change the selection.
      await alignSelectedLearner().catch(() => undefined);
      return profile;
    },
    editProfile: (draft) => profileController.editProfile(draft),
    async selectProfile(learnerId) {
      const selected = await profileController.selectProfile(learnerId);
      // Swallowing would close the switch sheet on the wrong learner.
      await runPostCommit(alignSelectedLearner);
      return selected;
    },
    async removeProfile(learnerId) {
      const removed = await profileController.removeProfile(learnerId);
      // The removal is committed and the profile screen self-heals.
      await alignSelectedLearner().catch(() => undefined);
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
  // Starter is the floor, not the ceiling: an entitled device with all 15
  // shards installed practises the full KS2 catalogue (E2.7b), chosen below
  // from the commerce snapshot. Both stay registered so stored aggregates and
  // backups on either side of the switch can be decoded.
  const starterCatalogue = loadStarterSpellingCatalogue();
  const fullCatalogue = await loadFullSpellingCatalogue();
  const cataloguesById = Object.freeze({
    [starterCatalogue.catalogueId]: starterCatalogue,
    [fullCatalogue.catalogueId]: fullCatalogue,
  });
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
  let sfx = null;
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
    // Live commerce composes only on a native runtime: the real store bridge,
    // the HTTP gateway and the N-shard download/activation coordinators, all
    // reachable solely through the Parent-gated commerce controller. Every
    // other composition (web, tests without commerce dependencies) keeps the
    // unavailable workflow, which fails purchase/restore/download closed.
    // It composes before learning and playback because the commerce snapshot
    // is what tells both which catalogue this device is entitled to.
    const commerceWorkflow = options.commerceWorkflow ??
      (options.runtime?.isNativePlatform === true
        ? createProductCommerceWorkflow({
            runtime: options.runtime,
            connection,
            commandGate: gate,
            packRepository: createSqlitePackRepositories(connection),
            packTransfer: options.packTransfer ??
              createCapacitorPackTransfer({ PackTransfer: PackTransferPlugin }),
            clock: now,
          })
        : createUnavailableProductCommerceWorkflow());
    parentCommerce = createParentCommerceController({
      workflow: commerceWorkflow,
    });
    // Awaited, unlike the audio switch's reactive observation: the learning
    // controller validates its initial snapshot against one fixed catalogue,
    // so the answer has to be settled before anything is composed. start()
    // never rejects past this catch, absorbs its own transient store/gateway
    // failures and resolves from durable local rows, so an offline entitled
    // device still reads 'active'/'installed' and keeps its full catalogue.
    // The cost is that a shard install finishing mid-session is not picked up
    // until relaunch — the Parent card says so.
    // The catch is attached before the race, so a bridge that rejects after the
    // bound has already won cannot surface as an unhandled rejection.
    await settleWithin(
      parentCommerce.start().catch(() => undefined),
      options.commerceStartTimeoutMs ?? COMMERCE_START_TIMEOUT_MS,
    );
    const alignCatalogueLearning = (store) =>
      store.administration.alignCatalogueLearning({
        entitled: isFullProductEntitled(parentCommerce.getState()),
        canRepresent: createCatalogueRepresentationCheck({
          snapshotStore,
          cataloguesById,
        }),
      });
    // A profile store seeds newly created learners with its initialCatalogueId,
    // so the aligned catalogue must be known before the store the app keeps is
    // built. The store is a pure factory over (connection, gate, now); the
    // throwaway instance below only runs the alignment.
    const activeCatalogueId = await alignCatalogueLearning(
      createSQLiteSpellingProfileStore({ connection, gate, now }),
    );
    const catalogue = cataloguesById[activeCatalogueId];
    const profileStore = createSQLiteSpellingProfileStore({
      connection,
      gate,
      now,
      initialCatalogueId: activeCatalogueId,
    });
    const [initialProfiles, initialSelectedLearnerId] = await Promise.all([
      profileStore.profiles.listProfiles(),
      profileStore.selection.readSelectedLearnerId(),
    ]);
    const initialSnapshot = initialSelectedLearnerId === null
      ? null
      : await snapshotStore.read(initialSelectedLearnerId);
    const roundBaselineStore = createSQLiteRoundBaselineStore({
      connection,
      gate,
      now,
    });
    let initialRoundBaseline = null;
    if (initialSnapshot?.subjectState?.ui?.phase === 'session') {
      initialRoundBaseline = await roundBaselineStore
        .read(initialSelectedLearnerId)
        .catch(() => null);
    }
    learning = createProductLearningController({
      repository: commandRepository,
      snapshotStore,
      catalogue,
      initialSnapshot,
      roundBaselineStore,
      initialRoundBaseline,
      random,
      now,
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
    const bundledAudioSource =
      options.bundledAudio ??
      options.bundledStarterAudio ??
      createBundledStarterAudio({ evidence: starterAudioEvidence });
    if (options.audio) {
      audio = options.audio;
    } else {
      // Always the Starter catalogue: the bundled evidence publishes exactly
      // those 20 words and the audio contract asserts the pair matches.
      const starterPlayer = createProductAudioPlayer({
        catalogue: starterCatalogue,
        installedAudio: bundledAudioSource,
        audioEvidence: starterAudioEvidence,
      });
      // Shard playback needs the native installed-audio reader; a runtime
      // without one (web, tests) can only ever serve Starter, so no switch is
      // composed and the Starter player is the whole player.
      const shardInstalledAudio = options.installedAudio ??
        (options.runtime?.isNativePlatform === true
          ? createCapacitorInstalledAudio({ InstalledAudio: InstalledAudioPlugin })
          : null);
      audio = shardInstalledAudio === null ? starterPlayer : createEntitledAudioSwitch({
        starter: starterPlayer,
        full: createFullProductAudioPlayer({ installedAudio: shardInstalledAudio }),
        observe: (listener) => parentCommerce.subscribe(listener),
      });
    }
    audioAvailability = createStarterPackAvailabilityController({
      audioSource: bundledAudioSource,
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
    const parentAdministration = Object.freeze({
      async resetLearning(learnerId) {
        await profileStore.administration.resetLearning(learnerId);
        if (learning.getState().learnerId === learnerId) {
          await runPostCommit(() => learning.selectLearner(learnerId));
        }
        // A committed reset must not be reported as failed because the
        // auxiliary summary could not be rebuilt; it carries its own notice.
        await parentProgress.refresh().catch(() => undefined);
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
        await runPostCommit(async () => {
          // An import can replace every aggregate with one taken on the other
          // side of the switch, so the same alignment runs here — the startup
          // path alone would leave a restored full-catalogue backup unaligned
          // on a device that never bought, and a restored Starter backup
          // stranded on an entitled one. Only the composed catalogue cannot
          // change under a running app: when the import lands on the other
          // catalogue this reports post-commit, and the Parent screen already
          // says the import succeeded and to reopen the app.
          const importedCatalogueId = await alignCatalogueLearning(profileStore);
          if (importedCatalogueId !== catalogue.catalogueId) {
            throw new Error('product_catalogue_changed_by_import');
          }
          await controller.reload();
        });
        // The progress summary is auxiliary and carries its own notice when a
        // refresh fails; a committed import must not be reported as failed
        // because of it.
        await parentProgress.refresh().catch(() => undefined);
      },
      now,
    });
    const soundPrefsStore = createSQLiteSoundPrefsStore({
      connection,
      gate,
      now,
    });
    const soundPrefs = await soundPrefsStore.read().catch(() => null);
    sfx = options.sfx ?? createSfxEngine({
      createContext: () => new AudioContext(),
      lifecycle,
      initiallyEnabled: soundPrefs?.sfxEnabled !== false,
      now,
    });
    if (typeof document !== 'undefined') {
      sfx.attachGestureUnlock(document);
    }
    const setSfxEnabled = (value) => {
      const enabled = value === true;
      sfx.setEnabled(enabled);
      void soundPrefsStore.write({ sfxEnabled: enabled }).catch(() => undefined);
    };
    let disposePromise;
    return Object.freeze({
      mode: 'product',
      databaseName: DATABASE_NAME,
      schemaVersion: SCHEMA_VERSION,
      // The catalogue this session composed. The Parent card reads it to say
      // honestly whether a finished install is already live or needs a
      // relaunch, because the switch is startup-only.
      catalogueId: catalogue.catalogueId,
      dataPolicy,
      controller,
      learning,
      audio,
      audioAvailability,
      sfx,
      setSfxEnabled,
      haptics: options.haptics ?? createCapacitorHaptics(),
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
          () => sfx.dispose(),
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
        sfx && (() => sfx.dispose()),
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
