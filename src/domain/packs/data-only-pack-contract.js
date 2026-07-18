const INPUT_KEYS = Object.freeze(['manifest', 'entries']);
const MANIFEST_KEYS = Object.freeze(['allowedExtensions', 'ceilings', 'files']);
const CEILING_KEYS = Object.freeze(['fileCount', 'compressedBytes', 'extractedBytes']);
const FILE_KEYS = Object.freeze(['path', 'sha256', 'bytes']);
const ENTRY_KEYS = Object.freeze(['path', 'compressedBytes', 'extractedBytes']);
const BINARY_OWNED_DATA_EXTENSIONS = new Set(['.json', '.m4a']);

function fail(detail) {
  throw new TypeError(`Data-only pack inventory ${detail}.`);
}

function assertClosedRecord(value, keys, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    fail(`${label} must be a closed plain object`);
  }
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) {
    fail(`${label} must contain exactly the approved fields`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail(`${label} must contain only enumerable data fields`);
    }
  }
}

function assertPlainArray(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(`${label} must be a plain array`);
  }
  const expectedKeys = new Set([
    ...Array.from({ length: value.length }, (_, index) => String(index)),
    'length',
  ]);
  if (Reflect.ownKeys(value).some((key) => !expectedKeys.has(key))) {
    fail(`${label} must not contain extra fields`);
  }
}

function assertPositiveSafeInteger(value, label, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    fail(`${label} must be a ${allowZero ? 'non-negative' : 'positive'} safe integer`);
  }
}

function pathExtension(path) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot);
}

function validatePath(path, allowedExtensions) {
  if (
    typeof path !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(path)
  ) {
    fail('path must use the deterministic safe ASCII path alphabet');
  }
  if (
    path.startsWith('/') ||
    /^[A-Za-z]:\//.test(path) ||
    path.includes('\\') ||
    path.endsWith('/')
  ) {
    fail(`path ${JSON.stringify(path)} is not a safe relative path`);
  }
  const segments = path.split('/');
  if (
    segments.some((segment) =>
      segment.length === 0 ||
      segment === '.' ||
      segment === '..' ||
      segment.startsWith('.')
    )
  ) {
    fail(`path ${JSON.stringify(path)} contains a forbidden segment`);
  }
  const extension = pathExtension(path);
  if (
    !allowedExtensions.has(extension) ||
    !BINARY_OWNED_DATA_EXTENSIONS.has(extension)
  ) {
    fail(`path ${JSON.stringify(path)} is not an approved data-only extension`);
  }
  return path;
}

function indexBySafePath(records, allowedExtensions, label, validateRecord) {
  const exact = new Set();
  const folded = new Set();
  const indexed = new Map();
  for (const record of records) {
    validateRecord(record);
    const path = validatePath(record.path, allowedExtensions);
    const collisionKey = path.replace(/[A-Z]/g, (character) => character.toLowerCase());
    if (exact.has(path) || folded.has(collisionKey)) {
      fail(`${label} contains a duplicate, case-fold or Unicode NFC path collision`);
    }
    exact.add(path);
    folded.add(collisionKey);
    indexed.set(path, record);
  }
  return indexed;
}

function addChecked(total, value, label) {
  const result = total + value;
  if (!Number.isSafeInteger(result)) fail(`${label} total exceeds the safe integer range`);
  return result;
}

export function validateDataOnlyInventory(input) {
  assertClosedRecord(input, INPUT_KEYS, 'input');
  assertClosedRecord(input.manifest, MANIFEST_KEYS, 'manifest');
  assertClosedRecord(input.manifest.ceilings, CEILING_KEYS, 'ceilings');
  assertPlainArray(input.manifest.allowedExtensions, 'allowed extensions');
  assertPlainArray(input.manifest.files, 'manifest files');
  assertPlainArray(input.entries, 'archive entries');

  const extensions = new Set();
  for (const extension of input.manifest.allowedExtensions) {
    if (
      typeof extension !== 'string' ||
      !/^\.[a-z0-9]{1,12}$/.test(extension) ||
      !BINARY_OWNED_DATA_EXTENSIONS.has(extension)
    ) {
      fail('allowed extension must be a lower-case data-only extension');
    }
    if (extensions.has(extension)) fail('allowed extensions contain a duplicate');
    extensions.add(extension);
  }
  if (extensions.size === 0) fail('allowed extensions must not be empty');

  for (const key of CEILING_KEYS) {
    assertPositiveSafeInteger(input.manifest.ceilings[key], `${key} ceiling`);
  }
  const manifestFiles = indexBySafePath(
    input.manifest.files,
    extensions,
    'manifest files',
    (file) => {
      assertClosedRecord(file, FILE_KEYS, 'manifest file');
      if (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) {
        fail('manifest file SHA-256 digest must be lower-case hexadecimal');
      }
      assertPositiveSafeInteger(file.bytes, 'manifest file bytes', { allowZero: true });
    },
  );
  const entries = indexBySafePath(
    input.entries,
    extensions,
    'archive entries',
    (entry) => {
      assertClosedRecord(entry, ENTRY_KEYS, 'archive entry');
      assertPositiveSafeInteger(entry.compressedBytes, 'compressed bytes', { allowZero: true });
      assertPositiveSafeInteger(entry.extractedBytes, 'extracted bytes', { allowZero: true });
    },
  );

  if (manifestFiles.size !== entries.size) {
    fail('archive inventory has an undeclared or missing member');
  }
  let compressedBytes = 0;
  let extractedBytes = 0;
  for (const [path, entry] of entries) {
    const declared = manifestFiles.get(path);
    if (!declared) fail(`archive inventory contains undeclared member ${JSON.stringify(path)}`);
    if (declared.bytes !== entry.extractedBytes) {
      fail(`archive member ${JSON.stringify(path)} extracted size differs from the manifest`);
    }
    compressedBytes = addChecked(compressedBytes, entry.compressedBytes, 'compressed bytes');
    extractedBytes = addChecked(extractedBytes, entry.extractedBytes, 'extracted bytes');
  }
  for (const path of manifestFiles.keys()) {
    if (!entries.has(path)) fail(`archive inventory is missing member ${JSON.stringify(path)}`);
  }

  const { ceilings } = input.manifest;
  if (entries.size > ceilings.fileCount) fail('file-count ceiling exceeded');
  if (compressedBytes > ceilings.compressedBytes) fail('compressed-bytes ceiling exceeded');
  if (extractedBytes > ceilings.extractedBytes) fail('extracted-bytes ceiling exceeded');

  const paths = Object.freeze([...entries.keys()]);
  return Object.freeze({
    fileCount: paths.length,
    compressedBytes,
    extractedBytes,
    paths,
  });
}
