const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_CANONICAL_BYTES = 64 * 1_024;
const INITIAL_OBSERVATION_SHA256 = '0'.repeat(64);
const B3_PUBLIC_SANDBOX_ORIGIN = ['https:', '', 'b3-gateway.eugnel.uk'].join('/');

export const B3_PROOF_PHASES = Object.freeze([
  'UNBOUND',
  'ARMED',
  'WAITING_OPERATOR',
  'OBSERVING',
  'HOLD_REACHED',
  'HOST_FORCE_STOP',
  'RELAUNCH_RECOVERY',
  'SCENARIO_COMPLETE',
  'REBIND_FRESH_INSTALL',
  'TERMINAL_CAPTURE',
  'MANUAL_ATTESTATION',
  'COMPLETE',
]);

export const B3_PROOF_ACTION_CODES = Object.freeze([
  'ARM_CAPTURE',
  'OBSERVE',
  'QUERY_PRODUCT',
  'CANCEL_PURCHASE',
  'INITIATE_PURCHASE',
  'APPROVE_PENDING_PURCHASE',
  'DECLINE_PENDING_PURCHASE',
  'INSTALL_PACK',
  'RESTORE_PURCHASES',
  'REDOWNLOAD_PACK',
  'OBSERVE_REVOCATION',
  'ARM_GATEWAY_COMPLETION_HOLD',
  'RELAUNCH',
  'REBIND_FRESH_INSTALL',
  'CAPTURE_TERMINAL',
  'COMPLETE_CAPTURE',
]);

export const B3_PROOF_SCENARIO_OUTCOMES = Object.freeze({
  'ios-physical': Object.freeze({
    'product-query': 'products-visible',
    cancel: 'cancelled',
    'ask-to-buy-pending': 'pending-no-access',
    'normal-purchase': 'verified-active',
    'unfinished-relaunch': 'finished-recovered',
    'pack-install': 'installed',
    'restore-after-reinstall': 'restored-active',
    redownload: 'redownloaded',
    'refund-revoke': 'revoked-locked',
  }),
  'android-play-physical': Object.freeze({
    'product-query': 'products-visible',
    cancel: 'cancelled',
    'slow-card-pending-decline': 'declined-no-access',
    'slow-card-pending-approve': 'pending-approved-no-access',
    'unacknowledged-relaunch': 'acknowledged-recovered',
    'pack-install': 'installed',
    'restore-after-reinstall': 'restored-active',
    redownload: 'redownloaded',
    'refund-revoke': 'revoked-locked',
  }),
});
const B3_PROOF_SCENARIO_OUTCOME_VALUES = Object.freeze([
  ...new Set(Object.values(B3_PROOF_SCENARIO_OUTCOMES).flatMap(Object.values)),
]);

export const B3_PROOF_GATEWAY_RELATIONS = Object.freeze([
  'transaction-verification',
  'recovery-reverification',
  'completion-of-prior-verify',
  'download-job-authorisation',
  'post-recovery-handle-refresh',
  'download-capability-authorisation',
  'fresh-install-startup-verification',
  'fresh-install-startup-completion',
  'fresh-install-download-job-authorisation',
  'fresh-install-handle-refresh',
  'explicit-restore-verification',
  'explicit-restore-completion',
  'redownload-capability-authorisation',
  'revocation-handle-refresh',
]);

const IOS_SCENARIOS = Object.freeze([
  'product-query',
  'cancel',
  'ask-to-buy-pending',
  'normal-purchase',
  'unfinished-relaunch',
  'pack-install',
  'restore-after-reinstall',
  'redownload',
  'refund-revoke',
]);
const ANDROID_SCENARIOS = Object.freeze([
  'product-query',
  'cancel',
  'slow-card-pending-decline',
  'slow-card-pending-approve',
  'unacknowledged-relaunch',
  'pack-install',
  'restore-after-reinstall',
  'redownload',
  'refund-revoke',
]);

function freezeGatewayCalls(value) {
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([scenario, calls]) => [
    scenario,
    Object.freeze(calls.map((call) => Object.freeze({ ...call }))),
  ])));
}

export const B3_PROOF_GATEWAY_CALLS = Object.freeze({
  'ios-physical': freezeGatewayCalls({
    'product-query': [],
    cancel: [],
    'ask-to-buy-pending': [],
    'normal-purchase': [
      { operation: 'verify', relation: 'transaction-verification' },
    ],
    'unfinished-relaunch': [
      { operation: 'verify', relation: 'recovery-reverification' },
      { operation: 'complete', relation: 'completion-of-prior-verify' },
      { operation: 'authorise', relation: 'download-job-authorisation' },
      { operation: 'refresh', relation: 'post-recovery-handle-refresh' },
    ],
    'pack-install': [
      { operation: 'authorise', relation: 'download-capability-authorisation' },
    ],
    'restore-after-reinstall': [
      { operation: 'verify', relation: 'fresh-install-startup-verification' },
      { operation: 'complete', relation: 'fresh-install-startup-completion' },
      { operation: 'authorise', relation: 'fresh-install-download-job-authorisation' },
      { operation: 'refresh', relation: 'fresh-install-handle-refresh' },
    ],
    redownload: [
      { operation: 'authorise', relation: 'redownload-capability-authorisation' },
    ],
    'refund-revoke': [
      { operation: 'refresh', relation: 'revocation-handle-refresh' },
    ],
  }),
  'android-play-physical': freezeGatewayCalls({
    'product-query': [],
    cancel: [],
    'slow-card-pending-decline': [],
    'slow-card-pending-approve': [],
    'unacknowledged-relaunch': [
      { operation: 'verify', relation: 'transaction-verification' },
      { operation: 'verify', relation: 'recovery-reverification' },
      { operation: 'complete', relation: 'completion-of-prior-verify' },
      { operation: 'authorise', relation: 'download-job-authorisation' },
      { operation: 'refresh', relation: 'post-recovery-handle-refresh' },
    ],
    'pack-install': [
      { operation: 'authorise', relation: 'download-capability-authorisation' },
    ],
    'restore-after-reinstall': [
      { operation: 'verify', relation: 'fresh-install-startup-verification' },
      { operation: 'complete', relation: 'fresh-install-startup-completion' },
      { operation: 'authorise', relation: 'fresh-install-download-job-authorisation' },
      { operation: 'refresh', relation: 'fresh-install-handle-refresh' },
    ],
    redownload: [
      { operation: 'authorise', relation: 'redownload-capability-authorisation' },
    ],
    'refund-revoke': [
      { operation: 'refresh', relation: 'revocation-handle-refresh' },
    ],
  }),
});
const PLATFORMS = Object.freeze({
  'ios-physical': IOS_SCENARIOS,
  'android-play-physical': ANDROID_SCENARIOS,
});

