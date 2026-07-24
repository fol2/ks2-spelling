import {
  LEARNING_BACKUP_MAXIMUM_BYTES,
} from '../domain/security/learning-backup-contract.js';

const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function backupFileError(code, message) {
  return Object.assign(new Error(message), { code });
}

function exactRecord(value, keys, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw backupFileError(
      'parent_backup_file_invalid',
      `${label} has an invalid shape.`,
    );
  }
  return value;
}

function requireDependencies(repository, files, afterImport, now) {
  if (
    typeof repository?.exportBackup !== 'function' ||
    typeof repository?.importBackup !== 'function' ||
    typeof files?.presentExport !== 'function' ||
    typeof files?.pickImport !== 'function' ||
    typeof afterImport !== 'function' ||
    typeof now !== 'function'
  ) {
    throw new TypeError('Parent backup service dependencies are invalid.');
  }
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return globalThis.btoa(binary);
}

function base64ToBytes(value) {
  const maximumEncodedLength =
    4 * Math.ceil(LEARNING_BACKUP_MAXIMUM_BYTES / 3);
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumEncodedLength ||
    !BASE64.test(value)
  ) {
    throw backupFileError(
      'parent_backup_file_invalid',
      'The selected backup bytes are invalid.',
    );
  }
  let binary;
  try {
    binary = globalThis.atob(value);
  } catch (cause) {
    throw backupFileError(
      'parent_backup_file_invalid',
      `The selected backup bytes are invalid: ${cause.message}`,
    );
  }
  if (
    binary.length === 0 ||
    binary.length > LEARNING_BACKUP_MAXIMUM_BYTES ||
    globalThis.btoa(binary) !== value
  ) {
    throw backupFileError(
      'parent_backup_file_invalid',
      'The selected backup bytes are outside the allowed bound.',
    );
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function sha256Hex(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw backupFileError(
      'parent_backup_crypto_unavailable',
      'Backup hashing is unavailable.',
    );
  }
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  return Array.from(
    digest,
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}

function sameDigest(left, right) {
  if (!SHA256.test(left) || !SHA256.test(right)) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function exportFileName(now) {
  const timestamp = now();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError('Parent backup clock returned an invalid timestamp.');
  }
  let iso;
  try {
    iso = new Date(timestamp).toISOString();
  } catch (cause) {
    throw new TypeError(
      'Parent backup clock returned an invalid timestamp.',
      { cause },
    );
  }
  return `ks2-spelling-backup-${iso
    .slice(0, 19)
    .replaceAll('-', '')
    .replace('T', '-')
    .replaceAll(':', '')}.json`;
}

function validateImportedResult(value) {
  const result = exactRecord(
    value,
    ['learnerCount', 'selectedLearnerId'],
    'Learning backup import result',
  );
  if (
    !Number.isSafeInteger(result.learnerCount) ||
    result.learnerCount < 0 ||
    (result.selectedLearnerId !== null &&
      typeof result.selectedLearnerId !== 'string') ||
    (result.learnerCount === 0) !== (result.selectedLearnerId === null)
  ) {
    throw backupFileError(
      'parent_backup_import_invalid',
      'Learning backup import result is invalid.',
    );
  }
  return Object.freeze({
    learnerCount: result.learnerCount,
    selectedLearnerId: result.selectedLearnerId,
  });
}

export function createParentBackupService({
  repository,
  files,
  afterImport,
  now = Date.now,
} = {}) {
  requireDependencies(repository, files, afterImport, now);

  return Object.freeze({
    async exportBackup() {
      const backup = await repository.exportBackup();
      if (typeof backup !== 'string') {
        throw backupFileError(
          'parent_backup_export_invalid',
          'Learning backup export did not return text.',
        );
      }
      const bytes = textEncoder.encode(backup);
      if (bytes.length < 2 || bytes.length > LEARNING_BACKUP_MAXIMUM_BYTES) {
        throw backupFileError(
          'parent_backup_export_invalid',
          'Learning backup export is outside the allowed bound.',
        );
      }
      const response = exactRecord(
        await files.presentExport({
          fileName: exportFileName(now),
          bytesBase64: bytesToBase64(bytes),
          sha256: await sha256Hex(bytes),
        }),
        ['presented'],
        'Backup export response',
      );
      if (response.presented !== true) {
        throw backupFileError(
          'parent_backup_export_failed',
          'The backup export sheet was not presented.',
        );
      }
      return Object.freeze({ presented: true });
    },

    async importBackup() {
      const response = await files.pickImport({
        maximumBytes: LEARNING_BACKUP_MAXIMUM_BYTES,
      });
      if (
        response &&
        typeof response === 'object' &&
        !Array.isArray(response) &&
        response.cancelled === true
      ) {
        exactRecord(response, ['cancelled'], 'Backup import response');
        return Object.freeze({ cancelled: true });
      }
      const imported = exactRecord(
        response,
        ['cancelled', 'bytesBase64', 'sha256'],
        'Backup import response',
      );
      if (imported.cancelled !== false || !SHA256.test(imported.sha256)) {
        throw backupFileError(
          'parent_backup_file_invalid',
          'The selected backup metadata is invalid.',
        );
      }
      const bytes = base64ToBytes(imported.bytesBase64);
      const actualSha256 = await sha256Hex(bytes);
      if (!sameDigest(actualSha256, imported.sha256)) {
        throw backupFileError(
          'parent_backup_hash_mismatch',
          'The selected backup hash does not match its bytes.',
        );
      }
      let backup;
      try {
        backup = textDecoder.decode(bytes);
      } catch (cause) {
        throw backupFileError(
          'parent_backup_file_invalid',
          `The selected backup is not valid UTF-8: ${cause.message}`,
        );
      }
      const result = validateImportedResult(
        await repository.importBackup(backup),
      );
      await afterImport(result);
      return Object.freeze({ cancelled: false, ...result });
    },
  });
}
