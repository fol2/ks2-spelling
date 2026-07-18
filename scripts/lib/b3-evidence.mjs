import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

import { canonicaliseB3ProofValue } from '../../src/app/b3-live-proof-protocol.js';

const HASH = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const R2_ETAG = /^[0-9a-f]{32}$/u;
const ACCOUNT = /^[0-9a-f]{32}$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const MANIFEST_KEY = 'packs/b3-sandbox-proof/1.0.0-b3.1/signed-manifest.json';
const ARCHIVE_KEY = 'packs/b3-sandbox-proof/1.0.0-b3.1/b3-sandbox-proof.zip';
const syntheticLearnerBytes = await readFile(new URL('../../config/b3-synthetic-learners.json', import.meta.url));
const syntheticLearnerDocument = JSON.parse(syntheticLearnerBytes.toString('utf8'));
if (!isDeepStrictEqual(Object.keys(syntheticLearnerDocument).sort(), ['learners', 'schemaVersion', 'v1CellTypeAndBytesSha256']) ||
    syntheticLearnerDocument.schemaVersion !== 1 || !Array.isArray(syntheticLearnerDocument.learners) ||
    syntheticLearnerDocument.learners.length !== 2 ||
    !isDeepStrictEqual(syntheticLearnerDocument.learners.map(({ learnerId, nickname }) => ({ learnerId, nickname })), [
      { learnerId: 'learner-a', nickname: 'Ada' },
      { learnerId: 'learner-b', nickname: 'Ben' },
    ]) || syntheticLearnerDocument.learners.some((learner) =>
      !isDeepStrictEqual(Object.keys(learner).sort(), ['afterFreshInstallReseedSnapshotSha256', 'beforePurchaseSnapshotSha256', 'learnerId', 'nickname']) ||
      !HASH.test(learner.beforePurchaseSnapshotSha256) || !HASH.test(learner.afterFreshInstallReseedSnapshotSha256))) {
  throw new Error('tracked B3 synthetic learner authority is invalid');
}
export const B3_SYNTHETIC_LEARNER_AUTHORITY_SHA256 = createHash('sha256').update(syntheticLearnerBytes).digest('hex');
export const B3_SYNTHETIC_LEARNER_DIGESTS = Object.freeze({
  'before-purchase': Object.freeze({
    learnerA: syntheticLearnerDocument.learners[0].beforePurchaseSnapshotSha256,
    learnerB: syntheticLearnerDocument.learners[1].beforePurchaseSnapshotSha256,
  }),
  'after-fresh-install-reseed': Object.freeze({
    learnerA: syntheticLearnerDocument.learners[0].afterFreshInstallReseedSnapshotSha256,
    learnerB: syntheticLearnerDocument.learners[1].afterFreshInstallReseedSnapshotSha256,
  }),
});

export const B3_REQUIRED_SECRET_NAMES = Object.freeze([
  'APPLE_IAP_ISSUER_ID',
  'APPLE_IAP_KEY_ID',
  'APPLE_IAP_PRIVATE_KEY',
  'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON',
  'ENTITLEMENT_HANDLE_KEY_CURRENT',
  'ENTITLEMENT_HANDLE_KEY_PREVIOUS',
  'R2_CAPABILITY_HMAC_KEY',
]);

function freezeGatewayCalls(value) {
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([platform, scenarios]) => [
    platform,
    Object.freeze(Object.fromEntries(Object.entries(scenarios).map(([scenario, calls]) => [
      scenario,
      Object.freeze(calls.map((call) => Object.freeze({ ...call }))),
    ]))),
  ])));
}