const COMMAND_KEYS = Object.freeze([
  'schemaVersion',
  'captureId',
  'platform',
  'testedApplicationCommit',
  'applicationFingerprint',
  'expectedScenarioIndex',
  'expectedSequence',
  'previousObservationSha256',
  'installationMode',
  'actionCode',
  'challengeSha256',
]);
const OBSERVATION_KEYS = Object.freeze([
  'schemaVersion',
  'platform',
  'buildAuthoritySha256',
  'captureId',
  'installationId',
  'sequence',
  'previousObservationSha256',
  'scenarioIndex',
  'scenario',
  'phase',
  'nextActionCode',
  'completedTransitions',
  'proofProjection',
  'observedAt',
  'observationSha256',
]);
const PROJECTION_KEYS = Object.freeze([
  'challengeSha256',
  'scenarioOutcome',
  'entitlementState',
  'packState',
  'storeCompletionObserved',
  'storeEvents',
  'storeAuthority',
  'gatewayCalls',
  'gatewaySmokeAuthority',
  'syntheticLearners',
  'transactionAuthority',
  'refreshHandleLifecycle',
  'entitlementAuthority',
  'packAuthority',
  'transportAuthority',
]);
const R2_ETAG = /^[0-9a-f]{32}$/u;
const B3_SMOKE_OBJECTS = Object.freeze([
  Object.freeze({
    role: 'signed-manifest',
    key: 'packs/b3-sandbox-proof/1.0.0-b3.1/signed-manifest.json',
  }),
  Object.freeze({
    role: 'archive',
    key: 'packs/b3-sandbox-proof/1.0.0-b3.1/b3-sandbox-proof.zip',
  }),
]);

function protocolError(message) {
  return Object.assign(new Error(message), { code: 'B3_PROOF_PROTOCOL_INVALID' });
}

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function requireExactRecord(value, keys, label) {
  if (!isPlainRecord(value)) throw protocolError(`${label} must be a plain record.`);
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) =>
    typeof key !== 'string' || !keys.includes(key) ||
    !Object.getOwnPropertyDescriptor(value, key)?.enumerable ||
    !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) {
    throw protocolError(`${label} violates its closed schema.`);
  }
  return value;
}

function requireCanonicalString(value) {
  if (value !== value.normalize('NFC')) {
    throw protocolError('Canonical proof strings must already be NFC normalised.');
  }
  return value;
}

function snapshotCanonicalValue(value, seen = new Set()) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return requireCanonicalString(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw protocolError('Canonical numbers must be finite.');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') {
    throw protocolError('Canonical proof values contain unsupported data.');
  }
  if (seen.has(value)) throw protocolError('Canonical proof values cannot be cyclic.');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > 1_024) throw protocolError('Canonical proof array exceeds its bound.');
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.length !== value.length + 1 ||
          ownKeys.at(-1) !== 'length' ||
          ownKeys.slice(0, -1).some((key, index) => {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            return key !== String(index) || !descriptor?.enumerable ||
              !Object.hasOwn(descriptor, 'value');
          })) {
        throw protocolError('Canonical proof arrays must be dense data arrays.');
      }
      return ownKeys.slice(0, -1).map((key) => snapshotCanonicalValue(
        Object.getOwnPropertyDescriptor(value, key).value,
        seen,
      ));
    }
    if (!isPlainRecord(value)) throw protocolError('Canonical objects must be plain records.');
    const result = {};
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => {
      if (typeof key !== 'string') return true;
      requireCanonicalString(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value');
    })) {
      throw protocolError('Canonical proof records must contain enumerable data fields only.');
    }
    for (const key of keys.toSorted()) {
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: snapshotCanonicalValue(
          Object.getOwnPropertyDescriptor(value, key).value,
          seen,
        ),
      });
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function encodeCanonicalSnapshot(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' ||
      typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => encodeCanonicalSnapshot(entry)).join(',')}]`;
  }
  return `{${Reflect.ownKeys(value).map((key) =>
    `${JSON.stringify(key)}:${encodeCanonicalSnapshot(
      Object.getOwnPropertyDescriptor(value, key).value,
    )}`).join(',')}}`;
}

export function canonicaliseB3ProofValue(value) {
  return encodeCanonicalSnapshot(snapshotCanonicalValue(value));
}

function canonicalBytes(value) {
  return new TextEncoder().encode(canonicaliseB3ProofValue(value));
}

async function sha256(value) {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', value));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function exactUtc(value) {
  if (typeof value !== 'string' || !ISO_UTC.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function clone(value) {
  return snapshotCanonicalValue(value);
}

export function validateB3ProofLaunchCommand(rawValue) {
  const value = requireExactRecord(
    snapshotCanonicalValue(rawValue),
    COMMAND_KEYS,
    'B3 proof launch command',
  );
  const scenarios = PLATFORMS[value.platform];
  if (
    value.schemaVersion !== 1 ||
    !UUID_V4.test(value.captureId) ||
    !scenarios ||
    !COMMIT.test(value.testedApplicationCommit) ||
    !SHA256.test(value.applicationFingerprint) ||
    !Number.isSafeInteger(value.expectedScenarioIndex) ||
    value.expectedScenarioIndex < 0 ||
    value.expectedScenarioIndex >= scenarios.length ||
    !Number.isSafeInteger(value.expectedSequence) ||
    value.expectedSequence < 1 ||
    !SHA256.test(value.previousObservationSha256) ||
    !['existing', 'fresh-reinstall'].includes(value.installationMode) ||
    !B3_PROOF_ACTION_CODES.includes(value.actionCode) ||
    !SHA256.test(value.challengeSha256)
  ) {
    throw protocolError('B3 proof launch command authority, action or hash is invalid.');
  }
  if (canonicalBytes(value).byteLength > MAX_CANONICAL_BYTES) {
    throw protocolError('B3 proof launch command exceeds the canonical size bound.');
  }
  return clone(value);
}

const BUILD_AUTHORITY_KEYS = Object.freeze([
  'mode', 'proofKind', 'platform', 'distribution', 'publicSandboxOrigin',
  'workerName', 'bundleId', 'testedApplicationCommit', 'applicationFingerprint',
  'versionName', 'buildNumber',
]);

function validateBuildAuthority(rawValue, command) {
  const value = requireExactRecord(rawValue, BUILD_AUTHORITY_KEYS, 'B3 build authority');
  const nativePlatform = command.platform === 'ios-physical' ? 'ios' : 'android';
  const expectedDistribution = nativePlatform === 'ios' ? 'development' : 'play-internal';
  if (value.mode !== 'B3SandboxProof' || value.proofKind !== 'physical-live' ||
      value.platform !== nativePlatform || value.distribution !== expectedDistribution ||
      value.publicSandboxOrigin !== B3_PUBLIC_SANDBOX_ORIGIN ||
      value.workerName !== 'ks2-spelling-b3-sandbox' ||
      value.bundleId !== 'uk.eugnel.ks2spelling' ||
      value.testedApplicationCommit !== command.testedApplicationCommit ||
      value.applicationFingerprint !== command.applicationFingerprint ||
      value.versionName !== '0.3.0-b3' ||
      !((nativePlatform === 'ios' && /^\d+$/u.test(value.buildNumber)) ||
        (nativePlatform === 'android' && Number.isSafeInteger(value.buildNumber))) ||
      !Number.isSafeInteger(Number(value.buildNumber)) ||
      Number(value.buildNumber) <= 0) {
    throw protocolError('B3 build authority does not match the exact launch command.');
  }
  return value;
}

export async function deriveB3ProofBuildAuthoritySha256(rawOptions) {
  const options = requireExactRecord(
    snapshotCanonicalValue(rawOptions),
    ['command', 'buildAuthority'],
    'B3 build-authority derivation options',
  );
  const command = validateB3ProofLaunchCommand(options.command);
  const buildAuthority = validateBuildAuthority(options.buildAuthority, command);
  const authority = {
    platform: command.platform,
    testedApplicationCommit: command.testedApplicationCommit,
    applicationFingerprint: command.applicationFingerprint,
    buildAuthority,
  };
  return sha256(new TextEncoder().encode(
    `ks2-spelling:b3-build-authority:v1\u0000${canonicaliseB3ProofValue(authority)}`,
  ));
}

const PROHIBITED_KEY = /(?:jws|token|receipt|order(?:id|identifier)?|transaction(?:id|identifier|ref)|sealed(?:refresh)?handle|capability(?:url)?|account|tester|email|device(?:id|identifier)|learner(?:id|identifier)|nickname)/iu;
const PROHIBITED_VALUE = /(?:https?:\/\/|[?&](?:cap|token|handle)=|\bGPA\.|\bb3rh1\.|\b(?:Ada|Ben|learner-[ab])\b|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,})/iu;

function scanPrivacy(value, path = 'proofProjection') {
  if (typeof value === 'string') {
    if (PROHIBITED_VALUE.test(value)) {
      throw protocolError(`B3 proof privacy rejected prohibited material at ${path}.`);
    }
    return;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return;
  if (Array.isArray(value)) {
    if (value.length > 1_024) throw protocolError('B3 proof projection array exceeds its bound.');
    Reflect.ownKeys(value).slice(0, -1).forEach((key, index) => scanPrivacy(
      Object.getOwnPropertyDescriptor(value, key).value,
      `${path}[${index}]`,
    ));
    return;
  }
  if (!isPlainRecord(value)) throw protocolError('B3 proof projection contains unsafe data.');
  for (const key of Reflect.ownKeys(value)) {
    if (PROHIBITED_KEY.test(key)) {
      throw protocolError(`B3 proof privacy rejected prohibited key at ${path}.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw protocolError(`B3 proof privacy rejected an accessor at ${path}.`);
    }
    scanPrivacy(descriptor.value, `${path}.${key}`);
  }
}

