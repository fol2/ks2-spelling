import { createHash } from 'node:crypto';

import { canonicalJson } from '../../src/platform/database/canonical-json.js';
import {
  canonicaliseB3ProofValue,
  validateB3GatewaySmokeAuthority,
  validateB3ProofLaunchCommand,
  validateB3ProofObservationBytes,
} from '../../src/app/b3-live-proof-protocol.js';
import { parseJsonWithoutDuplicateMembers } from '../../src/domain/packs/signed-manifest-contract.js';
import {
  createB3ObservationChainAuthoritySha256,
  createB3TransitionGatewayProjectionSha256,
} from './b3-evidence.mjs';

const HASH = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAXIMUM_BYTES = 128 * 1024;
const CHECKPOINT_KEYS = Object.freeze([
  'schemaVersion',
  'platform',
  'captureId',
  'testedApplicationCommit',
  'applicationFingerprint',
  'installationId',
  'nextScenarioIndex',
  'nextObservationSequence',
  'state',
  'completedScenarios',
  'previousObservationSha256',
  'checkpointRevision',
]);
const STORED_KEYS = Object.freeze([...CHECKPOINT_KEYS, 'checkpointSha256']);
const RESUME_KEYS = Object.freeze([
  'testedApplicationCommit',
  'applicationFingerprint',
  'captureId',
  'platform',
  'previousObservationSha256',
]);
const STATES = new Set([
  'UNBOUND', 'ARMED', 'WAITING_OPERATOR', 'OBSERVING', 'HOLD_REACHED',
  'HOST_FORCE_STOP', 'RELAUNCH_RECOVERY', 'SCENARIO_COMPLETE',
  'REBIND_FRESH_INSTALL', 'TERMINAL_CAPTURE', 'MANUAL_ATTESTATION', 'COMPLETE',
]);
const SCENARIOS = Object.freeze({
  ios: Object.freeze([
    'product-query', 'cancel', 'ask-to-buy-pending', 'normal-purchase',
    'unfinished-relaunch', 'pack-install', 'restore-after-reinstall',
    'redownload', 'refund-revoke',
  ]),
  android: Object.freeze([
    'product-query', 'cancel', 'slow-card-pending-decline',
    'slow-card-pending-approve', 'unacknowledged-relaunch', 'pack-install',
    'restore-after-reinstall', 'redownload', 'refund-revoke',
  ]),
});

function checkpointError(message, code = 'b3_capture_checkpoint_invalid') {
  return Object.assign(new Error(message), { code });
}

function isExactRecord(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && keys.includes(key) && descriptor?.enumerable === true &&
      Object.hasOwn(descriptor, 'value');
  });
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function unsignedCheckpoint(value) {
  return Object.fromEntries(CHECKPOINT_KEYS.map((key) => [key, structuredClone(value[key])]));
}

function validateCheckpointFields(value) {
  const scenarios = SCENARIOS[value.platform];
  if (value.schemaVersion !== 2 || !scenarios || !UUID_V4.test(value.captureId) ||
      !COMMIT.test(value.testedApplicationCommit) || !HASH.test(value.applicationFingerprint) ||
      !UUID_V4.test(value.installationId) || !Number.isSafeInteger(value.nextScenarioIndex) ||
      value.nextScenarioIndex < 0 || value.nextScenarioIndex > scenarios.length ||
      !Number.isSafeInteger(value.nextObservationSequence) || value.nextObservationSequence < 1 ||
      !STATES.has(value.state) || !Array.isArray(value.completedScenarios) ||
      value.completedScenarios.length !== value.nextScenarioIndex ||
      value.completedScenarios.some((scenario, index) => scenario !== scenarios[index]) ||
      !HASH.test(value.previousObservationSha256) ||
      !Number.isSafeInteger(value.checkpointRevision) || value.checkpointRevision < 0) {
    throw checkpointError('B3 capture checkpoint authority, state or scenario prefix is invalid');
  }
}

export function createB3CaptureCheckpoint(value) {
  if (!isExactRecord(value, CHECKPOINT_KEYS)) {
    throw checkpointError('B3 capture checkpoint violates its closed schema');
  }
  validateCheckpointFields(value);
  const unsigned = unsignedCheckpoint(value);
  const checkpointSha256 = sha256(Buffer.from(canonicalJson(unsigned), 'utf8'));
  return Object.freeze({ ...unsigned, checkpointSha256 });
}

