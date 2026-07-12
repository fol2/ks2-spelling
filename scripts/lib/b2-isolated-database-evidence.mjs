import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_FILENAME = /^[A-Za-z0-9._-]+$/;

const DEFAULT_FS = Object.freeze({
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
});

function evidenceError(code, message, options) {
  const error = new Error(message, options);
  error.code = code;
  return error;
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).toSorted().join('\0') === [...keys].toSorted().join('\0')
  );
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function validateAuthority({ databasePath, observedFiles, fileSha256 }) {
  if (
    typeof databasePath !== 'string' ||
    !databasePath ||
    !Array.isArray(observedFiles) ||
    observedFiles.length === 0 ||
    observedFiles[0] !== basename(databasePath) ||
    new Set(observedFiles).size !== observedFiles.length ||
    observedFiles.some(
      (name) =>
        typeof name !== 'string' ||
        !SAFE_FILENAME.test(name) ||
        basename(name) !== name,
    ) ||
    !exactKeys(fileSha256, observedFiles) ||
    observedFiles.some((name) => !SHA256.test(fileSha256[name] ?? ''))
  ) {
    throw evidenceError(
      'b2_hash_bound_database_set_invalid',
      'B2 hash-bound database authority is malformed',
    );
  }
}

async function verifyOriginals({
  sourceDirectory,
  observedFiles,
  fileSha256,
  fs,
}) {
  for (const filename of observedFiles) {
    const actual = sha256(await fs.readFile(join(sourceDirectory, filename)));
    if (actual !== fileSha256[filename]) {
      throw evidenceError(
        'b2_hash_bound_database_set_changed',
        `B2 hash-bound database evidence changed: ${filename}`,
      );
    }
  }
}

export async function inspectHashBoundDatabaseSet(
  {
    databasePath,
    observedFiles,
    fileSha256,
  },
  {
    scratchRoot,
    scratchPrefix,
    inspectDatabase,
    fs = DEFAULT_FS,
    signal,
  } = {},
) {
  validateAuthority({ databasePath, observedFiles, fileSha256 });
  if (
    typeof scratchRoot !== 'string' ||
    !scratchRoot ||
    typeof scratchPrefix !== 'string' ||
    !/^[a-z0-9-]+$/.test(scratchPrefix) ||
    typeof inspectDatabase !== 'function'
  ) {
    throw new TypeError('B2 isolated database inspection options are invalid.');
  }
  signal?.throwIfAborted();
  const sourceDirectory = dirname(databasePath);
  await verifyOriginals({ sourceDirectory, observedFiles, fileSha256, fs });
  signal?.throwIfAborted();
  await fs.mkdir(scratchRoot, { recursive: true });
  const scratchDirectory = await fs.mkdtemp(
    join(scratchRoot, `${scratchPrefix}-`),
  );
  let result;
  let primaryError;
  try {
    for (const filename of observedFiles) {
      signal?.throwIfAborted();
      const source = join(sourceDirectory, filename);
      const destination = join(scratchDirectory, filename);
      await fs.copyFile(source, destination);
      if (sha256(await fs.readFile(destination)) !== fileSha256[filename]) {
        throw evidenceError(
          'b2_hash_bound_database_scratch_invalid',
          `B2 verification scratch copy drifted: ${filename}`,
        );
      }
    }
    signal?.throwIfAborted();
    result = await inspectDatabase(
      join(scratchDirectory, observedFiles[0]),
      { signal },
    );
  } catch (error) {
    primaryError = error;
  }

  let integrityError;
  try {
    await verifyOriginals({ sourceDirectory, observedFiles, fileSha256, fs });
  } catch (error) {
    integrityError = error;
  }
  let cleanupError;
  try {
    await fs.rm(scratchDirectory, { force: true, recursive: true });
  } catch (error) {
    cleanupError = error;
  }
  const errors = [primaryError, integrityError, cleanupError].filter(Boolean);
  if (errors.length > 1) {
    const aggregate = new AggregateError(
      errors,
      'B2 isolated database inspection failed with verification or cleanup errors',
      { cause: primaryError ?? integrityError ?? cleanupError },
    );
    aggregate.code =
      primaryError?.code ??
      integrityError?.code ??
      cleanupError?.code ??
      'b2_isolated_database_inspection_failed';
    throw aggregate;
  }
  if (errors.length === 1) throw errors[0];
  signal?.throwIfAborted();
  return result;
}