export function validateB3GatewaySmokeAuthority(value) {
  if (value === null) return null;
  requireExactRecord(value, [
    'schemaVersion', 'deploymentVersionId', 'scriptAuthoritySha256',
    'signedEnvelopeSha256', 'objects', 'accessBehaviour', 'byteServingBehaviour',
  ], 'B3 gateway smoke authority');
  requireExactRecord(value.accessBehaviour, [
    'ttlSeconds', 'valid', 'tamperedRejected', 'expiredRejected',
    'canonicalEncodingRequired',
  ], 'B3 gateway capability smoke');
  requireExactRecord(value.byteServingBehaviour, [
    'full200', 'partial206', 'conditional304', 'unsatisfied416',
    'noRedirects', 'cacheControl',
  ], 'B3 gateway Range smoke');
  if (value.schemaVersion !== 1 || !UUID_V4.test(value.deploymentVersionId) ||
      !SHA256.test(value.scriptAuthoritySha256) ||
      !SHA256.test(value.signedEnvelopeSha256) || !Array.isArray(value.objects) ||
      value.objects.length !== B3_SMOKE_OBJECTS.length ||
      value.accessBehaviour.ttlSeconds !== 600 || value.accessBehaviour.valid !== true ||
      value.accessBehaviour.tamperedRejected !== true ||
      value.accessBehaviour.expiredRejected !== true ||
      value.accessBehaviour.canonicalEncodingRequired !== true ||
      value.byteServingBehaviour.full200 !== true ||
      value.byteServingBehaviour.partial206 !== true ||
      value.byteServingBehaviour.conditional304 !== true ||
      value.byteServingBehaviour.unsatisfied416 !== true ||
      value.byteServingBehaviour.noRedirects !== true ||
      value.byteServingBehaviour.cacheControl !== 'private, no-store') {
    throw protocolError('B3 gateway smoke authority is invalid.');
  }
  for (const [index, object] of value.objects.entries()) {
    requireExactRecord(
      object,
      ['role', 'key', 'sha256', 'size', 'etag'],
      `B3 gateway smoke object ${index}`,
    );
    const expected = B3_SMOKE_OBJECTS[index];
    if (object.role !== expected.role || object.key !== expected.key ||
        !SHA256.test(object.sha256) || !Number.isSafeInteger(object.size) ||
        object.size <= 0 || !R2_ETAG.test(object.etag)) {
      throw protocolError('B3 gateway smoke object authority or order is invalid.');
    }
  }
  if (value.signedEnvelopeSha256 !== value.objects[0].sha256) {
    throw protocolError('B3 gateway smoke envelope binding is invalid.');
  }
  return clone(value);
}

