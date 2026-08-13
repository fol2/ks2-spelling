import gatewayAuthorityJson from '../../config/b3-gateway-authority.json' with { type: 'json' };
import packKeyring from '../../config/pack-signing-public-keys.json' with { type: 'json' };
import {
  assertB3GatewayAuthority,
  findStoreProductByEntitlementId,
} from '../domain/commerce/commerce-contracts.js';
import {
  resolveCommerceProduct,
  resolvePackJobAuthorities,
} from '../domain/commerce/purchase-state.js';
import {
  projectActiveEntitlements,
} from '../domain/commerce/entitlement-access-projection.js';
import { findPackAuthority } from '../domain/packs/pack-registry.js';
import {
  B3_DOWNLOAD_CHUNK_BYTES,
} from '../domain/packs/signed-download-access-contract.js';
import {
  CommercePlugin,
} from '../platform/commerce/capacitor-commerce-plugin.js';
import { createCapacitorStore } from '../platform/commerce/capacitor-store.js';
import {
  createSqliteCommerceAttemptRepository,
} from '../platform/database/sqlite-commerce-attempt-repository.js';
import {
  createSqliteCommerceRepositories,
} from '../platform/database/sqlite-commerce-repositories.js';
import {
  createHttpEntitlementGateway,
} from '../platform/gateway/http-entitlement-gateway.js';
import { createCommerceReconciler } from './commerce-reconciler.js';
import {
  createGatewayRecorder,
  isRecoverableExternalFailure,
  verifyManifest,
} from './commerce-runtime-support.js';
import {
  createDatabaseGatedRepository,
} from './database-gated-repository.js';
import { createDownloadCoordinator } from './download-coordinator.js';
import {
  createPackActivationCoordinator,
} from './pack-activation-coordinator.js';
import { createPackReconciler } from './pack-reconciler.js';
import { createPurchaseCoordinator } from './purchase-coordinator.js';
export {
  createUnavailableProductCommerceWorkflow,
} from './unavailable-product-commerce-workflow.js';

const SHA256 = /^[a-f0-9]{64}$/u;

// The catalogue is the only product authority: every pack the full-ks2
// entitlement delivers resolves here, in catalogue order. Since the E2.7 join
// flip this is the 15 Full-KS2 shard set.
const PRODUCT = resolveCommerceProduct('full-ks2');
const PACKS = resolvePackJobAuthorities(PRODUCT);

function requireMethod(value, method, label) {
  if (!value || typeof value !== 'object' || typeof value[method] !== 'function') {
    throw new TypeError(`${label}.${method} must be a function.`);
  }
}

function requireRuntime(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    value.isNativePlatform !== true ||
    !['ios', 'android'].includes(value.platform)
  ) {
    throw new TypeError('Product commerce requires a native runtime authority.');
  }
  return value;
}

function safeTimestamp(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Product commerce clock is invalid.');
  }
  return value;
}

function transientFailure(error) {
  return isRecoverableExternalFailure(error) ||
    error?.code === 'sqlite_commands_paused';
}

function matchesInstalledAuthority(active, installed, native) {
  return Boolean(
    active &&
    installed &&
    native &&
    installed.state === 'ready' &&
    installed.packId === active.packId &&
    installed.version === active.version &&
    installed.manifestSha256 === active.manifestSha256 &&
    installed.pathToken === active.pathToken &&
    native.packId === active.packId &&
    native.version === active.version &&
    native.manifestSha256 === active.manifestSha256 &&
    native.installedPathToken === active.pathToken &&
    native.activationMarkerSha256 === installed.activationMarkerSha256
  );
}

function projectSinglePackState({ pack, activePack, installed, inventory, jobs }) {
  const installedRow = activePack
    ? installed.find((entry) => entry.version === activePack.version) ?? null
    : null;
  const nativeRows = activePack
    ? inventory.filter((entry) =>
        entry.packId === activePack.packId &&
        entry.version === activePack.version)
    : [];
  if (
    nativeRows.length === 1 &&
    matchesInstalledAuthority(activePack, installedRow, nativeRows[0])
  ) {
    return 'installed';
  }
  const job = jobs.find((entry) =>
    entry.packId === pack.packId &&
    entry.version === pack.version) ?? null;
  if (job?.state === 'queued') return 'queued';
  if (['downloading', 'downloaded', 'extracting'].includes(job?.state)) {
    return 'downloading';
  }
  if (job?.state === 'failed' || job?.state === 'ready' || activePack) {
    return 'failed';
  }
  return 'missing';
}

// One product-level state over N shards: every shard installed reads
// installed; any failed shard dominates in-flight work so the Parent area
// surfaces the retry; otherwise the busiest in-flight state wins.
export function aggregatePackStates(entitlementState, packStates) {
  if (entitlementState === 'revoked') return 'locked';
  if (entitlementState !== 'active') return 'missing';
  if (packStates.length > 0 && packStates.every((state) => state === 'installed')) {
    return 'installed';
  }
  if (packStates.includes('failed')) return 'failed';
  if (packStates.includes('downloading')) return 'downloading';
  if (packStates.includes('queued')) return 'queued';
  return 'missing';
}