function completedScenarioCount(platform, observation) {
  if (['TERMINAL_CAPTURE', 'MANUAL_ATTESTATION', 'COMPLETE'].includes(observation?.phase)) {
    return SCENARIOS[platform]?.length;
  }
  if (observation?.phase === 'SCENARIO_COMPLETE') return observation.scenarioIndex + 1;
  if (platform === 'ios' && observation?.scenario === 'normal-purchase' &&
      observation?.phase === 'HOLD_REACHED') return observation.scenarioIndex + 1;
  return observation?.scenarioIndex;
}

export function createB3CaptureCheckpointFromObservation({
  platform,
  buildAuthority,
  observation,
}) {
  const completedCount = completedScenarioCount(platform, observation);
  return createB3CaptureCheckpoint({
    schemaVersion: 2,
    platform,
    captureId: observation?.captureId,
    testedApplicationCommit: buildAuthority?.testedApplicationCommit,
    applicationFingerprint: buildAuthority?.applicationFingerprint,
    installationId: observation?.installationId,
    nextScenarioIndex: completedCount,
    nextObservationSequence: observation?.sequence + 1,
    state: observation?.phase,
    completedScenarios: SCENARIOS[platform]?.slice(0, completedCount),
    previousObservationSha256: observation?.observationSha256,
    checkpointRevision: observation?.sequence - 1,
  });
}

function validateStoredCheckpoint(value, bytes) {
  if (!isExactRecord(value, STORED_KEYS) || !HASH.test(value.checkpointSha256)) {
    throw checkpointError('B3 stored capture checkpoint violates its closed schema');
  }
  const expected = createB3CaptureCheckpoint(unsignedCheckpoint(value));
  if (value.checkpointSha256 !== expected.checkpointSha256 || canonicalJson(value) !== bytes.toString('utf8')) {
    throw checkpointError('B3 capture checkpoint hash or canonical bytes are invalid');
  }
  return expected;
}

export function validateB3CaptureCheckpointBytes({ bytes, platform }) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAXIMUM_BYTES) {
    throw checkpointError('B3 capture checkpoint bytes are invalid');
  }
  const value = parseJsonWithoutDuplicateMembers(bytes, 'B3 capture checkpoint');
  if (value.platform !== platform) throw checkpointError('B3 capture checkpoint platform differs');
  return validateStoredCheckpoint(value, bytes);
}


export function assertB3CaptureResumeAuthority(checkpoint, expected) {
  if (!isExactRecord(expected, RESUME_KEYS) ||
      RESUME_KEYS.some((key) => checkpoint?.[key] !== expected[key])) {
    throw checkpointError('B3 capture resume authority differs from its checkpoint');
  }
  return checkpoint;
}

const MAXIMUM_RECORD_BYTES = 128 * 1024;
const RECORD_KEYS = Object.freeze([
  'schemaVersion',
  'platform',
  'sequence',
  'command',
  'observation',
]);
const PLATFORMS = Object.freeze({
  ios: 'ios-physical',
  android: 'android-play-physical',
});
const BUILD_SOURCE_KEYS = Object.freeze([
  'schemaVersion',
  'testedApplicationCommit',
  'applicationFingerprint',
  'versionName',
  'iosBuildNumber',
  'androidVersionCode',
]);
const validatedRecordAuthority = new WeakMap();

function journalError(message, code = 'b3_physical_observation_journal_invalid') {
  return Object.assign(new Error(message), { code });
}

function platformName(platform) {
  if (!Object.hasOwn(PLATFORMS, platform)) {
    throw journalError('B3 physical observation journal platform is invalid');
  }
  return platform;
}

