import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
} from 'node:fs/promises';
import { resolve } from 'node:path';

import { parseB3StrictJsonBytes } from '../check-b3-external-prerequisites.mjs';
import {
  canonicaliseB3ProofValue,
  validateB3GatewaySmokeAuthority,
  validateB3ProofLaunchCommand,
  validateB3ProofObservationBytes,
} from '../../src/app/b3-live-proof-protocol.js';
import {
  createB3ObservationChainAuthoritySha256,
  createB3TransitionGatewayProjectionSha256,
} from './b3-evidence.mjs';
import {
  createB3CaptureCheckpointFromObservation,
  validateB3CaptureCheckpointBytes,
} from './b3-device-observation.mjs';

const MAXIMUM_RECORD_BYTES = 128 * 1024;
const MAXIMUM_JOURNAL_RECORDS = 512;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
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
const RECORD_NAME = /^(?<sequence>[0-9]{8})\.json$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const BUILD_SOURCE_KEYS = Object.freeze([
  'schemaVersion',
  'testedApplicationCommit',
  'applicationFingerprint',
  'versionName',
  'iosBuildNumber',
  'androidVersionCode',
]);
const validatedRecordAuthority = new WeakMap();
const validatedJournalSnapshots = new WeakSet();

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

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function recordName(sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 99_999_999) {
    throw journalError('B3 physical observation journal sequence is invalid');
  }
  return `${String(sequence).padStart(8, '0')}.json`;
}

function relativeDirectory(platform) {
  return `.native-build/b3/evidence/${platformName(platform)}-observations`;
}

async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensurePrivateDirectory(root, platform) {
  const canonicalRoot = await realpath(resolve(root));
  let current = canonicalRoot;
  for (const component of [
    '.native-build',
    'b3',
    'evidence',
    `${platformName(platform)}-observations`,
  ]) {
    current = resolve(current, component);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
        (metadata.mode & 0o077) !== 0) {
      throw journalError('B3 physical observation journal directory policy is invalid');
    }
  }
  const directory = await realpath(current);
  if (!directory.startsWith(`${canonicalRoot}/`)) {
    throw journalError('B3 physical observation journal escaped the repository');
  }
  return { canonicalRoot, directory };
}

async function readSecureRecord(path) {
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    if (['ELOOP', 'ENOENT'].includes(error?.code)) {
      throw journalError('B3 physical observation journal link or file policy is invalid');
    }
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600 ||
        before.size <= 0 || before.size > MAXIMUM_RECORD_BYTES) {
      throw journalError('B3 physical observation journal file or link policy is invalid');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!after.isFile() || after.nlink !== 1 || (after.mode & 0o777) !== 0o600 ||
        after.dev !== before.dev || after.ino !== before.ino ||
        after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs || bytes.length !== before.size) {
      throw journalError('B3 physical observation journal changed while being read');
    }
    return Object.freeze({
      bytes,
      metadata: Object.freeze({
        dev: before.dev,
        ino: before.ino,
        mode: before.mode & 0o777,
        nlink: before.nlink,
        size: before.size,
        mtimeMs: before.mtimeMs,
        ctimeMs: before.ctimeMs,
        sha256: sha256(bytes),
      }),
    });
  } finally {
    await handle.close();
  }
}

function validateCaptureAuthority({ records, captureAuthority }) {
  if (captureAuthority === undefined) return;
  if (!exactRecord(captureAuthority, [
    'captureId', 'expectedSequence', 'previousObservationSha256',
  ]) || !UUID_V4.test(captureAuthority.captureId) ||
      !Number.isSafeInteger(captureAuthority.expectedSequence) ||
      captureAuthority.expectedSequence < 1 ||
      !/^[0-9a-f]{64}$/u.test(captureAuthority.previousObservationSha256)) {
    throw journalError('B3 physical observation journal capture authority is invalid');
  }
  const tail = records.at(-1)?.observation;
  if (records.length !== captureAuthority.expectedSequence - 1 ||
      records.some(({ command, observation }) =>
        command.captureId !== captureAuthority.captureId ||
        observation.captureId !== captureAuthority.captureId) ||
      (tail?.observationSha256 ?? '0'.repeat(64)) !==
        captureAuthority.previousObservationSha256) {
    throw journalError('B3 physical observation journal differs from capture authority');
  }
}

function sameJournalSnapshot(left, right) {
  return left.directory.dev === right.directory.dev &&
    left.directory.ino === right.directory.ino &&
    left.directory.mode === right.directory.mode &&
    left.entries.length === right.entries.length &&
    left.entries.every((entry, index) => {
      const expected = right.entries[index];
      return entry.name === expected.name &&
        Object.entries(entry.metadata).every(([key, value]) => expected.metadata[key] === value);
    });
}

