import { Capacitor } from '@capacitor/core';

import gatewayAuthorityJson from '../../config/b3-gateway-authority.json' with { type: 'json' };
import packKeyring from '../../config/pack-signing-public-keys.json' with { type: 'json' };
import {
  assertB3GatewayAuthority,
  findStoreProductByEntitlementId,
} from '../domain/commerce/commerce-contracts.js';
import {
  B3_PACK_JOB_AUTHORITY,
  B3_PACK_REGISTRY,
  createB3SignedDownloadAccessContract,
  findB3PackAuthority,
} from '../domain/packs/b3-pack-registry.js';
import { B3_DOWNLOAD_CHUNK_BYTES } from '../domain/packs/signed-download-access-contract.js';
import { createCapacitorStore } from '../platform/commerce/capacitor-store.js';
import {
  CommercePlugin,
} from '../platform/commerce/capacitor-commerce-plugin.js';
import { createCapacitorSqliteConnection } from '../platform/database/capacitor-sqlite-connection.js';
import { seedB2Learners } from '../platform/database/b2-seed.js';
import { configureAndMigrateDatabase } from '../platform/database/migrate-database.js';
import { createSqliteCommerceAttemptRepository } from '../platform/database/sqlite-commerce-attempt-repository.js';
import { createSqliteCommerceRepositories } from '../platform/database/sqlite-commerce-repositories.js';
import { createSqlitePackRepositories } from '../platform/database/sqlite-pack-repositories.js';
import { createB3FakeGateway } from '../platform/fakes/create-b3-fake-gateway.js';
import { createB3FakePackTransfer } from '../platform/fakes/create-b3-fake-pack-transfer.js';
import { createB3FakeStore } from '../platform/fakes/create-b3-fake-store.js';
import { createHttpEntitlementGateway } from '../platform/gateway/http-entitlement-gateway.js';
import { createCapacitorAppLifecycle } from '../platform/lifecycle/capacitor-app-lifecycle.js';
import { createCapacitorPackTransfer } from '../platform/pack-transfer/capacitor-pack-transfer.js';
import {
  PackTransferPlugin,
} from '../platform/pack-transfer/capacitor-pack-transfer-plugin.js';
import {
  isCapacitorB3ProofObservation,
} from '../platform/proof/capacitor-b3-proof-observation.js';

import {
  createGatewayRecorder,
  isRecoverableExternalFailure,
  verifyManifest,
} from './commerce-runtime-support.js';
import { createB3ProofController } from './b3-proof-controller.js';
import { createB3DeviceGatewaySmokeProbe } from './b3-device-gateway-smoke.js';
import {
  createB3LiveProofSession,
  createB3ObservedGateway,
  createB3ObservedStore,
} from './b3-live-proof-composition.js';
import { createCommerceReconciler } from './commerce-reconciler.js';
import { createDownloadCoordinator } from './download-coordinator.js';
import { createPackActivationCoordinator } from './pack-activation-coordinator.js';
import { createPackReconciler } from './pack-reconciler.js';
import { createPurchaseCoordinator } from './purchase-coordinator.js';

const SHA256 = /^[a-f0-9]{64}$/;

// The B3 proof lane is pinned to the registry's b3 row. Since the E2.7 join
// flip the sellable catalogue delivers the 15 Full-KS2 shards, so this lane
// binds its coordinators explicitly instead of reading the catalogue join.
const B3_PACK = findB3PackAuthority('b3-sandbox-proof');

function defaultRuntime() {
  return Object.freeze({
    isNativePlatform: Capacitor.isNativePlatform(),
    platform: Capacitor.getPlatform(),
  });
}

function readRuntime(value) {
  const runtime = value ?? defaultRuntime();
  if (
    !runtime ||
    typeof runtime !== 'object' ||
    typeof runtime.isNativePlatform !== 'boolean' ||
    typeof runtime.platform !== 'string'
  ) {
    throw new TypeError('B3 runtime authority is invalid.');
  }
  if (
    runtime.isNativePlatform &&
    runtime.platform !== 'ios' &&
    runtime.platform !== 'android'
  ) {
    throw new TypeError('B3 native platform authority is invalid.');
  }
  return runtime;
}