export function buildB3PhysicalProofAuthority(platform, buildSource) {
  const name = platformName(platform);
  if (!exactRecord(buildSource, BUILD_SOURCE_KEYS) || buildSource.schemaVersion !== 1 ||
      !COMMIT.test(buildSource.testedApplicationCommit ?? '') ||
      !HASH.test(buildSource.applicationFingerprint ?? '') ||
      buildSource.versionName !== '0.3.0-b3' ||
      !/^[1-9][0-9]*$/u.test(buildSource.iosBuildNumber ?? '') ||
      !Number.isSafeInteger(buildSource.androidVersionCode) ||
      buildSource.androidVersionCode <= 0) {
    throw journalError('B3 physical proof build source is invalid or not closed');
  }
  return Object.freeze({
    mode: 'B3SandboxProof',
    proofKind: 'physical-live',
    platform: name,
    distribution: name === 'ios' ? 'development' : 'play-internal',
    publicSandboxOrigin: 'https://b3-gateway.eugnel.uk',
    workerName: 'ks2-spelling-b3-sandbox',
    bundleId: 'uk.eugnel.ks2spelling',
    testedApplicationCommit: buildSource.testedApplicationCommit,
    applicationFingerprint: buildSource.applicationFingerprint,
    versionName: buildSource.versionName,
    buildNumber: name === 'ios'
      ? buildSource.iosBuildNumber
      : buildSource.androidVersionCode,
  });
}

function exactRecord(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && keys.includes(key) &&
      descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
  });
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

export async function validateB3PhysicalObservationRecordBytes({
  bytes: rawBytes,
  platform,
  sequence,
  buildAuthority,
  previousObservation,
  expectedCommand,
}) {
  const bytes = Buffer.isBuffer(rawBytes) ? Buffer.from(rawBytes) : null;
  if (!bytes || bytes.length === 0 || bytes.length > MAXIMUM_RECORD_BYTES) {
    throw journalError('B3 physical observation journal record bytes are invalid');
  }
  const value = parseJsonWithoutDuplicateMembers(
    bytes,
    'B3 physical observation journal record',
  );
  if (!exactRecord(value, RECORD_KEYS) || value.schemaVersion !== 1 ||
      value.platform !== platform || value.sequence !== sequence ||
      canonicaliseB3ProofValue(value) !== bytes.toString('utf8')) {
    throw journalError('B3 physical observation journal record is not canonical or closed');
  }
  const command = validateB3ProofLaunchCommand(value.command);
  if (command.platform !== PLATFORMS[platform] || command.expectedSequence !== sequence) {
    throw journalError('B3 physical observation journal command authority is invalid');
  }
  if (expectedCommand !== undefined &&
      canonicaliseB3ProofValue(command) !==
        canonicaliseB3ProofValue(validateB3ProofLaunchCommand(expectedCommand))) {
    throw journalError('B3 retained observation command differs from persisted authority');
  }
  const observationBytes = Buffer.from(canonicaliseB3ProofValue(value.observation), 'utf8');
  const observation = await validateB3ProofObservationBytes(observationBytes, {
    command,
    buildAuthority,
    ...(previousObservation ? { previousObservation } : {}),
  });
  const record = deepFreeze({
    schemaVersion: 1,
    platform,
    sequence,
    command: structuredClone(command),
    observation: structuredClone(observation),
  });
  validatedRecordAuthority.set(record, sha256(bytes));
  return Object.freeze({
    record,
    get recordBytes() { return Buffer.from(bytes); },
    recordSha256: sha256(bytes),
    observationSha256: record.observation.observationSha256,
  });
}

export async function deriveB3PhysicalObservationRecord({
  platform,
  command: rawCommand,
  buildAuthority,
  previousObservation,
  observationBytes: rawObservationBytes,
}) {
  const name = platformName(platform);
  const command = validateB3ProofLaunchCommand(rawCommand);
  if (command.platform !== PLATFORMS[name]) {
    throw journalError('B3 physical observation command platform is invalid');
  }
  const observationBytes = rawObservationBytes instanceof Uint8Array
    ? Buffer.from(rawObservationBytes)
    : null;
  if (!observationBytes || observationBytes.length === 0 ||
      observationBytes.length > MAXIMUM_RECORD_BYTES) {
    throw journalError('B3 physical observation bytes are invalid');
  }
  const observation = await validateB3ProofObservationBytes(observationBytes, {
    command,
    buildAuthority,
    ...(previousObservation ? { previousObservation } : {}),
  });
  const record = deepFreeze({
    schemaVersion: 1,
    platform: name,
    sequence: command.expectedSequence,
    command: structuredClone(command),
    observation: structuredClone(observation),
  });
  const bytes = Buffer.from(canonicaliseB3ProofValue(record), 'utf8');
  if (bytes.length > MAXIMUM_RECORD_BYTES) {
    throw journalError('B3 physical observation journal record exceeds its bound');
  }
  validatedRecordAuthority.set(record, sha256(bytes));
  return Object.freeze({
    record,
    get recordBytes() { return Buffer.from(bytes); },
    recordSha256: sha256(bytes),
    observationSha256: observation.observationSha256,
  });
}

