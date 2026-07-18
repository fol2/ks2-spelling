import syntheticLearners from '../../config/b3-synthetic-learners.json' with { type: 'json' };
import { loadStarterSpellingCatalogue } from '../domain/spelling/index.js';
import {
  assertClosedArray,
  assertStorePort,
  STORE_METHODS,
  validateFinishResult,
  validateObservation,
  validateProduct,
} from '../platform/commerce/store-port.js';
import { canonicalJson } from '../platform/database/canonical-json.js';
import { createSQLiteSpellingSnapshotStore } from '../platform/database/sqlite-spelling-snapshot-store.js';
import {
  assertEntitlementGatewayPort,
  ENTITLEMENT_GATEWAY_METHODS,
} from '../platform/gateway/entitlement-gateway-port.js';
import { assertB3ProofObservationPort } from '../platform/proof/b3-proof-observation-port.js';
import {
  B3_PROOF_GATEWAY_CALLS,
  B3_PROOF_SCENARIO_OUTCOMES,
  canonicaliseB3ProofValue,
  createB3ProofObservation,
  validateB3GatewaySmokeAuthority,
  validateB3ProofLaunchCommand,
} from './b3-live-proof-protocol.js';

const GATEWAY_OPERATIONS = Object.freeze({
  verifyTransaction: 'verify',
  completeTransaction: 'complete',
  refreshEntitlement: 'refresh',
  authorisePackDownload: 'authorise',
});
const TRACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const INSTALLATION_METADATA_KEY = 'b3-proof-installation-v1';
const GATEWAY_CURSOR_METADATA_KEY = 'b3-proof-gateway-cursor-v1';
const GATEWAY_SMOKE_METADATA_KEY = 'b3-proof-gateway-smoke-v1';
const TRACKED_SYNTHETIC_LEARNERS = Object.freeze([
  Object.freeze({ learnerId: 'learner-a', nickname: 'Ada' }),
  Object.freeze({ learnerId: 'learner-b', nickname: 'Ben' }),
]);
const STORE_EVENT_OPERATIONS = Object.freeze([
  'queryProducts', 'purchase', 'queryTransactions', 'restore',
  'finishTransaction', 'transaction-update',
]);
const STORE_EVENT_OUTCOMES = Object.freeze([
  'products-visible', 'products-absent', 'none', 'cancelled', 'pending',
  'purchased', 'revoked', 'unverified', 'finished', 'completion-pending',
]);
const STORE_EVENT_PROOF_BOUND = 128;
const PHYSICAL_TRANSPORT_AUTHORITY = Object.freeze({
  storeAdapter: 'concreteCapacitorStore',
  gatewayAdapter: 'concreteHttpGateway',
  serverUrl: null,
  nativeOriginAllowed: true,
  noRedirects: true,
});

const FIRST_SCENARIO_ACTION = Object.freeze({
  'ios-physical': Object.freeze({
    'product-query': 'QUERY_PRODUCT',
    cancel: 'CANCEL_PURCHASE',
    'ask-to-buy-pending': 'INITIATE_PURCHASE',
    'normal-purchase': 'ARM_GATEWAY_COMPLETION_HOLD',
    'unfinished-relaunch': 'RELAUNCH',
    'pack-install': 'INSTALL_PACK',
    'restore-after-reinstall': 'REBIND_FRESH_INSTALL',
    redownload: 'REDOWNLOAD_PACK',
    'refund-revoke': 'OBSERVE_REVOCATION',
  }),
  'android-play-physical': Object.freeze({
    'product-query': 'QUERY_PRODUCT',
    cancel: 'CANCEL_PURCHASE',
    'slow-card-pending-decline': 'INITIATE_PURCHASE',
    'slow-card-pending-approve': 'INITIATE_PURCHASE',
    'unacknowledged-relaunch': 'ARM_GATEWAY_COMPLETION_HOLD',
    'pack-install': 'INSTALL_PACK',
    'restore-after-reinstall': 'REBIND_FRESH_INSTALL',
    redownload: 'REDOWNLOAD_PACK',
    'refund-revoke': 'OBSERVE_REVOCATION',
  }),
});