function assertBuildAuthority(runtime, gatewayAuthority) {
  if (runtime.isNativePlatform) {
    const authority = runtime.buildAuthority;
    if (!authority || typeof authority !== 'object' || Array.isArray(authority)) {
      throw new TypeError('B3 embedded build authority is required.');
    }
    const keys = [
      'mode',
      'proofKind',
      'platform',
      'distribution',
      'publicSandboxOrigin',
      'workerName',
      'bundleId',
      'testedApplicationCommit',
      'applicationFingerprint',
      'versionName',
      'buildNumber',
    ];
    if (
      Reflect.ownKeys(authority).length !== keys.length ||
      Reflect.ownKeys(authority).some((key) =>
        typeof key !== 'string' ||
        !keys.includes(key) ||
        !Object.getOwnPropertyDescriptor(authority, key)?.enumerable ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(authority, key), 'value'))
    ) {
      throw new TypeError('B3 embedded build authority is invalid.');
    }
    if (
      authority.mode !== 'B3SandboxProof' ||
      authority.proofKind !== 'physical-live' ||
      authority.platform !== runtime.platform ||
      authority.distribution !==
        (runtime.platform === 'ios' ? 'development' : 'play-internal') ||
      authority.publicSandboxOrigin !== gatewayAuthority.publicSandboxOrigin ||
      authority.workerName !== gatewayAuthority.workerName ||
      authority.bundleId !== 'uk.eugnel.ks2spelling' ||
      !/^[0-9a-f]{40}$/u.test(authority.testedApplicationCommit) ||
      !SHA256.test(authority.applicationFingerprint) ||
      authority.versionName !== '0.3.0-b3' ||
      !(
        (runtime.platform === 'ios' && /^\d+$/u.test(authority.buildNumber)) ||
        (runtime.platform === 'android' && Number.isSafeInteger(authority.buildNumber))
      ) ||
      Number(authority.buildNumber) <= 0
    ) {
      throw new TypeError('B3 native composition requires physical live proof authority.');
    }
  } else if (Object.hasOwn(runtime, 'buildAuthority')) {
    throw new TypeError('Browser B3 composition cannot accept native build authority.');
  }
  return runtime;
}

function readonlyEntitlementSet(entitlements) {
  const identifiers = new Set(
    entitlements
      .filter((entitlement) => entitlement.state === 'active')
      .map((entitlement) => entitlement.entitlementId),
  );
  const result = Object.create(null);
  Object.assign(result, {
    size: identifiers.size,
    has: (value) => identifiers.has(value),
    values: () => identifiers.values(),
    keys: () => identifiers.keys(),
    entries: () => identifiers.entries(),
    forEach: (callback, thisArgument) => identifiers.forEach(callback, thisArgument),
    [Symbol.iterator]: () => identifiers[Symbol.iterator](),
  });
  return Object.freeze(result);
}

function safeTimestampClock(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('B3 composition clock is invalid.');
  }
  return value;
}

// Re-exported for existing proof-lane importers; implementations live in
// commerce-runtime-support.js so the product bundle never imports this module.
export { createGatewayRecorder, isRecoverableExternalFailure, verifyManifest };

async function closeQuietly(connection) {
  try {
    await connection.close();
  } catch {
    // The original composition failure remains authoritative.
  }
}