function captureStepResult({ recordResult, checkpoint, checkpointBytes }) {
  const retainedRecordBytes = recordResult.recordBytes;
  const retainedCheckpointBytes = Buffer.from(checkpointBytes);
  return Object.freeze({
    record: recordResult.record,
    checkpoint: deepFreeze(structuredClone(checkpoint)),
    get recordBytes() { return Buffer.from(retainedRecordBytes); },
    get checkpointBytes() { return Buffer.from(retainedCheckpointBytes); },
    recordSha256: recordResult.recordSha256,
    observationSha256: recordResult.observationSha256,
    checkpointBlobSha256: sha256(retainedCheckpointBytes),
  });
}

export async function deriveB3CaptureStep({
  platform,
  command,
  buildSource,
  previousObservation,
  observationBytes,
}) {
  const buildAuthority = buildB3PhysicalProofAuthority(platform, buildSource);
  const recordResult = await deriveB3PhysicalObservationRecord({
    platform,
    command,
    buildAuthority,
    previousObservation,
    observationBytes,
  });
  const checkpoint = createB3CaptureCheckpointFromObservation({
    platform,
    buildAuthority,
    observation: recordResult.record.observation,
  });
  return captureStepResult({
    recordResult,
    checkpoint,
    checkpointBytes: Buffer.from(canonicaliseB3ProofValue(checkpoint), 'utf8'),
  });
}

export async function validateB3RetainedCaptureStep({
  platform,
  command,
  buildSource,
  previousObservation,
  recordBytes,
  checkpointBytes: rawCheckpointBytes,
}) {
  const buildAuthority = buildB3PhysicalProofAuthority(platform, buildSource);
  const sequence = command?.expectedSequence;
  const recordResult = await validateB3PhysicalObservationRecordBytes({
    bytes: recordBytes,
    platform,
    sequence,
    buildAuthority,
    previousObservation,
    expectedCommand: command,
  });
  const checkpointBytes = Buffer.isBuffer(rawCheckpointBytes)
    ? Buffer.from(rawCheckpointBytes)
    : null;
  if (!checkpointBytes) {
    throw journalError('B3 retained capture checkpoint bytes are invalid');
  }
  const checkpoint = validateB3CaptureCheckpointBytes({ bytes: checkpointBytes, platform });
  const expected = createB3CaptureCheckpointFromObservation({
    platform,
    buildAuthority,
    observation: recordResult.record.observation,
  });
  if (canonicaliseB3ProofValue(checkpoint) !== canonicaliseB3ProofValue(expected) ||
      canonicaliseB3ProofValue(checkpoint) !== checkpointBytes.toString('utf8')) {
    throw journalError('B3 retained capture checkpoint differs from its observation');
  }
  return captureStepResult({ recordResult, checkpoint, checkpointBytes });
}

export function deriveB3DeviceGatewaySmokeProjection(records) {
  if (!Array.isArray(records)) {
    throw journalError('B3 device gateway smoke records are invalid');
  }
  const candidates = records.filter(({ observation }) =>
    observation?.proofProjection?.gatewaySmokeAuthority !== null &&
    observation?.proofProjection?.gatewaySmokeAuthority !== undefined);
  if (candidates.length === 0) return null;
  if (candidates.length !== 1) {
    throw journalError('B3 device gateway smoke must occur exactly once when present');
  }
  const [{ observation }] = candidates;
  if (observation.platform === 'android-play-physical' ||
      observation.scenario !== 'pack-install' ||
      observation.phase !== 'SCENARIO_COMPLETE' ||
      !observation.proofProjection.gatewayCalls.some(({ operation, relation }) =>
        operation === 'authorise' && relation === 'download-capability-authorisation')) {
    throw journalError('B3 device gateway smoke is not bound to iOS pack-install authorisation');
  }
  const authority = validateB3GatewaySmokeAuthority(
    observation.proofProjection.gatewaySmokeAuthority,
  );
  return deepFreeze({
    schemaVersion: authority.schemaVersion,
    deploymentVersionId: authority.deploymentVersionId,
    scriptAuthoritySha256: authority.scriptAuthoritySha256,
    signedEnvelopeSha256: authority.signedEnvelopeSha256,
    objects: structuredClone(authority.objects),
    capability: structuredClone(authority.accessBehaviour),
    range: structuredClone(authority.byteServingBehaviour),
  });
}

