import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import { constants as sqliteConstants, DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';

import { parseB3StrictJsonBytes } from '../check-b3-external-prerequisites.mjs';
import {
  B3_CAPTURE_STATE_APPLICATION_ID,
  B3_CAPTURE_STATE_SCHEMA_OBJECTS,
  B3_CAPTURE_STATE_SCHEMA_SHA256,
  B3_CAPTURE_STATE_SCHEMA_SQL,
  B3_CAPTURE_STATE_SCHEMA_VERSION,
} from './b3-capture-state-schema.mjs';
import { B3_CAPTURE_STATE_REPOSITORY_ROOT } from './b3-capture-state-location.mjs';

const PLATFORMS = new Set(['ios', 'android']);
const DATABASE_NAME = 'recovery.sqlite';
const JOURNAL_NAME = `${DATABASE_NAME}-journal`;
const HASH = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const APPROVED_PRAGMAS = new Set([
  'application_id',
  'busy_timeout',
  'foreign_key_check',
  'foreign_keys',
  'fullfsync',
  'integrity_check',
  'journal_mode',
  'locking_mode',
  'secure_delete',
  'synchronous',
  'temp_store',
  'trusted_schema',
  'user_version',
]);
const DENIED_AUTHORISER_ACTIONS = new Set([
  sqliteConstants.SQLITE_ATTACH,
  sqliteConstants.SQLITE_DETACH,
  sqliteConstants.SQLITE_ALTER_TABLE,
  sqliteConstants.SQLITE_CREATE_VTABLE,
  sqliteConstants.SQLITE_DROP_VTABLE,
]);
const STRICT_ONLY_DENIED_AUTHORISER_ACTIONS = new Set([
  sqliteConstants.SQLITE_REINDEX,
  sqliteConstants.SQLITE_ANALYZE,
]);
const SCHEMA_AUTHORISER_ACTIONS = new Set([
  sqliteConstants.SQLITE_CREATE_INDEX,
  sqliteConstants.SQLITE_CREATE_TABLE,
  sqliteConstants.SQLITE_CREATE_TRIGGER,
  sqliteConstants.SQLITE_CREATE_VIEW,
  sqliteConstants.SQLITE_CREATE_TEMP_INDEX,
  sqliteConstants.SQLITE_CREATE_TEMP_TABLE,
  sqliteConstants.SQLITE_CREATE_TEMP_TRIGGER,
  sqliteConstants.SQLITE_CREATE_TEMP_VIEW,
  sqliteConstants.SQLITE_DROP_INDEX,
  sqliteConstants.SQLITE_DROP_TABLE,
  sqliteConstants.SQLITE_DROP_TRIGGER,
  sqliteConstants.SQLITE_DROP_VIEW,
  sqliteConstants.SQLITE_DROP_TEMP_INDEX,
  sqliteConstants.SQLITE_DROP_TEMP_TABLE,
  sqliteConstants.SQLITE_DROP_TEMP_TRIGGER,
  sqliteConstants.SQLITE_DROP_TEMP_VIEW,
]);

function databaseError(message, code = 'b3_capture_state_invalid') {
  return Object.assign(new Error(message), { code });
}

function strictAuthoriser(actionCode, first, second) {
  if (DENIED_AUTHORISER_ACTIONS.has(actionCode) ||
      STRICT_ONLY_DENIED_AUTHORISER_ACTIONS.has(actionCode) ||
      SCHEMA_AUTHORISER_ACTIONS.has(actionCode)) return sqliteConstants.SQLITE_DENY;
  if (actionCode === sqliteConstants.SQLITE_PRAGMA &&
      (!APPROVED_PRAGMAS.has(first) || second !== null)) {
    return sqliteConstants.SQLITE_DENY;
  }
  if (actionCode === sqliteConstants.SQLITE_FUNCTION &&
      String(second ?? first ?? '').toLowerCase() === 'load_extension') {
    return sqliteConstants.SQLITE_DENY;
  }
  return sqliteConstants.SQLITE_OK;
}

function bootstrapAuthoriser(actionCode, first, second) {
  if (DENIED_AUTHORISER_ACTIONS.has(actionCode)) return sqliteConstants.SQLITE_DENY;
  if (actionCode === sqliteConstants.SQLITE_PRAGMA &&
      !APPROVED_PRAGMAS.has(first)) return sqliteConstants.SQLITE_DENY;
  if (actionCode === sqliteConstants.SQLITE_FUNCTION &&
      String(second ?? first ?? '').toLowerCase() === 'load_extension') {
    return sqliteConstants.SQLITE_DENY;
  }
  return sqliteConstants.SQLITE_OK;
}

async function syncFile(path) {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(path) {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

function validateDirectory(metadata, label) {
  if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
      (metadata.mode & 0o7777) !== 0o700) {
    throw databaseError(`B3 capture-state ${label} directory policy is invalid`);
  }
}

function validatePrivateFile(metadata, label, allowedSizes = null) {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 ||
      (metadata.mode & 0o7777) !== 0o600 ||
      (allowedSizes && !allowedSizes(metadata.size))) {
    throw databaseError(`B3 capture-state ${label} file policy is invalid`);
  }
}

async function createOrValidateDirectory(parent, name) {
  const path = resolve(parent, name);
  let created = false;
  try {
    await mkdir(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  validateDirectory(await lstat(path), name);
  if (created) await syncDirectory(parent);
  const canonical = await realpath(path);
  if (!canonical.startsWith(`${parent}/`)) {
    throw databaseError('B3 capture-state directory escaped the repository');
  }
  return canonical;
}

async function readBuildAuthority(root) {
  let current = root;
  for (const component of ['.native-build', 'b3', 'distribution']) {
    current = resolve(current, component);
    validateDirectory(await lstat(current), `build-authority ${component}`);
    const canonical = await realpath(current);
    if (!canonical.startsWith(`${root}/`)) {
      throw databaseError('B3 capture-state build authority escaped the repository');
    }
    current = canonical;
  }
  const authorityPath = resolve(current, 'build-authority.json');
  const handle = await open(
    authorityPath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  let bytes;
  try {
    const before = await handle.stat();
    validatePrivateFile(before, 'build-authority', (size) => size > 0 && size <= 16 * 1024);
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino ||
        after.mode !== before.mode || after.nlink !== before.nlink ||
        after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs || bytes.length !== before.size) {
      throw databaseError('B3 capture-state build authority changed while being read');
    }
  } finally {
    await handle.close();
  }
  const value = parseB3StrictJsonBytes(bytes, 'B3 distribution build authority');
  if (!value || Object.keys(value).length !== 6 || value.schemaVersion !== 1 ||
      !COMMIT.test(value.testedApplicationCommit ?? '') ||
      !HASH.test(value.applicationFingerprint ?? '') || value.versionName !== '0.3.0-b3' ||
      !/^[1-9][0-9]*$/u.test(value.iosBuildNumber ?? '') ||
      !Number.isSafeInteger(value.androidVersionCode) || value.androidVersionCode <= 0) {
    throw databaseError('B3 capture-state build authority is invalid');
  }
  return Object.freeze({
    testedApplicationCommit: value.testedApplicationCommit,
    applicationFingerprint: value.applicationFingerprint,
  });
}

async function assertLegacyStateAbsent(evidence, platform) {
  for (const name of [
    `${platform}-issued-command-ledger`,
    `${platform}-capture-recovery-installing`,
    `${platform}-abandoned-captures`,
  ]) {
    try {
      await lstat(resolve(evidence, name));
      throw databaseError('B3 capture-state legacy-state is present', 'b3_legacy_state');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

async function assertBootstrapBundleState(evidence, platform) {
  const path = resolve(evidence, `${platform}-capture-bundles`);
  try {
    validateDirectory(await lstat(path), 'capture-bundles');
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if ((await readdir(path)).length !== 0) {
    throw databaseError('B3 capture-state orphan-bundle-state is present', 'b3_orphan_bundle_state');
  }
}

async function validateStateNamespace(stateDirectory) {
  const maximumScans = 3;
  for (let scan = 1; scan <= maximumScans; scan += 1) {
    const entries = await readdir(stateDirectory, { withFileTypes: true });
    const names = new Set();
    let journalDisappeared = false;
    for (const entry of entries) {
      if (!entry.isFile() || ![DATABASE_NAME, JOURNAL_NAME].includes(entry.name)) {
        throw databaseError('B3 capture-state database sibling policy is invalid');
      }
      let metadata;
      try {
        metadata = await lstat(resolve(stateDirectory, entry.name));
      } catch (error) {
        if (entry.name === JOURNAL_NAME && error?.code === 'ENOENT') {
          journalDisappeared = true;
          break;
        }
        throw error;
      }
      validatePrivateFile(metadata, entry.name, (size) => size >= 0);
      names.add(entry.name);
    }
    if (journalDisappeared) continue;
    if (names.has(JOURNAL_NAME) && !names.has(DATABASE_NAME)) {
      throw databaseError('B3 capture-state journal exists without its database');
    }
    return names;
  }
  throw databaseError('B3 capture-state journal namespace did not stabilise');
}

function setConnectionPragmas(database) {
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    PRAGMA fullfsync = ON;
    PRAGMA foreign_keys = ON;
    PRAGMA trusted_schema = OFF;
    PRAGMA locking_mode = NORMAL;
    PRAGMA temp_store = MEMORY;
    PRAGMA secure_delete = ON;
  `);
}

async function validateExistingHeaderBytes(handle, size) {
  if (size < 100) {
    throw databaseError('B3 capture-state existing database header is truncated');
  }
  const header = Buffer.alloc(100);
  const { bytesRead } = await handle.read(header, 0, header.length, 0);
  if (bytesRead !== header.length ||
      !header.subarray(0, 16).equals(Buffer.from('SQLite format 3\0', 'binary')) ||
      header[18] !== 1 || header[19] !== 1 ||
      header.readUInt32BE(60) !== B3_CAPTURE_STATE_SCHEMA_VERSION ||
      header.readUInt32BE(68) !== B3_CAPTURE_STATE_APPLICATION_ID) {
    throw databaseError('B3 capture-state existing database header differs');
  }
}

function validateExistingDatabase(database) {
  if (pragmaScalar(database, 'application_id') !== B3_CAPTURE_STATE_APPLICATION_ID ||
      pragmaScalar(database, 'user_version') !== B3_CAPTURE_STATE_SCHEMA_VERSION ||
      pragmaScalar(database, 'journal_mode') !== 'delete' ||
      !isDeepStrictEqual(schemaObjects(database), B3_CAPTURE_STATE_SCHEMA_OBJECTS)) {
    throw databaseError('B3 capture-state existing database header or schema differs');
  }
}

function pragmaScalar(database, name) {
  const values = Object.values(database.prepare(`PRAGMA ${name}`).get());
  if (values.length !== 1) {
    throw databaseError(`B3 capture-state PRAGMA ${name} shape differs`);
  }
  return values[0];
}

function validatePragmas(database) {
  const expected = Object.freeze({
    application_id: B3_CAPTURE_STATE_APPLICATION_ID,
    user_version: B3_CAPTURE_STATE_SCHEMA_VERSION,
    journal_mode: 'delete',
    synchronous: 2,
    fullfsync: 1,
    foreign_keys: 1,
    trusted_schema: 0,
    busy_timeout: 5000,
    locking_mode: 'normal',
    temp_store: 2,
    secure_delete: 1,
  });
  for (const [name, value] of Object.entries(expected)) {
    if (pragmaScalar(database, name) !== value) {
      throw databaseError(`B3 capture-state PRAGMA ${name} differs`);
    }
  }
}

function schemaObjects(database) {
  return database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all().map((row) => ({ ...row }));
}

function bootstrapOrObserveSchema(database, platform, buildAuthority) {
  database.exec('BEGIN EXCLUSIVE');
  try {
    const userVersion = pragmaScalar(database, 'user_version');
    const objects = schemaObjects(database);
    if (userVersion === 0 && objects.length === 0) {
      database.exec(`
        PRAGMA application_id = ${B3_CAPTURE_STATE_APPLICATION_ID};
        PRAGMA user_version = ${B3_CAPTURE_STATE_SCHEMA_VERSION};
        ${B3_CAPTURE_STATE_SCHEMA_SQL}
      `);
      database.prepare(`
        INSERT INTO b3_meta (
          singleton, schema_version, platform, tested_application_commit,
          application_fingerprint, schema_sha256
        ) VALUES (1, ?, ?, ?, ?, ?)
      `).run(
        B3_CAPTURE_STATE_SCHEMA_VERSION,
        platform,
        buildAuthority.testedApplicationCommit,
        buildAuthority.applicationFingerprint,
        B3_CAPTURE_STATE_SCHEMA_SHA256,
      );
      database.exec(`
        INSERT INTO b3_authority_state (
          singleton, next_allocation_sequence, active_command_sha256,
          reserved_start_command_sha256, row_version
        ) VALUES (1, 1, NULL, NULL, 1)
      `);
    }
    database.exec('COMMIT');
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK');
    throw error;
  }
}

function validateDatabase(database, platform, buildAuthority) {
  validatePragmas(database);
  if (!isDeepStrictEqual(schemaObjects(database), B3_CAPTURE_STATE_SCHEMA_OBJECTS)) {
    throw databaseError('B3 capture-state frozen schema differs');
  }
  const integrity = database.prepare('PRAGMA integrity_check').all()
    .map((row) => ({ ...row }));
  if (!isDeepStrictEqual(integrity, [{ integrity_check: 'ok' }])) {
    throw databaseError('B3 capture-state integrity check failed');
  }
  if (database.prepare('PRAGMA foreign_key_check').all().length !== 0) {
    throw databaseError('B3 capture-state foreign-key check failed');
  }
  const meta = database.prepare('SELECT * FROM b3_meta').all();
  if (meta.length !== 1 || meta[0].singleton !== 1 ||
      meta[0].schema_version !== B3_CAPTURE_STATE_SCHEMA_VERSION ||
      meta[0].platform !== platform ||
      meta[0].tested_application_commit !== buildAuthority.testedApplicationCommit ||
      meta[0].application_fingerprint !== buildAuthority.applicationFingerprint ||
      meta[0].schema_sha256 !== B3_CAPTURE_STATE_SCHEMA_SHA256) {
    throw databaseError('B3 capture-state metadata authority differs');
  }
  const authorityRows = database.prepare('SELECT * FROM b3_authority_state').all();
  if (!isDeepStrictEqual(authorityRows.map((row) => ({ ...row })), [{
    singleton: 1,
    next_allocation_sequence: 1,
    active_command_sha256: null,
    reserved_start_command_sha256: null,
    row_version: 1,
  }])) {
    throw databaseError('B3 capture-state singleton authority differs');
  }
  const domainCounts = database.prepare(`
    SELECT
      (SELECT count(*) FROM b3_capture_start_intents) AS start_intents,
      (SELECT count(*) FROM b3_captures) AS captures,
      (SELECT count(*) FROM b3_commands) AS commands,
      (SELECT count(*) FROM b3_decisions) AS decisions,
      (SELECT count(*) FROM b3_recoveries) AS recoveries,
      (SELECT count(*) FROM b3_recovery_manifests) AS recovery_manifests,
      (SELECT count(*) FROM b3_recovery_authorities) AS recovery_authorities,
      (SELECT count(*) FROM b3_recovery_terminals) AS recovery_terminals
  `).get();
  if (Object.values(domainCounts).some((count) => count !== 0)) {
    throw databaseError('B3 capture-state domain authority requires S2 validation');
  }
}

function openWithPrivateMask(path) {
  const previous = process.umask(0o077);
  try { return new DatabaseSync(path); } finally { process.umask(previous); }
}

export async function openB3CaptureStateDatabase(options) {
  const keys = options && typeof options === 'object' ? Object.keys(options) : [];
  if (keys.length !== 1 || keys[0] !== 'platform') {
    throw databaseError('B3 capture-state open authority is invalid');
  }
  const platform = options.platform;
  if (!PLATFORMS.has(platform)) {
    throw databaseError('B3 capture-state open authority is invalid');
  }
  const root = await realpath(B3_CAPTURE_STATE_REPOSITORY_ROOT);
  if (root !== B3_CAPTURE_STATE_REPOSITORY_ROOT) {
    throw databaseError('B3 capture-state repository root is not canonical');
  }
  const buildAuthority = await readBuildAuthority(root);

  let evidence = root;
  for (const component of ['.native-build', 'b3', 'evidence']) {
    evidence = await createOrValidateDirectory(evidence, component);
  }
  await assertLegacyStateAbsent(evidence, platform);
  const unresolvedStateDirectory = resolve(evidence, `${platform}-capture-state`);
  try {
    await lstat(unresolvedStateDirectory);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await assertBootstrapBundleState(evidence, platform);
  }
  const stateDirectory = await createOrValidateDirectory(
    evidence, `${platform}-capture-state`,
  );
  await validateStateNamespace(stateDirectory);
  const databasePath = resolve(stateDirectory, DATABASE_NAME);
  try {
    await lstat(databasePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await assertBootstrapBundleState(evidence, platform);
  }
  let created = false;
  let guard;
  try {
    try {
      guard = await open(
        databasePath,
        fsConstants.O_RDONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
          fsConstants.O_NOFOLLOW,
        0o600,
      );
      created = true;
      await guard.sync();
      await syncDirectory(stateDirectory);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      guard = await open(databasePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    }
    const databaseMetadata = await guard.stat();
    validatePrivateFile(databaseMetadata, DATABASE_NAME, (size) => size >= 0);
    const bootstrapEligible = created || databaseMetadata.size === 0;
    if (bootstrapEligible) await assertBootstrapBundleState(evidence, platform);
    if (!bootstrapEligible) {
      await validateExistingHeaderBytes(guard, databaseMetadata.size);
    }

    const database = openWithPrivateMask(databasePath);
    let returned = false;
    try {
      database.enableDefensive(true);
      database.enableLoadExtension(false);
      database.setAuthorizer(bootstrapAuthoriser);
      if (database.location() !== databasePath) {
        throw databaseError('B3 capture-state SQLite location differs');
      }
      if (!bootstrapEligible) validateExistingDatabase(database);
      setConnectionPragmas(database);
      bootstrapOrObserveSchema(database, platform, buildAuthority);
      database.setAuthorizer(strictAuthoriser);
      validateDatabase(database, platform, buildAuthority);
      const after = await lstat(databasePath);
      validatePrivateFile(after, DATABASE_NAME, (size) => size > 0);
      if (after.dev !== databaseMetadata.dev || after.ino !== databaseMetadata.ino) {
        throw databaseError('B3 capture-state database identity changed during open');
      }
      if (bootstrapEligible) {
        await syncFile(databasePath);
        await syncDirectory(stateDirectory);
      }
      let closed = false;
      const state = Object.freeze({
        async close() {
          if (closed) throw databaseError('B3 capture-state handle is already closed');
          closed = true;
          database.close();
        },
      });
      returned = true;
      return state;
    } finally {
      if (!returned) {
        try { database.close(); } catch { /* Preserve the authority failure. */ }
      }
    }
  } finally {
    await guard?.close();
  }
}