export const B3_EVIDENCE_GATEWAY_CALLS = freezeGatewayCalls({
  'ios-physical': {
    'product-query': [], cancel: [], 'ask-to-buy-pending': [],
    'normal-purchase': [{ operation: 'verify', relation: 'transaction-verification' }],
    'unfinished-relaunch': [
      { operation: 'verify', relation: 'recovery-reverification' },
      { operation: 'complete', relation: 'completion-of-prior-verify' },
      { operation: 'authorise', relation: 'download-job-authorisation' },
      { operation: 'refresh', relation: 'post-recovery-handle-refresh' },
    ],
    'pack-install': [{ operation: 'authorise', relation: 'download-capability-authorisation' }],
    'restore-after-reinstall': [
      { operation: 'verify', relation: 'fresh-install-startup-verification' },
      { operation: 'complete', relation: 'fresh-install-startup-completion' },
      { operation: 'authorise', relation: 'fresh-install-download-job-authorisation' },
      { operation: 'refresh', relation: 'fresh-install-handle-refresh' },
    ],
    redownload: [{ operation: 'authorise', relation: 'redownload-capability-authorisation' }],
    'refund-revoke': [{ operation: 'refresh', relation: 'revocation-handle-refresh' }],
  },
  'android-play-physical': {
    'product-query': [], cancel: [], 'slow-card-pending-decline': [],
    'slow-card-pending-approve': [],
    'unacknowledged-relaunch': [
      { operation: 'verify', relation: 'transaction-verification' },
      { operation: 'verify', relation: 'recovery-reverification' },
      { operation: 'complete', relation: 'completion-of-prior-verify' },
      { operation: 'authorise', relation: 'download-job-authorisation' },
      { operation: 'refresh', relation: 'post-recovery-handle-refresh' },
    ],
    'pack-install': [{ operation: 'authorise', relation: 'download-capability-authorisation' }],
    'restore-after-reinstall': [
      { operation: 'verify', relation: 'fresh-install-startup-verification' },
      { operation: 'complete', relation: 'fresh-install-startup-completion' },
      { operation: 'authorise', relation: 'fresh-install-download-job-authorisation' },
      { operation: 'refresh', relation: 'fresh-install-handle-refresh' },
    ],
    redownload: [{ operation: 'authorise', relation: 'redownload-capability-authorisation' }],
    'refund-revoke': [{ operation: 'refresh', relation: 'revocation-handle-refresh' }],
  },
});

export const B3_IOS_SCENARIOS = Object.freeze([
  { scenario: 'product-query', outcome: 'products-visible', traces: [] },
  { scenario: 'cancel', outcome: 'cancelled', traces: [] },
  { scenario: 'ask-to-buy-pending', outcome: 'pending-no-access', traces: [] },
  { scenario: 'normal-purchase', outcome: 'verified-active', traces: B3_EVIDENCE_GATEWAY_CALLS['ios-physical']['normal-purchase'] },
  { scenario: 'unfinished-relaunch', outcome: 'finished-recovered', traces: B3_EVIDENCE_GATEWAY_CALLS['ios-physical']['unfinished-relaunch'] },
  { scenario: 'pack-install', outcome: 'installed', traces: B3_EVIDENCE_GATEWAY_CALLS['ios-physical']['pack-install'] },
  { scenario: 'restore-after-reinstall', outcome: 'restored-active', traces: B3_EVIDENCE_GATEWAY_CALLS['ios-physical']['restore-after-reinstall'] },
  { scenario: 'redownload', outcome: 'redownloaded', traces: B3_EVIDENCE_GATEWAY_CALLS['ios-physical'].redownload },
  { scenario: 'refund-revoke', outcome: 'revoked-locked', traces: B3_EVIDENCE_GATEWAY_CALLS['ios-physical']['refund-revoke'] },
]);

export const B3_ANDROID_SCENARIOS = Object.freeze([
  { scenario: 'product-query', outcome: 'products-visible', traces: [] },
  { scenario: 'cancel', outcome: 'cancelled', traces: [] },
  { scenario: 'slow-card-pending-decline', outcome: 'declined-no-access', traces: [] },
  { scenario: 'slow-card-pending-approve', outcome: 'pending-approved-no-access', traces: [] },
  { scenario: 'unacknowledged-relaunch', outcome: 'acknowledged-recovered', traces: B3_EVIDENCE_GATEWAY_CALLS['android-play-physical']['unacknowledged-relaunch'] },
  { scenario: 'pack-install', outcome: 'installed', traces: B3_EVIDENCE_GATEWAY_CALLS['android-play-physical']['pack-install'] },
  { scenario: 'restore-after-reinstall', outcome: 'restored-active', traces: B3_EVIDENCE_GATEWAY_CALLS['android-play-physical']['restore-after-reinstall'] },
  { scenario: 'redownload', outcome: 'redownloaded', traces: B3_EVIDENCE_GATEWAY_CALLS['android-play-physical'].redownload },
  { scenario: 'refund-revoke', outcome: 'revoked-locked', traces: B3_EVIDENCE_GATEWAY_CALLS['android-play-physical']['refund-revoke'] },
]);

function evidenceError(message) {
  const error = new Error(message);
  error.code = 'b3_evidence_invalid';
  return error;
}

function exactKeys(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());
}

function requireKeys(value, expected, label) {
  if (!exactKeys(value, expected)) throw evidenceError(`${label} violates its closed schema`);
}

function hash(value) {
  return typeof value === 'string' && HASH.test(value);
}

