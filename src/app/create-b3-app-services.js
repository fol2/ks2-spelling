import { Capacitor, registerPlugin } from '@capacitor/core';

import gatewayAuthorityJson from '../../config/b3-gateway-authority.json' with { type: 'json' };
import packKeyring from '../../config/pack-signing-public-keys.json' with { type: 'json' };
import { assertB3GatewayAuthority } from '../domain/commerce/commerce-contracts.js';
import {
  B3_PACK_JOB_AUTHORITY,
  FULL_KS2_PACK,
} from '../domain/commerce/purchase-state.js';
import { verifySignedPackManifest } from '../domain/packs/pack-signature-verifier.js';
import { B3_DOWNLOAD_CHUNK_BYTES } from '../domain/packs/signed-download-access-contract.js';
import { createCapacitorStore } from '../platform/commerce/capacitor-store.js';
import { createCapacitorSqliteConnection } from '../platform/database/capacitor-sqlite-connection.js';
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

import { createB3ProofController } from './b3-proof-controller.js';
import { createCommerceReconciler } from './commerce-reconciler.js';
import { createDownloadCoordinator } from './download-coordinator.js';
import { createPackActivationCoordinator } from './pack-activation-coordinator.js';
import { createPackReconciler } from './pack-reconciler.js';
import { createPurchaseCoordinator } from './purchase-coordinator.js';

const CommercePlugin = registerPlugin('Commerce');
const PackTransferPlugin = registerPlugin('PackTransfer');
const SHA256 = /^[a-f0-9]{64}$/;

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
      authority.workerName !== gatewayAuthority.workerName
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

function isRecoverableExternalFailure(error) {
  if (!(error instanceof Error)) return false;
  if (error.code === 'STORE_NATIVE_FAILURE') return true;
  if (
    (error.code === 'GATEWAY_OFFLINE' || error.code === 'GATEWAY_TIMEOUT') &&
    error.retryable !== false
  ) {
    return true;
  }
  return error.retryable === true && (
    error.status === 429 ||
    (Number.isInteger(error.status) && error.status >= 500)
  );
}

function p256DerToRaw(signatureDer) {
  const bytes = new Uint8Array(signatureDer);
  if (bytes[0] !== 0x30 || bytes[1] !== bytes.length - 2 || bytes[2] !== 0x02) {
    throw new TypeError('P-256 DER signature is invalid.');
  }
  const rLength = bytes[3];
  const sTag = 4 + rLength;
  if (bytes[sTag] !== 0x02 || sTag + 2 + bytes[sTag + 1] !== bytes.length) {
    throw new TypeError('P-256 DER signature is invalid.');
  }
  const normalise = (start, length) => {
    const integer = bytes.slice(start, start + length);
    const magnitude = integer[0] === 0 ? integer.slice(1) : integer;
    if (magnitude.length === 0 || magnitude.length > 32) {
      throw new TypeError('P-256 DER signature is invalid.');
    }
    const output = new Uint8Array(32);
    output.set(magnitude, 32 - magnitude.length);
    return output;
  };
  const raw = new Uint8Array(64);
  raw.set(normalise(4, rLength), 0);
  raw.set(normalise(sTag + 2, bytes[sTag + 1]), 32);
  return raw;
}

async function verifyManifest(input) {
  return verifySignedPackManifest({
    ...input,
    async verifyP256Der({ publicKeySpkiDer, signatureDer, signingInput }) {
      const key = await globalThis.crypto.subtle.importKey(
        'spki',
        publicKeySpkiDer,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      );
      return globalThis.crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        p256DerToRaw(signatureDer),
        signingInput,
      );
    },
  });
}