export function assertB3ProofProjectionPrivacy(rawValue) {
  const value = snapshotCanonicalValue(rawValue);
  scanPrivacy(value);
  requireExactRecord(value, PROJECTION_KEYS, 'B3 proof projection');
  validateB3GatewaySmokeAuthority(value.gatewaySmokeAuthority);
  requireExactRecord(
    value.syntheticLearners,
    ['syntheticAuthorityMatched', 'positionalSnapshotSha256'],
    'B3 synthetic learner projection',
  );
  requireExactRecord(
    value.transactionAuthority,
    ['source', 'crossCheckedOnRefresh', 'domainSeparatedDigestSha256', 'rawProofCleared'],
    'B3 transaction authority projection',
  );
  requireExactRecord(
    value.refreshHandleLifecycle,
    ['present', 'positiveVersionObserved', 'rotated', 'deleted'],
    'B3 refresh-handle lifecycle projection',
  );
  requireExactRecord(
    value.entitlementAuthority,
    ['id', 'state', 'domainSeparatedDigestSha256', 'refreshHandlePresent'],
    'B3 entitlement authority projection',
  );
  requireExactRecord(
    value.packAuthority,
    ['packId', 'manifestSha256', 'archiveSha256', 'installed'],
    'B3 pack authority projection',
  );
  requireExactRecord(
    value.transportAuthority,
    ['storeAdapter', 'gatewayAdapter', 'serverUrl', 'nativeOriginAllowed', 'noRedirects'],
    'B3 transport authority projection',
  );
  requireExactRecord(
    value.storeAuthority,
    ['environment', 'productId', 'localisedPriceObserved', 'completionState'],
    'B3 store authority projection',
  );
  const learnerDigests = value.syntheticLearners.positionalSnapshotSha256;
  const transactionDigest = value.transactionAuthority.domainSeparatedDigestSha256;
  const entitlementAuthority = value.entitlementAuthority;
  const packAuthority = value.packAuthority;
  if (value.storeAuthority.environment !== 'sandbox' ||
      !['uk.eugnel.ks2spelling.fullks2', 'full_ks2'].includes(value.storeAuthority.productId) ||
      typeof value.storeAuthority.localisedPriceObserved !== 'boolean' ||
      !['not-observed', 'finished', 'acknowledged'].includes(value.storeAuthority.completionState) ||
      value.storeCompletionObserved !==
        (value.storeAuthority.completionState !== 'not-observed')) {
    throw protocolError('B3 store authority projection is invalid.');
  }
  if (!Array.isArray(value.storeEvents) || value.storeEvents.length > 128) {
    throw protocolError('B3 proof store-event projection exceeds its bound.');
  }
  for (const [index, event] of value.storeEvents.entries()) {
    requireExactRecord(event, ['operation', 'outcome'], `B3 proof store event ${index}`);
    if (![
      'queryProducts', 'purchase', 'queryTransactions', 'restore',
      'finishTransaction', 'transaction-update',
    ].includes(event.operation) || ![
      'products-visible', 'products-absent', 'none', 'cancelled', 'pending',
      'purchased', 'revoked', 'unverified', 'finished', 'completion-pending',
    ].includes(event.outcome)) {
      throw protocolError('B3 proof store-event authority is invalid.');
    }
  }
  if (!Array.isArray(value.gatewayCalls) || value.gatewayCalls.length > 16) {
    throw protocolError('B3 proof gateway call projection exceeds its bound.');
  }
  const traceIds = new Set();
  for (const [index, call] of value.gatewayCalls.entries()) {
    requireExactRecord(
      call,
      ['operation', 'relation', 'traceId'],
      `B3 proof gateway call ${index}`,
    );
    if (!['verify', 'complete', 'refresh', 'authorise'].includes(call.operation) ||
        !B3_PROOF_GATEWAY_RELATIONS.includes(call.relation) ||
        !UUID_V4.test(call.traceId) || traceIds.has(call.traceId)) {
      throw protocolError('B3 proof gateway call authority, order or uniqueness is invalid.');
    }
    traceIds.add(call.traceId);
  }
  if (
    !SHA256.test(value.challengeSha256) ||
    !['in-progress', ...B3_PROOF_SCENARIO_OUTCOME_VALUES]
      .includes(value.scenarioOutcome) ||
    !['none', 'pending', 'active', 'revoked'].includes(value.entitlementState) ||
    !['absent', 'queued', 'downloading', 'installed', 'locked'].includes(value.packState) ||
    typeof value.storeCompletionObserved !== 'boolean' ||
    value.syntheticLearners.syntheticAuthorityMatched !== true ||
    !Array.isArray(learnerDigests) ||
    learnerDigests.length !== 2 ||
    !learnerDigests.every((entry) => SHA256.test(entry)) ||
    !['none', 'apple-transaction-id', 'google-order-id'].includes(
      value.transactionAuthority.source,
    ) ||
    typeof value.transactionAuthority.crossCheckedOnRefresh !== 'boolean' ||
    typeof value.transactionAuthority.rawProofCleared !== 'boolean' ||
    !(
      (value.transactionAuthority.source === 'none' && transactionDigest === null) ||
      (value.transactionAuthority.source !== 'none' && SHA256.test(transactionDigest))
    ) ||
    entitlementAuthority.state !== value.entitlementState ||
    entitlementAuthority.refreshHandlePresent !== value.refreshHandleLifecycle.present ||
    !(
      (entitlementAuthority.state === 'none' && entitlementAuthority.id === null &&
       entitlementAuthority.domainSeparatedDigestSha256 === null &&
       entitlementAuthority.refreshHandlePresent === false) ||
      (['active', 'revoked'].includes(entitlementAuthority.state) &&
       entitlementAuthority.id === 'full-ks2' &&
       SHA256.test(entitlementAuthority.domainSeparatedDigestSha256))
    ) ||
    !(
      (packAuthority.installed === false && packAuthority.packId === null &&
       packAuthority.manifestSha256 === null && packAuthority.archiveSha256 === null) ||
      (packAuthority.installed === true && packAuthority.packId === 'b3-sandbox-proof' &&
       SHA256.test(packAuthority.manifestSha256) && SHA256.test(packAuthority.archiveSha256) &&
       ['installed', 'locked'].includes(value.packState))
    ) ||
    (value.packState === 'installed' && packAuthority.installed !== true) ||
    value.transportAuthority.storeAdapter !== 'concreteCapacitorStore' ||
    value.transportAuthority.gatewayAdapter !== 'concreteHttpGateway' ||
    value.transportAuthority.serverUrl !== null ||
    value.transportAuthority.nativeOriginAllowed !== true ||
    value.transportAuthority.noRedirects !== true ||
    Reflect.ownKeys(value.refreshHandleLifecycle).some((key) =>
      typeof Object.getOwnPropertyDescriptor(value.refreshHandleLifecycle, key).value !== 'boolean')
  ) {
    throw protocolError('B3 proof projection authority or bound is invalid.');
  }
  if (canonicalBytes(value).byteLength > MAX_CANONICAL_BYTES) {
    throw protocolError('B3 proof projection exceeds the canonical size bound.');
  }
  return clone(value);
}

