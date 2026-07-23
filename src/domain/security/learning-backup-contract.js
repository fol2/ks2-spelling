import {
  validateCatalogueV1,
  validateSpellingCommandSnapshotV1,
  validateSpellingProfile,
} from '../spelling/index.js';
import { canonicalJson } from '../../platform/database/canonical-json.js';

export const LEARNING_BACKUP_MAXIMUM_BYTES = 5 * 1024 * 1024;
export const LEARNING_BACKUP_MAXIMUM_LEARNERS = 20;

const APP_ID = 'uk.eugnel.ks2spelling';
const BACKUP_KEYS = Object.freeze([
  'schemaVersion',
  'appId',
  'exportedAt',
  'selectedLearnerId',
  'learners',
]);
const ENCODE_KEYS = Object.freeze([
  'exportedAt',
  'selectedLearnerId',
  'learners',
]);
const LEARNER_KEYS = Object.freeze(['profile', 'snapshot']);
const textEncoder = new TextEncoder();

function backupError(code, message = code, options) {
  const error = new Error(message, options);
  error.code = code;
  return error;
}

function exactRecord(value, keys, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw backupError(
      'learning_backup_invalid',
      `${label} has an invalid shape.`,
    );
  }
  return value;
}

function safeTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw backupError(
      'learning_backup_invalid',
      `${label} must be a safe timestamp.`,
    );
  }
  return value;
}

function catalogueRegistry(cataloguesById) {
  if (
    !cataloguesById ||
    typeof cataloguesById !== 'object' ||
    Array.isArray(cataloguesById)
  ) {
    throw new TypeError('Learning backup catalogues must be an object.');
  }
  const registry = new Map();
  for (const [catalogueId, candidate] of Object.entries(cataloguesById)) {
    const catalogue = validateCatalogueV1(structuredClone(candidate));
    if (catalogue.catalogueId !== catalogueId) {
      throw new TypeError('Learning backup catalogue identity is invalid.');
    }
    registry.set(catalogueId, catalogue);
  }
  if (registry.size === 0) {
    throw new TypeError('Learning backup requires at least one catalogue.');
  }
  return registry;
}

function normaliseLearners(candidate, registry) {
  if (
    !Array.isArray(candidate) ||
    candidate.length > LEARNING_BACKUP_MAXIMUM_LEARNERS
  ) {
    throw backupError(
      'learning_backup_invalid',
      'Learning backup learner count is invalid.',
    );
  }
  const learnerIds = new Set();
  const learners = candidate.map((raw, index) => {
    const entry = exactRecord(raw, LEARNER_KEYS, `Backup learner ${index}`);
    const profile = validateSpellingProfile(structuredClone(entry.profile));
    const catalogueId = entry.snapshot?.catalogueId;
    const catalogue = registry.get(catalogueId);
    if (!catalogue) {
      throw backupError(
        'learning_backup_invalid',
        'Learning backup catalogue is unavailable.',
      );
    }
    const snapshot = validateSpellingCommandSnapshotV1(
      structuredClone(entry.snapshot),
      catalogue,
    );
    if (
      profile.learnerId !== snapshot.learnerId ||
      learnerIds.has(profile.learnerId)
    ) {
      throw backupError(
        'learning_backup_invalid',
        'Learning backup learner identity is invalid.',
      );
    }
    learnerIds.add(profile.learnerId);
    return { profile, snapshot };
  });
  learners.sort((left, right) =>
    left.profile.learnerId.localeCompare(right.profile.learnerId, 'en'));
  return { learners, learnerIds };
}

function normaliseBackup(candidate, registry, fromBytes) {
  const input = exactRecord(
    candidate,
    fromBytes ? BACKUP_KEYS : ENCODE_KEYS,
    'Learning backup',
  );
  if (
    fromBytes &&
    (input.schemaVersion !== 1 || input.appId !== APP_ID)
  ) {
    throw backupError(
      'learning_backup_invalid',
      'Learning backup authority is invalid.',
    );
  }
  const exportedAt = safeTimestamp(input.exportedAt, 'Backup exportedAt');
  const { learners, learnerIds } = normaliseLearners(input.learners, registry);
  const selectedLearnerId = input.selectedLearnerId;
  if (
    selectedLearnerId !== null &&
    (typeof selectedLearnerId !== 'string' ||
      !learnerIds.has(selectedLearnerId))
  ) {
    throw backupError(
      'learning_backup_invalid',
      'Learning backup selected learner is invalid.',
    );
  }
  if (learners.length > 0 && selectedLearnerId === null) {
    throw backupError(
      'learning_backup_invalid',
      'Learning backup must select one learner.',
    );
  }
  return {
    schemaVersion: 1,
    appId: APP_ID,
    exportedAt,
    selectedLearnerId,
    learners,
  };
}

function requireBoundedBytes(bytes, maximumBytes) {
  if (typeof bytes !== 'string') {
    throw backupError(
      'learning_backup_invalid',
      'Learning backup bytes must be text.',
    );
  }
  const length = textEncoder.encode(bytes).length;
  if (length < 2 || length > maximumBytes) {
    throw backupError(
      'learning_backup_too_large',
      'Learning backup size is outside the allowed bound.',
    );
  }
  return bytes;
}

export function createLearningBackupCodec({
  cataloguesById,
  maximumBytes = LEARNING_BACKUP_MAXIMUM_BYTES,
} = {}) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 2) {
    throw new TypeError('Learning backup maximumBytes must be a safe bound.');
  }
  const registry = catalogueRegistry(cataloguesById);

  return Object.freeze({
    encode(candidate) {
      const backup = normaliseBackup(candidate, registry, false);
      return requireBoundedBytes(canonicalJson(backup), maximumBytes);
    },
    decode(candidate) {
      const bytes = requireBoundedBytes(candidate, maximumBytes);
      let parsed;
      try {
        parsed = JSON.parse(bytes);
      } catch (cause) {
        throw backupError(
          'learning_backup_invalid',
          'Learning backup is not valid JSON.',
          { cause },
        );
      }
      const backup = normaliseBackup(parsed, registry, true);
      if (canonicalJson(backup) !== bytes) {
        throw backupError(
          'learning_backup_invalid',
          'Learning backup is not canonical.',
        );
      }
      return structuredClone(backup);
    },
  });
}