function createGatewayRecorder(gateway, recordEnvelope) {
  return Object.freeze({
    verifyTransaction: (request) => gateway.verifyTransaction(request),
    completeTransaction: (request) => gateway.completeTransaction(request),
    refreshEntitlement: (request) => gateway.refreshEntitlement(request),
    async authorisePackDownload(request) {
      const result = await gateway.authorisePackDownload(request);
      recordEnvelope(result.signedManifestEnvelopeBase64);
      return result;
    },
  });
}

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
  let controller;
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
    connection = await connectionFactory();
    await connection.open();
    await migrate(connection);
    startupSequence.push('database-migrated');

    const packTransfer = runtime.isNativePlatform
      ? createCapacitorPackTransfer({ PackTransfer: PackTransferPlugin })
      : createB3FakePackTransfer(options.fakePackTransferOptions);
    const commerceRepository = createSqliteCommerceRepositories(connection);
    const packRepository = createSqlitePackRepositories(connection);

    const activeEntitlementSet = async () =>
      readonlyEntitlementSet(await commerceRepository.listEntitlements());
    const packReconciler = createPackReconciler({
      packTransfer,
      packRepository,
      activeEntitlementProjection: activeEntitlementSet,
      clock: () => safeTimestampClock(clock),
    });
    await packReconciler.reconcileAtStartup();
    startupSequence.push('packs-reconciled');

    assertBuildAuthority(runtime, gatewayAuthority);
    startupSequence.push('build-authority-selected');
    const store = runtime.isNativePlatform
      ? createCapacitorStore({ Commerce: CommercePlugin })
      : createB3FakeStore(options.fakeStoreOptions);
    const rawGateway = runtime.isNativePlatform
      ? createHttpEntitlementGateway({
          authority: gatewayAuthority,
          fetchImpl: globalThis.fetch.bind(globalThis),
        })
      : createB3FakeGateway(options.fakeGatewayOptions);
    startupSequence.push('commerce-adapters-composed');
    let latestSignedManifestEnvelope = null;
    const gateway = createGatewayRecorder(rawGateway, (value) => {
      latestSignedManifestEnvelope = value;
    });
    const storeKind = runtime.platform === 'ios' ? 'apple' : 'google';
    const attemptRepository = createSqliteCommerceAttemptRepository(
      connection,
      { store: storeKind },
    );
    const purchaseCoordinator = createPurchaseCoordinator({
      store,
      gateway,
      commerceRepository,
      attemptRepository,
      downloadRepository: packRepository,
      clock: () => safeTimestampClock(clock),
      idFactory: () => globalThis.crypto.randomUUID(),
      failureInjector: async () => undefined,
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
      activeEntitlementProjection: activeEntitlement,
      entitlementRepository: commerceRepository,
      currentAppVersion: '0.3.0-b3',
      currentSchemaVersion: 2,
      clock: () => safeTimestampClock(clock),
      chunkSize: B3_DOWNLOAD_CHUNK_BYTES,
    });
    const activationCoordinator = createPackActivationCoordinator({
      packTransfer,
      packRepository,
      manifestVerifier,
      keyring: packKeyring,
      environment: 'sandbox',
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
    const productId = storeKind === 'apple'
      ? 'uk.eugnel.ks2spelling.fullks2'
      : 'full_ks2';
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
        packRepository.getActiveVersion({ packId: FULL_KS2_PACK.packId }),
        packRepository.listInstalledVersions({ packId: FULL_KS2_PACK.packId }),
      ]);
      const entitlement = entitlements.find(
        (entry) => entry.entitlementId === FULL_KS2_PACK.entitlementId,
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
        packId: FULL_KS2_PACK.packId,
        version: FULL_KS2_PACK.version,
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
        const result = await purchaseCoordinator.purchaseFullKs2({ productId });
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
        const operation = (async () => {
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
        void operation.catch(() => undefined);
        return operation;
      });
    }
    startupSequence.push('ready');

    let disposePromise;
    const dispose = () => {
      if (!disposePromise) {
        disposePromise = (async () => {
          const failures = [];
          for (const disposeOwned of [
            () => resumeHandle?.remove?.(),
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
      startupSequence: Object.freeze([...startupSequence]),
      controller,
      dispose,
    });
  } catch (error) {
    await commerceReconciler?.dispose().catch(() => undefined);
    await resumeHandle?.remove?.().catch(() => undefined);
    await lifecycle?.dispose?.().catch(() => undefined);
    if (connection) await closeQuietly(connection);
    throw error;
  }
}