async function sha256(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function scenarioFor(command) {
  const scenarios = Object.keys(B3_PROOF_GATEWAY_CALLS[command.platform] ?? {});
  const scenario = scenarios[command.expectedScenarioIndex];
  if (!scenario) throw new TypeError('B3 proof scenario authority is invalid.');
  return scenario;
}

async function loadInstallationId({ command, connection, clock, uuidFactory }) {
  const rows = await connection.query(
    'SELECT value_json FROM app_metadata WHERE key = ?',
    [INSTALLATION_METADATA_KEY],
  );
  if (!Array.isArray(rows) || rows.length > 1) {
    throw new TypeError('B3 proof installation metadata is invalid.');
  }
  if (rows.length === 1) {
    if (command.installationMode === 'fresh-reinstall') {
      throw new TypeError('Fresh B3 proof installation retained prior metadata.');
    }
    let value;
    try {
      value = JSON.parse(rows[0].value_json);
    } catch (error) {
      throw new TypeError('B3 proof installation metadata is invalid.', { cause: error });
    }
    if (
      !value ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== 1 ||
      !TRACE_ID.test(value.installationId) ||
      canonicaliseB3ProofValue(value) !== rows[0].value_json
    ) {
      throw new TypeError('B3 proof installation metadata is invalid.');
    }
    return value.installationId;
  }
  if (command.installationMode === 'existing' && command.expectedSequence !== 1) {
    throw new TypeError('Existing B3 proof installation metadata is missing.');
  }
  const installationId = uuidFactory();
  if (!TRACE_ID.test(installationId)) {
    throw new TypeError('B3 proof installation identifier is invalid.');
  }
  await connection.execute(
    'INSERT INTO app_metadata (key, value_json, updated_at) VALUES (?, ?, ?)',
    [INSTALLATION_METADATA_KEY, canonicaliseB3ProofValue({ installationId }), clock()],
  );
  return installationId;
}

function validateGatewayCursorCall(call) {
  return call && Object.getPrototypeOf(call) === Object.prototype &&
    Reflect.ownKeys(call).length === 3 &&
    ['operation', 'relation', 'traceId'].every((key) => Object.hasOwn(call, key)) &&
    typeof call.operation === 'string' && typeof call.relation === 'string' &&
    TRACE_ID.test(call.traceId);
}

async function loadGatewayCursor({ command, connection, clock, allowPending = false }) {
  const rows = await connection.query(
    'SELECT value_json FROM app_metadata WHERE key = ?',
    [GATEWAY_CURSOR_METADATA_KEY],
  );
  if (!Array.isArray(rows) || rows.length > 1) {
    throw new TypeError('B3 proof gateway cursor metadata is invalid.');
  }
  if (rows.length === 0) return { offset: 0, usedTraceIds: [] };
  let value;
  try {
    value = JSON.parse(rows[0].value_json);
  } catch (error) {
    throw new TypeError('B3 proof gateway cursor metadata is invalid.', { cause: error });
  }
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== 8 ||
      !TRACE_ID.test(value.captureId) || !Number.isSafeInteger(value.scenarioIndex) ||
      !Number.isSafeInteger(value.offset) || value.offset < 0 ||
      !Array.isArray(value.pendingCalls) || value.pendingCalls.length > 16 ||
      !value.pendingCalls.every(validateGatewayCursorCall) ||
      !Array.isArray(value.usedTraceIds) || value.usedTraceIds.length > 64 ||
      !value.usedTraceIds.every((traceId) => TRACE_ID.test(traceId)) ||
      new Set(value.usedTraceIds).size !== value.usedTraceIds.length ||
      value.pendingCalls.some(({ traceId }) => !value.usedTraceIds.includes(traceId)) ||
      !((value.publishedObservationSha256 === null && value.publishedSequence === null) ||
        (SHA256.test(value.publishedObservationSha256) &&
         Number.isSafeInteger(value.publishedSequence) && value.publishedSequence > 0)) ||
      typeof value.drifted !== 'boolean' ||
      canonicaliseB3ProofValue(value) !== rows[0].value_json) {
    throw new TypeError('B3 proof gateway cursor metadata is invalid.');
  }
  if (value.captureId !== command.captureId) {
    throw new TypeError('B3 gateway continuity belongs to another capture.');
  }
  if (value.drifted) {
    throw new TypeError('B3 gateway continuity retained production trace drift.');
  }
  if (value.publishedObservationSha256 !== null) {
    if (command.previousObservationSha256 !== value.publishedObservationSha256 ||
        command.expectedSequence !== value.publishedSequence + 1) {
      throw new TypeError('B3 gateway continuity has an unacknowledged published observation.');
    }
    const sameScenario = value.scenarioIndex === command.expectedScenarioIndex;
    const acknowledged = {
      offset: sameScenario ? value.offset : 0,
      usedTraceIds: value.usedTraceIds,
    };
    await persistGatewayCursor({
      command,
      connection,
      ...acknowledged,
      pendingCalls: [],
      publishedObservationSha256: null,
      publishedSequence: null,
      drifted: false,
      clock,
    });
    return acknowledged;
  }
  if (value.pendingCalls.length > 0) {
    if (allowPending && value.scenarioIndex === command.expectedScenarioIndex) {
      return {
        offset: value.offset,
        usedTraceIds: value.usedTraceIds,
        pendingCalls: value.pendingCalls,
      };
    }
    throw new TypeError('B3 gateway continuity has unpublished successful calls.');
  }
  if (value.scenarioIndex !== command.expectedScenarioIndex) {
    return { offset: 0, usedTraceIds: value.usedTraceIds };
  }
  return { offset: value.offset, usedTraceIds: value.usedTraceIds, pendingCalls: [] };
}

