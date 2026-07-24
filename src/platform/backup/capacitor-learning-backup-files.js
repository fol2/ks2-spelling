import {
  LEARNING_BACKUP_MAXIMUM_BYTES,
} from '../../domain/security/learning-backup-contract.js';

const FILE_NAME =
  /^ks2-spelling-backup-[0-9]{8}-[0-9]{6}\.json$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function backupFileError() {
  return Object.assign(
    new Error('The learning backup file operation failed.'),
    { code: 'learning_backup_file_unavailable' },
  );
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
    throw new TypeError(`${label} is invalid learning backup data.`);
  }
  return value;
}

function decodedByteLength(value) {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function requireBase64(value, label) {
  const maximumEncodedLength =
    4 * Math.ceil(LEARNING_BACKUP_MAXIMUM_BYTES / 3);
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumEncodedLength ||
    !BASE64.test(value)
  ) {
    throw new TypeError(`${label} is invalid learning backup base64.`);
  }
  const length = decodedByteLength(value);
  if (length < 2 || length > LEARNING_BACKUP_MAXIMUM_BYTES) {
    throw new TypeError(`${label} is outside the learning backup byte bound.`);
  }
  return value;
}

function exportRequest(candidate) {
  const value = exactRecord(
    candidate,
    ['fileName', 'bytesBase64', 'sha256'],
    'Learning backup export request',
  );
  if (
    typeof value.fileName !== 'string' ||
    !FILE_NAME.test(value.fileName) ||
    typeof value.sha256 !== 'string' ||
    !SHA256.test(value.sha256)
  ) {
    throw new TypeError('Learning backup export metadata is invalid.');
  }
  return Object.freeze({
    fileName: value.fileName,
    bytesBase64: requireBase64(
      value.bytesBase64,
      'Learning backup export bytes',
    ),
    sha256: value.sha256,
  });
}

function importRequest(candidate) {
  const value = exactRecord(
    candidate,
    ['maximumBytes'],
    'Learning backup import request',
  );
  if (value.maximumBytes !== LEARNING_BACKUP_MAXIMUM_BYTES) {
    throw new TypeError('Learning backup import byte bound is invalid.');
  }
  return Object.freeze({
    maximumBytes: LEARNING_BACKUP_MAXIMUM_BYTES,
  });
}

function exportResult(candidate) {
  const value = exactRecord(
    candidate,
    ['presented'],
    'Learning backup export result',
  );
  if (value.presented !== true) {
    throw backupFileError();
  }
  return Object.freeze({ presented: true });
}

function importResult(candidate) {
  if (
    candidate &&
    typeof candidate === 'object' &&
    !Array.isArray(candidate) &&
    candidate.cancelled === true
  ) {
    exactRecord(candidate, ['cancelled'], 'Learning backup import result');
    return Object.freeze({ cancelled: true });
  }
  const value = exactRecord(
    candidate,
    ['cancelled', 'bytesBase64', 'sha256'],
    'Learning backup import result',
  );
  if (
    value.cancelled !== false ||
    typeof value.sha256 !== 'string' ||
    !SHA256.test(value.sha256)
  ) {
    throw new TypeError('Learning backup import metadata is invalid.');
  }
  return Object.freeze({
    cancelled: false,
    bytesBase64: requireBase64(
      value.bytesBase64,
      'Learning backup import bytes',
    ),
    sha256: value.sha256,
  });
}

function nativeMethods(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('LearningBackupFile plugin must be an object.');
  }
  const names = ['presentExport', 'pickImport'];
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== 0 &&
    (ownKeys.length !== names.length ||
      ownKeys.some((key) => !names.includes(key)))
  ) {
    throw new TypeError('LearningBackupFile exposes unsupported methods.');
  }
  const methods = {};
  for (const name of names) {
    let method;
    try {
      method = value[name];
    } catch {
      throw new TypeError(`LearningBackupFile.${name} must be available.`);
    }
    if (typeof method !== 'function') {
      throw new TypeError(`LearningBackupFile.${name} must be a function.`);
    }
    methods[name] = (request) => Reflect.apply(method, value, [request]);
  }
  return Object.freeze(methods);
}

async function callNative(method, request) {
  let pending;
  try {
    pending = method(request);
  } catch {
    throw backupFileError();
  }
  if (!(pending instanceof Promise)) {
    throw new TypeError('LearningBackupFile methods must return a Promise.');
  }
  try {
    return await pending;
  } catch {
    throw backupFileError();
  }
}

export function createCapacitorLearningBackupFiles({
  LearningBackupFile,
} = {}) {
  const methods = nativeMethods(LearningBackupFile);
  return Object.freeze({
    async presentExport(candidate) {
      const request = exportRequest(candidate);
      return exportResult(await callNative(methods.presentExport, request));
    },
    async pickImport(candidate) {
      const request = importRequest(candidate);
      return importResult(await callNative(methods.pickImport, request));
    },
  });
}