const TRANSITION_EDGES = Object.freeze({
  UNBOUND: Object.freeze(['ARMED']),
  ARMED: Object.freeze(['WAITING_OPERATOR', 'OBSERVING']),
  WAITING_OPERATOR: Object.freeze(['OBSERVING']),
  OBSERVING: Object.freeze(['HOLD_REACHED', 'SCENARIO_COMPLETE']),
  HOLD_REACHED: Object.freeze(['HOST_FORCE_STOP']),
  HOST_FORCE_STOP: Object.freeze(['RELAUNCH_RECOVERY']),
  RELAUNCH_RECOVERY: Object.freeze(['SCENARIO_COMPLETE']),
  SCENARIO_COMPLETE: Object.freeze([
    'ARMED', 'RELAUNCH_RECOVERY', 'REBIND_FRESH_INSTALL', 'TERMINAL_CAPTURE',
  ]),
  REBIND_FRESH_INSTALL: Object.freeze(['ARMED', 'OBSERVING', 'TERMINAL_CAPTURE']),
  TERMINAL_CAPTURE: Object.freeze(['MANUAL_ATTESTATION']),
  MANUAL_ATTESTATION: Object.freeze(['COMPLETE']),
  COMPLETE: Object.freeze([]),
});

const NEXT_ACTIONS_BY_PHASE = Object.freeze({
  UNBOUND: Object.freeze(['ARM_CAPTURE']),
  ARMED: Object.freeze([
    'OBSERVE', 'QUERY_PRODUCT', 'CANCEL_PURCHASE',
    'INITIATE_PURCHASE', 'APPROVE_PENDING_PURCHASE', 'DECLINE_PENDING_PURCHASE',
    'INSTALL_PACK', 'RESTORE_PURCHASES', 'REDOWNLOAD_PACK',
    'OBSERVE_REVOCATION', 'ARM_GATEWAY_COMPLETION_HOLD',
  ]),
  WAITING_OPERATOR: Object.freeze([
    'OBSERVE', 'CANCEL_PURCHASE', 'INITIATE_PURCHASE',
    'APPROVE_PENDING_PURCHASE', 'DECLINE_PENDING_PURCHASE',
    'OBSERVE_REVOCATION',
  ]),
  OBSERVING: Object.freeze([
    'OBSERVE', 'APPROVE_PENDING_PURCHASE', 'DECLINE_PENDING_PURCHASE',
    'ARM_GATEWAY_COMPLETION_HOLD',
  ]),
  HOLD_REACHED: Object.freeze(['RELAUNCH']),
  HOST_FORCE_STOP: Object.freeze(['RELAUNCH']),
  RELAUNCH_RECOVERY: Object.freeze(['OBSERVE', 'ARM_CAPTURE']),
  SCENARIO_COMPLETE: Object.freeze([
    'ARM_CAPTURE', 'REBIND_FRESH_INSTALL', 'CAPTURE_TERMINAL',
  ]),
  REBIND_FRESH_INSTALL: Object.freeze(['ARM_CAPTURE', 'OBSERVE']),
  TERMINAL_CAPTURE: Object.freeze(['COMPLETE_CAPTURE']),
  MANUAL_ATTESTATION: Object.freeze(['COMPLETE_CAPTURE']),
  COMPLETE: Object.freeze(['COMPLETE_CAPTURE']),
});

function validateTransitions(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > B3_PROOF_PHASES.length) {
    throw protocolError('B3 proof completed transition list is invalid.');
  }
  for (const [index, phase] of value.entries()) {
    if (!B3_PROOF_PHASES.includes(phase)) throw protocolError('B3 proof phase is unknown.');
    if (index > 0 && !TRANSITION_EDGES[value[index - 1]].includes(phase)) {
      throw protocolError('B3 proof transition sequence contains an illegal edge.');
    }
  }
  return value;
}

function validateObservationShape(rawValue) {
  const value = requireExactRecord(
    snapshotCanonicalValue(rawValue),
    OBSERVATION_KEYS,
    'B3 proof observation',
  );
  const scenarios = PLATFORMS[value.platform];
  const transitions = validateTransitions(value.completedTransitions);
  const projection = assertB3ProofProjectionPrivacy(value.proofProjection);
  const expectedStoreProductId = value.platform === 'ios-physical'
    ? 'uk.eugnel.ks2spelling.fullks2'
    : 'full_ks2';
  const expectedCompletionState = value.platform === 'ios-physical' ? 'finished' : 'acknowledged';
  const expectedGatewayCalls = B3_PROOF_GATEWAY_CALLS[value.platform]?.[value.scenario];
  const expectedScenarioOutcome = B3_PROOF_SCENARIO_OUTCOMES[value.platform]?.[value.scenario];
  const outcomeIsTerminal = value.phase === 'SCENARIO_COMPLETE' ||
    (value.platform === 'ios-physical' && value.scenario === 'normal-purchase' &&
      value.phase === 'HOLD_REACHED');
  const requiresClearedRawProof = [
    'unfinished-relaunch', 'unacknowledged-relaunch', 'pack-install',
    'restore-after-reinstall', 'redownload', 'refund-revoke',
  ].includes(value.scenario);
  const gatewaySegmentStarts = expectedGatewayCalls
    ? Array.from({ length: expectedGatewayCalls.length - projection.gatewayCalls.length + 1 },
      (_, index) => index)
      .filter((start) => projection.gatewayCalls.every((call, index) =>
        call.operation === expectedGatewayCalls[start + index]?.operation &&
        call.relation === expectedGatewayCalls[start + index]?.relation))
    : [];
  if (!expectedGatewayCalls || gatewaySegmentStarts.length === 0) {
    throw protocolError('B3 proof gateway calls do not match a production trace segment.');
  }
  if (projection.storeAuthority.productId !== expectedStoreProductId ||
      !['not-observed', expectedCompletionState]
        .includes(projection.storeAuthority.completionState)) {
    throw protocolError('B3 store authority does not match the physical platform.');
  }
  if ((outcomeIsTerminal && projection.scenarioOutcome !== expectedScenarioOutcome) ||
      (!outcomeIsTerminal && projection.scenarioOutcome !== 'in-progress') ||
      (outcomeIsTerminal && requiresClearedRawProof &&
       projection.transactionAuthority.rawProofCleared !== true)) {
    throw protocolError('B3 proof scenario outcome does not match the device-observed phase.');
  }
  if (
    value.schemaVersion !== 1 ||
    !scenarios ||
    !SHA256.test(value.buildAuthoritySha256) ||
    !UUID_V4.test(value.captureId) ||
    !UUID_V4.test(value.installationId) ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    !SHA256.test(value.previousObservationSha256) ||
    !Number.isSafeInteger(value.scenarioIndex) ||
    value.scenarioIndex < 0 ||
    value.scenarioIndex >= scenarios.length ||
    value.scenario !== scenarios[value.scenarioIndex] ||
    !B3_PROOF_PHASES.includes(value.phase) ||
    value.phase !== transitions.at(-1) ||
    !B3_PROOF_ACTION_CODES.includes(value.nextActionCode) ||
    !NEXT_ACTIONS_BY_PHASE[value.phase].includes(value.nextActionCode) ||
    !exactUtc(value.observedAt) ||
    !SHA256.test(value.observationSha256)
  ) {
    throw protocolError('B3 proof observation authority, phase or hash is invalid.');
  }
  return { value, projection };
}

