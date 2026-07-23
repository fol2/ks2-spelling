import { assertSqlConnection } from './sql-connection-contract.js';
import {
  runExclusive,
  runOwnedTransaction,
} from './sqlite-transaction-runner.js';

const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ARCHIVE_NAME = /^[a-z0-9][a-z0-9._-]{0,59}\.zip$/;
const REQUIRED_ENTITLEMENT_ID = 'full-ks2';
const FREE_STARTER_PACK_ID = 'ks2-core';
const JOB_STATES = Object.freeze([
  'queued',
  'downloading',
  'downloaded',
  'extracting',
  'ready',
  'failed',
]);
const JOB_TRANSITIONS = Object.freeze({
  queued: Object.freeze(['downloading', 'failed']),
  downloading: Object.freeze(['downloaded', 'failed']),
  downloaded: Object.freeze(['extracting', 'failed']),
  extracting: Object.freeze(['ready', 'failed']),
  failed: Object.freeze(['queued']),
  ready: Object.freeze([]),
});
const JOB_KEYS = Object.freeze([
  'jobId',
  'packId',
  'version',
  'manifestSha256',
  'archiveName',
  'archiveSha256',
  'expectedBytes',
  'completedBytes',
  'etag',
  'state',
  'updatedAt',
]);
const CHUNK_KEYS = Object.freeze([
  'jobId',
  'startByte',
  'endByteExclusive',
  'state',
  'chunkSha256',
]);
const INSTALLED_KEYS = Object.freeze([
  'packId',
  'version',
  'manifestSha256',
  'pathToken',
  'activationMarkerSha256',
  'state',
  'installedAt',
]);
const ACTIVE_KEYS = Object.freeze([
  'packId',
  'version',
  'manifestSha256',
  'pathToken',
  'activatedAt',
]);

function packError(code, options) {
  const error = new Error(code, options);
  error.code = code;
  return error;
}

function inputError() {
  const error = new TypeError('sqlite_pack_input_invalid');
  error.code = 'sqlite_pack_input_invalid';
  return error;
}

function requireExactInput(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw inputError();
  }
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) {
    throw inputError();
  }
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw inputError();
    }
    result[key] = descriptor.value;
  }
  return result;
}

function requireNoInput(args) {
  if (args.length !== 0) throw inputError();
}

function requireIdentifier(value) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw inputError();
  return value;
}

function requireSha256(value) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw inputError();
  return value;
}

function requireInstalledPathToken(value, packId, version) {
  if (value !== `installed/${packId}/${version}`) {
    throw inputError();
  }
  return value;
}

function requireStoredInstalledPathToken(value, packId, version) {
  if (
    typeof packId !== 'string' ||
    typeof version !== 'string' ||
    value !== `installed/${packId}/${version}`
  ) {
    throw packError('sqlite_pack_row_invalid');
  }
  return value;
}

function requireSafeInteger(value, { positive = false } = {}) {
  if (
    !Number.isSafeInteger(value) ||
    (positive ? value <= 0 : value < 0)
  ) {
    throw inputError();
  }
  return value;
}

function requireEtag(value) {
  const hasControlCharacter =
    typeof value === 'string' &&
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 31 || codePoint === 127;
    });
  if (
    value !== null &&
    (typeof value !== 'string' ||
      value.length === 0 ||
      value.length > 1_024 ||
      hasControlCharacter)
  ) {
    throw inputError();
  }
  return value;
}

function toSafeInteger(value) {
  const number = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 0) {
    throw packError('sqlite_pack_row_invalid');
  }
  return number;
}

function frozenRecord(keys, values) {
  const result = {};
  for (const key of keys) result[key] = values[key];
  return Object.freeze(result);
}

function mapJob(row) {
  if (!row || typeof row !== 'object') throw packError('sqlite_pack_row_invalid');
  return frozenRecord(JOB_KEYS, {
    jobId: row.job_id,
    packId: row.pack_id,
    version: row.version,
    manifestSha256: row.manifest_sha256,
    archiveName: row.archive_name,
    archiveSha256: row.archive_sha256,
    expectedBytes: toSafeInteger(row.expected_bytes),
    completedBytes: toSafeInteger(row.completed_bytes),
    etag: row.etag,
    state: row.state,
    updatedAt: toSafeInteger(row.updated_at),
  });
}