async function loadPersistedGatewaySmoke({ command, connection }) {
  const rows = await connection.query(
    'SELECT value_json FROM app_metadata WHERE key = ?',
    [GATEWAY_SMOKE_METADATA_KEY],
  );
  if (!Array.isArray(rows) || rows.length > 1) {
    throw new TypeError('B3 persisted gateway smoke authority is ambiguous.');
  }
  if (rows.length === 0) return null;
  let record;
  try {
    record = JSON.parse(rows[0].value_json);
  } catch (error) {
    throw new TypeError('B3 persisted gateway smoke authority is invalid.', { cause: error });
  }
  if (!record || Object.getPrototypeOf(record) !== Object.prototype ||
      Reflect.ownKeys(record).length !== 5 || record.schemaVersion !== 1 ||
      record.captureId !== command.captureId ||
      record.scenarioIndex !== command.expectedScenarioIndex ||
      command.expectedScenarioIndex !== 5 ||
      canonicaliseB3ProofValue(record) !== rows[0].value_json) {
    throw new TypeError('B3 persisted gateway smoke authority binding is invalid.');
  }
  const authority = validateB3GatewaySmokeAuthority(record.authority);
  const expectedSha256 = await sha256(
    `ks2-spelling:b3-gateway-smoke-authority:v1\u0000${canonicaliseB3ProofValue(authority)}`,
  );
  if (record.authoritySha256 !== expectedSha256) {
    throw new TypeError('B3 persisted gateway smoke authority hash is invalid.');
  }
  return authority;
}

async function persistGatewayCursor({
  command, connection, offset, pendingCalls, usedTraceIds,
  publishedObservationSha256 = null, publishedSequence = null,
  drifted = false, clock,
}) {
  await connection.execute(
    'INSERT INTO app_metadata (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
    [GATEWAY_CURSOR_METADATA_KEY, canonicaliseB3ProofValue({
      captureId: command.captureId,
      scenarioIndex: command.expectedScenarioIndex,
      offset,
      pendingCalls,
      usedTraceIds,
      publishedObservationSha256,
      publishedSequence,
      drifted,
    }), clock()],
  );
}

function expectedLearnerDigests(command) {
  if (
    syntheticLearners?.schemaVersion !== 1 ||
    !Array.isArray(syntheticLearners.learners) ||
    syntheticLearners.learners.length !== TRACKED_SYNTHETIC_LEARNERS.length ||
    syntheticLearners.learners.some((learner, index) =>
      !learner ||
      Object.getPrototypeOf(learner) !== Object.prototype ||
      Reflect.ownKeys(learner).length !== 4 ||
      learner.learnerId !== TRACKED_SYNTHETIC_LEARNERS[index].learnerId ||
      learner.nickname !== TRACKED_SYNTHETIC_LEARNERS[index].nickname ||
      !SHA256.test(learner.beforePurchaseSnapshotSha256) ||
      !SHA256.test(learner.afterFreshInstallReseedSnapshotSha256))
  ) {
    throw new TypeError('Tracked B3 synthetic learner authority is invalid.');
  }
  const key = command.installationMode === 'fresh-reinstall'
    ? 'afterFreshInstallReseedSnapshotSha256'
    : 'beforePurchaseSnapshotSha256';
  return syntheticLearners.learners.map((learner) => learner[key]);
}

function hasStoreOutcome(storeEvents, outcome, operations = STORE_EVENT_OPERATIONS) {
  return storeEvents.some((event) =>
    operations.includes(event.operation) && event.outcome === outcome);
}

function deriveScenarioOutcome({ command, scenario, phase, projection, storeEvents }) {
  const terminal = phase === 'SCENARIO_COMPLETE' ||
    (command.platform === 'ios-physical' && scenario === 'normal-purchase' &&
      phase === 'HOLD_REACHED');
  if (!terminal) return 'in-progress';
  const expected = B3_PROOF_SCENARIO_OUTCOMES[command.platform][scenario];
  const active = projection.entitlementState === 'active';
  const noAccess = projection.entitlementState === 'none' && projection.packState === 'absent';
  const valid = {
    'product-query': hasStoreOutcome(storeEvents, 'products-visible', ['queryProducts']),
    cancel: hasStoreOutcome(storeEvents, 'cancelled', ['purchase']) && noAccess,
    'ask-to-buy-pending': hasStoreOutcome(storeEvents, 'pending', ['purchase']) && noAccess,
    'normal-purchase': hasStoreOutcome(storeEvents, 'purchased', ['purchase', 'transaction-update']) && active,
    'unfinished-relaunch': active && projection.storeCompletionObserved &&
      projection.transactionAuthority.rawProofCleared,
    'slow-card-pending-decline':
      (hasStoreOutcome(storeEvents, 'none', ['queryTransactions']) ||
       hasStoreOutcome(storeEvents, 'cancelled', ['queryTransactions', 'transaction-update'])) && noAccess,
    'slow-card-pending-approve':
      hasStoreOutcome(storeEvents, 'pending', ['queryTransactions', 'transaction-update', 'purchase']) && noAccess,
    'unacknowledged-relaunch': active && projection.storeCompletionObserved &&
      projection.transactionAuthority.rawProofCleared,
    'pack-install': active && projection.packState === 'installed' &&
      projection.transactionAuthority.rawProofCleared,
    'restore-after-reinstall': active &&
      projection.transactionAuthority.rawProofCleared &&
      hasStoreOutcome(storeEvents, 'purchased', ['restore', 'queryTransactions', 'transaction-update']),
    redownload: active && projection.packState === 'installed' &&
      projection.transactionAuthority.rawProofCleared,
    'refund-revoke': projection.entitlementState === 'revoked' && projection.packState === 'locked' &&
      projection.transactionAuthority.rawProofCleared &&
      hasStoreOutcome(storeEvents, 'revoked', ['queryTransactions', 'transaction-update', 'restore']),
  }[scenario];
  if (!valid) throw new TypeError('B3 device store outcome does not prove the scenario result.');
  return expected;
}