export function deriveB3ProofObservationChain({ records, transitions }) {
  if (!Array.isArray(records) || records.length === 0 ||
      records.some((record) => {
        const authority = validatedRecordAuthority.get(record);
        return authority === undefined || authority !== sha256(Buffer.from(
          canonicaliseB3ProofValue(record),
          'utf8',
        ));
      })) {
    throw journalError('B3 proof observation chain requires validated retained records');
  }
  if (!Array.isArray(transitions)) {
    throw journalError('B3 proof observation chain transitions are invalid');
  }
  const scenarioOrder = [];
  for (const { observation } of records) {
    if (!scenarioOrder.includes(observation.scenario)) scenarioOrder.push(observation.scenario);
  }
  if (transitions.length === 0 || transitions.length > scenarioOrder.length ||
      transitions.some((transition, index) => {
        if (!exactRecord(transition, [
          'scenario', 'startedAt', 'completedAt', 'outcome', 'gatewayTraces',
        ]) || transition.scenario !== scenarioOrder[index] ||
            !Array.isArray(transition.gatewayTraces)) return true;
        const derived = deriveB3ScenarioTransition({
          records,
          authority: {
            scenario: transition.scenario,
            outcome: transition.outcome,
            traces: transition.gatewayTraces.map(({ operation, relation }) => ({
              operation,
              relation,
            })),
          },
        });
        return canonicaliseB3ProofValue(derived) !== canonicaliseB3ProofValue(transition);
      })) {
    throw journalError('B3 proof observation chain transition differs from retained observations');
  }
  const observations = records.map(({ observation }) => Object.freeze({
    sequence: observation.sequence,
    scenarioIndex: observation.scenarioIndex,
    previousObservationSha256: observation.previousObservationSha256,
    observationSha256: observation.observationSha256,
    proofProjectionSha256: sha256(Buffer.from(
      canonicaliseB3ProofValue(observation.proofProjection),
      'utf8',
    )),
  }));
  const transitionGatewayProjectionSha256 =
    createB3TransitionGatewayProjectionSha256(transitions);
  const unsigned = {
    captureId: records[0].observation.captureId,
    terminalObservationSha256: records.at(-1).observation.observationSha256,
    transitionGatewayProjectionSha256,
    observations,
  };
  return Object.freeze({
    ...unsigned,
    chainAuthoritySha256: createB3ObservationChainAuthoritySha256({
      chain: unsigned,
      transitions,
    }),
  });
}

