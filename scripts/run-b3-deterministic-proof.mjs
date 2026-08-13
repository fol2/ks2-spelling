import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createB3AppServices } from '../src/app/create-b3-app-services.js';
import { createDownloadCoordinator } from '../src/app/download-coordinator.js';
import { createPackActivationCoordinator } from '../src/app/pack-activation-coordinator.js';
import { createPackReconciler } from '../src/app/pack-reconciler.js';
import { createProductCommerceWorkflow } from '../src/app/create-product-commerce-workflow.js';
import { FULL_KS2_PACKS } from '../src/domain/commerce/purchase-state.js';
import { findPackAuthority } from '../src/domain/packs/pack-registry.js';
import {
  B3_DOWNLOAD_CHUNK_BYTES,
} from '../src/domain/packs/signed-download-access-contract.js';
import { createDatabaseCommandGate } from '../src/platform/database/database-command-gate.js';
import { createSqlitePackRepositories } from '../src/platform/database/sqlite-pack-repositories.js';
import { createB3FakeStore } from '../src/platform/fakes/create-b3-fake-store.js';
import { loadStarterSpellingCatalogue } from '../src/domain/spelling/index.js';
import { seedB2Learners } from '../src/platform/database/b2-seed.js';
import { canonicalJson } from '../src/platform/database/canonical-json.js';
import { configureAndMigrateDatabase } from '../src/platform/database/migrate-database.js';
import { createSQLiteSpellingSnapshotStore } from '../src/platform/database/sqlite-spelling-snapshot-store.js';
import {
  ARCHIVE_ETAG,
  ARCHIVE_SHA,
  ENVELOPE_SHA,
  HANDLE,
  NOW,
  authorisation,
  createHarness,
  realManifestVerifier,
} from '../tests/helpers/range-fixture-server.mjs';
import { activationHarness } from '../tests/helpers/pack-activation-harness.mjs';
import { createNodeSqliteConnection } from '../tests/helpers/node-sqlite-connection.mjs';
import { learnerCellDigest } from '../tests/helpers/sqlite-v1-fixture.mjs';
import { EXIT_CODES, isMain, printJson } from './lib/run-command.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const OUTPUT = resolve(ROOT, 'reports/b3');
const FIXED_CLOCK = new Date(NOW - 5 * 60_000).toISOString();
const GROUPS = Object.freeze({
  commerce: Object.freeze([
    'cancelled',
    'offline-retry',
    'pending',
    'purchased',
    'restored',
    'revoked',
    'sealed-handle-replay',
  ]),
  download: Object.freeze([
    'capability-expired',
    'fresh',
    'manifest-rejected',
    'offline-continuity',
    'range-resume',
    'storage-rejected',
  ]),
  activation: Object.freeze([
    'already-installed',
    'crash-before-switch',
    'fresh-install',
    'reconcile-interrupted',
    'rollback-preserved',
  ]),
  // E2.7: the flipped catalogue delivers 15 Full-KS2 shards. These scenarios
  // drive the shipping product commerce workflow against the real registry
  // rows and the real signed shard envelopes (tests/fixtures/packs), with
  // deterministic store/gateway/transfer fakes and durable SQLite state.
  shards: Object.freeze([
    'purchased-all-shards',
    'interrupted-resume',
    'integrity-failure-durable',
    'revoked-locks-shards',
  ]),
});
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PROHIBITED =
  /opaqueProof|purchaseToken|refreshHandle|capabilityUrl|privateKey|serviceAccount|learnerId|nickname|https?:\/\//i;