async function expectedObservationHash(value) {
  const unsigned = clone(value);
  delete unsigned.observationSha256;
  return sha256(canonicalBytes(unsigned));
}

function assertCommandBinding(value, projection, command) {
  const holdScenario = ['normal-purchase', 'unacknowledged-relaunch'].includes(
    value.scenario,
  );
  const recoveryScenario = ['unfinished-relaunch', 'unacknowledged-relaunch'].includes(
    value.scenario,
  );
  if (
    value.platform !== command.platform ||
    value.captureId !== command.captureId ||
    value.scenarioIndex !== command.expectedScenarioIndex ||
    value.sequence !== command.expectedSequence ||
    value.previousObservationSha256 !== command.previousObservationSha256 ||
    projection.challengeSha256 !== command.challengeSha256
  ) {
    throw protocolError(
      'B3 proof observation sequence, scenario or challenge does not bind its launch command.',
    );
  }
  if (value.sequence === 1 && (
    command.actionCode !== 'ARM_CAPTURE' ||
    value.completedTransitions[0] !== 'UNBOUND' ||
    value.phase === 'COMPLETE'
  )) {
    throw protocolError('Initial B3 proof sequence must begin with ARM_CAPTURE from UNBOUND.');
  }
  if (
    command.actionCode === 'COMPLETE_CAPTURE' ||
    (command.actionCode === 'ARM_GATEWAY_COMPLETION_HOLD' && !holdScenario) ||
    (['HOLD_REACHED', 'HOST_FORCE_STOP'].includes(value.phase) && !holdScenario) ||
    (value.phase === 'RELAUNCH_RECOVERY' && !recoveryScenario) ||
    (command.installationMode === 'fresh-reinstall' && (
      !['REBIND_FRESH_INSTALL', 'SCENARIO_COMPLETE'].includes(value.phase) ||
      value.scenario !== 'restore-after-reinstall' ||
      command.actionCode !== 'REBIND_FRESH_INSTALL'
    )) ||
    (command.installationMode === 'existing' &&
      (value.phase === 'REBIND_FRESH_INSTALL' ||
       command.actionCode === 'REBIND_FRESH_INSTALL'))
  ) {
    throw protocolError('B3 proof action is not applicable to this scenario or installation.');
  }
}