async function readDurableProjection({
  command, connection, gatewayCalls, gatewaySmokeAuthority, storeEvents, storeAuthority,
  scenario, phase,
}) {
  const profiles = await connection.query(
    'SELECT learner_id, nickname FROM learner_profiles ORDER BY learner_id',
  );
  if (
    !Array.isArray(profiles) ||
    profiles.length !== TRACKED_SYNTHETIC_LEARNERS.length ||
    profiles.some((profile, index) =>
      profile?.learner_id !== TRACKED_SYNTHETIC_LEARNERS[index].learnerId ||
      profile?.nickname !== TRACKED_SYNTHETIC_LEARNERS[index].nickname)
  ) {
    throw new TypeError('B3 synthetic learner authority drifted.');
  }
  const catalogue = loadStarterSpellingCatalogue();
  const store = createSQLiteSpellingSnapshotStore({
    connection,
    cataloguesById: Object.freeze({ [catalogue.catalogueId]: catalogue }),
  });
  const learnerDigests = await Promise.all(TRACKED_SYNTHETIC_LEARNERS.map(
    async ({ learnerId }) => sha256(canonicalJson(await store.read(learnerId))),
  ));
  if (canonicaliseB3ProofValue(learnerDigests) !==
      canonicaliseB3ProofValue(expectedLearnerDigests(command))) {
    throw new TypeError('B3 synthetic learner authority drifted.');
  }
  const storeKind = command.platform === 'ios-physical' ? 'apple' : 'google';
  const productId = storeKind === 'apple'
    ? 'uk.eugnel.ks2spelling.fullks2'
    : 'full_ks2';
  const [entitlements, journals, jobs, activePacks] = await Promise.all([
    connection.query(
      'SELECT entitlement_id, store, product_id, state, sealed_refresh_handle, refresh_handle_version, verified_at, refreshed_at, revocation_at FROM app_entitlements WHERE entitlement_id = ? ORDER BY entitlement_id',
      ['full-ks2'],
    ),
    connection.query(
      'SELECT journal_id, store, product_id, store_transaction_id, processing_state, opaque_proof, updated_at FROM transaction_journal WHERE store = ? AND product_id = ? ORDER BY updated_at, journal_id',
      [storeKind, productId],
    ),
    connection.query(
      'SELECT state FROM pack_download_jobs ORDER BY updated_at, job_id',
    ),
    connection.query(
      'SELECT pack_id, version, manifest_sha256, path_token, activated_at FROM active_pack_versions ORDER BY pack_id',
    ),
  ]);
  if (entitlements.length > 1 || activePacks.length > 1) {
    throw new TypeError('B3 durable authority is ambiguous.');
  }
  const entitlement = entitlements[0] ?? null;
  if (journals.some((row) =>
    row.store !== storeKind || row.product_id !== productId ||
    (['verified', 'entitlement-committed', 'store-completion-pending']
      .includes(row.processing_state) && typeof row.store_transaction_id !== 'string'))) {
    throw new TypeError('B3 transaction authority is ambiguous.');
  }
  const distinctStoreTransactionIds = new Set(journals
    .map(({ store_transaction_id: transactionId }) => transactionId)
    .filter((transactionId) => typeof transactionId === 'string'));
  if (distinctStoreTransactionIds.size > 1) {
    throw new TypeError('B3 transaction authority is ambiguous.');
  }
  const transaction = [...journals].reverse().find((row) =>
    typeof row.store_transaction_id === 'string') ?? null;
  const transactionDigest = transaction
    ? await sha256(`b3-proof-transaction-authority-v1\u0000${transaction.store}\u0000${transaction.store_transaction_id}`)
    : null;
  let packAuthority = {
    packId: null,
    manifestSha256: null,
    archiveSha256: null,
    installed: false,
  };
  if (activePacks.length === 1) {
    const activePack = activePacks[0];
    const [installedRows, matchingJobs] = await Promise.all([
      connection.query(
        'SELECT pack_id, version, manifest_sha256, path_token, state, installed_at FROM installed_pack_versions WHERE pack_id = ? AND version = ?',
        [activePack.pack_id, activePack.version],
      ),
      connection.query(
        'SELECT job_id, archive_sha256, state, updated_at FROM pack_download_jobs WHERE pack_id = ? AND version = ? AND manifest_sha256 = ? ORDER BY updated_at DESC, job_id DESC',
        [activePack.pack_id, activePack.version, activePack.manifest_sha256],
      ),
    ]);
    const installed = installedRows[0];
    const latestMatchingJob = matchingJobs[0];
    if (installedRows.length !== 1 || !installed || installed.state !== 'ready' ||
        installed.manifest_sha256 !== activePack.manifest_sha256 ||
        installed.path_token !== activePack.path_token || !latestMatchingJob ||
        latestMatchingJob.state !== 'ready' ||
        (matchingJobs[1] && matchingJobs[1].updated_at === latestMatchingJob.updated_at) ||
        !SHA256.test(activePack.manifest_sha256) ||
        !SHA256.test(latestMatchingJob.archive_sha256)) {
      throw new TypeError('B3 active pack authority drifted.');
    }
    packAuthority = {
      packId: activePack.pack_id,
      manifestSha256: activePack.manifest_sha256,
      archiveSha256: latestMatchingJob.archive_sha256,
      installed: true,
    };
  }
  const latestJob = jobs.at(-1)?.state ?? null;
  const packState = entitlement?.state === 'revoked'
    ? 'locked'
    : packAuthority.installed
      ? 'installed'
      : latestJob === 'downloading'
        ? 'downloading'
        : latestJob === 'queued'
          ? 'queued'
          : 'absent';
  const projection = {
    challengeSha256: command.challengeSha256,
    scenarioOutcome: 'in-progress',
    entitlementState: entitlement?.state ?? 'none',
    packState,
    storeCompletionObserved: journals.some(({ processing_state: state }) => state === 'complete'),
    storeEvents: structuredClone(storeEvents),
    storeAuthority: {
      ...structuredClone(storeAuthority),
      completionState: journals.some(({ processing_state: state }) => state === 'complete')
        ? command.platform === 'ios-physical' ? 'finished' : 'acknowledged'
        : 'not-observed',
    },
    gatewayCalls: structuredClone(gatewayCalls),
    gatewaySmokeAuthority: gatewaySmokeAuthority === null
      ? null
      : structuredClone(gatewaySmokeAuthority),
    syntheticLearners: {
      syntheticAuthorityMatched: true,
      positionalSnapshotSha256: learnerDigests,
    },
    transactionAuthority: {
      source: transaction === null
        ? 'none'
        : transaction.store === 'apple'
          ? 'apple-transaction-id'
          : 'google-order-id',
      crossCheckedOnRefresh: Boolean(
        entitlement && entitlement.refreshed_at > entitlement.verified_at,
      ),
      domainSeparatedDigestSha256: transactionDigest,
      rawProofCleared: journals.length > 0 &&
        journals.every(({ opaque_proof: proof }) => proof === null),
    },
    refreshHandleLifecycle: {
      present: typeof entitlement?.sealed_refresh_handle === 'string',
      positiveVersionObserved: Number.isSafeInteger(entitlement?.refresh_handle_version) &&
        entitlement.refresh_handle_version > 0,
      rotated: Number.isSafeInteger(entitlement?.refresh_handle_version) &&
        entitlement.refresh_handle_version > 1,
      deleted: entitlement?.state === 'revoked' && entitlement.sealed_refresh_handle === null,
    },
    entitlementAuthority: entitlement === null
      ? {
          id: null,
          state: 'none',
          domainSeparatedDigestSha256: null,
          refreshHandlePresent: false,
        }
      : {
          id: entitlement.entitlement_id,
          state: entitlement.state,
          domainSeparatedDigestSha256: await sha256(
            `b3-proof-entitlement-authority-v1\u0000${canonicaliseB3ProofValue({
              entitlementId: entitlement.entitlement_id,
              store: entitlement.store,
              productId: entitlement.product_id,
              state: entitlement.state,
              refreshHandlePresent: typeof entitlement.sealed_refresh_handle === 'string',
              refreshHandleVersion: entitlement.refresh_handle_version,
              verifiedAt: entitlement.verified_at,
              refreshedAt: entitlement.refreshed_at,
              revocationAt: entitlement.revocation_at,
            })}`,
          ),
          refreshHandlePresent: typeof entitlement.sealed_refresh_handle === 'string',
        },
    packAuthority,
    transportAuthority: PHYSICAL_TRANSPORT_AUTHORITY,
  };
  projection.scenarioOutcome = deriveScenarioOutcome({
    command, scenario, phase, projection, storeEvents,
  });
  return projection;
}