function mapChunk(row) {
  if (!row || typeof row !== 'object') throw packError('sqlite_pack_row_invalid');
  return frozenRecord(CHUNK_KEYS, {
    jobId: row.job_id,
    startByte: toSafeInteger(row.start_byte),
    endByteExclusive: toSafeInteger(row.end_byte_exclusive),
    state: row.state,
    chunkSha256: row.chunk_sha256,
  });
}

function mapInstalled(row) {
  if (!row || typeof row !== 'object') throw packError('sqlite_pack_row_invalid');
  return frozenRecord(INSTALLED_KEYS, {
    packId: row.pack_id,
    version: row.version,
    manifestSha256: row.manifest_sha256,
    pathToken: requireStoredInstalledPathToken(row.path_token, row.pack_id, row.version),
    activationMarkerSha256: row.activation_marker_sha256,
    state: row.state,
    installedAt: toSafeInteger(row.installed_at),
  });
}

function mapActive(row) {
  if (!row || typeof row !== 'object') throw packError('sqlite_pack_row_invalid');
  return frozenRecord(ACTIVE_KEYS, {
    packId: row.pack_id,
    version: row.version,
    manifestSha256: row.manifest_sha256,
    pathToken: requireStoredInstalledPathToken(row.path_token, row.pack_id, row.version),
    activatedAt: toSafeInteger(row.activated_at),
  });
}

function optionalRow(rows) {
  if (!Array.isArray(rows) || rows.length > 1) throw packError('sqlite_pack_row_invalid');
  return rows[0] ?? null;
}

function frozenList(rows, mapper) {
  if (!Array.isArray(rows)) throw packError('sqlite_pack_rows_invalid');
  return Object.freeze(rows.map(mapper));
}

function requireOneChange(result, code) {
  if (!result || typeof result !== 'object' || result.changes !== 1) {
    throw packError(code);
  }
}

function sameRecord(left, right, keys) {
  return keys.every((key) => left[key] === right[key]);
}

function validateJob(input) {
  const value = requireExactInput(input, JOB_KEYS);
  requireIdentifier(value.jobId);
  requireIdentifier(value.packId);
  requireIdentifier(value.version);
  requireSha256(value.manifestSha256);
  if (typeof value.archiveName !== 'string' || !ARCHIVE_NAME.test(value.archiveName)) {
    throw inputError();
  }
  requireSha256(value.archiveSha256);
  requireSafeInteger(value.expectedBytes, { positive: true });
  requireSafeInteger(value.completedBytes);
  if (value.completedBytes > value.expectedBytes) throw inputError();
  requireEtag(value.etag);
  if (!JOB_STATES.includes(value.state)) throw inputError();
  requireSafeInteger(value.updatedAt);
  return value;
}

function validateChunk(input) {
  const value = requireExactInput(input, CHUNK_KEYS);
  requireIdentifier(value.jobId);
  requireSafeInteger(value.startByte);
  requireSafeInteger(value.endByteExclusive, { positive: true });
  if (value.endByteExclusive <= value.startByte) throw inputError();
  if (!['pending', 'complete'].includes(value.state)) throw inputError();
  if (value.chunkSha256 !== null) requireSha256(value.chunkSha256);
  return value;
}

function validateInstalled(input, { allowRetired = false } = {}) {
  const value = requireExactInput(input, INSTALLED_KEYS);
  requireIdentifier(value.packId);
  requireIdentifier(value.version);
  requireSha256(value.manifestSha256);
  requireInstalledPathToken(value.pathToken, value.packId, value.version);
  requireSha256(value.activationMarkerSha256);
  if (value.state !== 'ready' && !(allowRetired && value.state === 'retired')) {
    throw inputError();
  }
  requireSafeInteger(value.installedAt);
  return value;
}