export async function createB3AppServices(options = {}) {
  const gatewayAuthority = assertB3GatewayAuthority(gatewayAuthorityJson);
  const runtime = readRuntime(options.runtime);
  const startupSequence = [];
  const clock = options.clock ?? (() => Date.now());
  const connectionFactory = options.connectionFactory ?? createCapacitorSqliteConnection;
  const migrate = options.migrate ?? configureAndMigrateDatabase;
  let connection;
  let commerceReconciler;
  let lifecycle;
  let resumeHandle;
  let resumeOperation = null;
  let acceptingResumeEvents = true;
  let controller;
  let proofCommand = null;
  let liveProofSession = null;
  try {
    if (
      runtime.isNativePlatform &&
      ['fakeStoreOptions', 'fakeGatewayOptions', 'fakePackTransferOptions',
        'manifestVerifier', 'packTransferFactory', 'lifecycleFactory']
        .some((key) => Object.hasOwn(options, key))
    ) {
      throw new TypeError('B3 physical proof does not accept fake adapters.');
    }
    assertBuildAuthority(runtime, gatewayAuthority);
    if (runtime.isNativePlatform) {
      if (!isCapacitorB3ProofObservation(options.proofObservationPort)) {
        throw new TypeError('B3 physical proof requires its concrete observation transport.');
      }
      proofCommand = await options.proofObservationPort.getLaunchCommand();
      if (proofCommand !== null && (
        proofCommand.platform !==
          (runtime.platform === 'ios' ? 'ios-physical' : 'android-play-physical') ||
        proofCommand.testedApplicationCommit !==
          runtime.buildAuthority.testedApplicationCommit ||
        proofCommand.applicationFingerprint !==
          runtime.buildAuthority.applicationFingerprint
      )) {
        throw new TypeError('B3 launch command does not match the embedded build authority.');
      }
    } else if (Object.hasOwn(options, 'proofObservationPort')) {
      throw new TypeError('Browser B3 composition cannot accept a proof observation transport.');
    }
    connection = await connectionFactory();
    await connection.open();
    await migrate(connection);
    await seedB2Learners(connection);
    startupSequence.push('database-migrated');

    const packTransfer = runtime.isNativePlatform
      ? createCapacitorPackTransfer({
          PackTransfer: PackTransferPlugin,
          gatewayOrigin: ['https:', '', 'b3-gateway.eugnel.uk'].join('/'),
        })
      : createB3FakePackTransfer(options.fakePackTransferOptions);
    const commerceRepository = createSqliteCommerceRepositories(connection);
    const packRepository = createSqlitePackRepositories(connection);

    const activeEntitlementSet = async () =>
      readonlyEntitlementSet(await commerceRepository.listEntitlements());
    const packReconciler = createPackReconciler({
      entitlementId: B3_PACK.requiredEntitlementId,
      packIds: [B3_PACK.packId],
      registry: B3_PACK_REGISTRY,
      packTransfer,
      packRepository,
      activeEntitlementProjection: activeEntitlementSet,
      clock: () => safeTimestampClock(clock),
    });
    await packReconciler.reconcileAtStartup();
    startupSequence.push('packs-reconciled');

    assertBuildAuthority(runtime, gatewayAuthority);
    startupSequence.push('build-authority-selected');
    const rawStore = runtime.isNativePlatform
      ? createCapacitorStore({ Commerce: CommercePlugin })
      : createB3FakeStore(options.fakeStoreOptions);
    const rawGateway = runtime.isNativePlatform
      ? createHttpEntitlementGateway({
          authority: gatewayAuthority,
          fetchImpl: globalThis.fetch.bind(globalThis),
        })
      : createB3FakeGateway(options.fakeGatewayOptions);
    startupSequence.push('commerce-adapters-composed');
    if (proofCommand !== null) {
      const gatewaySmokeProbe = options.deviceGatewaySmokeProbe ??
        createB3DeviceGatewaySmokeProbe({
          fetchImpl: globalThis.fetch.bind(globalThis),
          clock,
          wait: (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
        });
      liveProofSession = await createB3LiveProofSession({
        command: proofCommand,
        buildAuthority: runtime.buildAuthority,
        connection,
        observationPort: options.proofObservationPort,
        gatewaySmokeProbe,
      });
    }
    const store = liveProofSession
      ? createB3ObservedStore(rawStore, liveProofSession)
      : rawStore;
    const observedGateway = liveProofSession
      ? createB3ObservedGateway(rawGateway, liveProofSession)
      : rawGateway;
    let latestSignedManifestEnvelope = null;
    const gateway = createGatewayRecorder(
      observedGateway,
      (value) => { latestSignedManifestEnvelope = value; },
      (result) => liveProofSession?.observeDownloadAuthorisation(result),
      () => liveProofSession?.recordGatewaySmokeFailure(),
    );
    const storeKind = runtime.platform === 'ios' ? 'apple' : 'google';
    const attemptRepository = createSqliteCommerceAttemptRepository(
      connection,
      { store: storeKind, entitlementId: B3_PACK.requiredEntitlementId },
    );
    const purchaseCoordinator = createPurchaseCoordinator({
      entitlementId: B3_PACK.requiredEntitlementId,
      packIds: [B3_PACK.packId],
      registry: B3_PACK_REGISTRY,
      store,
      gateway,
      commerceRepository,
      attemptRepository,
      downloadRepository: packRepository,
      clock: () => safeTimestampClock(clock),
      idFactory: () => globalThis.crypto.randomUUID(),
      failureInjector: liveProofSession?.failureInjector ?? (async () => undefined),
    });
    let latestTransactionState = null;
    let syncFailed = false;
    let publishCommerceChange = async () => undefined;
    commerceReconciler = createCommerceReconciler({
      store,
      coordinator: Object.freeze({
        async handleObservation(observation) {
          try {
            const result = await purchaseCoordinator.handleObservation(observation);
            latestTransactionState = result.state;
            await publishCommerceChange();
            return result;
          } catch (error) {
            if (isRecoverableExternalFailure(error)) {
              syncFailed = true;
              await publishCommerceChange();
            }
            throw error;
          }
        },
        recover: () => purchaseCoordinator.recover(),
      }),
    });

    const activeEntitlement = async () => {
      const entitlements = await commerceRepository.listEntitlements();
      return entitlements.find((entry) => entry.state === 'active') ?? null;
    };
    const manifestVerifier = runtime.isNativePlatform
      ? verifyManifest
      : (options.manifestVerifier ?? verifyManifest);
    const downloadCoordinator = createDownloadCoordinator({
      gateway,
      packTransfer,
      packRepository,
      manifestVerifier,
      keyring: packKeyring,
      gatewayOrigin: ['https:', '', 'b3-gateway.eugnel.uk'].join('/'),
      createDownloadAccessContract: createB3SignedDownloadAccessContract,
      activeEntitlementProjection: activeEntitlement,
      entitlementRepository: commerceRepository,
      currentAppVersion: '0.3.0-b3',
      currentSchemaVersion: 2,
      clock: () => safeTimestampClock(clock),
      chunkSize: B3_DOWNLOAD_CHUNK_BYTES,
      packAuthority: B3_PACK,
    });
    const activationCoordinator = createPackActivationCoordinator({
      packTransfer,
      packRepository,
      manifestVerifier,
      keyring: packKeyring,
      environment: 'sandbox',
      registry: B3_PACK_REGISTRY,
      clock: () => safeTimestampClock(clock),
    });

    try {
      await commerceReconciler.start();
    } catch (error) {
      if (!isRecoverableExternalFailure(error)) throw error;
      syncFailed = true;
    }
    startupSequence.push('transactions-subscribed-replayed');
    try {
      await purchaseCoordinator.refresh();
    } catch (error) {
      if (!isRecoverableExternalFailure(error)) throw error;
      syncFailed = true;
    }
    startupSequence.push('refresh-handles-refreshed');
    const catalogueProduct = findStoreProductByEntitlementId(B3_PACK.requiredEntitlementId);
    const productId = storeKind === 'apple'
      ? catalogueProduct.appleProductId
      : catalogueProduct.googleProductId;
    const queryApprovedProduct = async () => {
      const products = await store.queryProducts({ productIds: [productId] });
      if (products.length !== 1 || products[0].productId !== productId) {
        throw new TypeError('B3 approved store product is unavailable.');
      }
      return products[0];
    };
    let product = null;
    try {
      product = await queryApprovedProduct();
    } catch (error) {
      if (!isRecoverableExternalFailure(error)) throw error;
      syncFailed = true;
    }

    async function snapshot() {
      const [entitlements, activePack, installed] = await Promise.all([
        commerceRepository.listEntitlements(),
        packRepository.getActiveVersion({ packId: B3_PACK.packId }),
        packRepository.listInstalledVersions({ packId: B3_PACK.packId }),
      ]);
      const entitlement = entitlements.find(
        (entry) => entry.entitlementId === B3_PACK.requiredEntitlementId,
      ) ?? null;
      const installedVersion = activePack
        ? installed.find((entry) => entry.version === activePack.version) ?? null
        : null;
      const installDigest = installedVersion?.activationMarkerSha256 ?? null;
      if (installDigest !== null && !SHA256.test(installDigest)) {
        throw new Error('B3 installed-pack evidence is invalid.');
      }
      return Object.freeze({
        displayPrice: product?.displayPrice ?? '',
        packReady: Boolean(
          entitlement?.state === 'active' &&
          activePack &&
          installedVersion?.state === 'ready',
        ),
        entitlementState: entitlement?.state ?? 'none',
        startupFailed: syncFailed,
        transactionState: latestTransactionState,
        digests: Object.freeze({
          manifest: B3_PACK_JOB_AUTHORITY.manifestSha256,
          archive: B3_PACK_JOB_AUTHORITY.archiveSha256,
          install: installDigest,
        }),
      });
    }

    async function install() {
      const entitlement = await activeEntitlement();
      if (!entitlement) throw new Error('B3 active entitlement is unavailable.');
      await downloadCoordinator.queue({
        sealedRefreshHandle: entitlement.sealedRefreshHandle,
      });
      if (typeof latestSignedManifestEnvelope !== 'string') {
        throw new Error('B3 signed manifest was not observed.');
      }
      const result = await activationCoordinator.activate({
        packId: B3_PACK.packId,
        version: B3_PACK.version,
        signedManifestEnvelope: latestSignedManifestEnvelope,
      });
      const latest = await snapshot();
      return Object.freeze({
        state: result.state === 'ready' ? 'installed' : result.state,
        packReady: latest.packReady,
        installDigest: latest.digests.install,
      });
    }

    const workflow = Object.freeze({
      start: snapshot,
      sync: snapshot,
      async purchase() {
        const result = await purchaseCoordinator.purchase({ productId });
        const latest = await snapshot();
        return Object.freeze({
          state: latest.entitlementState === 'revoked' ? 'revoked' : result.state,
          packReady: latest.packReady,
        });
      },
      install,
      async restore() {
        const result = await purchaseCoordinator.restore();
        const latest = await snapshot();
        return Object.freeze({
          state: latest.entitlementState === 'revoked' ? 'revoked' : result.state,
          packReady: latest.packReady,
        });
      },
      async redownload() {
        return install();
      },
      async dispose() {
        await commerceReconciler.dispose();
      },
    });
    controller = createB3ProofController({ workflow });
    publishCommerceChange = () => controller.sync();
    if (runtime.isNativePlatform || Object.hasOwn(options, 'lifecycleFactory')) {
      const lifecycleFactory = options.lifecycleFactory ?? createCapacitorAppLifecycle;
      lifecycle = lifecycleFactory();
      resumeHandle = lifecycle.onResume(() => {
        if (!acceptingResumeEvents) return Promise.resolve();
        if (resumeOperation) return resumeOperation;
        const attempt = (async () => {
          let resumeFailed = false;
          for (const refresh of [
            () => commerceReconciler.resume(),
            () => purchaseCoordinator.refresh(),
            async () => { product = await queryApprovedProduct(); },
          ]) {
            try {
              await refresh();
            } catch (error) {
              if (!isRecoverableExternalFailure(error)) throw error;
              resumeFailed = true;
            }
          }
          syncFailed = resumeFailed;
          await controller.sync();
        })();
        let tracked;
        tracked = attempt.finally(() => {
          if (resumeOperation === tracked) resumeOperation = null;
        });
        resumeOperation = tracked;
        void tracked.catch(() => undefined);
        return tracked;
      });
    }
    startupSequence.push('ready');

    let disposePromise;
    const dispose = () => {
      if (!disposePromise) {
        disposePromise = (async () => {
          const failures = [];
          acceptingResumeEvents = false;
          try {
            await resumeHandle?.remove?.();
          } catch (error) {
            failures.push(error);
          }
          const activeResume = resumeOperation;
          if (activeResume) {
            try {
              await activeResume;
            } catch (error) {
              failures.push(error);
            }
          }
          for (const disposeOwned of [
            () => lifecycle?.dispose?.(),
            () => controller.dispose(),
            () => connection.close(),
          ]) {
            try {
              await disposeOwned();
            } catch (error) {
              failures.push(error);
            }
          }
          if (failures.length > 0) {
            throw new AggregateError(failures, 'B3 service disposal failed.');
          }
        })();
      }
      return disposePromise;
    };
    return Object.freeze({
      mode: 'b3-parent-proof',
      adapterKind: runtime.isNativePlatform ? 'concrete-live' : 'deterministic-fake',
      liveProofArmed: proofCommand !== null,
      runLiveProofCommand: liveProofSession
        ? () => liveProofSession.run(controller)
        : null,
      startupSequence: Object.freeze([...startupSequence]),
      controller,
      dispose,
    });
  } catch (error) {
    acceptingResumeEvents = false;
    await resumeHandle?.remove?.().catch(() => undefined);
    await resumeOperation?.catch(() => undefined);
    await lifecycle?.dispose?.().catch(() => undefined);
    if (controller) {
      await controller.dispose().catch(() => undefined);
    } else {
      await commerceReconciler?.dispose().catch(() => undefined);
    }
    if (connection) await closeQuietly(connection);
    throw error;
  }
}