export async function validateB3PhysicalObservationJournalDirectory({
  root,
  directory: rawDirectory,
  platform,
  buildAuthority,
  captureAuthority,
  expectedSnapshot,
}) {
  const name = platformName(platform);
  const canonicalRoot = await realpath(resolve(root));
  const path = resolve(rawDirectory);
  const before = await lstat(path);
  if (!before.isDirectory() || before.isSymbolicLink() ||
      (before.mode & 0o777) !== 0o700) {
    throw journalError('B3 physical observation journal directory policy is invalid');
  }
  const directory = await realpath(path);
  if (!directory.startsWith(`${canonicalRoot}/`)) {
    throw journalError('B3 physical observation journal escaped the repository');
  }
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > MAXIMUM_JOURNAL_RECORDS) {
    throw journalError('B3 physical observation journal entry bound is exceeded');
  }
  if (entries.some((entry) => !entry.isFile() || !RECORD_NAME.test(entry.name))) {
    throw journalError('B3 physical observation journal link or entry policy is invalid');
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const records = [];
  const retainedEntries = [];
  let previousObservation;
  for (const [index, entry] of entries.entries()) {
    const sequence = Number(RECORD_NAME.exec(entry.name).groups.sequence);
    if (sequence !== index + 1 || entry.name !== recordName(sequence)) {
      throw journalError('B3 physical observation journal sequence is not contiguous');
    }
    const retained = await readSecureRecord(resolve(directory, entry.name));
    const { record } = await validateB3PhysicalObservationRecordBytes({
      bytes: retained.bytes,
      platform: name,
      sequence,
      buildAuthority,
      previousObservation,
    });
    records.push(record);
    retainedEntries.push(Object.freeze({ name: entry.name, metadata: retained.metadata }));
    previousObservation = record.observation;
  }
  const after = await lstat(directory);
  if (!after.isDirectory() || after.isSymbolicLink() ||
      after.dev !== before.dev || after.ino !== before.ino ||
      (after.mode & 0o777) !== 0o700 || after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs) {
    throw journalError('B3 physical observation journal changed while being read');
  }
  validateCaptureAuthority({ records, captureAuthority });
  const snapshot = Object.freeze({
    directory: Object.freeze({
      dev: before.dev,
      ino: before.ino,
      mode: before.mode & 0o777,
    }),
    entries: Object.freeze(retainedEntries),
  });
  const snapshotSha256 = sha256(Buffer.concat([
    Buffer.from('ks2-spelling:b3-physical-observation-journal-snapshot:v1\0', 'utf8'),
    Buffer.from(canonicaliseB3ProofValue(snapshot), 'utf8'),
  ]));
  validatedJournalSnapshots.add(snapshot);
  if (expectedSnapshot !== undefined &&
      (!validatedJournalSnapshots.has(expectedSnapshot) ||
       !sameJournalSnapshot(snapshot, expectedSnapshot))) {
    throw journalError('B3 physical observation journal changed while being archived');
  }
  return Object.freeze({
    records: Object.freeze(records),
    snapshot,
    snapshotSha256,
  });
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
  const value = parseB3StrictJsonBytes(bytes, 'B3 physical observation journal record');
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

export async function readB3PhysicalObservationJournal({ root, platform, buildAuthority }) {
  const name = platformName(platform);
  const { directory } = await ensurePrivateDirectory(root, name);
  return (await validateB3PhysicalObservationJournalDirectory({
    root,
    directory,
    platform: name,
    buildAuthority,
  })).records;
}

async function writeSyncedTemporary(path, bytes) {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function appendB3PhysicalObservation({
  root,
  platform,
  command: rawCommand,
  buildAuthority,
  observationBytes: rawObservationBytes,
}) {
  const name = platformName(platform);
  const command = validateB3ProofLaunchCommand(rawCommand);
  if (command.platform !== PLATFORMS[name]) {
    throw journalError('B3 physical observation command platform is invalid');
  }
  const records = await readB3PhysicalObservationJournal({ root, platform: name, buildAuthority });
  const sequence = command.expectedSequence;
  const previousObservation = records.at(-1)?.observation;
  const observationBytes = rawObservationBytes instanceof Uint8Array
    ? Buffer.from(rawObservationBytes)
    : null;
  if (!observationBytes) {
    throw journalError('B3 physical observation bytes are invalid');
  }
  const filename = recordName(sequence);
  const relative = `${relativeDirectory(name)}/${filename}`;
  if (sequence <= records.length) {
    const existing = records[sequence - 1];
    if (canonicaliseB3ProofValue(existing.command) !== canonicaliseB3ProofValue(command) ||
        canonicaliseB3ProofValue(existing.observation) !== observationBytes.toString('utf8')) {
      throw journalError('B3 physical observation journal sequence conflicts with its immutable record');
    }
    return relative;
  }
  const derived = await deriveB3PhysicalObservationRecord({
    platform: name,
    command,
    buildAuthority,
    previousObservation,
    observationBytes,
  });
  const bytes = derived.recordBytes;
  const { directory } = await ensurePrivateDirectory(root, name);
  const path = resolve(directory, filename);
  if (sequence !== records.length + 1) {
    throw journalError('B3 physical observation journal sequence is not contiguous');
  }

  // Temporary writer debris lives outside the closed observation directory.
  // The immutable target hard-link is the concurrency primitive: exactly one
  // writer can create a sequence and a loser can only accept identical bytes.
  const temporary = resolve(directory, '..', `${name}-observation-${randomUUID()}.tmp`);
  try {
    await writeSyncedTemporary(temporary, bytes);
    try {
      await link(temporary, path);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = await readSecureRecord(path);
      if (!existing.bytes.equals(bytes)) {
        throw journalError('B3 physical observation journal sequence conflicts with its immutable record');
      }
    }
    await rm(temporary, { force: true });
    await syncDirectory(directory);
    const persisted = await readSecureRecord(path);
    if (!persisted.bytes.equals(bytes)) {
      throw journalError('B3 physical observation journal persistence changed its bytes');
    }
  } finally {
    await rm(temporary, { force: true });
  }
  return relative;
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