export function deriveB3ScenarioTransition({ records, authority }) {
  if (!Array.isArray(records) || records.length === 0 ||
      records.some((record) => {
        const retained = validatedRecordAuthority.get(record);
        return retained === undefined || retained !== sha256(Buffer.from(
          canonicaliseB3ProofValue(record),
          'utf8',
        ));
      })) {
    throw journalError('B3 scenario transition requires validated retained records');
  }
  if (!exactRecord(authority, ['scenario', 'outcome', 'traces']) ||
      typeof authority.scenario !== 'string' || typeof authority.outcome !== 'string' ||
      !Array.isArray(authority.traces) || authority.traces.some((trace) =>
        !exactRecord(trace, ['operation', 'relation']) ||
        typeof trace.operation !== 'string' || typeof trace.relation !== 'string')) {
    throw journalError('B3 scenario transition authority is invalid');
  }
  const scenarioRecords = records.filter(({ observation }) =>
    observation.scenario === authority.scenario,
  );
  if (scenarioRecords.length === 0) {
    throw journalError('B3 scenario transition is absent from retained observations');
  }
  // Host terminal capture reuses the ninth scenario identity but is not a new
  // scenario outcome. Preserve the latest actual scenario completion as the
  // transition authority.
  const scenarioTail = scenarioRecords.findLast(({ observation }) =>
    ['SCENARIO_COMPLETE', 'HOLD_REACHED'].includes(observation.phase),
  )?.observation ?? scenarioRecords.at(-1).observation;
  let completionObservation = scenarioTail;
  let observedOutcome = scenarioTail.proofProjection.scenarioOutcome;
  const android = scenarioTail.platform === 'android-play-physical';
  if (!['SCENARIO_COMPLETE', 'HOLD_REACHED'].includes(scenarioTail.phase) && android &&
      authority.scenario === 'slow-card-pending-decline') {
    completionObservation = records.find(({ observation }) =>
      observation.sequence > scenarioTail.sequence &&
      observation.scenarioIndex === scenarioTail.scenarioIndex + 1 &&
      observation.phase === 'ARMED' &&
      observation.proofProjection.entitlementState === 'none' &&
      observation.proofProjection.packState === 'absent' &&
      observation.proofProjection.entitlementAuthority.id === null &&
      observation.proofProjection.entitlementAuthority.state === 'none' &&
      observation.proofProjection.entitlementAuthority.domainSeparatedDigestSha256 === null &&
      observation.proofProjection.entitlementAuthority.refreshHandlePresent === false &&
      observation.proofProjection.packAuthority.packId === null &&
      observation.proofProjection.packAuthority.manifestSha256 === null &&
      observation.proofProjection.packAuthority.archiveSha256 === null &&
      observation.proofProjection.packAuthority.installed === false &&
      observation.proofProjection.transactionAuthority.source === 'none' &&
      observation.proofProjection.transactionAuthority.domainSeparatedDigestSha256 === null &&
      observation.proofProjection.transactionAuthority.rawProofCleared === false &&
      !observation.proofProjection.storeEvents.some((event) => event.outcome === 'purchased') &&
      observation.proofProjection.storeEvents.some((event) =>
        event.operation === 'queryTransactions' &&
        ['none', 'cancelled'].includes(event.outcome)))?.observation;
    observedOutcome = completionObservation ? 'declined-no-access' : observedOutcome;
  }
  if (!['SCENARIO_COMPLETE', 'HOLD_REACHED'].includes(scenarioTail.phase) && android &&
      authority.scenario === 'slow-card-pending-approve') {
    const pendingWithoutAccess = scenarioTail.proofProjection.entitlementState === 'none' &&
      scenarioTail.proofProjection.packState === 'absent' &&
      scenarioTail.proofProjection.storeCompletionObserved === false &&
      scenarioTail.proofProjection.entitlementAuthority.id === null &&
      scenarioTail.proofProjection.entitlementAuthority.state === 'none' &&
      scenarioTail.proofProjection.entitlementAuthority.refreshHandlePresent === false &&
      scenarioTail.proofProjection.packAuthority.packId === null &&
      scenarioTail.proofProjection.packAuthority.installed === false;
    completionObservation = records.find(({ observation }) =>
      pendingWithoutAccess &&
      observation.sequence > scenarioTail.sequence &&
      observation.scenario === 'unacknowledged-relaunch' &&
      observation.phase === 'HOLD_REACHED' &&
      observation.proofProjection.entitlementAuthority.state === 'active' &&
      observation.proofProjection.storeCompletionObserved === false &&
      observation.proofProjection.storeEvents.some((event) =>
        ['queryTransactions', 'transaction-update'].includes(event.operation) &&
        event.outcome === 'purchased'))?.observation;
    observedOutcome = completionObservation ? 'pending-approved-no-access' : observedOutcome;
  }
  if (!completionObservation || observedOutcome !== authority.outcome ||
      (!['SCENARIO_COMPLETE', 'HOLD_REACHED'].includes(scenarioTail.phase) &&
       completionObservation === scenarioTail)) {
    throw journalError('B3 scenario outcome differs from retained device authority');
  }
  const gatewayTraces = scenarioRecords.flatMap(({ observation }) =>
    observation.proofProjection.gatewayCalls.map((call) => ({
      operation: call.operation,
      relation: call.relation,
      traceId: call.traceId,
    })),
  );
  if (gatewayTraces.length !== authority.traces.length ||
      gatewayTraces.some((trace, index) =>
        trace.operation !== authority.traces[index].operation ||
        trace.relation !== authority.traces[index].relation)) {
    throw journalError('B3 scenario gateway traces differ from retained device authority');
  }
  return Object.freeze({
    scenario: authority.scenario,
    startedAt: scenarioRecords[0].observation.observedAt,
    completedAt: completionObservation.observedAt,
    outcome: observedOutcome,
    gatewayTraces: Object.freeze(gatewayTraces.map((trace) => Object.freeze(trace))),
  });
}