function assertHostChain(value, command, previous) {
  if (previous === null) return;
  const scenarioAdvance = value.scenarioIndex - previous.scenarioIndex;
  const firstPhase = value.completedTransitions[0];
  const previousPending = previous.proofProjection.storeEvents.some((event) =>
    event.operation === 'purchase' && event.outcome === 'pending');
  const previousPendingWithoutAccess = previous.proofProjection.entitlementState === 'none' &&
    previous.proofProjection.packState === 'absent' &&
    previous.proofProjection.storeCompletionObserved === false &&
    previous.proofProjection.entitlementAuthority.id === null &&
    previous.proofProjection.entitlementAuthority.state === 'none' &&
    previous.proofProjection.entitlementAuthority.refreshHandlePresent === false &&
    previous.proofProjection.packAuthority.packId === null &&
    previous.proofProjection.packAuthority.installed === false;
  const currentPending = value.proofProjection.storeEvents.some((event) =>
    ['queryTransactions', 'transaction-update', 'purchase'].includes(event.operation) &&
    ['none', 'pending'].includes(event.outcome));
  const currentPendingWithoutAccess = value.proofProjection.entitlementState === 'none' &&
    value.proofProjection.packState === 'absent' &&
    value.proofProjection.storeCompletionObserved === false &&
    value.proofProjection.entitlementAuthority.id === null &&
    value.proofProjection.entitlementAuthority.state === 'none' &&
    value.proofProjection.entitlementAuthority.refreshHandlePresent === false &&
    value.proofProjection.packAuthority.packId === null &&
    value.proofProjection.packAuthority.installed === false && currentPending;
  const declinedWithoutAccess = value.proofProjection.entitlementState === 'none' &&
    value.proofProjection.packState === 'absent' &&
    value.proofProjection.entitlementAuthority.id === null &&
    value.proofProjection.entitlementAuthority.state === 'none' &&
    value.proofProjection.entitlementAuthority.domainSeparatedDigestSha256 === null &&
    value.proofProjection.entitlementAuthority.refreshHandlePresent === false &&
    value.proofProjection.packAuthority.packId === null &&
    value.proofProjection.packAuthority.manifestSha256 === null &&
    value.proofProjection.packAuthority.archiveSha256 === null &&
    value.proofProjection.packAuthority.installed === false &&
    value.proofProjection.transactionAuthority.source === 'none' &&
    value.proofProjection.transactionAuthority.domainSeparatedDigestSha256 === null &&
    value.proofProjection.transactionAuthority.rawProofCleared === false &&
    !value.proofProjection.storeEvents.some((event) => event.outcome === 'purchased');
  const androidDeclineBridge = previous.platform === 'android-play-physical' &&
    previous.scenario === 'slow-card-pending-decline' && previous.phase === 'OBSERVING' &&
    previous.nextActionCode === 'DECLINE_PENDING_PURCHASE' && previousPending &&
    scenarioAdvance === 1 && value.scenario === 'slow-card-pending-approve' &&
    command.actionCode === 'ARM_CAPTURE' && firstPhase === 'ARMED' && declinedWithoutAccess &&
    value.proofProjection.storeEvents.some((event) =>
      event.operation === 'queryTransactions' &&
      ['none', 'cancelled'].includes(event.outcome));
  const androidApproveDecision = previous.platform === 'android-play-physical' &&
    previous.scenario === 'slow-card-pending-approve' && previous.phase === 'OBSERVING' &&
    previous.nextActionCode === 'APPROVE_PENDING_PURCHASE' && previousPending &&
    previousPendingWithoutAccess &&
    scenarioAdvance === 1 && value.scenario === 'unacknowledged-relaunch' &&
    command.actionCode === 'ARM_GATEWAY_COMPLETION_HOLD';
  const androidApprovePendingBridge = androidApproveDecision &&
    value.phase === 'OBSERVING' && firstPhase === 'ARMED' &&
    value.nextActionCode === 'ARM_GATEWAY_COMPLETION_HOLD' && currentPendingWithoutAccess;
  const androidApproveBridge = androidApproveDecision &&
    value.phase === 'HOLD_REACHED' && firstPhase === 'ARMED' &&
    value.proofProjection.entitlementState === 'active' &&
    value.proofProjection.storeCompletionObserved === false &&
    value.proofProjection.storeEvents.some((event) =>
      ['queryTransactions', 'transaction-update'].includes(event.operation) &&
      event.outcome === 'purchased');
  const hostStoreDecisionBridge = androidDeclineBridge || androidApprovePendingBridge ||
    androidApproveBridge;
  if (command.actionCode !== previous.nextActionCode && !hostStoreDecisionBridge) {
    throw protocolError('B3 proof command does not match the prior next action.');
  }
  if (previous.phase === 'COMPLETE') {
    throw protocolError('B3 proof terminal state cannot be duplicated.');
  }
  if (scenarioAdvance === 1) {
    if (hostStoreDecisionBridge) return;
    const iosRecoveryBridge = previous.platform === 'ios-physical' &&
      previous.scenario === 'normal-purchase' && previous.phase === 'HOLD_REACHED' &&
      value.scenario === 'unfinished-relaunch' && command.actionCode === 'RELAUNCH' &&
      firstPhase === 'HOST_FORCE_STOP';
    if (iosRecoveryBridge) return;
    if (previous.phase !== 'SCENARIO_COMPLETE') {
      throw protocolError('B3 proof scenario cannot advance before scenario completion.');
    }
    if (command.installationMode === 'fresh-reinstall') {
      if (firstPhase !== 'REBIND_FRESH_INSTALL') {
        throw protocolError('Fresh reinstall must enter through REBIND_FRESH_INSTALL.');
      }
    } else {
      const recoveryAdvance = previous.scenario === 'normal-purchase' &&
        value.scenario === 'unfinished-relaunch' && command.actionCode === 'RELAUNCH';
      if (firstPhase !== (recoveryAdvance ? 'RELAUNCH_RECOVERY' : 'ARMED')) {
        throw protocolError('B3 proof scenario advance entered through an invalid phase.');
      }
    }
    return;
  }
  if (previous.phase === 'SCENARIO_COMPLETE') {
    const terminalCapture = previous.scenarioIndex === 8 &&
      firstPhase === 'TERMINAL_CAPTURE' && command.actionCode === 'CAPTURE_TERMINAL';
    if (!terminalCapture) {
      throw protocolError('B3 proof completed scenario or terminal state was duplicated.');
    }
    return;
  }
  if (scenarioAdvance !== 0) {
    throw protocolError('B3 proof scenario index moved without an approved transition.');
  }
  const androidApprovePollingBridge = previous.platform === 'android-play-physical' &&
    previous.scenario === 'unacknowledged-relaunch' && previous.phase === 'OBSERVING' &&
    previous.nextActionCode === 'ARM_GATEWAY_COMPLETION_HOLD' &&
    previousPendingWithoutAccess && command.actionCode === 'ARM_GATEWAY_COMPLETION_HOLD' &&
    value.scenario === 'unacknowledged-relaunch' && (
      (value.phase === 'OBSERVING' && currentPendingWithoutAccess) ||
      (value.phase === 'HOLD_REACHED' &&
       value.proofProjection.entitlementState === 'active' &&
       value.proofProjection.storeCompletionObserved === false)
    );
  if (androidApprovePollingBridge) return;
  const androidForceStopBridge = previous.platform === 'android-play-physical' &&
    previous.scenario === 'unacknowledged-relaunch' && previous.phase === 'HOLD_REACHED' &&
    previous.nextActionCode === 'RELAUNCH' && command.actionCode === 'RELAUNCH' &&
    value.scenario === 'unacknowledged-relaunch' && firstPhase === 'HOST_FORCE_STOP';
  if (androidForceStopBridge) return;
  const previousTransitions = previous.completedTransitions;
  const extendsCumulativePrefix = value.completedTransitions.length > previousTransitions.length &&
    previousTransitions.every((phase, index) => value.completedTransitions[index] === phase);
  if (!extendsCumulativePrefix) {
    throw protocolError('B3 proof observation skipped or reordered a cross-observation phase.');
  }
}

async function assertObservationIntegrity(value) {
  if (value.observationSha256 !== await expectedObservationHash(value)) {
    throw protocolError('B3 proof observation self-hash is invalid.');
  }
  if (canonicalBytes(value).byteLength > MAX_CANONICAL_BYTES) {
    throw protocolError('B3 proof observation exceeds the canonical size bound.');
  }
}

function snapshotValidationOptions(rawOptions, { publication = false } = {}) {
  if (!isPlainRecord(rawOptions)) {
    throw protocolError('B3 proof observation validation options are invalid.');
  }
  const allowed = publication
    ? ['command', 'buildAuthority']
    : ['command', 'buildAuthority', 'previousObservation', 'canonicalBytes'];
  const keys = Reflect.ownKeys(rawOptions);
  if (!keys.includes('command') || !keys.includes('buildAuthority') ||
      (publication && keys.length !== allowed.length) ||
      keys.some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(rawOptions, key);
        return typeof key !== 'string' || !allowed.includes(key) ||
          !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value');
      })) {
    throw protocolError('B3 proof observation validation options are invalid.');
  }
  const result = {
    command: snapshotCanonicalValue(
      Object.getOwnPropertyDescriptor(rawOptions, 'command').value,
    ),
    buildAuthority: snapshotCanonicalValue(
      Object.getOwnPropertyDescriptor(rawOptions, 'buildAuthority').value,
    ),
  };
  if (Object.hasOwn(rawOptions, 'previousObservation')) {
    result.previousObservation = snapshotCanonicalValue(
      Object.getOwnPropertyDescriptor(rawOptions, 'previousObservation').value,
    );
  }
  if (Object.hasOwn(rawOptions, 'canonicalBytes')) {
    const supplied = Object.getOwnPropertyDescriptor(rawOptions, 'canonicalBytes').value;
    if (typeof supplied !== 'string' && !(supplied instanceof Uint8Array)) {
      throw protocolError('B3 proof canonical bytes are invalid.');
    }
    result.canonicalBytes = typeof supplied === 'string'
      ? supplied
      : new Uint8Array(supplied);
  }
  return result;
}