function validateActive(input) {
  const value = requireExactInput(input, ACTIVE_KEYS);
  requireIdentifier(value.packId);
  requireIdentifier(value.version);
  requireSha256(value.manifestSha256);
  requireInstalledPathToken(value.pathToken, value.packId, value.version);
  requireSafeInteger(value.activatedAt);
  return value;
}

async function readJob(connection, jobId) {
  return optionalRow(
    await connection.query(
      'SELECT job_id, pack_id, version, manifest_sha256, archive_name, archive_sha256, expected_bytes, completed_bytes, etag, state, updated_at FROM pack_download_jobs WHERE job_id = ?',
      [jobId],
    ),
  );
}

async function readInstalled(connection, packId, version) {
  return optionalRow(
    await connection.query(
      'SELECT pack_id, version, manifest_sha256, path_token, activation_marker_sha256, state, installed_at FROM installed_pack_versions WHERE pack_id = ? AND version = ?',
      [packId, version],
    ),
  );
}

async function readActive(connection, packId) {
  return optionalRow(
    await connection.query(
      'SELECT pack_id, version, manifest_sha256, path_token, activated_at FROM active_pack_versions WHERE pack_id = ?',
      [packId],
    ),
  );
}

async function registerInstalledWithinTransaction(connection, value) {
  const existingRow = await readInstalled(connection, value.packId, value.version);
  if (existingRow) {
    const existing = mapInstalled(existingRow);
    if (sameRecord(existing, value, INSTALLED_KEYS)) return existing;
    throw packError('sqlite_pack_version_conflict');
  }
  requireOneChange(
    await connection.execute(
      'INSERT INTO installed_pack_versions (pack_id, version, manifest_sha256, path_token, activation_marker_sha256, state, installed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        value.packId,
        value.version,
        value.manifestSha256,
        value.pathToken,
        value.activationMarkerSha256,
        value.state,
        value.installedAt,
      ],
    ),
    'sqlite_pack_version_conflict',
  );
  return mapInstalled(await readInstalled(connection, value.packId, value.version));
}

async function flipActiveWithinTransaction(connection, value) {
  const installedRow = await readInstalled(connection, value.packId, value.version);
  if (!installedRow) {
    const alternatives = await connection.query(
      'SELECT version FROM installed_pack_versions WHERE pack_id = ? LIMIT 1',
      [value.packId],
    );
    throw packError(
      Array.isArray(alternatives) && alternatives.length > 0
        ? 'sqlite_pack_activation_conflict'
        : 'sqlite_pack_version_not_ready',
    );
  }
  const installed = mapInstalled(installedRow);
  if (installed.state !== 'ready') throw packError('sqlite_pack_version_not_ready');
  if (
    installed.manifestSha256 !== value.manifestSha256 ||
    installed.pathToken !== value.pathToken
  ) {
    throw packError('sqlite_pack_activation_conflict');
  }
  const currentRow = await readActive(connection, value.packId);
  if (currentRow && sameRecord(mapActive(currentRow), value, ACTIVE_KEYS)) {
    return mapActive(currentRow);
  }
  if (currentRow && value.activatedAt <= mapActive(currentRow).activatedAt) {
    throw packError('sqlite_pack_activation_conflict');
  }
  requireOneChange(
    await connection.execute(
      'INSERT INTO active_pack_versions (pack_id, version, manifest_sha256, path_token, activated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(pack_id) DO UPDATE SET version = excluded.version, manifest_sha256 = excluded.manifest_sha256, path_token = excluded.path_token, activated_at = excluded.activated_at',
      [
        value.packId,
        value.version,
        value.manifestSha256,
        value.pathToken,
        value.activatedAt,
      ],
    ),
    'sqlite_pack_activation_conflict',
  );
  return mapActive(await readActive(connection, value.packId));
}