export async function createB3LiveProofSession(rawOptions) {
  const command = validateB3ProofLaunchCommand(rawOptions?.command);
  const connection = rawOptions?.connection;
  const observationPort = assertB3ProofObservationPort(rawOptions?.observationPort);
  const clock = rawOptions?.clock ?? (() => Date.now());
  const uuidFactory = rawOptions?.uuidFactory ?? (() => globalThis.crypto.randomUUID());
  if (!connection || typeof connection.query !== 'function' ||
      typeof connection.execute !== 'function' ||
      !rawOptions.buildAuthority || typeof rawOptions.buildAuthority !== 'object') {
    throw new TypeError('B3 live-proof session options are invalid.');
  }
  const scenario = scenarioFor(command);
  const expectedCalls = B3_PROOF_GATEWAY_CALLS[command.platform][scenario];
  const gatewaySmokeProbe = rawOptions?.gatewaySmokeProbe ?? null;
  if (gatewaySmokeProbe !== null && typeof gatewaySmokeProbe !== 'function') {
    throw new TypeError('B3 device gateway smoke probe is invalid.');
  }
  const installationId = await loadInstallationId({ command, connection, clock, uuidFactory });
  const persistedGatewaySmoke = scenario === 'pack-install'
    ? await loadPersistedGatewaySmoke({ command, connection })
    : null;
  const gatewayCursor = await loadGatewayCursor({
    command,
    connection,
    clock,
    allowPending: persistedGatewaySmoke !== null,
  });
  let gatewayOffset = gatewayCursor.offset;
  const buildAuthority = structuredClone(rawOptions.buildAuthority);
  const gatewayCalls = [...(gatewayCursor.pendingCalls ?? [])];
  const storeEvents = [];
  const expectedStore = command.platform === 'ios-physical' ? 'apple' : 'google';
  const expectedProductId = command.platform === 'ios-physical'
    ? 'uk.eugnel.ks2spelling.fullks2'
    : 'full_ks2';
  const storeAuthority = {
    environment: 'sandbox',
    productId: expectedProductId,
    localisedPriceObserved: false,
  };
  const traceIds = new Set(gatewayCursor.usedTraceIds);
  let gatewayDrift = false;
  let proofWriteChain = Promise.resolve();
  let held = false;
  let runPromise = null;
  let gatewaySmokePromise = persistedGatewaySmoke === null
    ? null
    : Promise.resolve(persistedGatewaySmoke);
  let gatewaySmokeAuthority = persistedGatewaySmoke;

  async function persistGatewaySmoke(authority) {
    const safeAuthority = validateB3GatewaySmokeAuthority(authority);
    const authoritySha256 = await sha256(
      `ks2-spelling:b3-gateway-smoke-authority:v1\u0000${canonicaliseB3ProofValue(safeAuthority)}`,
    );
    const record = {
      schemaVersion: 1,
      captureId: command.captureId,
      scenarioIndex: command.expectedScenarioIndex,
      authority: safeAuthority,
      authoritySha256,
    };
    const rows = await connection.query(
      'SELECT value_json FROM app_metadata WHERE key = ?',
      [GATEWAY_SMOKE_METADATA_KEY],
    );
    if (!Array.isArray(rows) || rows.length > 1 || rows.length === 1) {
      throw new TypeError('B3 gateway smoke authority was already persisted.');
    }
    await connection.execute(
      'INSERT INTO app_metadata (key, value_json, updated_at) VALUES (?, ?, ?)',
      [GATEWAY_SMOKE_METADATA_KEY, canonicaliseB3ProofValue(record), clock()],
    );
    return safeAuthority;
  }

  function queueGatewayCursorWrite(options) {
    const snapshot = structuredClone(options);
    proofWriteChain = proofWriteChain
      .then(() => persistGatewayCursor({
        command,
        connection,
        ...snapshot,
        clock,
      }))
      .catch(() => {
        gatewayDrift = true;
      });
  }

  async function publish({ phase, nextActionCode, completedTransitions }) {
    await proofWriteChain;
    if (gatewayDrift) throw new TypeError('B3 production gateway trace drifted.');
    if (scenario === 'pack-install' && phase === 'SCENARIO_COMPLETE') {
      if (gatewaySmokePromise === null) {
        throw new TypeError('B3 device gateway smoke was not started by authorisation.');
      }
      gatewaySmokeAuthority = await gatewaySmokePromise;
    }
    const proofProjection = await readDurableProjection({
      command,
      connection,
      gatewayCalls,
      gatewaySmokeAuthority,
      storeEvents,
      storeAuthority,
      scenario,
      phase,
    });
    const observation = await createB3ProofObservation({
      command,
      buildAuthority,
      installationId,
      sequence: command.expectedSequence,
      scenario,
      phase,
      nextActionCode,
      completedTransitions,
      proofProjection,
      observedAt: new Date(clock()).toISOString(),
    });
    await observationPort.publishObservation(observation);
    await persistGatewayCursor({
      command,
      connection,
      offset: gatewayOffset,
      pendingCalls: gatewayCalls,
      usedTraceIds: [...traceIds],
      publishedObservationSha256: observation.observationSha256,
      publishedSequence: observation.sequence,
      drifted: false,
      clock,
    });
    gatewayCalls.length = 0;
    storeEvents.length = 0;
    return observation;
  }

  const session = {
    observeDownloadAuthorisation(authorisation) {
      if (scenario !== 'pack-install' || command.actionCode !== 'INSTALL_PACK') return;
      if (gatewaySmokeProbe === null) {
        gatewayDrift = true;
        return;
      }
      if (gatewaySmokePromise !== null) {
        gatewayDrift = true;
        return;
      }
      gatewaySmokePromise = Promise.resolve()
        .then(() => gatewaySmokeProbe(authorisation))
        .then((authority) => persistGatewaySmoke(authority));
      void gatewaySmokePromise.catch(() => {});
    },
    recordGatewaySmokeFailure() {
      gatewayDrift = true;
    },
    async observeGatewayCall(operation, invoke) {
      if (typeof invoke !== 'function') {
        throw new TypeError('B3 observed gateway invocation is invalid.');
      }
      let result;
      try {
        result = await invoke();
      } catch (error) {
        gatewayDrift = true;
        queueGatewayCursorWrite({
          offset: gatewayOffset,
          pendingCalls: gatewayCalls,
          usedTraceIds: [...traceIds],
          drifted: true,
        });
        throw error;
      }
      const expected = expectedCalls[gatewayOffset];
      if (!expected || expected.operation !== operation ||
          !TRACE_ID.test(result?.traceId) || traceIds.has(result.traceId)) {
        gatewayDrift = true;
        queueGatewayCursorWrite({
          offset: gatewayOffset,
          pendingCalls: gatewayCalls,
          usedTraceIds: [...traceIds],
          drifted: true,
        });
        return result;
      }
      traceIds.add(result.traceId);
      gatewayCalls.push(Object.freeze({
        operation,
        relation: expected.relation,
        traceId: result.traceId,
      }));
      gatewayOffset += 1;
      queueGatewayCursorWrite({
        offset: gatewayOffset,
        pendingCalls: gatewayCalls,
        usedTraceIds: [...traceIds],
        publishedObservationSha256: null,
        publishedSequence: null,
        drifted: false,
      });
      return result;
    },
    observeStoreResult(operation, event, authority = null) {
      if (!STORE_EVENT_OPERATIONS.includes(operation) ||
          !event || Object.getPrototypeOf(event) !== Object.prototype ||
          Reflect.ownKeys(event).length !== 2 || event.operation !== operation ||
          !STORE_EVENT_OUTCOMES.includes(event.outcome) ||
          storeEvents.length >= STORE_EVENT_PROOF_BOUND) {
        gatewayDrift = true;
        return;
      }
      if (authority !== null && (
        !authority || Object.getPrototypeOf(authority) !== Object.prototype ||
        Reflect.ownKeys(authority).length !== 4 ||
        !['store', 'environment', 'productId', 'localisedPriceObserved']
          .every((key) => Object.hasOwn(authority, key)) ||
        ![null, expectedStore].includes(authority.store) ||
        ![null, 'sandbox'].includes(authority.environment) ||
        ![null, expectedProductId].includes(authority.productId) ||
        typeof authority.localisedPriceObserved !== 'boolean'
      )) {
        gatewayDrift = true;
        return;
      }
      if (authority?.localisedPriceObserved === true) {
        storeAuthority.localisedPriceObserved = true;
      }
      storeEvents.push(Object.freeze({ operation, outcome: event.outcome }));
    },
    async failureInjector(checkpoint) {
      if (checkpoint !== 'before:gateway-completion' ||
          command.actionCode !== 'ARM_GATEWAY_COMPLETION_HOLD') return;
      if (held) throw new TypeError('B3 gateway-completion hold was already reached.');
      held = true;
      await publish({
        phase: 'HOLD_REACHED',
        nextActionCode: 'RELAUNCH',
        completedTransitions: [
          ...(command.expectedScenarioIndex === 0 ? ['UNBOUND'] : []),
          'ARMED', 'WAITING_OPERATOR', 'OBSERVING', 'HOLD_REACHED',
        ],
      });
      await new Promise(() => {});
    },
    publish,
    run(controller) {
      if (runPromise) return runPromise;
      if (!controller || typeof controller.start !== 'function' ||
          typeof controller.sync !== 'function') {
        return Promise.reject(new TypeError('B3 live-proof controller is invalid.'));
      }
      runPromise = (async () => {
        await controller.start();
        switch (command.actionCode) {
          case 'ARM_CAPTURE':
            return publish({
              phase: 'ARMED', nextActionCode: FIRST_SCENARIO_ACTION[command.platform][scenario],
              completedTransitions: [
                ...(command.expectedScenarioIndex === 0 ? ['UNBOUND'] : []), 'ARMED',
              ],
            });
          case 'QUERY_PRODUCT':
          case 'OBSERVE':
          case 'OBSERVE_REVOCATION':
            await controller.sync();
            break;
          case 'CANCEL_PURCHASE':
          case 'INITIATE_PURCHASE':
          case 'ARM_GATEWAY_COMPLETION_HOLD':
            await controller.buy();
            break;
          case 'INSTALL_PACK':
            if (persistedGatewaySmoke !== null) {
              return publish({
                phase: 'SCENARIO_COMPLETE', nextActionCode: 'ARM_CAPTURE',
                completedTransitions: [
                  'ARMED', 'WAITING_OPERATOR', 'OBSERVING', 'SCENARIO_COMPLETE',
                ],
              });
            }
            await controller.redownload();
            break;
          case 'REDOWNLOAD_PACK':
            await controller.redownload();
            break;
          case 'RESTORE_PURCHASES':
            await controller.restore();
            break;
          case 'REBIND_FRESH_INSTALL':
            return publish({
              phase: 'SCENARIO_COMPLETE', nextActionCode: 'ARM_CAPTURE',
              completedTransitions: [
                'REBIND_FRESH_INSTALL', 'OBSERVING', 'SCENARIO_COMPLETE',
              ],
            });
          case 'RELAUNCH':
            await controller.sync();
            return publish({
              phase: 'SCENARIO_COMPLETE', nextActionCode: 'ARM_CAPTURE',
              completedTransitions: [
                'HOST_FORCE_STOP', 'RELAUNCH_RECOVERY', 'SCENARIO_COMPLETE',
              ],
            });
          case 'CAPTURE_TERMINAL':
            return publish({
              phase: 'TERMINAL_CAPTURE', nextActionCode: 'COMPLETE_CAPTURE',
              completedTransitions: ['TERMINAL_CAPTURE'],
            });
          default:
            throw new TypeError('B3 live-proof action is unsupported.');
        }
        const androidPurchaseObserved = hasStoreOutcome(
          storeEvents,
          'purchased',
          ['queryTransactions', 'transaction-update', 'purchase'],
        );
        const pendingAndroidSlowCard = command.platform === 'android-play-physical' &&
          ['slow-card-pending-decline', 'slow-card-pending-approve'].includes(scenario) &&
          command.actionCode === 'INITIATE_PURCHASE';
        const pendingAndroidApprovalPoll = command.platform === 'android-play-physical' &&
          scenario === 'unacknowledged-relaunch' &&
          command.actionCode === 'ARM_GATEWAY_COMPLETION_HOLD' &&
          !androidPurchaseObserved;
        const pendingAndroid = pendingAndroidSlowCard || pendingAndroidApprovalPoll;
        const nextActionCode = pendingAndroidApprovalPoll
          ? 'ARM_GATEWAY_COMPLETION_HOLD'
          : pendingAndroidSlowCard
          ? (scenario.endsWith('decline') ? 'DECLINE_PENDING_PURCHASE' : 'APPROVE_PENDING_PURCHASE')
          : command.expectedScenarioIndex === 8
            ? 'CAPTURE_TERMINAL'
            : command.expectedScenarioIndex === 5
              ? 'REBIND_FRESH_INSTALL'
              : 'ARM_CAPTURE';
        const completedTransitions = [
          ...(command.expectedScenarioIndex === 0 ? ['UNBOUND'] : []),
          'ARMED', 'WAITING_OPERATOR', 'OBSERVING',
          ...(!pendingAndroid ? ['SCENARIO_COMPLETE'] : []),
        ];
        return publish({
          phase: pendingAndroid ? 'OBSERVING' : 'SCENARIO_COMPLETE',
          nextActionCode,
          completedTransitions,
        });
      })();
      return runPromise;
    },
  };
  return Object.freeze(session);
}