function proofError(code, message) {
  return Object.assign(new Error(message), { code });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function exactJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readonlyEntitlementSet(...identifiers) {
  const values = new Set(identifiers);
  const result = Object.create(null);
  Object.assign(result, {
    size: values.size,
    has: (value) => values.has(value),
    values: () => values.values(),
    keys: () => values.keys(),
    entries: () => values.entries(),
    forEach: (callback, thisArgument) => values.forEach(callback, thisArgument),
    [Symbol.iterator]: () => values[Symbol.iterator](),
  });
  return Object.freeze(result);
}

async function executeSyntheticLearnerDigestProof(root, authority) {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-b3-synthetic-proof-'));
  const beforePurchase = [];
  const afterFreshInstallReseed = [];
  const cellDigests = [];
  try {
    for (const [index, run] of ['before-purchase', 'fresh-install-reseed'].entries()) {
      const connection = createNodeSqliteConnection(join(directory, `${run}.sqlite`));
      await connection.open();
      try {
        await configureAndMigrateDatabase(connection);
        await seedB2Learners(connection);
        if (run === 'fresh-install-reseed') await seedB2Learners(connection);
        const catalogue = loadStarterSpellingCatalogue();
        const store = createSQLiteSpellingSnapshotStore({
          connection,
          cataloguesById: Object.freeze({ [catalogue.catalogueId]: catalogue }),
        });
        cellDigests.push(await learnerCellDigest(connection));
        for (const learner of authority.learners) {
          const digest = sha256(canonicalJson(await store.read(learner.learnerId)));
          (index === 0 ? beforePurchase : afterFreshInstallReseed).push(digest);
        }
      } finally {
        await connection.close();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const expectedBefore = authority.learners.map(({ beforePurchaseSnapshotSha256 }) =>
    beforePurchaseSnapshotSha256);
  const expectedAfter = authority.learners.map(({ afterFreshInstallReseedSnapshotSha256 }) =>
    afterFreshInstallReseedSnapshotSha256);
  if (
    JSON.stringify(beforePurchase) !== JSON.stringify(expectedBefore) ||
    JSON.stringify(afterFreshInstallReseed) !== JSON.stringify(expectedAfter) ||
    cellDigests.some((digest) => digest !== authority.v1CellTypeAndBytesSha256)
  ) {
    throw proofError('b3_synthetic_digest_drift', 'Synthetic learner digest proof drifted');
  }
  return Object.freeze({
    beforePurchase: Object.freeze(beforePurchase),
    afterFreshInstallReseed: Object.freeze(afterFreshInstallReseed),
    v1CellTypeAndBytesSha256: authority.v1CellTypeAndBytesSha256,
  });
}

function safeResult(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== 2 || value.passed !== true ||
      !SHA256.test(value.stateSha256)) {
    throw proofError('b3_scenario_failed', 'A deterministic B3 scenario did not pass');
  }
  return Object.freeze({ passed: true, stateSha256: value.stateSha256 });
}

function stateResult(value) {
  const failed = value && Object.getPrototypeOf(value) === Object.prototype
    ? Object.entries(value).filter(([, entry]) => typeof entry !== 'boolean' || entry !== true)
      .map(([key]) => key)
    : ['closed-record'];
  if (!value || Reflect.ownKeys(value).length === 0 || failed.length > 0) {
    throw proofError(
      'b3_scenario_invariant_failed',
      `A deterministic scenario invariant failed: ${failed.join(',')}`,
    );
  }
  return safeResult({ passed: true, stateSha256: sha256(JSON.stringify(value)) });
}

function fixedError(code, retryable = true) {
  return Object.assign(new Error('Scripted deterministic failure.'), {
    code,
    retryable,
  });
}

function observation(outcome) {
  const base = {
    store: 'google',
    environment: 'sandbox',
    productId: 'full_ks2',
    outcome,
    transactionRef: outcome === 'purchased' ? 'native-purchased' : `fake-${outcome}-transaction`,
  };
  return ['purchased', 'revoked'].includes(outcome)
    ? { ...base, opaqueProof: outcome === 'purchased'
      ? 'sandbox-purchase-proof'
      : `fake-${outcome}-proof` }
    : base;
}

function identityOutcome(state = 'active') {
  return {
    store: 'google',
    productId: 'full_ks2',
    environment: 'sandbox',
    applicationId: 'uk.eugnel.ks2spelling',
    entitlementId: 'full-ks2',
    state,
    storeTransactionId: 'GPA.1234-5678-9012-34567',
    sealedRefreshHandle: HANDLE,
    refreshHandleVersion: 1,
    workerVersionId: 'worker-test',
    workerScriptAuthoritySha256: 'a'.repeat(64),
  };
}

const PRODUCT = Object.freeze({
  productId: 'full_ks2',
  displayName: 'Full KS2',
  description: 'The complete statutory spelling catalogue.',
  displayPrice: '£4.99',
  currencyCode: 'GBP',
});

function transactionSnapshots(count = 8) {
  return Array.from({ length: count }, () => []);
}

function fullPackTransferOptions() {
  return {
    freeByteOutcomes: [64 * 1024 * 1024],
    downloadOutcomes: [{
      status: 206,
      startByte: 0,
      endByteExclusive: 1_324,
      totalBytes: 1_324,
      bytesWritten: 1_324,
      etag: ARCHIVE_ETAG,
    }],
    inspectOutcomes: [{
      archiveSha256: ARCHIVE_SHA,
      manifestSha256: ENVELOPE_SHA,
      extractedBytes: 1_082,
      fileCount: 2,
      stagingToken: 'staging/b3-sandbox-proof/1.0.0-b3.1',
    }, {
      archiveSha256: ARCHIVE_SHA,
      manifestSha256: ENVELOPE_SHA,
      extractedBytes: 1_082,
      fileCount: 2,
      stagingToken: 'staging/b3-sandbox-proof/1.0.0-b3.1',
    }],
    inventoryOutcomes: [[], []],
    sealOutcomes: [{
      installedPathToken: 'installed/b3-sandbox-proof/1.0.0-b3.1',
      activationMarkerSha256: 'd'.repeat(64),
    }],
  };
}

async function fullAuthorisation() {
  const identity = identityOutcome();
  const signedManifestEnvelopeBase64 = (
    await readFile(resolve(ROOT, 'tests/fixtures/b3-signed-manifest.json'))
  ).toString('base64');
  return {
    ...identity,
    packId: 'b3-sandbox-proof',
    version: '1.0.0-b3.1',
    signedManifestEnvelopeBase64,
    signedEnvelopeSha256: ENVELOPE_SHA,
    objects: [
      { objectKind: 'manifest', sha256: ENVELOPE_SHA, size: 1_135,
        etag: 'c76b2858b8345814279a1c92ae64e365' },
      { objectKind: 'archive', sha256: ARCHIVE_SHA, size: 1_324, etag: ARCHIVE_ETAG },
    ],
    archiveCapability: {
      packId: 'b3-sandbox-proof',
      version: '1.0.0-b3.1',
      archiveName: 'b3-sandbox-proof.zip',
      sha256: ARCHIVE_SHA,
      compressedBytes: 1_324,
      etag: ARCHIVE_ETAG,
      capabilityUrl:
        'https://b3-gateway.eugnel.uk/v1/packs/b3-sandbox-proof/1.0.0-b3.1/b3-sandbox-proof.zip?expires=1783987200&cap=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    },
  };
}

async function createComposedServices({
  context, directory, store = {}, gateway = {}, packTransfer, lifecycleFactory,
}) {
  return createB3AppServices({
    runtime: Object.freeze({ isNativePlatform: false, platform: 'web' }),
    connectionFactory: () => createNodeSqliteConnection(join(directory, 'proof.sqlite')),
    clock: () => Date.parse(context.fixedClock),
    fakeStoreOptions: {
      productOutcomes: [[PRODUCT]],
      transactionOutcomes: transactionSnapshots(),
      ...store,
    },
    fakeGatewayOptions: {
      uuidFactory: context.nextTraceId,
      ...gateway,
    },
    ...(packTransfer ? { fakePackTransferOptions: packTransfer } : {}),
    ...(lifecycleFactory ? { lifecycleFactory } : {}),
  });
}

async function withComposition(context, options, operation) {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-b3-deterministic-commerce-'));
  let services;
  try {
    services = await createComposedServices({ context, directory, ...options });
    return await operation(services, directory);
  } finally {
    await services?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

async function inspectDurableCommerceState(filename) {
  const connection = createNodeSqliteConnection(filename);
  await connection.open();
  try {
    const [journal, entitlements, jobs, schema] = await Promise.all([
      connection.query(
        'SELECT store_transaction_id, opaque_proof FROM transaction_journal ORDER BY journal_id',
      ),
      connection.query(
        'SELECT entitlement_id, sealed_refresh_handle FROM app_entitlements ORDER BY entitlement_id',
      ),
      connection.query(
        'SELECT archive_name, etag, state FROM pack_download_jobs ORDER BY job_id',
      ),
      connection.query("SELECT sql FROM sqlite_schema WHERE type = 'table' ORDER BY name"),
    ]);
    return Object.freeze({
      safeStoreIdsOnly:
        journal.filter(({ store_transaction_id: value }) => value !== null).length === 1 &&
        journal.some(({ store_transaction_id: value }) =>
          value === 'GPA.1234-5678-9012-34567') &&
        journal.every(({ store_transaction_id: value, opaque_proof: proof }) =>
          (value === null || /^GPA\.[0-9]{4}(?:-[0-9]{4}){3}[0-9]$/u.test(value)) &&
          proof === null),
      sealedHandlesOnly:
        entitlements.length === 1 &&
        entitlements[0].entitlement_id === 'full-ks2' &&
        entitlements[0].sealed_refresh_handle === HANDLE &&
        !/https?:|expires=|cap=/iu.test(JSON.stringify({ journal, entitlements, jobs })) &&
        schema.every(({ sql }) => !/capability_url/iu.test(sql ?? '')),
    });
  } finally {
    await connection.close();
  }
}

async function runCommerceScenario(scenario, context) {
  if (scenario === 'cancelled' || scenario === 'pending') {
    return withComposition(
      context,
      { store: { purchaseOutcomes: [observation(scenario)] } },
      async (services) => {
        await services.controller.start();
        const result = await services.controller.buy();
        return stateResult({
          deterministicAdapter: services.adapterKind === 'deterministic-fake',
          observedExpectedOutcome: result.status === scenario,
          noPackAccess: result.packReady === false,
        });
      },
    );
  }
  if (scenario === 'offline-retry') {
    let resume;
    return withComposition(
      context,
      {
        store: {
          productOutcomes: [fixedError('STORE_NATIVE_FAILURE'), [PRODUCT]],
          transactionOutcomes: transactionSnapshots(12),
        },
        lifecycleFactory: () => Object.freeze({
          onResume(listener) {
            resume = listener;
            return Object.freeze({ async remove() {} });
          },
          async dispose() {},
        }),
      },
      async (services) => {
        const failed = await services.controller.start();
        await resume();
        const retried = services.controller.getState();
        return stateResult({
          calmFailure: failed.status === 'failed',
          deterministicRetryReady: retried.status === 'ready',
          priceRecovered: retried.displayPrice === '£4.99',
        });
      },
    );
  }
  if (scenario === 'purchased') {
    return withComposition(
      context,
      {
        store: { purchaseOutcomes: [observation('purchased')] },
        gateway: {
          verifyOutcomes: [identityOutcome()],
          completeOutcomes: [identityOutcome()],
          authoriseOutcomes: [await fullAuthorisation(), await fullAuthorisation()],
        },
        packTransfer: fullPackTransferOptions(),
      },
      async (services, directory) => {
        const transitions = [];
        services.controller.subscribe((state) => transitions.push(state.status));
        await services.controller.start();
        const result = await services.controller.buy();
        if (result.status !== 'installed') {
          throw proofError(
            'b3_purchased_flow_failed',
            `Composed purchase ended ${result.status}; transitions=${transitions.join(',')}`,
          );
        }
        const durable = await inspectDurableCommerceState(join(directory, 'proof.sqlite'));
        context.evidence.safeStoreIdsOnly = durable.safeStoreIdsOnly;
        context.evidence.sealedHandlesOnly = durable.sealedHandlesOnly;
        return stateResult({
          orderedCoordinatorFlow:
            transitions.join(',') === 'ready,purchasing,entitled,downloading,installed',
          installed: result.status === 'installed',
          packReady: result.packReady === true,
          installDigestBound: result.digests.install === 'd'.repeat(64),
          safeStoreIdPersisted: durable.safeStoreIdsOnly,
          sealedHandlePersistedWithoutCapability: durable.sealedHandlesOnly,
        });
      },
    );
  }
  if (scenario === 'restored') {
    return withComposition(
      context,
      {
        store: { restoreOutcomes: [[observation('purchased')]] },
        gateway: {
          verifyOutcomes: [identityOutcome()],
          completeOutcomes: [identityOutcome()],
          authoriseOutcomes: [await fullAuthorisation(), await fullAuthorisation()],
        },
        packTransfer: fullPackTransferOptions(),
      },
      async (services) => {
        await services.controller.start();
        const result = await services.controller.restore();
        const redownloaded = await services.controller.redownload();
        return stateResult({
          restoredEntitlement: result.status === 'restored',
          explicitDownloadStillRequired: result.packReady === false,
          redownloadInstalled: redownloaded.status === 'installed',
          packReadyAfterRedownload: redownloaded.packReady === true,
        });
      },
    );
  }
  if (scenario === 'revoked') {
    return withComposition(
      context,
      {
        store: { updateOutcomes: [observation('revoked')] },
        gateway: { verifyOutcomes: [identityOutcome('revoked')] },
      },
      async (services) => {
        await services.controller.start();
        const result = await services.controller.buy();
        return stateResult({ revoked: result.status === 'revoked', accessLocked: result.packReady === false });
      },
    );
  }
  if (scenario === 'sealed-handle-replay') {
    const directory = await mkdtemp(join(tmpdir(), 'ks2-b3-deterministic-replay-'));
    let first;
    let second;
    try {
      first = await createComposedServices({
        context,
        directory,
        store: { purchaseOutcomes: [observation('purchased')] },
        gateway: {
          verifyOutcomes: [identityOutcome()],
          completeOutcomes: [identityOutcome()],
          authoriseOutcomes: [await fullAuthorisation(), await fullAuthorisation()],
        },
        packTransfer: fullPackTransferOptions(),
      });
      await first.controller.start();
      const installed = await first.controller.buy();
      await first.dispose();
      first = null;
      second = await createComposedServices({
        context,
        directory,
        gateway: { refreshOutcomes: [identityOutcome()] },
        store: { productOutcomes: [fixedError('STORE_NATIVE_FAILURE')] },
        packTransfer: {
          inventoryOutcomes: [[{
            packId: 'b3-sandbox-proof',
            version: '1.0.0-b3.1',
            manifestSha256: ENVELOPE_SHA,
            installedPathToken: 'installed/b3-sandbox-proof/1.0.0-b3.1',
            activationMarkerSha256: 'd'.repeat(64),
          }]],
        },
      });
      const offline = await second.controller.start();
      context.evidence.offlineInstalledPackReady = offline.packReady === true;
      return stateResult({
        initialInstallReady: installed.packReady === true,
        sealedHandleReplayedAfterReopen: offline.packReady === true,
        offlineShellCalm: offline.status === 'failed',
      });
    } finally {
      await first?.dispose();
      await second?.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  }
  throw proofError('b3_unknown_scenario', `Unknown commerce scenario: ${scenario}`);
}

async function runDownloadScenario(scenario) {
  if (scenario === 'fresh') {
    const harness = createHarness();
    const result = await createDownloadCoordinator(harness.dependencies).queue({
      sealedRefreshHandle: HANDLE,
    });
    return stateResult({
      downloaded: result.state === 'downloaded',
      exactArchive: result.job.archiveSha256 === ARCHIVE_SHA,
      noDurableNetworkAuthority: !/https?:|expires|b3rh1/iu.test(JSON.stringify(harness.memory.snapshot())),
    });
  }
  if (scenario === 'capability-expired') {
    const harness = createHarness({
      outcomes: [
        fixedError('PACK_CAPABILITY_EXPIRED'),
        { status: 206, startByte: 0, endByteExclusive: 1_324, totalBytes: 1_324,
          bytesWritten: 1_324, etag: ARCHIVE_ETAG },
      ],
      authoriseOutcomes: [authorisation(), authorisation()],
    });
    const result = await createDownloadCoordinator(harness.dependencies).queue({
      sealedRefreshHandle: HANDLE,
    });
    return stateResult({ renewedOnce: harness.calls.gateway.length === 2, downloaded: result.state === 'downloaded' });
  }
  if (scenario === 'range-resume') {
    const harness = createHarness({
      initialJob: {
        jobId: 'b3-sandbox-proof.1.0.0-b3.1', packId: 'b3-sandbox-proof',
        version: '1.0.0-b3.1', manifestSha256: ENVELOPE_SHA,
        archiveName: 'b3-sandbox-proof.zip', archiveSha256: ARCHIVE_SHA,
        expectedBytes: 1_324, completedBytes: 1_000, etag: ARCHIVE_ETAG,
        state: 'downloading', updatedAt: NOW - 10,
      },
      initialChunks: [
        { jobId: 'b3-sandbox-proof.1.0.0-b3.1', startByte: 0,
          endByteExclusive: 1_000, state: 'complete', chunkSha256: ARCHIVE_SHA },
        { jobId: 'b3-sandbox-proof.1.0.0-b3.1', startByte: 1_000,
          endByteExclusive: 1_324, state: 'pending', chunkSha256: null },
      ],
      outcomes: [{ status: 206, startByte: 1_000, endByteExclusive: 1_324,
        totalBytes: 1_324, bytesWritten: 324, etag: ARCHIVE_ETAG }],
    });
    const coordinator = createDownloadCoordinator(harness.dependencies);
    const result = await coordinator.resume({ sealedRefreshHandle: HANDLE });
    return stateResult({
      resumed: result.state === 'downloaded',
      exactNonZeroRange: harness.calls.downloads.length === 1 &&
        harness.calls.downloads[0].startByte === 1_000 &&
        harness.calls.downloads[0].endByteExclusive === 1_324 &&
        harness.calls.downloads[0].truncate === false,
    });
  }
  if (scenario === 'manifest-rejected') {
    const harness = createHarness({
      manifestVerifier: async () => { throw fixedError('PACK_MANIFEST_REJECTED', false); },
    });
    let rejected = false;
    try {
      await createDownloadCoordinator(harness.dependencies).queue({ sealedRefreshHandle: HANDLE });
    } catch (error) {
      rejected = error.code === 'PACK_MANIFEST_REJECTED';
    }
    return stateResult({ rejectedBeforeMutation: rejected && harness.memory.snapshot().job === null });
  }
  if (scenario === 'offline-continuity') {
    const harness = createHarness({ authoriseOutcomes: [fixedError('GATEWAY_OFFLINE')] });
    let calmFailure = false;
    try {
      await createDownloadCoordinator(harness.dependencies).queue({ sealedRefreshHandle: HANDLE });
    } catch (error) {
      calmFailure = error.code === 'GATEWAY_OFFLINE';
    }
    return stateResult({ calmFailure, existingInstalledPackUntouched: harness.memory.snapshot().job === null });
  }
  if (scenario === 'storage-rejected') {
    const harness = createHarness({ freeBytes: 0 });
    let rejected = false;
    try {
      await createDownloadCoordinator(harness.dependencies).queue({ sealedRefreshHandle: HANDLE });
    } catch (error) {
      rejected = error.code === 'DOWNLOAD_STORAGE_INSUFFICIENT';
    }
    return stateResult({ rejected, noArchiveWrite: harness.calls.downloads.length === 0 });
  }
  throw proofError('b3_unknown_scenario', `Unknown download scenario: ${scenario}`);
}

async function activateWithOneCrash() {
  let crash = true;
  const harness = activationHarness({
    crashInjector(name) {
      if (crash && name === 'beforeDatabaseRegisterAndFlip') {
        crash = false;
        throw fixedError('SIMULATED_PROCESS_CRASH', false);
      }
    },
  });
  const coordinator = createPackActivationCoordinator(harness.dependencies);
  let crashed = false;
  try {
    await coordinator.activate(harness.input);
  } catch (error) {
    crashed = error.code === 'SIMULATED_PROCESS_CRASH';
  }
  return { harness, coordinator, crashed };
}

async function runActivationScenario(scenario) {
  if (scenario === 'fresh-install') {
    const harness = activationHarness();
    const result = await createPackActivationCoordinator(harness.dependencies).activate(harness.input);
    return stateResult({ ready: result.state === 'ready', activeSwitched: result.active.version === '1.0.0-b3.1' });
  }
  if (scenario === 'already-installed') {
    const harness = activationHarness();
    const coordinator = createPackActivationCoordinator(harness.dependencies);
    await coordinator.activate(harness.input);
    const result = await coordinator.activate(harness.input);
    return stateResult({ ready: result.state === 'ready', singleInstalledRow: harness.snapshot().installedRows.length === 1 });
  }
  if (scenario === 'crash-before-switch') {
    const { harness, crashed } = await activateWithOneCrash();
    const snapshot = harness.snapshot();
    return stateResult({ crashed, previousActivePreserved: snapshot.active.version === '0.9.0', sealedInventoryPresent: snapshot.inventory.length === 1 });
  }
  if (scenario === 'reconcile-interrupted') {
    const { harness, crashed } = await activateWithOneCrash();
    const repository = {
      ...harness.dependencies.packRepository,
      async listDownloadJobs() { return [harness.snapshot().job]; },
      async deleteDownloadJob() {
        throw proofError('b3_unexpected_deletion', 'Startup reconciliation deleted a b3 job');
      },
      async retireInstalledVersion() {
        throw proofError('b3_unexpected_retirement', 'Startup reconciliation retired a pack');
      },
    };
    const transfer = {
      ...harness.dependencies.packTransfer,
      async removeOwnedTemporaryState() {
        throw proofError('b3_unexpected_cleanup', 'Startup reconciliation removed a sealed pack');
      },
    };
    const result = await createPackReconciler({
      entitlementId: 'full-ks2',
      // The b3 proof lane pins itself to the registry's b3 row now that the
      // catalogue join delivers the 15 shards.
      packIds: ['b3-sandbox-proof'],
      packTransfer: transfer,
      packRepository: repository,
      activeEntitlementProjection: async () => readonlyEntitlementSet('full-ks2'),
      clock: () => new Date(NOW),
    }).reconcileAtStartup();
    const snapshot = harness.snapshot();
    return stateResult({
      crashed,
      recovered: result.recovered.includes('b3-sandbox-proof.1.0.0-b3.1'),
      ready: result.readiness.some(({ version, ready }) =>
        version === '1.0.0-b3.1' && ready === true),
      activeSwitched: snapshot.active.version === '1.0.0-b3.1',
      jobReady: snapshot.job.state === 'ready',
    });
  }
  if (scenario === 'rollback-preserved') {
    const harness = activationHarness({ entitlementActive: false });
    const result = await createPackActivationCoordinator(harness.dependencies).activate(harness.input);
    return stateResult({ accessLocked: result.state === 'access-locked', previousActivePreserved: result.active.version === '0.9.0' });
  }
  throw proofError('b3_unknown_scenario', `Unknown activation scenario: ${scenario}`);
}

// ---------------------------------------------------------------------------
// E2.7 shard scenarios: the shipping N-shard commerce workflow over the real
// catalogue join, real registry rows and the real signed shard envelopes.

const SHARD_FIXTURES = new Map();

async function shardFixture(packId) {
  if (!SHARD_FIXTURES.has(packId)) {
    const bytes = await readFile(resolve(
      ROOT,
      `tests/fixtures/packs/full-ks2-shards/${packId}.signed-manifest.json`,
    ));
    const envelope = JSON.parse(bytes.toString('utf8'));
    const manifest = JSON.parse(
      Buffer.from(envelope.canonicalManifestBase64, 'base64').toString('utf8'),
    );
    SHARD_FIXTURES.set(packId, Object.freeze({
      base64: bytes.toString('base64'),
      extractedBytes: manifest.files.reduce((total, file) => total + file.bytes, 0),
      fileCount: manifest.files.length,
    }));
  }
  return SHARD_FIXTURES.get(packId);
}

function shardChunkCount(packId) {
  return Math.ceil(findPackAuthority(packId).archiveBytes / B3_DOWNLOAD_CHUNK_BYTES);
}

const TOTAL_SHARD_CHUNKS = FULL_KS2_PACKS
  .reduce((total, pack) => total + shardChunkCount(pack.packId), 0);

function createShardGateway(context, {
  verifyState = 'active',
  authoriseFailure = () => null,
  log,
}) {
  const identityFor = (state) => ({
    ...identityOutcome(state),
    traceId: context.nextTraceId(),
  });
  return {
    async verifyTransaction() { return identityFor(verifyState); },
    async completeTransaction() { return identityFor(verifyState); },
    async refreshEntitlement() { return identityFor(verifyState); },
    async authorisePackDownload({ packId, version }) {
      log.authorised.push(packId);
      const failure = authoriseFailure(packId, log);
      if (failure) throw failure;
      const row = findPackAuthority(packId);
      if (version !== row.version) throw fixedError('PACK_NOT_FOUND', false);
      const fixture = await shardFixture(packId);
      return {
        ...identityFor('active'),
        packId,
        version: row.version,
        signedManifestEnvelopeBase64: fixture.base64,
        signedEnvelopeSha256: row.manifestSha256,
        objects: [
          { objectKind: 'manifest', sha256: row.manifestSha256,
            size: row.manifestBytes, etag: row.manifestEtag },
          { objectKind: 'archive', sha256: row.archiveSha256,
            size: row.archiveBytes, etag: row.archiveEtag },
        ],
        archiveCapability: {
          packId,
          version: row.version,
          archiveName: row.archiveName,
          sha256: row.archiveSha256,
          compressedBytes: row.archiveBytes,
          etag: row.archiveEtag,
          capabilityUrl: `https://b3-gateway.eugnel.uk/v1/packs/${packId}/${row.version}/${row.archiveName}?expires=${Math.floor(NOW / 1_000) + 600}&cap=${'A'.repeat(43)}`,
        },
      };
    },
  };
}

function createShardPackTransfer(log, {
  downloadFailure = () => null,
  inspectOverride = () => null,
  initialInstalled = [],
} = {}) {
  const installed = structuredClone(initialInstalled);
  return {
    installedSnapshot: () => structuredClone(installed),
    port: {
      async getFreeBytes() { return 1_073_741_824; },
      async downloadRange(request) {
        log.downloads.push(`${request.packId}:${request.startByte}`);
        const failure = downloadFailure(request, log);
        if (failure) throw failure;
        const row = findPackAuthority(request.packId);
        return {
          status: 206,
          startByte: request.startByte,
          endByteExclusive: request.endByteExclusive,
          totalBytes: row.archiveBytes,
          bytesWritten: request.endByteExclusive - request.startByte,
          etag: row.archiveEtag,
        };
      },
      async inspectAndExtract(request) {
        const override = inspectOverride(request, log);
        if (override) return override;
        const row = findPackAuthority(request.packId);
        const fixture = await shardFixture(request.packId);
        return {
          archiveSha256: row.archiveSha256,
          manifestSha256: row.manifestSha256,
          extractedBytes: fixture.extractedBytes,
          fileCount: fixture.fileCount,
          stagingToken: `staging/${request.packId}/${row.version}`,
        };
      },
      async sealAndInstall({ packId, version, manifestSha256 }) {
        const record = {
          packId,
          version,
          manifestSha256,
          installedPathToken: `installed/${packId}/${version}`,
          activationMarkerSha256: sha256(`activation-marker:${packId}`),
        };
        installed.push(record);
        return {
          installedPathToken: record.installedPathToken,
          activationMarkerSha256: record.activationMarkerSha256,
        };
      },
      async inventoryInstalledVersions() { return structuredClone(installed); },
      async removeOwnedTemporaryState(request) {
        log.removals.push(request.packId);
        return { removed: true };
      },
    },
  };
}

async function withShardComposition(context, {
  directory,
  store = {},
  gateway = {},
  transfer = {},
}, operation) {
  const connection = createNodeSqliteConnection(join(directory, 'shards.sqlite'));
  await connection.open();
  await configureAndMigrateDatabase(connection);
  const log = { authorised: [], downloads: [], removals: [] };
  const packTransfer = createShardPackTransfer(log, transfer);
  const packRepository = createSqlitePackRepositories(connection);
  let attemptSequence = 0;
  const workflow = createProductCommerceWorkflow({
    runtime: Object.freeze({ isNativePlatform: true, platform: 'android' }),
    connection,
    commandGate: createDatabaseCommandGate(),
    packRepository,
    packTransfer: packTransfer.port,
    store: createB3FakeStore({
      productOutcomes: Array.from({ length: 8 }, () => [PRODUCT]),
      transactionOutcomes: transactionSnapshots(12),
      ...store,
    }),
    gateway: createShardGateway(context, { log, ...gateway }),
    manifestVerifier: realManifestVerifier,
    clock: () => NOW,
    idFactory: () => {
      attemptSequence += 1;
      return `shard-proof-attempt-${attemptSequence}`;
    },
  });
  try {
    return await operation({ workflow, packRepository, packTransfer, log });
  } finally {
    await workflow.dispose();
    await connection.close();
  }
}

async function shardDurableState(packRepository) {
  const jobs = await packRepository.listDownloadJobs();
  const actives = [];
  for (const pack of FULL_KS2_PACKS) {
    actives.push(await packRepository.getActiveVersion({ packId: pack.packId }));
  }
  return { jobs, actives };
}

function downloadsPerShard(log) {
  const counts = new Map(FULL_KS2_PACKS.map((pack) => [pack.packId, 0]));
  for (const entry of log.downloads) {
    const packId = entry.slice(0, entry.indexOf(':'));
    counts.set(packId, (counts.get(packId) ?? 0) + 1);
  }
  return counts;
}

function sequentialByCatalogueOrder(entries) {
  const order = FULL_KS2_PACKS.map((pack) => pack.packId);
  let highestStarted = -1;
  for (const packId of entries) {
    const index = order.indexOf(packId);
    if (index === -1) return false;
    if (index < highestStarted) return false;
    highestStarted = Math.max(highestStarted, index);
  }
  return highestStarted === order.length - 1;
}

async function runShardScenario(scenario, context) {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-e27-shard-proof-'));
  try {
    if (scenario === 'purchased-all-shards') {
      return await withShardComposition(context, {
        directory,
        store: { purchaseOutcomes: [observation('purchased')] },
      }, async ({ workflow, packRepository, log }) => {
        const started = await workflow.start();
        const purchased = await workflow.purchase();
        const afterPurchase = await shardDurableState(packRepository);
        const purchaseAuthorisations = [...log.authorised];
        const installed = await workflow.download();
        const afterInstall = await shardDurableState(packRepository);
        return stateResult({
          startWithoutEntitlementHasNoPacks:
            started.entitlementState === 'none' && started.packState === 'missing',
          purchaseCreatesEveryShardJob:
            purchased.entitlementState === 'active' &&
            purchased.packState === 'queued' &&
            afterPurchase.jobs.length === 15 &&
            afterPurchase.jobs.every((job) => job.state === 'queued'),
          purchaseAuthorisedEveryShardInCatalogueOrder:
            purchaseAuthorisations.length === 15 &&
            purchaseAuthorisations.join(',') ===
              FULL_KS2_PACKS.map((pack) => pack.packId).join(','),
          installedEveryShard:
            installed.packState === 'installed' &&
            installed.syncFailed === false &&
            afterInstall.jobs.length === 15 &&
            afterInstall.jobs.every((job) => job.state === 'ready') &&
            afterInstall.actives.every((active, index) =>
              active?.packId === FULL_KS2_PACKS[index].packId &&
              active.version === FULL_KS2_PACKS[index].version),
          sequentialShardLoop: sequentialByCatalogueOrder(
            log.downloads.map((entry) => entry.slice(0, entry.indexOf(':'))),
          ),
          exactChunkLedger: log.downloads.length === TOTAL_SHARD_CHUNKS,
        });
      });
    }
    if (scenario === 'interrupted-resume') {
      let failed = false;
      return await withShardComposition(context, {
        directory,
        store: { purchaseOutcomes: [observation('purchased')] },
        transfer: {
          downloadFailure: (request) => {
            if (request.packId === 'full-ks2-shard-04' && !failed) {
              failed = true;
              return fixedError('GATEWAY_OFFLINE');
            }
            return null;
          },
        },
      }, async ({ workflow, log }) => {
        await workflow.start();
        await workflow.purchase();
        const interrupted = await workflow.download();
        const downloadsAtInterruption = downloadsPerShard(log);
        const resumed = await workflow.download();
        const downloadsAfterResume = downloadsPerShard(log);
        const untouchedEarlyShards = ['full-ks2-shard-01', 'full-ks2-shard-02', 'full-ks2-shard-03']
          .every((packId) =>
            downloadsAfterResume.get(packId) === downloadsAtInterruption.get(packId) &&
            downloadsAfterResume.get(packId) === shardChunkCount(packId));
        return stateResult({
          interruptionAbsorbedCalmly:
            interrupted.syncFailed === true && interrupted.packState === 'downloading',
          completedShardsNotRefetched: untouchedEarlyShards,
          interruptedShardResumedItsOwnChunks:
            downloadsAfterResume.get('full-ks2-shard-04') ===
              shardChunkCount('full-ks2-shard-04') + 1,
          resumedToFullInstall:
            resumed.packState === 'installed' && resumed.syncFailed === false,
        });
      });
    }
    if (scenario === 'integrity-failure-durable') {
      let corrupted = false;
      return await withShardComposition(context, {
        directory,
        store: { purchaseOutcomes: [observation('purchased')] },
        transfer: {
          inspectOverride: (request) => {
            if (request.packId === 'full-ks2-shard-09' && !corrupted) {
              corrupted = true;
              return {
                archiveSha256: 'e'.repeat(64),
                manifestSha256: 'e'.repeat(64),
                extractedBytes: 1,
                fileCount: 1,
                stagingToken: `staging/${request.packId}/mismatch`,
              };
            }
            return null;
          },
        },
      }, async ({ workflow, packRepository, log }) => {
        await workflow.start();
        await workflow.purchase();
        let integrityCode = null;
        try {
          await workflow.download();
        } catch (error) {
          integrityCode = error?.code ?? null;
        }
        const durable = await shardDurableState(packRepository);
        // Pinned first: the two Array.every invariants below hold vacuously if
        // the rows vanished instead of surviving the failure.
        const everyShardStillHasItsJob = durable.jobs.length === 15;
        const failedJob = durable.jobs.find((job) => job.packId === 'full-ks2-shard-09');
        const earlierReady = durable.jobs
          .filter((job) => job.packId < 'full-ks2-shard-09')
          .every((job) => job.state === 'ready');
        const recovered = await workflow.download();
        return stateResult({
          integrityMismatchFailsClosed: integrityCode === 'DOWNLOAD_FINAL_INTEGRITY_MISMATCH',
          everyShardStillHasItsJob,
          earlierShardsStayReady: earlierReady,
          failedShardLeftDurableAndResumable:
            failedJob?.state === 'downloading' && failedJob.completedBytes === 0 &&
            log.removals.includes('full-ks2-shard-09'),
          laterShardsStayQueued: durable.jobs
            .filter((job) => job.packId > 'full-ks2-shard-09')
            .every((job) => job.state === 'queued'),
          recoveredToFullInstall:
            recovered.packState === 'installed' && recovered.syncFailed === false,
        });
      });
    }
    if (scenario === 'revoked-locks-shards') {
      let installedInventory = null;
      await withShardComposition(context, {
        directory,
        store: { purchaseOutcomes: [observation('purchased')] },
      }, async ({ workflow, packTransfer }) => {
        await workflow.start();
        await workflow.purchase();
        const installed = await workflow.download();
        if (installed.packState !== 'installed') {
          throw proofError('b3_shard_revocation_setup_failed', 'Shard install before revocation failed');
        }
        installedInventory = packTransfer.installedSnapshot();
      });
      return await withShardComposition(context, {
        directory,
        store: { updateOutcomes: [observation('revoked')] },
        gateway: { verifyState: 'revoked' },
        transfer: { initialInstalled: installedInventory },
      }, async ({ workflow, packRepository }) => {
        await workflow.start();
        const settled = await workflow.refresh();
        // packState 'locked' follows from entitlementState 'revoked' by
        // construction, so it proves nothing on its own. The per-shard
        // evidence is the durable store itself: every one of the 15 shards
        // keeps its installed bytes and its active pointer, and every one of
        // them is refused re-activation while the entitlement is revoked —
        // that refusal is the database boundary a locked device relies on.
        let shardsHoldingBytes = 0;
        let shardsRefusingReactivation = 0;
        for (const pack of FULL_KS2_PACKS) {
          const [installedRows, active] = await Promise.all([
            packRepository.listInstalledVersions({ packId: pack.packId }),
            packRepository.getActiveVersion({ packId: pack.packId }),
          ]);
          const installed = installedRows.find((row) => row.version === pack.version);
          if (!installed || active?.version !== pack.version) continue;
          shardsHoldingBytes += 1;
          try {
            await packRepository.registerAndFlipActiveVersion({
              requiredEntitlementId: 'full-ks2',
              installedVersion: installed,
              activeVersion: {
                packId: pack.packId,
                version: pack.version,
                manifestSha256: installed.manifestSha256,
                pathToken: installed.pathToken,
                activatedAt: NOW,
              },
            });
          } catch (error) {
            if (error?.code === 'sqlite_pack_entitlement_inactive') {
              shardsRefusingReactivation += 1;
            }
          }
        }
        return stateResult({
          revocationLocksEveryShard:
            settled.entitlementState === 'revoked' && settled.packState === 'locked',
          everyShardKeepsItsInstalledBytes: shardsHoldingBytes === 15,
          everyShardRefusedReactivationWhileRevoked: shardsRefusingReactivation === 15,
        });
      });
    }
    throw proofError('b3_unknown_scenario', `Unknown shard scenario: ${scenario}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function runB3DeterministicScenario({ group, scenario, context }) {
  if (group === 'commerce') return runCommerceScenario(scenario, context);
  if (group === 'download') return runDownloadScenario(scenario);
  if (group === 'activation') return runActivationScenario(scenario);
  if (group === 'shards') return runShardScenario(scenario, context);
  throw proofError('b3_unknown_scenario_group', `Unknown deterministic group: ${group}`);
}

export async function buildB3DeterministicProof({
  root = ROOT,
  outputDirectory = OUTPUT,
  scenarioRunner = runB3DeterministicScenario,
} = {}) {
  if (typeof scenarioRunner !== 'function') throw new TypeError('scenarioRunner must be a function');
  const traceIds = [];
  let traceIndex = 0;
  const executionEvidence = {
    offlineInstalledPackReady: false,
    safeStoreIdsOnly: false,
    sealedHandlesOnly: false,
  };
  const context = Object.freeze({
    fixedClock: FIXED_CLOCK,
    evidence: executionEvidence,
    nextTraceId() {
      traceIndex += 1;
      const traceId = `00000000-0000-4000-8000-${String(traceIndex).padStart(12, '0')}`;
      traceIds.push(traceId);
      return traceId;
    },
  });
  const scenarioMatrix = {};
  for (const [group, scenarios] of Object.entries(GROUPS)) {
    scenarioMatrix[group] = [];
    for (const scenario of scenarios) {
      const result = safeResult(await scenarioRunner({ group, scenario, context }));
      scenarioMatrix[group].push({ scenario, ...result });
    }
  }
  const traceIdValid = traceIds.length > 0 && traceIds.every((value) => UUID_V4.test(value));
  const traceIdsUnique = new Set(traceIds).size === traceIds.length;
  if (!traceIdValid || !traceIdsUnique) {
    throw proofError('b3_trace_id_invalid', 'Deterministic trace ID proof failed');
  }
  const [appSource, storeProductSource, repositorySource, manifest, archiveAuthority,
    syntheticAuthorityBytes, storeKitTranscript] = await Promise.all([
    readFile(resolve(root, 'src/app/App.jsx'), 'utf8'),
    readFile(resolve(root, 'config/store-products.json'), 'utf8'),
    readFile(resolve(root, 'src/platform/database/sqlite-commerce-repositories.js'), 'utf8'),
    readFile(resolve(root, 'tests/fixtures/b3-signed-manifest.json')),
    readFile(resolve(root, 'config/b3-pack-object-authority.json')),
    readFile(resolve(root, 'config/b3-synthetic-learners.json')),
    readFile(resolve(root, 'tests/fixtures/storekit-bridge-transcript.json'), 'utf8').then(JSON.parse),
  ]);
  scenarioMatrix.privacyContinuity = {
    parentOnlyDiagnostic: /Parent-only diagnostic/.test(appSource),
    childSalesCopy: /(?:Buy|purchase|price).*(?:child|monster|camp)/iu.test(appSource),
    safeStoreIdsOnly: executionEvidence.safeStoreIdsOnly &&
      storeProductSource.includes('uk.eugnel.ks2spelling.fullks2') &&
      storeProductSource.includes('full_ks2'),
    sealedHandlesOnly: executionEvidence.sealedHandlesOnly &&
      repositorySource.includes('sealed_refresh_handle') &&
      !repositorySource.includes('capability_url'),
    offlineInstalledPackReady: executionEvidence.offlineInstalledPackReady,
  };
  if (
    scenarioMatrix.privacyContinuity.parentOnlyDiagnostic !== true ||
    scenarioMatrix.privacyContinuity.childSalesCopy !== false ||
    scenarioMatrix.privacyContinuity.safeStoreIdsOnly !== true ||
    scenarioMatrix.privacyContinuity.sealedHandlesOnly !== true ||
    scenarioMatrix.privacyContinuity.offlineInstalledPackReady !== true
  ) {
    throw proofError('b3_privacy_continuity_failed', 'B3 privacy continuity evidence failed');
  }
  const syntheticAuthority = JSON.parse(syntheticAuthorityBytes);
  const syntheticProof = await executeSyntheticLearnerDigestProof(root, syntheticAuthority);
  const report = {
    schemaVersion: 1,
    status: 'pass',
    evidenceBoundary: {
      deterministicFakes: true,
      liveStoreProof: false,
      liveCloudProof: false,
      physicalDeviceProof: false,
    },
    clock: FIXED_CLOCK,
    traceIdValid,
    traceIdsUnique,
    scenarioMatrix,
    nonLiveStoreKit: {
      evidenceKind: storeKitTranscript.evidenceKind,
      physicalSandbox: storeKitTranscript.physicalSandbox,
      liveStore: storeKitTranscript.liveStore,
      cases: storeKitTranscript.cases.map(({ name, initialOutcome, finalOutcome }) => ({
        name, initialOutcome, finalOutcome,
      })),
    },
    syntheticDigests: {
      signedManifestSha256: sha256(manifest),
      packObjectAuthoritySha256: sha256(archiveAuthority),
      beforePurchase: syntheticProof.beforePurchase,
      afterFreshInstallReseed: syntheticProof.afterFreshInstallReseed,
      v1CellTypeAndBytesSha256: syntheticProof.v1CellTypeAndBytesSha256,
      syntheticLearnerAuthoritySha256: sha256(syntheticAuthorityBytes),
      // The shard scenarios are only as frozen as the authority set they run
      // against: this pins the 15 resolved registry rows in catalogue order,
      // so a drifted sha256, byte count, etag or ordering fails the proof
      // rather than quietly changing what the scenarios proved.
      shardAuthoritySha256: sha256(JSON.stringify(
        FULL_KS2_PACKS.map((pack) => findPackAuthority(pack.packId)),
      )),
      scenarioMatrixSha256: sha256(JSON.stringify(scenarioMatrix)),
    },
  };
  const reportJson = exactJson(report);
  if (PROHIBITED.test(reportJson)) {
    throw proofError('b3_deterministic_privacy_violation', 'Deterministic report contains prohibited data');
  }
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(resolve(outputDirectory, 'deterministic-proof.json'), reportJson, 'utf8');
  return Object.freeze({ reportJson, reportSha256: sha256(reportJson) });
}

export async function main() {
  try {
    const first = await buildB3DeterministicProof();
    const second = await buildB3DeterministicProof();
    if (first.reportJson !== second.reportJson) {
      throw proofError('b3_deterministic_bytes_drift', 'Repeated deterministic reports differ');
    }
    printJson({
      ok: true,
      evidenceBoundary: 'deterministic-fakes-not-live-proof',
      reportSha256: first.reportSha256,
      repeatedReportSha256: second.reportSha256,
      byteIdentical: true,
    });
    return EXIT_CODES.success;
  } catch (error) {
    printJson({ ok: false, code: error.code ?? 'b3_deterministic_proof_failed', message: error.message }, process.stderr);
    return EXIT_CODES.commandFailed;
  }
}

if (isMain(import.meta.url)) process.exitCode = await main();