export async function validateB3ProofObservationForPublication(rawValue, options = {}) {
  const { value, projection } = validateObservationShape(rawValue);
  const safeOptions = snapshotValidationOptions(options, { publication: true });
  const command = validateB3ProofLaunchCommand(safeOptions.command);
  const expectedBuildAuthoritySha256 = await deriveB3ProofBuildAuthoritySha256({
    command,
    buildAuthority: safeOptions.buildAuthority,
  });
  if (value.buildAuthoritySha256 !== expectedBuildAuthoritySha256) {
    throw protocolError('B3 proof observation build authority is invalid.');
  }
  assertCommandBinding(value, projection, command);
  await assertObservationIntegrity(value);
  return clone(value);
}

export async function validateB3ProofObservation(rawValue, options = {}) {
  const { value, projection } = validateObservationShape(rawValue);
  const safeOptions = snapshotValidationOptions(options);
  const command = validateB3ProofLaunchCommand(safeOptions.command);
  const expectedBuildAuthoritySha256 = await deriveB3ProofBuildAuthoritySha256({
    command,
    buildAuthority: safeOptions.buildAuthority,
  });
  if (value.buildAuthoritySha256 !== expectedBuildAuthoritySha256) {
    throw protocolError('B3 proof observation build authority is invalid.');
  }
  const previous = safeOptions.previousObservation ?? null;
  assertCommandBinding(value, projection, command);
  if (previous === null) {
    if (command.installationMode === 'fresh-reinstall' ||
        command.expectedSequence !== 1 ||
        command.previousObservationSha256 !== INITIAL_OBSERVATION_SHA256) {
      throw protocolError('B3 proof observation is missing its required prior chain authority.');
    }
  } else {
    const previousShape = validateObservationShape(previous).value;
    if (previousShape.buildAuthoritySha256 !== expectedBuildAuthoritySha256 ||
        previousShape.observationSha256 !== await expectedObservationHash(previousShape)) {
      throw protocolError('Prior B3 proof observation hash is invalid.');
    }
    if (
      value.captureId !== previousShape.captureId ||
      value.platform !== previousShape.platform ||
      value.previousObservationSha256 !== previousShape.observationSha256 ||
      value.sequence !== previousShape.sequence + 1 ||
      value.scenarioIndex < previousShape.scenarioIndex ||
      value.scenarioIndex > previousShape.scenarioIndex + 1
    ) {
      throw protocolError('B3 proof observation sequence or scenario is not monotonic.');
    }
    assertHostChain(value, command, previousShape);
    if (command?.installationMode === 'fresh-reinstall') {
      if (value.installationId === previousShape.installationId) {
        throw protocolError('Fresh reinstall retained its prior installation identifier.');
      }
    } else if (value.installationId !== previousShape.installationId) {
      throw protocolError('Existing installation unexpectedly changed identity.');
    }
  }
  await assertObservationIntegrity(value);
  if (safeOptions.canonicalBytes !== undefined) {
    const supplied = typeof safeOptions.canonicalBytes === 'string'
      ? new TextEncoder().encode(safeOptions.canonicalBytes)
      : safeOptions.canonicalBytes;
    if (!(supplied instanceof Uint8Array) ||
        new TextDecoder('utf-8', { fatal: true }).decode(supplied) !==
          canonicaliseB3ProofValue(value)) {
      throw protocolError('B3 proof observation bytes are not canonical.');
    }
  }
  return clone(value);
}

export async function validateB3ProofObservationBytes(rawBytes, options) {
  const unsafeBytes = typeof rawBytes === 'string'
    ? new TextEncoder().encode(rawBytes)
    : rawBytes;
  if (!(unsafeBytes instanceof Uint8Array) || unsafeBytes.byteLength === 0 ||
      unsafeBytes.byteLength > MAX_CANONICAL_BYTES) {
    throw protocolError('B3 proof observation bytes exceed their bound.');
  }
  const bytes = new Uint8Array(unsafeBytes);
  let decoded;
  let value;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    value = JSON.parse(decoded);
  } catch {
    throw protocolError('B3 proof observation bytes are not valid UTF-8 JSON.');
  }
  return validateB3ProofObservation(value, { ...options, canonicalBytes: bytes });
}

const OBSERVATION_INPUT_KEYS = Object.freeze([
  'command',
  'buildAuthority',
  'installationId',
  'sequence',
  'scenario',
  'phase',
  'nextActionCode',
  'completedTransitions',
  'proofProjection',
  'observedAt',
]);

export async function createB3ProofObservation(rawInput) {
  const input = requireExactRecord(
    snapshotCanonicalValue(rawInput),
    OBSERVATION_INPUT_KEYS,
    'B3 proof observation input',
  );
  const command = validateB3ProofLaunchCommand(input.command);
  const buildAuthoritySha256 = await deriveB3ProofBuildAuthoritySha256({
    command,
    buildAuthority: input.buildAuthority,
  });
  const value = {
    schemaVersion: 1,
    platform: command.platform,
    buildAuthoritySha256,
    captureId: command.captureId,
    installationId: input.installationId,
    sequence: input.sequence,
    previousObservationSha256: command.previousObservationSha256,
    scenarioIndex: command.expectedScenarioIndex,
    scenario: input.scenario,
    phase: input.phase,
    nextActionCode: input.nextActionCode,
    completedTransitions: clone(input.completedTransitions),
    proofProjection: assertB3ProofProjectionPrivacy(input.proofProjection),
    observedAt: input.observedAt,
    observationSha256: '0'.repeat(64),
  };
  validateObservationShape(value);
  if (value.sequence !== command.expectedSequence ||
      value.proofProjection.challengeSha256 !== command.challengeSha256) {
    throw protocolError('B3 proof observation input does not bind its launch command.');
  }
  value.observationSha256 = await expectedObservationHash(value);
  return validateB3ProofObservationForPublication(value, {
    command,
    buildAuthority: input.buildAuthority,
  });
}