export function createSqlitePackRepositories(connection) {
  assertSqlConnection(connection);

  async function clearDownloadChunks(input) {
    const value = requireExactInput(input, ['jobId', 'updatedAt']);
    requireIdentifier(value.jobId);
    requireSafeInteger(value.updatedAt);
    return runOwnedTransaction(connection, async () => {
      const jobRow = await readJob(connection, value.jobId);
      if (!jobRow) throw packError('sqlite_pack_job_conflict');
      if (value.updatedAt < mapJob(jobRow).updatedAt) {
        throw packError('sqlite_pack_job_conflict');
      }
      await connection.execute('DELETE FROM pack_download_chunks WHERE job_id = ?', [value.jobId]);
      requireOneChange(
        await connection.execute(
          'UPDATE pack_download_jobs SET completed_bytes = 0, updated_at = ? WHERE job_id = ?',
          [value.updatedAt, value.jobId],
        ),
        'sqlite_pack_job_conflict',
      );
      return Object.freeze([]);
    });
  }

  async function completeDownloadChunk(input) {
    const value = requireExactInput(
      input,
      ['jobId', 'startByte', 'endByteExclusive', 'chunkSha256', 'updatedAt'],
    );
    requireIdentifier(value.jobId);
    requireSafeInteger(value.startByte);
    requireSafeInteger(value.endByteExclusive, { positive: true });
    if (value.endByteExclusive <= value.startByte) throw inputError();
    requireSha256(value.chunkSha256);
    requireSafeInteger(value.updatedAt);
    return runOwnedTransaction(connection, async () => {
      const jobRow = await readJob(connection, value.jobId);
      if (!jobRow) throw packError('sqlite_pack_job_conflict');
      const job = mapJob(jobRow);
      if (value.updatedAt < job.updatedAt) throw packError('sqlite_pack_job_conflict');
      const row = optionalRow(
        await connection.query(
          'SELECT job_id, start_byte, end_byte_exclusive, state, chunk_sha256 FROM pack_download_chunks WHERE job_id = ? AND start_byte = ?',
          [value.jobId, value.startByte],
        ),
      );
      if (!row) throw packError('sqlite_pack_chunk_conflict');
      const chunk = mapChunk(row);
      if (chunk.endByteExclusive !== value.endByteExclusive) {
        throw packError('sqlite_pack_chunk_conflict');
      }
      if (chunk.state === 'complete') {
        if (chunk.chunkSha256 !== value.chunkSha256) {
          throw packError('sqlite_pack_chunk_conflict');
        }
        return chunk;
      }
      if (job.state !== 'downloading') throw packError('sqlite_pack_job_conflict');
      requireOneChange(
        await connection.execute(
          'UPDATE pack_download_chunks SET state = ?, chunk_sha256 = ? WHERE job_id = ? AND start_byte = ? AND state = ?',
          ['complete', value.chunkSha256, value.jobId, value.startByte, 'pending'],
        ),
        'sqlite_pack_chunk_conflict',
      );
      const [progress] = await connection.query(
        "SELECT COALESCE(SUM(end_byte_exclusive - start_byte), 0) AS completed_bytes FROM pack_download_chunks WHERE job_id = ? AND state = 'complete'",
        [value.jobId],
      );
      const completedBytes = toSafeInteger(progress?.completed_bytes);
      requireOneChange(
        await connection.execute(
          'UPDATE pack_download_jobs SET completed_bytes = ?, updated_at = ? WHERE job_id = ?',
          [completedBytes, value.updatedAt, value.jobId],
        ),
        'sqlite_pack_job_conflict',
      );
      return mapChunk(
        optionalRow(
          await connection.query(
            'SELECT job_id, start_byte, end_byte_exclusive, state, chunk_sha256 FROM pack_download_chunks WHERE job_id = ? AND start_byte = ?',
            [value.jobId, value.startByte],
          ),
        ),
      );
    });
  }

  async function deleteDownloadJob(input) {
    const value = requireExactInput(input, ['jobId']);
    requireIdentifier(value.jobId);
    return runOwnedTransaction(connection, async () => {
      const result = await connection.execute(
        'DELETE FROM pack_download_jobs WHERE job_id = ?',
        [value.jobId],
      );
      if (!result || ![0, 1].includes(result.changes)) {
        throw packError('sqlite_pack_job_conflict');
      }
      return result.changes === 1;
    });
  }

  async function flipActiveVersion(input) {
    const value = validateActive(input);
    return runOwnedTransaction(connection, () =>
      flipActiveWithinTransaction(connection, value),
    );
  }

  async function getActiveVersion(input) {
    const value = requireExactInput(input, ['packId']);
    requireIdentifier(value.packId);
    return runExclusive(connection, async () => {
      const row = await readActive(connection, value.packId);
      return row ? mapActive(row) : null;
    });
  }

  async function getDownloadJob(input) {
    const value = requireExactInput(input, ['jobId']);
    requireIdentifier(value.jobId);
    return runExclusive(connection, async () => {
      const row = await readJob(connection, value.jobId);
      return row ? mapJob(row) : null;
    });
  }

  async function listDownloadChunks(input) {
    const value = requireExactInput(input, ['jobId']);
    requireIdentifier(value.jobId);
    return runExclusive(connection, async () =>
      frozenList(
        await connection.query(
          'SELECT job_id, start_byte, end_byte_exclusive, state, chunk_sha256 FROM pack_download_chunks WHERE job_id = ? ORDER BY start_byte ASC',
          [value.jobId],
        ),
        mapChunk,
      ),
    );
  }

  async function listDownloadJobs() {
    requireNoInput(arguments);
    return runExclusive(connection, async () =>
      frozenList(
        await connection.query(
          'SELECT job_id, pack_id, version, manifest_sha256, archive_name, archive_sha256, expected_bytes, completed_bytes, etag, state, updated_at FROM pack_download_jobs ORDER BY updated_at DESC, job_id ASC',
        ),
        mapJob,
      ),
    );
  }

  async function listInstalledVersions(input) {
    const value = requireExactInput(input, ['packId']);
    requireIdentifier(value.packId);
    return runExclusive(connection, async () =>
      frozenList(
        await connection.query(
          'SELECT pack_id, version, manifest_sha256, path_token, activation_marker_sha256, state, installed_at FROM installed_pack_versions WHERE pack_id = ? ORDER BY version ASC',
          [value.packId],
        ),
        mapInstalled,
      ),
    );
  }

  async function registerAndFlipActiveVersion(input) {
    const value = requireExactInput(
      input,
      ['requiredEntitlementId', 'installedVersion', 'activeVersion'],
    );
    const installed = validateInstalled(value.installedVersion);
    const active = validateActive(value.activeVersion);
    if (value.requiredEntitlementId === null) {
      if (installed.packId !== FREE_STARTER_PACK_ID) throw inputError();
    } else {
      requireIdentifier(value.requiredEntitlementId);
      if (value.requiredEntitlementId !== REQUIRED_ENTITLEMENT_ID) throw inputError();
    }
    if (
      installed.packId !== active.packId ||
      installed.version !== active.version ||
      installed.manifestSha256 !== active.manifestSha256 ||
      installed.pathToken !== active.pathToken
    ) {
      throw packError('sqlite_pack_activation_conflict');
    }
    return runOwnedTransaction(connection, async () => {
      if (value.requiredEntitlementId !== null) {
        const entitlement = optionalRow(await connection.query(
          'SELECT state FROM app_entitlements WHERE entitlement_id = ?',
          [value.requiredEntitlementId],
        ));
        if (entitlement?.state !== 'active') {
          throw packError('sqlite_pack_entitlement_inactive');
        }
      }
      await registerInstalledWithinTransaction(connection, installed);
      return flipActiveWithinTransaction(connection, active);
    });
  }

  async function registerInstalledVersion(input) {
    const value = validateInstalled(input);
    return runOwnedTransaction(connection, () =>
      registerInstalledWithinTransaction(connection, value),
    );
  }

  async function replaceDownloadChunks(input) {
    const value = requireExactInput(input, ['jobId', 'chunks']);
    requireIdentifier(value.jobId);
    const chunkArrayKeys = Array.isArray(value.chunks)
      ? Reflect.ownKeys(value.chunks)
      : [];
    if (
      !Array.isArray(value.chunks) ||
      Object.getPrototypeOf(value.chunks) !== Array.prototype ||
      value.chunks.length === 0 ||
      chunkArrayKeys.length !== value.chunks.length + 1 ||
      chunkArrayKeys.some(
        (key) => key !== 'length' && !/^(?:0|[1-9][0-9]*)$/u.test(String(key)),
      ) ||
      Array.from({ length: value.chunks.length }, (_, index) =>
        Object.getOwnPropertyDescriptor(value.chunks, String(index)),
      ).some(
        (descriptor) =>
          !descriptor ||
          !Object.hasOwn(descriptor, 'value') ||
          !descriptor.enumerable,
      )
    ) {
      throw packError('sqlite_pack_chunk_plan_invalid');
    }
    let chunks;
    try {
      chunks = value.chunks.map(validateChunk).toSorted(
        (left, right) => left.startByte - right.startByte,
      );
    } catch (error) {
      if (error?.code === 'sqlite_pack_input_invalid') {
        throw packError('sqlite_pack_chunk_plan_invalid');
      }
      throw error;
    }
    if (
      chunks.some(
        (chunk) =>
          chunk.jobId !== value.jobId ||
          chunk.state !== 'pending' ||
          chunk.chunkSha256 !== null,
      )
    ) {
      throw packError('sqlite_pack_chunk_plan_invalid');
    }
    return runOwnedTransaction(connection, async () => {
      const jobRow = await readJob(connection, value.jobId);
      if (!jobRow) throw packError('sqlite_pack_job_conflict');
      const job = mapJob(jobRow);
      if (job.state !== 'queued') throw packError('sqlite_pack_job_conflict');
      let expectedStart = 0;
      for (const chunk of chunks) {
        if (chunk.startByte !== expectedStart) {
          throw packError('sqlite_pack_chunk_plan_invalid');
        }
        expectedStart = chunk.endByteExclusive;
      }
      if (expectedStart !== job.expectedBytes) {
        throw packError('sqlite_pack_chunk_plan_invalid');
      }
      const current = frozenList(
        await connection.query(
          'SELECT job_id, start_byte, end_byte_exclusive, state, chunk_sha256 FROM pack_download_chunks WHERE job_id = ? ORDER BY start_byte ASC',
          [value.jobId],
        ),
        mapChunk,
      );
      if (
        current.length === chunks.length &&
        current.every((row, index) => sameRecord(row, chunks[index], CHUNK_KEYS))
      ) {
        return current;
      }
      await connection.execute('DELETE FROM pack_download_chunks WHERE job_id = ?', [value.jobId]);
      for (const chunk of chunks) {
        requireOneChange(
          await connection.execute(
            'INSERT INTO pack_download_chunks (job_id, start_byte, end_byte_exclusive, state, chunk_sha256) VALUES (?, ?, ?, ?, NULL)',
            [chunk.jobId, chunk.startByte, chunk.endByteExclusive, 'pending'],
          ),
          'sqlite_pack_chunk_plan_invalid',
        );
      }
      requireOneChange(
        await connection.execute(
          'UPDATE pack_download_jobs SET completed_bytes = 0 WHERE job_id = ?',
          [value.jobId],
        ),
        'sqlite_pack_job_conflict',
      );
      return frozenList(
        await connection.query(
          'SELECT job_id, start_byte, end_byte_exclusive, state, chunk_sha256 FROM pack_download_chunks WHERE job_id = ? ORDER BY start_byte ASC',
          [value.jobId],
        ),
        mapChunk,
      );
    });
  }

  async function retireInstalledVersion(input) {
    const value = requireExactInput(input, ['packId', 'version']);
    requireIdentifier(value.packId);
    requireIdentifier(value.version);
    return runOwnedTransaction(connection, async () => {
      const row = await readInstalled(connection, value.packId, value.version);
      if (!row) throw packError('sqlite_pack_version_conflict');
      const installed = mapInstalled(row);
      const activeRow = await readActive(connection, value.packId);
      if (activeRow && mapActive(activeRow).version === value.version) {
        throw packError('sqlite_pack_version_active');
      }
      if (installed.state === 'retired') return installed;
      requireOneChange(
        await connection.execute(
          'UPDATE installed_pack_versions SET state = ? WHERE pack_id = ? AND version = ? AND state = ?',
          ['retired', value.packId, value.version, 'ready'],
        ),
        'sqlite_pack_version_conflict',
      );
      return mapInstalled(await readInstalled(connection, value.packId, value.version));
    });
  }

  async function updateDownloadJob(input) {
    const value = requireExactInput(
      input,
      ['jobId', 'expectedState', 'state', 'etag', 'updatedAt'],
    );
    requireIdentifier(value.jobId);
    if (!JOB_STATES.includes(value.expectedState) || !JOB_STATES.includes(value.state)) {
      throw inputError();
    }
    requireEtag(value.etag);
    requireSafeInteger(value.updatedAt);
    return runOwnedTransaction(connection, async () => {
      const row = await readJob(connection, value.jobId);
      if (!row) throw packError('sqlite_pack_job_conflict');
      const job = mapJob(row);
      if (job.state !== value.expectedState) throw packError('sqlite_pack_job_conflict');
      if (value.updatedAt < job.updatedAt) throw packError('sqlite_pack_job_conflict');
      if (!JOB_TRANSITIONS[value.expectedState].includes(value.state)) {
        throw packError('sqlite_pack_job_transition_invalid');
      }
      if (value.state === 'downloaded') {
        const [pending] = await connection.query(
          "SELECT COUNT(*) AS pending_count FROM pack_download_chunks WHERE job_id = ? AND state <> 'complete'",
          [value.jobId],
        );
        if (
          job.completedBytes !== job.expectedBytes ||
          toSafeInteger(pending?.pending_count) !== 0
        ) {
          throw packError('sqlite_pack_download_incomplete');
        }
      }
      requireOneChange(
        await connection.execute(
          'UPDATE pack_download_jobs SET state = ?, etag = ?, updated_at = ? WHERE job_id = ? AND state = ?',
          [value.state, value.etag, value.updatedAt, value.jobId, value.expectedState],
        ),
        'sqlite_pack_job_conflict',
      );
      return mapJob(await readJob(connection, value.jobId));
    });
  }

  async function upsertDownloadJob(input) {
    const value = validateJob(input);
    return runOwnedTransaction(connection, async () => {
      const existingRow = await readJob(connection, value.jobId);
      if (existingRow) {
        const existing = mapJob(existingRow);
        if (sameRecord(existing, value, JOB_KEYS)) return existing;
        throw packError('sqlite_pack_job_conflict');
      }
      if (value.state !== 'queued' || value.completedBytes !== 0) {
        throw inputError();
      }
      requireOneChange(
        await connection.execute(
          'INSERT INTO pack_download_jobs (job_id, pack_id, version, manifest_sha256, archive_name, archive_sha256, expected_bytes, completed_bytes, etag, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            value.jobId,
            value.packId,
            value.version,
            value.manifestSha256,
            value.archiveName,
            value.archiveSha256,
            value.expectedBytes,
            value.completedBytes,
            value.etag,
            value.state,
            value.updatedAt,
          ],
        ),
        'sqlite_pack_job_conflict',
      );
      return mapJob(await readJob(connection, value.jobId));
    });
  }

  return Object.freeze({
    clearDownloadChunks,
    completeDownloadChunk,
    deleteDownloadJob,
    flipActiveVersion,
    getActiveVersion,
    getDownloadJob,
    listDownloadChunks,
    listDownloadJobs,
    listInstalledVersions,
    registerAndFlipActiveVersion,
    registerInstalledVersion,
    replaceDownloadChunks,
    retireInstalledVersion,
    updateDownloadJob,
    upsertDownloadJob,
  });
}