function requireSession(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.observeGatewayCall !== 'function' ||
    typeof value.observeStoreResult !== 'function'
  ) {
    throw new TypeError('B3 live-proof observation session is invalid.');
  }
  return value;
}

export function createB3ObservedGateway(rawGateway, rawSession) {
  const gateway = assertEntitlementGatewayPort(rawGateway);
  const session = requireSession(rawSession);
  const observed = Object.fromEntries(ENTITLEMENT_GATEWAY_METHODS.map((method) => [
    method,
    (request) => session.observeGatewayCall(
      GATEWAY_OPERATIONS[method],
      () => gateway[method](request),
    ),
  ]));
  assertEntitlementGatewayPort(observed);
  return Object.freeze(observed);
}

export function createB3ObservedStore(rawStore, rawSession) {
  const store = assertStorePort(rawStore);
  const session = requireSession(rawSession);
  const observeStoreProof = (operation, event, authority) => {
    try {
      const observation = session.observeStoreResult(operation, event, authority);
      if (observation && typeof observation.then === 'function') {
        void observation.catch(() => {});
      }
    } catch {
      // Proof observation is fail-later metadata and cannot replace StorePort semantics.
    }
  };
  const observed = {};
  for (const method of STORE_METHODS) {
    if (method === 'subscribeTransactionUpdates') {
      observed[method] = (listener) => store[method]((observation) => {
        const validated = validateObservation(observation);
        observeStoreProof('transaction-update', {
          operation: 'transaction-update', outcome: validated.outcome,
        }, {
          store: validated.store,
          environment: validated.environment,
          productId: validated.productId,
          localisedPriceObserved: false,
        });
        return listener(observation);
      });
      continue;
    }
    observed[method] = async (request) => {
      const result = await store[method](request);
      if (method === 'queryProducts') {
        const products = assertClosedArray(result, 'Observed StorePort product results', { max: 16 });
        products.forEach(validateProduct);
        observeStoreProof(method, {
          operation: method, outcome: products.length > 0 ? 'products-visible' : 'products-absent',
        }, {
          store: null,
          environment: null,
          productId: products[0]?.productId ?? null,
          localisedPriceObserved: products.some(({ displayPrice }) => displayPrice.length > 0),
        });
      } else if (method === 'purchase') {
        const observation = validateObservation(result);
        observeStoreProof(method, { operation: method, outcome: observation.outcome }, {
          store: observation.store,
          environment: observation.environment,
          productId: observation.productId,
          localisedPriceObserved: false,
        });
      } else if (method === 'queryTransactions' || method === 'restore') {
        const observations = assertClosedArray(result, `Observed StorePort ${method} results`, { max: 64 });
        if (observations.length === 0) {
          observeStoreProof(method, { operation: method, outcome: 'none' }, {
            store: null, environment: null, productId: null, localisedPriceObserved: false,
          });
        } else {
          for (const observation of observations.map(validateObservation)) {
            observeStoreProof(method, { operation: method, outcome: observation.outcome }, {
              store: observation.store,
              environment: observation.environment,
              productId: observation.productId,
              localisedPriceObserved: false,
            });
          }
        }
      } else if (method === 'finishTransaction') {
        const completion = validateFinishResult(result).completion;
        observeStoreProof(method, {
          operation: method,
          outcome: completion === 'finished' ? 'finished' : 'completion-pending',
        }, {
          store: null, environment: null, productId: null, localisedPriceObserved: false,
        });
      }
      return result;
    };
  }
  assertStorePort(observed);
  return Object.freeze(observed);
}