function workerVersionId(value) {
  return typeof value === 'string' && UUID_V4.test(value);
}

function r2Etag(value) {
  return typeof value === 'string' && R2_ETAG.test(value);
}

function identifier(value, maximum = 512) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum &&
    value.trim() === value && ![...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 0x1f || codePoint === 0x7f;
    }) && !/(?:https?:\/\/|[?&](?:cap|token|handle)=|opaque(?:proof)?|sealedrefreshhandle|BEGIN PRIVATE KEY|private[_-]?key|\bGPA\.|\b(?:Ada|Ben|learner-[ab])\b|@)/iu.test(value) &&
    !/^[A-Za-z0-9+/_=-]{32,}$/u.test(value);
}

function exactUtc(value) {
  if (typeof value !== 'string' || !ISO_UTC.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function assertObject(value, expected, role, key) {
  requireKeys(value, ['role', 'key', 'sha256', 'size', 'etag', 'customMetadata'], `${role} object`);
  const metadataKeys = role === 'signed-manifest'
    ? ['b3-role', 'b3-sha256', 'b3-size', 'b3-envelope-sha256']
    : ['b3-role', 'b3-sha256', 'b3-size'];
  requireKeys(value.customMetadata, metadataKeys, `${role} metadata`);
  if (
    value.role !== role || value.key !== key || !hash(value.sha256) ||
    !Number.isSafeInteger(value.size) || value.size <= 0 || !r2Etag(value.etag) ||
    value.customMetadata['b3-role'] !== role ||
    value.customMetadata['b3-sha256'] !== value.sha256 ||
    value.customMetadata['b3-size'] !== String(value.size) ||
    (role === 'signed-manifest' && value.customMetadata['b3-envelope-sha256'] !== value.sha256)
  ) throw evidenceError(`invalid ${role} object authority or object order`);
}

export function validateB3CloudflareEvidence(value) {
  requireKeys(value, [
    'schemaVersion', 'testedApplicationCommit', 'applicationFingerprint', 'worker', 'bucket',
    'signedEnvelopeSha256', 'objects', 'capability', 'range', 'rateLimit',
  ], 'Cloudflare evidence');
  requireKeys(value.worker, [
    'accountId', 'name', 'publicSandboxOrigin', 'deploymentVersionId',
    'scriptAuthoritySha256', 'compatibilityDate', 'compatibilityFlags', 'bindings',
    'requiredSecretNames', 'remoteSecretNamesVerified',
  ], 'Cloudflare worker evidence');
  requireKeys(value.worker.bindings, ['r2', 'rateLimit', 'versionMetadata'], 'Cloudflare bindings');
  requireKeys(value.bucket, ['approvedIdentifier', 'private', 'r2DevPublicAccess', 'customDomains'], 'R2 bucket evidence');
  requireKeys(value.capability, ['ttlSeconds', 'valid', 'tamperedRejected', 'expiredRejected', 'canonicalEncodingRequired'], 'capability evidence');
  requireKeys(value.range, ['full200', 'partial206', 'conditional304', 'unsatisfied416', 'noRedirects', 'cacheControl'], 'range evidence');
  requireKeys(value.rateLimit, ['everyPublicPostGetCovered', 'limitedStatus', 'limitedBodyReads', 'limitedUpstreamCalls', 'missingBindingFailedClosed'], 'rate-limit evidence');
  if (
    value.schemaVersion !== 1 || !COMMIT.test(value.testedApplicationCommit) ||
    !hash(value.applicationFingerprint) || !ACCOUNT.test(value.worker.accountId) ||
    value.worker.name !== 'ks2-spelling-b3-sandbox' ||
    value.worker.publicSandboxOrigin !== 'https://b3-gateway.eugnel.uk' ||
    !workerVersionId(value.worker.deploymentVersionId) || !hash(value.worker.scriptAuthoritySha256) ||
    value.worker.compatibilityDate !== '2026-07-12' ||
    !isDeepStrictEqual(value.worker.compatibilityFlags, ['nodejs_compat']) ||
    !isDeepStrictEqual(value.worker.bindings, { r2: 'PACKS', rateLimit: 'GATEWAY_RATE_LIMIT', versionMetadata: 'WORKER_VERSION_METADATA' }) ||
    !isDeepStrictEqual(value.worker.requiredSecretNames, B3_REQUIRED_SECRET_NAMES) ||
    value.worker.remoteSecretNamesVerified !== true ||
    !isDeepStrictEqual(value.bucket, { approvedIdentifier: 'ks2-spelling-b3-sandbox-packs', private: true, r2DevPublicAccess: false, customDomains: [] }) ||
    !hash(value.signedEnvelopeSha256) || !Array.isArray(value.objects) || value.objects.length !== 2
  ) throw evidenceError('Cloudflare evidence authority mismatch');
  assertObject(value.objects[0], 'signed-manifest', 'signed-manifest', MANIFEST_KEY);
  assertObject(value.objects[1], 'archive', 'archive', ARCHIVE_KEY);
  if (value.signedEnvelopeSha256 !== value.objects[0].sha256) {
    throw evidenceError('signed envelope authority mismatch');
  }
  if (!isDeepStrictEqual(value.capability, { ttlSeconds: 600, valid: true, tamperedRejected: true, expiredRejected: true, canonicalEncodingRequired: true }) ||
      !isDeepStrictEqual(value.range, { full200: true, partial206: true, conditional304: true, unsatisfied416: true, noRedirects: true, cacheControl: 'private, no-store' }) ||
      !isDeepStrictEqual(value.rateLimit, { everyPublicPostGetCovered: true, limitedStatus: 429, limitedBodyReads: 0, limitedUpstreamCalls: 0, missingBindingFailedClosed: true })) {
    throw evidenceError('Cloudflare behavioural evidence mismatch');
  }
  return structuredClone(value);
}

function assertTransitions(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) {
    throw evidenceError('transition scenario count mismatch');
  }
  const traceIds = new Set();
  for (let index = 0; index < expected.length; index += 1) {
    const transition = actual[index];
    const authority = expected[index];
    requireKeys(transition, ['scenario', 'startedAt', 'completedAt', 'outcome', 'gatewayTraces'], `transition ${index}`);
    if (transition.scenario !== authority.scenario || transition.outcome !== authority.outcome ||
        !exactUtc(transition.startedAt) || !exactUtc(transition.completedAt) ||
        new Date(transition.completedAt) < new Date(transition.startedAt) ||
        !Array.isArray(transition.gatewayTraces) || transition.gatewayTraces.length !== authority.traces.length) {
      throw evidenceError(`transition scenario ${index} mismatch`);
    }
    for (let traceIndex = 0; traceIndex < authority.traces.length; traceIndex += 1) {
      const trace = transition.gatewayTraces[traceIndex];
      const expectedTrace = authority.traces[traceIndex];
      requireKeys(trace, ['operation', 'traceId', 'relation'], `transition trace ${index}.${traceIndex}`);
      if (trace.operation !== expectedTrace.operation || trace.relation !== expectedTrace.relation ||
          !UUID_V4.test(trace.traceId) || traceIds.has(trace.traceId)) {
        throw evidenceError('gateway trace authority, order or uniqueness mismatch');
      }
      traceIds.add(trace.traceId);
    }
  }
}

function assertObservationChain(value) {
  requireKeys(value, [
    'captureId', 'terminalObservationSha256', 'transitionGatewayProjectionSha256',
    'chainAuthoritySha256', 'observations',
  ], 'proof observation chain');
  if (!UUID_V4.test(value.captureId) || !hash(value.terminalObservationSha256) ||
      !hash(value.transitionGatewayProjectionSha256) ||
      !hash(value.chainAuthoritySha256) ||
      !Array.isArray(value.observations) || value.observations.length < 9 ||
      value.observations.length > 128) {
    throw evidenceError('proof observation chain authority or bound mismatch');
  }
  let previous = '0'.repeat(64);
  let previousScenario = 0;
  const observationHashes = new Set();
  for (const [index, observation] of value.observations.entries()) {
    requireKeys(observation, [
      'sequence', 'scenarioIndex', 'previousObservationSha256',
      'observationSha256', 'proofProjectionSha256',
    ], `proof observation chain ${index}`);
    if (observation.sequence !== index + 1 ||
        !Number.isSafeInteger(observation.scenarioIndex) ||
        (index === 0 && observation.scenarioIndex !== 0) ||
        observation.scenarioIndex < previousScenario ||
        observation.scenarioIndex > previousScenario + 1 ||
        observation.scenarioIndex < 0 || observation.scenarioIndex > 8 ||
        observation.previousObservationSha256 !== previous ||
        !hash(observation.observationSha256) ||
        !hash(observation.proofProjectionSha256) ||
        observationHashes.has(observation.observationSha256)) {
      throw evidenceError('proof observation hash chain, sequence or scenario mismatch');
    }
    observationHashes.add(observation.observationSha256);
    previous = observation.observationSha256;
    previousScenario = observation.scenarioIndex;
  }
  if (previousScenario !== 8 || value.terminalObservationSha256 !== previous) {
    throw evidenceError('proof observation terminal authority mismatch');
  }
}

function sha256Domain(domain, value) {
  return createHash('sha256')
    .update(`${domain}\u0000${canonicaliseB3ProofValue(value)}`)
    .digest('hex');
}

export function createB3TransitionGatewayProjectionSha256(transitions) {
  if (!Array.isArray(transitions)) throw evidenceError('transition projection is invalid');
  const safeTransitions = JSON.parse(canonicaliseB3ProofValue(transitions));
  return sha256Domain(
    'ks2-spelling:b3-transition-gateway-projection:v1',
    safeTransitions.map(({ scenario, outcome, gatewayTraces }) => ({
      scenario,
      outcome,
      gatewayTraces,
    })),
  );
}

export function createB3ObservationChainAuthoritySha256({ chain, transitions }) {
  if (!chain || typeof chain !== 'object' || Array.isArray(chain)) {
    throw evidenceError('proof observation chain authority input is invalid');
  }
  const safeChain = JSON.parse(canonicaliseB3ProofValue(chain));
  const transitionGatewayProjectionSha256 =
    createB3TransitionGatewayProjectionSha256(transitions);
  return sha256Domain('ks2-spelling:b3-observation-chain-authority:v1', {
    captureId: safeChain.captureId,
    terminalObservationSha256: safeChain.terminalObservationSha256,
    transitionGatewayProjectionSha256,
    observations: safeChain.observations,
  });
}

function assertLearnerPreservation(value) {
  if (!Array.isArray(value) || value.length !== 2) throw evidenceError('learner preservation count mismatch');
  const expected = [
    ['purchase-install', 'before-purchase'],
    ['refund-revoke-after-fresh-install-reseed', 'after-fresh-install-reseed'],
  ];
  for (let index = 0; index < expected.length; index += 1) {
    const row = value[index];
    requireKeys(row, ['scenario', 'baseline', 'learnerAInitialSha256', 'learnerAFinalSha256', 'learnerBInitialSha256', 'learnerBFinalSha256'], `learner preservation ${index}`);
    const authority = B3_SYNTHETIC_LEARNER_DIGESTS[expected[index][1]];
    const digests = [row.learnerAInitialSha256, row.learnerAFinalSha256, row.learnerBInitialSha256, row.learnerBFinalSha256];
    if (row.scenario !== expected[index][0] || row.baseline !== expected[index][1] ||
        !digests.every(hash) || row.learnerAInitialSha256 !== row.learnerAFinalSha256 ||
        row.learnerBInitialSha256 !== row.learnerBFinalSha256 ||
        row.learnerAInitialSha256 !== authority.learnerA ||
        row.learnerBInitialSha256 !== authority.learnerB) {
      throw evidenceError('learner preservation authority mismatch');
    }
  }
}

function assertDistribution(value, ios, commit, fingerprint) {
  const shared = ['embeddedCommit', 'embeddedFingerprint', 'versionName', 'kind'];
  const keys = ios
    ? [...shared, 'iosBuildNumber', 'signedIpaSha256', 'ipaEmbeddedAuthoritySha256', 'codeSigningCertificateSha256', 'installedBundleId', 'installedVersion', 'installedBuild', 'installedEmbeddedAuthoritySha256', 'installedBuiltByDeveloper', 'sandboxReceiptVerified']
    : [...shared, 'androidVersionCode', 'signedAabSha256', 'aabEmbeddedAuthoritySha256', 'playAppSigningCertificateSha256', 'installer', 'installedEmbeddedAuthoritySha256', 'pmPathOrderVerified', 'installedApks'];
  requireKeys(value, keys, `${ios ? 'iOS' : 'Android'} distribution evidence`);
  if (value.embeddedCommit !== commit || value.embeddedFingerprint !== fingerprint || value.versionName !== '0.3.0-b3') {
    throw evidenceError('embedded distribution authority mismatch');
  }
  if (ios) {
    if (value.kind !== 'development' || !/^\d+$/u.test(value.iosBuildNumber) || Number(value.iosBuildNumber) <= 0 ||
        ![value.signedIpaSha256, value.ipaEmbeddedAuthoritySha256, value.codeSigningCertificateSha256, value.installedEmbeddedAuthoritySha256].every(hash) ||
        value.ipaEmbeddedAuthoritySha256 !== value.installedEmbeddedAuthoritySha256 ||
        value.installedBundleId !== 'uk.eugnel.ks2spelling' || value.installedVersion !== '0.3.0-b3' ||
        value.installedBuild !== value.iosBuildNumber || value.installedBuiltByDeveloper !== true || value.sandboxReceiptVerified !== true) {
      throw evidenceError('iOS IPA certificate, developer app or installed distribution authority mismatch');
    }
    return;
  }
  if (value.kind !== 'play-internal' || !Number.isSafeInteger(value.androidVersionCode) || value.androidVersionCode <= 0 ||
      ![value.signedAabSha256, value.aabEmbeddedAuthoritySha256, value.playAppSigningCertificateSha256, value.installedEmbeddedAuthoritySha256].every(hash) ||
      value.aabEmbeddedAuthoritySha256 !== value.installedEmbeddedAuthoritySha256 || value.installer !== 'com.android.vending' || value.pmPathOrderVerified !== true ||
      !Array.isArray(value.installedApks) || value.installedApks.length < 1) {
    throw evidenceError('Android certificate or installed distribution authority mismatch');
  }
  let previousSplit = '';
  value.installedApks.forEach((entry, index) => {
    requireKeys(entry, ['order', 'kind', 'splitName', 'sha256'], `installed APK ${index}`);
    if (entry.order !== index || !hash(entry.sha256) ||
        (index === 0 && (entry.kind !== 'base' || entry.splitName !== '')) ||
        (index > 0 && (entry.kind !== 'split' || !identifier(entry.splitName) || entry.splitName.localeCompare(previousSplit) <= 0))) {
      throw evidenceError('Android pm path order mismatch');
    }
    if (index > 0) previousSplit = entry.splitName;
  });
}

export function validateB3DistributionProjection({ value, platform, buildAuthority }) {
  const ios = platform === 'ios';
  if (!ios && platform !== 'android') {
    throw evidenceError('distribution platform is invalid');
  }
  assertDistribution(
    value,
    ios,
    buildAuthority?.testedApplicationCommit,
    buildAuthority?.applicationFingerprint,
  );
  if (value.versionName !== buildAuthority?.versionName ||
      value[ios ? 'iosBuildNumber' : 'androidVersionCode'] !== buildAuthority?.buildNumber) {
    throw evidenceError('distribution build authority mismatch');
  }
  return structuredClone(value);
}

export function validateB3PlatformEvidence(value) {
  const baseKeys = [
    'schemaVersion', 'testedApplicationCommit', 'applicationFingerprint', 'platform', 'device',
    'store', 'transitions', 'storeCompletion', 'distribution', 'gateway', 'transport',
    'proofObservationChain',
    'storeTransactionAuthority', 'refreshHandleLifecycle', 'entitlement', 'pack',
    'syntheticLearnerAuthoritySha256', 'learnerPreservation', 'restore', 'screenshotSha256',
    'manualVisualInspection',
  ];
  const ios = value?.platform === 'ios-physical';
  const android = value?.platform === 'android-play-physical';
  requireKeys(value, ios ? [...baseKeys, 'storeKitTest'] : baseKeys, 'platform evidence');
  if ((!ios && !android) || value.schemaVersion !== 1 || !COMMIT.test(value.testedApplicationCommit) || !hash(value.applicationFingerprint)) {
    throw evidenceError('platform evidence authority mismatch');
  }
  requireKeys(value.device, ios
    ? ['model', 'osVersion', 'physical']
    : [
        'model', 'osVersion', 'physical', 'playCertified',
        'playProtectSettingsScreenshotSha256', 'playProtectRootAttestationSha256',
      ], 'physical device evidence');
  requireKeys(value.store, ['environment', 'productId', 'localisedPriceObserved'], 'store evidence');
  const androidPlayAuthorityHashes = android ? [
    value.device.playProtectSettingsScreenshotSha256,
    value.device.playProtectRootAttestationSha256,
    value.screenshotSha256,
  ] : [];
  if (!identifier(value.device.model) || !identifier(value.device.osVersion) || value.device.physical !== true ||
      (!ios && (value.device.playCertified !== true ||
        !hash(value.device.playProtectSettingsScreenshotSha256) ||
        !hash(value.device.playProtectRootAttestationSha256) ||
        new Set(androidPlayAuthorityHashes).size !== androidPlayAuthorityHashes.length)) ||
      value.store.environment !== (ios ? 'sandbox' : 'play-test') ||
      value.store.productId !== (ios ? 'uk.eugnel.ks2spelling.fullks2' : 'full_ks2') || value.store.localisedPriceObserved !== true) {
    throw evidenceError('physical device or store authority mismatch');
  }
  assertTransitions(value.transitions, ios ? B3_IOS_SCENARIOS : B3_ANDROID_SCENARIOS);
  assertObservationChain(value.proofObservationChain);
  const transitionGatewayProjectionSha256 =
    createB3TransitionGatewayProjectionSha256(value.transitions);
  if (value.proofObservationChain.transitionGatewayProjectionSha256 !==
        transitionGatewayProjectionSha256 ||
      value.proofObservationChain.chainAuthoritySha256 !==
        createB3ObservationChainAuthoritySha256({
          chain: value.proofObservationChain,
          transitions: value.transitions,
        })) {
    throw evidenceError('proof observation chain authority mismatch');
  }
  requireKeys(value.storeCompletion, [ios ? 'finished' : 'acknowledged'], 'store completion');
  if (value.storeCompletion[ios ? 'finished' : 'acknowledged'] !== true) throw evidenceError('store completion mismatch');
  if (ios) {
    requireKeys(value.storeKitTest, ['reportSha256', 'scenarios', 'liveSandbox'], 'StoreKit Test evidence');
    if (!hash(value.storeKitTest.reportSha256) || !isDeepStrictEqual(value.storeKitTest.scenarios, ['storekit-test-pending-approve', 'storekit-test-pending-decline']) || value.storeKitTest.liveSandbox !== false) {
      throw evidenceError('StoreKit Test evidence mismatch');
    }
  }
  assertDistribution(value.distribution, ios, value.testedApplicationCommit, value.applicationFingerprint);
  requireKeys(value.gateway, ['accountId', 'workerName', 'publicSandboxOrigin', 'deploymentVersionId', 'scriptAuthoritySha256', 'signedEnvelopeSha256', 'manifestObject', 'archiveObject'], 'platform gateway evidence');
  for (const [name, key] of [['manifestObject', MANIFEST_KEY], ['archiveObject', ARCHIVE_KEY]]) {
    const object = value.gateway[name];
    requireKeys(object, ['key', 'sha256', 'size', 'etag', 'metadataMatched'], `${name} evidence`);
    if (object.key !== key || !hash(object.sha256) || !Number.isSafeInteger(object.size) || object.size <= 0 || !r2Etag(object.etag) || object.metadataMatched !== true) throw evidenceError(`${name} authority mismatch`);
  }
  if (!ACCOUNT.test(value.gateway.accountId) || value.gateway.workerName !== 'ks2-spelling-b3-sandbox' ||
      value.gateway.publicSandboxOrigin !== 'https://b3-gateway.eugnel.uk' || !workerVersionId(value.gateway.deploymentVersionId) ||
      !hash(value.gateway.scriptAuthoritySha256) || !hash(value.gateway.signedEnvelopeSha256) ||
      value.gateway.signedEnvelopeSha256 !== value.gateway.manifestObject.sha256) throw evidenceError('gateway authority mismatch');
  requireKeys(value.transport, ['concreteCapacitorStore', 'concreteHttpGateway', 'serverUrl', 'nativeOriginAllowed', 'noRedirects'], 'transport evidence');
  if (!isDeepStrictEqual(value.transport, { concreteCapacitorStore: true, concreteHttpGateway: true, serverUrl: null, nativeOriginAllowed: true, noRedirects: true })) throw evidenceError('transport evidence mismatch');
  requireKeys(value.storeTransactionAuthority, ['source', 'crossCheckedOnRefresh', 'rawValueCommitted'], 'store transaction authority');
  if (value.storeTransactionAuthority.source !== (ios ? 'apple-transaction-id' : 'google-order-id') || value.storeTransactionAuthority.crossCheckedOnRefresh !== true || value.storeTransactionAuthority.rawValueCommitted !== false) throw evidenceError('store transaction authority mismatch');
  requireKeys(value.refreshHandleLifecycle, ['positiveVersionObserved', 'rawProofCleared', 'restoredFreshHandle', 'revokedHandleDeleted', 'rawHandleCommitted'], 'refresh handle lifecycle');
  if (!isDeepStrictEqual(value.refreshHandleLifecycle, { positiveVersionObserved: true, rawProofCleared: true, restoredFreshHandle: true, revokedHandleDeleted: true, rawHandleCommitted: false })) throw evidenceError('refresh handle lifecycle mismatch');
  requireKeys(value.entitlement, ['id', 'finalState', 'digest', 'refreshHandlePresent'], 'entitlement evidence');
  if (value.entitlement.id !== 'full-ks2' || value.entitlement.finalState !== 'revoked' || !hash(value.entitlement.digest) || value.entitlement.refreshHandlePresent !== false) throw evidenceError('terminal entitlement mismatch');
  requireKeys(value.pack, ['packId', 'manifestSha256', 'archiveSha256', 'installed', 'redownloaded'], 'pack evidence');
  if (value.pack.packId !== 'b3-sandbox-proof' || value.pack.manifestSha256 !== value.gateway.manifestObject.sha256 || value.pack.archiveSha256 !== value.gateway.archiveObject.sha256 || value.pack.installed !== true || value.pack.redownloaded !== true) throw evidenceError('pack evidence mismatch');
  if (value.syntheticLearnerAuthoritySha256 !== B3_SYNTHETIC_LEARNER_AUTHORITY_SHA256) throw evidenceError('synthetic learner authority mismatch');
  assertLearnerPreservation(value.learnerPreservation);
  requireKeys(value.restore, ['freshInstall', 'entitlementRebuilt', 'packRedownloaded', 'learnerBackupRestoreClaimed', 'baselineCreatedAfterFreshInstall'], 'restore evidence');
  if (!isDeepStrictEqual(value.restore, { freshInstall: true, entitlementRebuilt: true, packRedownloaded: true, learnerBackupRestoreClaimed: false, baselineCreatedAfterFreshInstall: true })) throw evidenceError('restore evidence mismatch');
  if (!hash(value.screenshotSha256) || value.manualVisualInspection !== 'passed') throw evidenceError('manual screenshot attestation mismatch');
  return structuredClone(value);
}

export function assertB3GatewayEquality(platform, cloudflare) {
  const live = validateB3CloudflareEvidence(cloudflare);
  const report = validateB3PlatformEvidence(platform);
  const expected = {
    accountId: live.worker.accountId,
    workerName: live.worker.name,
    publicSandboxOrigin: live.worker.publicSandboxOrigin,
    deploymentVersionId: live.worker.deploymentVersionId,
    scriptAuthoritySha256: live.worker.scriptAuthoritySha256,
    signedEnvelopeSha256: live.signedEnvelopeSha256,
    manifestObject: { ...live.objects[0], metadataMatched: true },
    archiveObject: { ...live.objects[1], metadataMatched: true },
  };
  delete expected.manifestObject.role;
  delete expected.manifestObject.customMetadata;
  delete expected.archiveObject.role;
  delete expected.archiveObject.customMetadata;
  if (!isDeepStrictEqual(report.gateway, expected)) throw evidenceError('platform and Cloudflare gateway evidence differ');
  return report;
}

export function b3PlatformGatewayFromCloudflare(cloudflare) {
  const live = validateB3CloudflareEvidence(cloudflare);
  return Object.freeze({
    accountId: live.worker.accountId,
    workerName: live.worker.name,
    publicSandboxOrigin: live.worker.publicSandboxOrigin,
    deploymentVersionId: live.worker.deploymentVersionId,
    scriptAuthoritySha256: live.worker.scriptAuthoritySha256,
    signedEnvelopeSha256: live.signedEnvelopeSha256,
    manifestObject: Object.freeze({
      key: live.objects[0].key, sha256: live.objects[0].sha256, size: live.objects[0].size,
      etag: live.objects[0].etag, metadataMatched: true,
    }),
    archiveObject: Object.freeze({
      key: live.objects[1].key, sha256: live.objects[1].sha256, size: live.objects[1].size,
      etag: live.objects[1].etag, metadataMatched: true,
    }),
  });
}

export function assertB3SyntheticLearnerObservation(value, baseline) {
  const expected = B3_SYNTHETIC_LEARNER_DIGESTS[baseline];
  if (!expected || !Array.isArray(value) || value.length !== 2 ||
      !isDeepStrictEqual(value.map(({ learnerId, nickname }) => ({ learnerId, nickname })), [
        { learnerId: 'learner-a', nickname: 'Ada' },
        { learnerId: 'learner-b', nickname: 'Ben' },
      ]) || value.some((entry) => !exactKeys(entry, ['learnerId', 'nickname', 'digest'])) ||
      value[0].digest !== expected.learnerA || value[1].digest !== expected.learnerB) {
    throw evidenceError('synthetic learner profile authority mismatch');
  }
  return Object.freeze({ learnerA: expected.learnerA, learnerB: expected.learnerB });
}

export function validateB3PendingPlatformEvidence(value) {
  if (value?.manualVisualInspection !== 'pending') throw evidenceError('pending manual visual state is invalid');
  const candidate = structuredClone(value);
  candidate.manualVisualInspection = 'passed';
  validateB3PlatformEvidence(candidate);
  return structuredClone(value);
}
