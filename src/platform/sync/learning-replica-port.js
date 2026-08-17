import { validateSpellingProfile } from '../../domain/spelling/profile-contract.js';
import {
  assertClosedArray,
  assertClosedRecord,
  assertExactPort,
  assertString,
  cloneFrozenArray,
  fail,
} from '../commerce/store-port.js';

export const LEARNING_REPLICA_METHODS = Object.freeze([
  'getStatus',
  'publish',
  'pull',
]);

export const LEARNING_REPLICA_CONTAINER = 'iCloud.uk.eugnel.ks2spelling';

const ACCOUNT_STATES = new Set([
  'available',
  'noAccount',
  'restricted',
  'couldNotDetermine',
  'unsupported',
]);

const PROFILE_KEYS = Object.freeze([
  'learnerId',
  'nickname',
  'yearGroup',
  'goal',
  'colour',
  'createdAt',
  'updatedAt',
]);

const SNAPSHOT_ENVELOPE_KEYS = Object.freeze(['learnerId', 'payload']);
const ENVELOPE_KEYS = Object.freeze(['profiles', 'snapshots']);
const STATUS_KEYS = Object.freeze(['available', 'account', 'container']);
const LEARNER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const FORBIDDEN_ENVELOPE_KEYS = new Set([
  'selectedLearner',
  'selectedLearnerId',
  'parentPin',
  'pin',
  'PIN',
  'app_entitlements',
  'appEntitlements',
  'storeEntitlements',
  'packInstall',
  'pack-install',
  'downloadJobs',
]);

function rejectForbiddenKeys(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'string' && FORBIDDEN_ENVELOPE_KEYS.has(key)) {
      fail(label, `must not contain ${key}`);
    }
  }
}

function validateLearnerId(value, label) {
  return assertString(value, label, { max: 64, pattern: LEARNER_ID });
}

export function validateLearningReplicaStatus(value) {
  assertClosedRecord(value, STATUS_KEYS, 'Learning replica status');
  if (typeof value.available !== 'boolean') fail('Learning replica availability');
  if (!ACCOUNT_STATES.has(value.account)) fail('Learning replica account');
  if (value.container !== LEARNING_REPLICA_CONTAINER) {
    fail('Learning replica container');
  }
  if (value.available === true && value.account !== 'available') {
    fail('Learning replica availability', 'must be true only for an available account');
  }
  return Object.freeze({
    available: value.available,
    account: value.account,
    container: LEARNING_REPLICA_CONTAINER,
  });
}

function validateProfile(value, label) {
  rejectForbiddenKeys(value, label);
  assertClosedRecord(value, PROFILE_KEYS, label);
  try {
    return validateSpellingProfile(value);
  } catch (cause) {
    throw new TypeError(`${label} is invalid.`, { cause });
  }
}

function validateSnapshotEnvelope(value, label) {
  rejectForbiddenKeys(value, label);
  assertClosedRecord(value, SNAPSHOT_ENVELOPE_KEYS, label);
  const payload = value.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail(`${label} payload`, 'must be a plain record');
  }
  rejectForbiddenKeys(payload, `${label} payload`);
  return Object.freeze({
    learnerId: validateLearnerId(value.learnerId, `${label} learnerId`),
    payload: structuredClone(payload),
  });
}

export function validateLearningReplicaEnvelope(value, label) {
  rejectForbiddenKeys(value, label);
  assertClosedRecord(value, ENVELOPE_KEYS, label);
  return Object.freeze({
    profiles: cloneFrozenArray(
      assertClosedArray(value.profiles, `${label} profiles`, { max: 32 }),
      (profile, index) => validateProfile(profile, `${label} profiles[${index}]`),
    ),
    snapshots: cloneFrozenArray(
      assertClosedArray(value.snapshots, `${label} snapshots`, { max: 32 }),
      (snapshot, index) => validateSnapshotEnvelope(
        snapshot,
        `${label} snapshots[${index}]`,
      ),
    ),
  });
}

export function validatePublishRequest(value) {
  return validateLearningReplicaEnvelope(value, 'Learning replica publish');
}

export function validatePullResult(value) {
  return validateLearningReplicaEnvelope(value, 'Learning replica pull');
}

export function assertLearningReplicaPort(value) {
  return assertExactPort(value, LEARNING_REPLICA_METHODS, 'LearningReplicaPort');
}