export function createProductCommerceWorkflow(options = {}) {
  const runtime = requireRuntime(options.runtime);
  const connection = options.connection;
  const commandGate = options.commandGate;
  const rawPackRepository = options.packRepository;
  const packTransfer = options.packTransfer;
  const clock = options.clock ?? Date.now;
  const idFactory = options.idFactory ??
    (() => globalThis.crypto.randomUUID().toLowerCase());
  requireMethod(connection, 'query', 'connection');
  requireMethod(commandGate, 'run', 'commandGate');
  requireMethod(rawPackRepository, 'listDownloadJobs', 'packRepository');
  requireMethod(packTransfer, 'inventoryInstalledVersions', 'packTransfer');
  if (typeof clock !== 'function' || typeof idFactory !== 'function') {
    throw new TypeError('Product commerce functions are invalid.');
  }

  const authority = assertB3GatewayAuthority(gatewayAuthorityJson);
  const store = options.store ??
    createCapacitorStore({ Commerce: CommercePlugin });
  const fetchImpl = options.fetchImpl ??
    globalThis.fetch?.bind(globalThis);
  const gateway = options.gateway ?? (
    typeof fetchImpl === 'function'
      ? createHttpEntitlementGateway({ authority, fetchImpl })
      : null
  );
  if (gateway === null) {
    throw new TypeError('Product commerce gateway transport is unavailable.');
  }
  const manifestVerifier = options.manifestVerifier ?? verifyManifest;
  if (typeof manifestVerifier !== 'function') {
    throw new TypeError('Product commerce manifest verifier is invalid.');
  }

  const commerceRepository = createDatabaseGatedRepository(
    createSqliteCommerceRepositories(connection),
    commandGate,
  );
  const attemptRepository = createDatabaseGatedRepository(
    createSqliteCommerceAttemptRepository(connection, {
      store: runtime.platform === 'ios' ? 'apple' : 'google',
      entitlementId: PRODUCT.entitlementId,
    }),
    commandGate,
  );
  const packRepository = createDatabaseGatedRepository(
    rawPackRepository,
    commandGate,
  );
  const activeEntitlementProjection = async () =>
    projectActiveEntitlements(await commerceRepository.listEntitlements());
  const packReconciler = createPackReconciler({
    entitlementId: PRODUCT.entitlementId,
    packTransfer,
    packRepository,
    activeEntitlementProjection,
    clock: () => safeTimestamp(clock),
  });

  // Envelope capture is keyed per pack: a single-slot recorder would activate
  // every shard against the last envelope observed in a 15-download sequence.
  const envelopesByPackId = new Map();
  const recordedGateway = createGatewayRecorder(
    gateway,
    (value, authorisation) => {
      if (typeof authorisation?.packId === 'string') {
        envelopesByPackId.set(authorisation.packId, value);
      }
    },
  );
  const purchaseCoordinator = createPurchaseCoordinator({
    entitlementId: PRODUCT.entitlementId,
    store,
    gateway: recordedGateway,
    commerceRepository,
    attemptRepository,
    downloadRepository: packRepository,
    clock: () => safeTimestamp(clock),
    idFactory,
    failureInjector: async () => undefined,
  });
  const activeEntitlement = async () => {
    const entitlements = await commerceRepository.listEntitlements();
    return entitlements.find((entry) =>
      entry.entitlementId === PRODUCT.entitlementId &&
      entry.state === 'active') ?? null;
  };
  const downloadCoordinators = new Map(PACKS.map((pack) => [
    pack.packId,
    createDownloadCoordinator({
      gateway: recordedGateway,
      packTransfer,
      packRepository,
      manifestVerifier,
      keyring: packKeyring,
      activeEntitlementProjection: activeEntitlement,
      entitlementRepository: commerceRepository,
      currentAppVersion: '0.3.0-b3',
      currentSchemaVersion: 2,
      clock: () => safeTimestamp(clock),
      chunkSize: B3_DOWNLOAD_CHUNK_BYTES,
      packAuthority: findPackAuthority(pack.packId),
    }),
  ]));
  const activationCoordinator = createPackActivationCoordinator({
    packTransfer,
    packRepository,
    manifestVerifier,
    keyring: packKeyring,
    environment: 'sandbox',
    clock: () => safeTimestamp(clock),
  });
  let syncFailed = false;
  const commerceReconciler = createCommerceReconciler({
    store,
    coordinator: Object.freeze({
      async handleObservation(observation) {
        try {
          const result = await purchaseCoordinator.handleObservation(observation);
          syncFailed = false;
          return result;
        } catch (error) {
          if (transientFailure(error)) syncFailed = true;
          throw error;
        }
      },
      recover: () => purchaseCoordinator.recover(),
    }),
  });

  const catalogueProduct = findStoreProductByEntitlementId(PRODUCT.entitlementId);
  const productId = runtime.platform === 'ios'
    ? catalogueProduct.appleProductId
    : catalogueProduct.googleProductId;
  let product = null;
  let started = false;
  let disposed = false;
  let operationTail = Promise.resolve();
  let disposePromise = null;

  async function queryApprovedProduct() {
    const products = await store.queryProducts({ productIds: [productId] });
    if (products.length !== 1 || products[0].productId !== productId) {
      throw new TypeError('Approved Full KS2 store product is unavailable.');
    }
    product = products[0];
  }

  async function snapshot() {
    const [entitlements, jobs, inventory] = await Promise.all([
      commerceRepository.listEntitlements(),
      packRepository.listDownloadJobs(),
      packTransfer.inventoryInstalledVersions(),
    ]);
    const entitlement = entitlements.find((entry) =>
      entry.entitlementId === PRODUCT.entitlementId) ?? null;
    const entitlementState = entitlement?.state ?? 'none';
    const packStates = [];
    for (const pack of PACKS) {
      const [activePack, installed] = await Promise.all([
        packRepository.getActiveVersion({ packId: pack.packId }),
        packRepository.listInstalledVersions({ packId: pack.packId }),
      ]);
      const installDigest = activePack
        ? installed.find((entry) => entry.version === activePack.version)
          ?.activationMarkerSha256 ?? null
        : null;
      if (installDigest !== null && !SHA256.test(installDigest)) {
        throw new TypeError('Installed Full KS2 pack authority is invalid.');
      }
      packStates.push(projectSinglePackState({
        pack,
        activePack,
        installed,
        inventory,
        jobs,
      }));
    }
    return Object.freeze({
      displayPrice: product?.displayPrice ?? '',
      entitlementState,
      packState: aggregatePackStates(entitlementState, packStates),
      syncFailed,
    });
  }

  async function absorbTransient(operation) {
    try {
      await operation();
      return false;
    } catch (error) {
      if (!transientFailure(error)) throw error;
      return true;
    }
  }

  async function synchronise(initial) {
    let failed = false;
    failed = await absorbTransient(() =>
      packReconciler.reconcileAtStartup()) || failed;
    failed = await absorbTransient(() =>
      initial
        ? commerceReconciler.start()
        : commerceReconciler.resume()) || failed;
    failed = await absorbTransient(() =>
      purchaseCoordinator.refresh()) || failed;
    failed = await absorbTransient(queryApprovedProduct) || failed;
    syncFailed = failed;
    return snapshot();
  }

  async function runAction(operation) {
    try {
      await operation();
      syncFailed = false;
    } catch (error) {
      if (!transientFailure(error)) throw error;
      syncFailed = true;
    }
    return snapshot();
  }

  function enqueue(operation) {
    if (disposed) {
      return Promise.reject(new Error('product_commerce_workflow_disposed'));
    }
    const result = operationTail.then(operation, operation);
    operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // The N-shard loop is deliberately sequential: each shard is authorised,
  // downloaded and activated before the next starts, and the entitlement row
  // is re-read per shard so a sealed-handle rotation (or a revocation) taken
  // during one shard governs the next. Resume and partial failure ride the
  // durable per-shard job/chunk rows.
  async function install() {
    for (const pack of PACKS) {
      const entitlement = await activeEntitlement();
      if (!entitlement) {
        throw Object.assign(new Error('Full KS2 entitlement is not active.'), {
          code: 'product_commerce_entitlement_inactive',
        });
      }
      await downloadCoordinators.get(pack.packId).queue({
        sealedRefreshHandle: entitlement.sealedRefreshHandle,
      });
      const envelope = envelopesByPackId.get(pack.packId);
      if (typeof envelope !== 'string') {
        throw new Error('Signed Full KS2 manifest was not observed.');
      }
      await activationCoordinator.activate({
        packId: pack.packId,
        version: pack.version,
        signedManifestEnvelope: envelope,
      });
    }
  }

  const workflow = {
    start() {
      return enqueue(async () => {
        const next = await synchronise(!started);
        started = true;
        return next;
      });
    },
    refresh() {
      return enqueue(async () => {
        const next = await synchronise(!started);
        started = true;
        return next;
      });
    },
    purchase() {
      return enqueue(() => runAction(() =>
        purchaseCoordinator.purchase({ productId })));
    },
    restore() {
      return enqueue(() => runAction(() => purchaseCoordinator.restore()));
    },
    download() {
      return enqueue(() => runAction(install));
    },
    recover() {
      return enqueue(async () => {
        const next = await synchronise(!started);
        started = true;
        return next;
      });
    },
    async dispose() {
      if (disposePromise) return disposePromise;
      disposed = true;
      disposePromise = (async () => {
        await operationTail;
        await commerceReconciler.dispose();
      })();
      return disposePromise;
    },
  };
  return Object.freeze(workflow);
}
