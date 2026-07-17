import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { resolve } from 'node:path';

import { parseB3StrictJsonBytes } from '../check-b3-external-prerequisites.mjs';
import { canonicalJson } from '../../src/platform/database/canonical-json.js';

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
  const value = parseB3StrictJsonBytes(bytes, 'B3 capture checkpoint');
  if (value.platform !== platform) throw checkpointError('B3 capture checkpoint platform differs');
  return validateStoredCheckpoint(value, bytes);
}

function relativeCheckpointPath(platform) {
  if (!Object.hasOwn(SCENARIOS, platform)) throw checkpointError('B3 capture platform is invalid');
  return `.native-build/b3/evidence/${platform}-capture-checkpoint.json`;
}

async function ensurePrivateDirectory(root) {
  const canonicalRoot = await realpath(resolve(root));
  let current = canonicalRoot;
  for (const component of ['.native-build', 'b3', 'evidence']) {
    current = resolve(current, component);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
      throw checkpointError('B3 capture checkpoint directory policy is invalid');
    }
  }
  const canonicalDirectory = await realpath(current);
  if (!canonicalDirectory.startsWith(`${canonicalRoot}/`)) {
    throw checkpointError('B3 capture checkpoint directory escaped the repository');
  }
  return { canonicalRoot, directory: canonicalDirectory };
}

export async function readB3CaptureCheckpoint({ root, platform }) {
  const { canonicalRoot } = await ensurePrivateDirectory(root);
  const path = resolve(canonicalRoot, relativeCheckpointPath(platform));
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let bytes;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0 ||
        metadata.size <= 0 || metadata.size > MAXIMUM_BYTES) {
      throw checkpointError('B3 capture checkpoint file or link policy is invalid');
    }
    bytes = await handle.readFile();
    const finalMetadata = await handle.stat();
    if (finalMetadata.dev !== metadata.dev || finalMetadata.ino !== metadata.ino ||
        finalMetadata.size !== metadata.size || finalMetadata.mtimeMs !== metadata.mtimeMs) {
      throw checkpointError('B3 capture checkpoint changed while being read');
    }
  } finally {
    await handle.close();
  }
  return validateB3CaptureCheckpointBytes({ bytes, platform });
}

async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
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

export async function writeB3CaptureCheckpoint({
  root,
  platform,
  expectedRevision,
  value,
}) {
  if (!isExactRecord(value, STORED_KEYS)) {
    throw checkpointError('B3 capture checkpoint write violates its closed schema');
  }
  const checkpoint = createB3CaptureCheckpoint(unsignedCheckpoint(value));
  if (checkpoint.checkpointSha256 !== value.checkpointSha256 || checkpoint.platform !== platform) {
    throw checkpointError('B3 capture checkpoint write authority is invalid');
  }
  if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
    throw checkpointError('B3 capture checkpoint expected revision is invalid');
  }
  const { canonicalRoot, directory } = await ensurePrivateDirectory(root);
  const relativePath = relativeCheckpointPath(platform);
  const path = resolve(canonicalRoot, relativePath);
  const bytes = Buffer.from(canonicalJson(checkpoint), 'utf8');
  const revisionPath = `${path}.revision-${String(checkpoint.checkpointRevision).padStart(8, '0')}.json`;
  const revisionTemporary = `${path}.${randomUUID()}.revision.tmp`;
  const currentTemporary = `${path}.${randomUUID()}.current.tmp`;
  try {
    await writeSyncedTemporary(revisionTemporary, bytes);
    try {
      await link(revisionTemporary, revisionPath);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const retainedRevision = await open(
        revisionPath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      try {
        if (!(await retainedRevision.readFile()).equals(bytes)) {
          throw checkpointError(
            'B3 capture checkpoint revision conflicts with a concurrent writer',
            'b3_capture_checkpoint_stale',
          );
        }
      } finally {
        await retainedRevision.close();
      }
    }
    await rm(revisionTemporary, { force: true });
    if (expectedRevision === null) {
      if (checkpoint.checkpointRevision !== 0) {
        throw checkpointError('B3 initial capture checkpoint revision is invalid');
      }
      await writeSyncedTemporary(currentTemporary, bytes);
      try {
        await link(currentTemporary, path);
      } catch (error) {
        if (error?.code === 'EEXIST') {
          throw checkpointError('B3 capture checkpoint already exists', 'b3_capture_checkpoint_stale');
        }
        throw error;
      } finally {
        await rm(currentTemporary, { force: true });
      }
    } else {
      const current = await readB3CaptureCheckpoint({ root: canonicalRoot, platform });
      if (current.checkpointRevision !== expectedRevision ||
          checkpoint.checkpointRevision !== expectedRevision + 1) {
        throw checkpointError('B3 capture checkpoint stale revision rejected', 'b3_capture_checkpoint_stale');
      }
      await writeSyncedTemporary(currentTemporary, bytes);
      const currentAgain = await readB3CaptureCheckpoint({ root: canonicalRoot, platform });
      if (currentAgain.checkpointRevision !== current.checkpointRevision ||
          currentAgain.checkpointSha256 !== current.checkpointSha256) {
        throw checkpointError('B3 capture checkpoint changed before replacement', 'b3_capture_checkpoint_stale');
      }
      await rename(currentTemporary, path);
    }
    await syncDirectory(directory);
    const persisted = await readB3CaptureCheckpoint({ root: canonicalRoot, platform });
    if (persisted.checkpointSha256 !== checkpoint.checkpointSha256) {
      throw checkpointError('B3 capture checkpoint persistence changed its bytes');
    }
  } finally {
    await rm(revisionTemporary, { force: true });
    await rm(currentTemporary, { force: true });
  }
  return relativePath;
}

export function assertB3CaptureResumeAuthority(checkpoint, expected) {
  if (!isExactRecord(expected, RESUME_KEYS) ||
      RESUME_KEYS.some((key) => checkpoint?.[key] !== expected[key])) {
    throw checkpointError('B3 capture resume authority differs from its checkpoint');
  }
  return checkpoint;
}
