import {
  validateCatalogueV1,
  validateSpellingCommandSnapshotV1,
} from '../../domain/spelling/index.js';

import { canonicalJson } from './canonical-json.js';
import { assertSqlConnection } from './sql-connection-contract.js';

const LEARNER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function storeError(code, message = code, options) {
  const error = new Error(message, options);
  error.code = code;
  return error;
}

function requireLearnerId(learnerId) {
  if (typeof learnerId !== 'string' || !LEARNER_ID.test(learnerId)) {
    throw new TypeError('Snapshot learnerId must be a canonical identifier.');
  }
  return learnerId;
}

function requirePlainRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  return value;
}

function requireSafeNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a safe non-negative integer.`);
  }
  return value;
}

function canonicalDataClone(value, label) {
  let bytes;
  try {
    bytes = canonicalJson(value);
  } catch (cause) {
    throw new TypeError(`${label} must contain canonical serialisable data.`, {
      cause,
    });
  }
  return JSON.parse(bytes);
}

function requireExactChanges(result, allowed, label) {
  const value = requirePlainRecord(canonicalDataClone(result, label), label);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 1 || keys[0] !== 'changes') {
    throw new TypeError(`${label} must expose exactly changes.`);
  }
  if (
    !Number.isSafeInteger(value.changes) ||
    !allowed.includes(value.changes)
  ) {
    throw new TypeError(
      `${label} changes must be exactly ${allowed.join(' or ')}.`,
    );
  }
  return value.changes;
}

function parseCanonicalJson(bytes, label) {
  if (typeof bytes !== 'string') {
    throw storeError('sqlite_json_bytes_invalid', `${label} must contain JSON bytes.`);
  }
  let value;
  try {
    value = JSON.parse(bytes);
  } catch (cause) {
    throw storeError('sqlite_json_bytes_invalid', `${label} contains invalid JSON.`, {
      cause,
    });
  }
  let encoded;
  try {
    encoded = canonicalJson(value);
  } catch (cause) {
    const error = storeError(
      'sqlite_json_bytes_invalid',
      `${label} contains unsupported JSON.`,
    );
    error.cause = cause;
    throw error;
  }
  if (encoded !== bytes) {
    throw storeError(
      'sqlite_json_bytes_non_canonical',
      `${label} JSON bytes are not canonical.`,
    );
  }
  return value;
}

function exactRow(rows, label, { optional = false } = {}) {
  if (!Array.isArray(rows)) throw storeError('sqlite_rows_invalid', `${label} is invalid.`);
  if (optional && rows.length === 0) return null;
  if (rows.length !== 1 || !rows[0]) {
    throw storeError('sqlite_row_count_invalid', `${label} must contain exactly one row.`);
  }
  return rows[0];
}

function createCatalogueRegistry(cataloguesById) {
  const source = requirePlainRecord(
    canonicalDataClone(cataloguesById, 'cataloguesById'),
    'cataloguesById',
  );
  const registry = new Map();
  for (const [catalogueId, rawCatalogue] of Object.entries(source)) {
    const catalogue = validateCatalogueV1(structuredClone(rawCatalogue));
    if (catalogue.catalogueId !== catalogueId) {
      throw new TypeError('Catalogue registry key does not match catalogue identity.');
    }
    registry.set(catalogueId, catalogue);
  }
  if (registry.size === 0) throw new TypeError('cataloguesById must not be empty.');
  return registry;
}

async function requireTransaction(connection) {
  if ((await connection.isTransactionActive()) !== true) {
    throw storeError(
      'sqlite_transaction_required',
      'sqlite_transaction_required',
    );
  }
}

function assertOwned(value, learnerId, identityKey, expectedIdentity, label) {
  const record = requirePlainRecord(value, label);
  if (record.learnerId !== undefined && record.learnerId !== learnerId) {
    throw new TypeError(`${label} belongs to another learner.`);
  }
  if (record[identityKey] !== expectedIdentity) {
    throw new TypeError(`${label} identity does not match its key.`);
  }
  return record;
}

export function createSQLiteSpellingSnapshotStore({ connection, cataloguesById } = {}) {
  assertSqlConnection(connection);
  const catalogues = createCatalogueRegistry(cataloguesById);

  async function read(learnerId) {
    requireLearnerId(learnerId);
    const aggregate = exactRow(
      await connection.query(
        'SELECT learner_id, snapshot_schema_version, revision, pack_id, catalogue_id, granted_entitlement_ids_json FROM spelling_aggregates WHERE learner_id = ?',
        [learnerId],
      ),
      `Spelling aggregate for ${learnerId}`,
      { optional: true },
    );
    if (aggregate === null) {
      throw storeError(
        'sqlite_unknown_spelling_learner',
        `Unknown Spelling learner: ${learnerId}.`,
      );
    }
    if (aggregate.learner_id !== learnerId) {
      throw storeError('sqlite_learner_ownership_invalid');
    }

    const catalogue = catalogues.get(aggregate.catalogue_id);
    if (!catalogue) {
      throw storeError(
        'sqlite_unknown_spelling_catalogue',
        `Unknown Spelling catalogue: ${String(aggregate.catalogue_id)}.`,
      );
    }

    const subjectRow = exactRow(
      await connection.query(
        'SELECT learner_id, state_json FROM spelling_subject_states WHERE learner_id = ?',
        [learnerId],
      ),
      `Spelling subject state for ${learnerId}`,
    );
    const practiceRow = exactRow(
      await connection.query(
        'SELECT learner_id, session_id, status, state_json FROM spelling_practice_sessions WHERE learner_id = ?',
        [learnerId],
      ),
      `Spelling practice session for ${learnerId}`,
      { optional: true },
    );
    const eventRows = await connection.query(
      'SELECT learner_id, event_id, sequence_no, created_at, event_json FROM spelling_events WHERE learner_id = ? ORDER BY sequence_no ASC',
      [learnerId],
    );
    const monsterRows = await connection.query(
      'SELECT learner_id, reward_track_id, state_json FROM spelling_monster_states WHERE learner_id = ? ORDER BY reward_track_id ASC',
      [learnerId],
    );
    const campRows = await connection.query(
      'SELECT learner_id, pack_id, state_json FROM spelling_camp_states WHERE learner_id = ? ORDER BY pack_id ASC',
      [learnerId],
    );
    if (![eventRows, monsterRows, campRows].every(Array.isArray)) {
      throw storeError('sqlite_rows_invalid');
    }

    if (
      subjectRow.learner_id !== learnerId ||
      (practiceRow !== null && practiceRow.learner_id !== learnerId)
    ) {
      throw storeError('sqlite_learner_ownership_invalid');
    }
    const subjectState = parseCanonicalJson(
      subjectRow.state_json,
      `Spelling subject state for ${learnerId}`,
    );
    const practiceSession = practiceRow
      ? parseCanonicalJson(
          practiceRow.state_json,
          `Spelling practice session for ${learnerId}`,
        )
      : null;
    if (
      practiceRow &&
      (practiceSession.id !== practiceRow.session_id ||
        practiceSession.status !== practiceRow.status)
    ) {
      throw storeError('sqlite_practice_session_identity_invalid');
    }

    const eventLog = eventRows.map((row, sequenceNo) => {
      if (row.learner_id !== learnerId) {
        throw storeError('sqlite_learner_ownership_invalid');
      }
      if (row.sequence_no !== sequenceNo) {
        throw storeError(
          'sqlite_event_sequence_invalid',
          'Spelling event sequence must be contiguous and zero-based.',
        );
      }
      requireSafeNonNegativeInteger(row.created_at, 'Spelling event created_at');
      const event = parseCanonicalJson(
        row.event_json,
        `Spelling event ${row.event_id}`,
      );
      if (
        event.id !== row.event_id ||
        event.learnerId !== learnerId ||
        event.createdAt !== row.created_at
      ) {
        throw storeError('sqlite_event_identity_invalid');
      }
      return event;
    });

    const monsterEntries = [];
    for (const row of monsterRows) {
      if (row.learner_id !== learnerId) {
        throw storeError('sqlite_learner_ownership_invalid');
      }
      const state = parseCanonicalJson(
        row.state_json,
        `Monster state ${row.reward_track_id}`,
      );
      if (state.rewardTrackId !== row.reward_track_id) {
        throw storeError('sqlite_monster_identity_invalid');
      }
      monsterEntries.push([row.reward_track_id, state]);
    }
    const monsterStateByRewardTrackId = Object.fromEntries(monsterEntries);

    const campEntries = [];
    for (const row of campRows) {
      if (row.learner_id !== learnerId) {
        throw storeError('sqlite_learner_ownership_invalid');
      }
      const state = parseCanonicalJson(row.state_json, `Camp state ${row.pack_id}`);
      if (state.packId !== row.pack_id) {
        throw storeError('sqlite_camp_identity_invalid');
      }
      campEntries.push([row.pack_id, state]);
    }
    const campStateByPackId = Object.fromEntries(campEntries);

    const snapshot = {
      schemaVersion: aggregate.snapshot_schema_version,
      learnerId,
      revision: requireSafeNonNegativeInteger(
        aggregate.revision,
        'Spelling aggregate revision',
      ),
      packId: aggregate.pack_id,
      catalogueId: aggregate.catalogue_id,
      grantedEntitlementIds: parseCanonicalJson(
        aggregate.granted_entitlement_ids_json,
        `Spelling entitlements for ${learnerId}`,
      ),
      subjectState,
      practiceSession,
      eventLog,
      monsterStateByRewardTrackId,
      campStateByPackId,
    };
    const validated = validateSpellingCommandSnapshotV1(snapshot, catalogue);
    if (canonicalJson(validated) !== canonicalJson(snapshot)) {
      throw storeError(
        'sqlite_snapshot_not_canonical',
        'Stored Spelling snapshot is not in the frozen A3 canonical form.',
      );
    }
    return validated;
  }

  async function writeSubjectState(learnerId, state) {
    await requireTransaction(connection);
    requireLearnerId(learnerId);
    const stateJson = canonicalJson(requirePlainRecord(state, 'subject state'));
    await connection.execute(
      'INSERT INTO spelling_subject_states (learner_id, state_json) VALUES (?, ?) ON CONFLICT (learner_id) DO UPDATE SET state_json = excluded.state_json',
      [learnerId, stateJson],
    );
  }

  async function writePracticeSession(learnerId, session) {
    await requireTransaction(connection);
    requireLearnerId(learnerId);
    if (session === null) {
      await connection.execute(
        'DELETE FROM spelling_practice_sessions WHERE learner_id = ?',
        [learnerId],
      );
      return;
    }
    const value = requirePlainRecord(
      canonicalDataClone(session, 'practice session'),
      'practice session',
    );
    if (value.learnerId !== learnerId) {
      throw new TypeError('Practice session belongs to another learner.');
    }
    if (typeof value.id !== 'string' || typeof value.status !== 'string') {
      throw new TypeError('Practice session identity is invalid.');
    }
    await connection.execute(
      'INSERT INTO spelling_practice_sessions (learner_id, session_id, status, state_json) VALUES (?, ?, ?, ?) ON CONFLICT (learner_id) DO UPDATE SET session_id = excluded.session_id, status = excluded.status, state_json = excluded.state_json',
      [learnerId, value.id, value.status, canonicalJson(value)],
    );
  }

  async function appendEvents(learnerId, existingEventLog, appendedEvents) {
    await requireTransaction(connection);
    requireLearnerId(learnerId);

    function prepareEvents(candidate, label) {
      const events = canonicalDataClone(candidate, label);
      if (!Array.isArray(events)) throw new TypeError(`${label} must be an array.`);
      const ids = new Set();
      const prepared = events.map((event, index) => {
        const value = requirePlainRecord(event, `${label}[${index}]`);
        if (typeof value.id !== 'string' || value.id.length === 0) {
          throw new TypeError(`${label}[${index}] event ID must be non-empty.`);
        }
        if (value.learnerId !== learnerId) {
          throw new TypeError(`${label}[${index}] belongs to another learner.`);
        }
        requireSafeNonNegativeInteger(
          value.createdAt,
          `${label}[${index}] createdAt`,
        );
        if (ids.has(value.id)) {
          throw storeError(
            'spelling_event_id_collision',
            `${label} contains a duplicate event ID.`,
          );
        }
        ids.add(value.id);
        return Object.freeze({
          event: value,
          eventJson: canonicalJson(value),
        });
      });
      return { ids, prepared };
    }

    const existing = prepareEvents(existingEventLog, 'existingEventLog');
    const appended = prepareEvents(appendedEvents, 'appendedEvents');
    if ([...appended.ids].some((eventId) => existing.ids.has(eventId))) {
      throw storeError(
        'spelling_event_id_collision',
        'Appended event ID collides with the stored prefix.',
      );
    }

    const storedRows = await connection.query(
      'SELECT learner_id, event_id, sequence_no, created_at, event_json FROM spelling_events WHERE learner_id = ? ORDER BY sequence_no ASC',
      [learnerId],
    );
    if (
      !Array.isArray(storedRows) ||
      storedRows.length !== existing.prepared.length
    ) {
      throw storeError(
        'sqlite_event_prefix_mismatch',
        'Stored Spelling events do not match the supplied prefix.',
      );
    }
    for (const [index, row] of storedRows.entries()) {
      const expected = existing.prepared[index];
      if (
        row.learner_id !== learnerId ||
        row.sequence_no !== index ||
        row.event_id !== expected.event.id ||
        row.created_at !== expected.event.createdAt ||
        row.event_json !== expected.eventJson
      ) {
        throw storeError(
          'sqlite_event_prefix_mismatch',
          'Stored Spelling events are not the exact zero-based supplied prefix.',
        );
      }
    }

    for (const [index, prepared] of appended.prepared.entries()) {
      const result = await connection.execute(
        'INSERT INTO spelling_events (learner_id, event_id, sequence_no, created_at, event_json) VALUES (?, ?, ?, ?, ?)',
        [
          learnerId,
          prepared.event.id,
          existing.prepared.length + index,
          prepared.event.createdAt,
          prepared.eventJson,
        ],
      );
      requireExactChanges(result, [1], 'Spelling event insert result');
    }
  }

  async function syncRows({ learnerId, states, table, keyColumn, identityKey, label }) {
    await requireTransaction(connection);
    requireLearnerId(learnerId);
    const values = requirePlainRecord(
      canonicalDataClone(states, `${label} states`),
      `${label} states`,
    );
    const prepared = Object.entries(values).map(([key, state]) => {
      const value = assertOwned(state, learnerId, identityKey, key, `${label} ${key}`);
      return Object.freeze({ key, stateJson: canonicalJson(value) });
    });
    const currentRows = await connection.query(
      `SELECT ${keyColumn} AS state_key FROM ${table} WHERE learner_id = ?`,
      [learnerId],
    );
    if (!Array.isArray(currentRows)) throw storeError('sqlite_rows_invalid');
    const wanted = new Set(prepared.map(({ key }) => key));
    for (const row of currentRows) {
      if (!wanted.has(row.state_key)) {
        await connection.execute(
          `DELETE FROM ${table} WHERE learner_id = ? AND ${keyColumn} = ?`,
          [learnerId, row.state_key],
        );
      }
    }
    for (const { key, stateJson } of prepared) {
      await connection.execute(
        `INSERT INTO ${table} (learner_id, ${keyColumn}, state_json) VALUES (?, ?, ?) ON CONFLICT (learner_id, ${keyColumn}) DO UPDATE SET state_json = excluded.state_json`,
        [learnerId, key, stateJson],
      );
    }
  }

  async function syncMonsters(learnerId, states) {
    await syncRows({
      learnerId,
      states,
      table: 'spelling_monster_states',
      keyColumn: 'reward_track_id',
      identityKey: 'rewardTrackId',
      label: 'Monster',
    });
  }

  async function syncCamp(learnerId, states) {
    await syncRows({
      learnerId,
      states,
      table: 'spelling_camp_states',
      keyColumn: 'pack_id',
      identityKey: 'packId',
      label: 'Camp',
    });
  }

  async function compareAndSetAggregate(learnerId, expectedRevision, plan, nowMs) {
    await requireTransaction(connection);
    requireLearnerId(learnerId);
    requireSafeNonNegativeInteger(expectedRevision, 'Expected revision');
    requireSafeNonNegativeInteger(nowMs, 'Aggregate timestamp');
    const value = requirePlainRecord(
      canonicalDataClone(plan, 'Spelling command plan'),
      'Spelling command plan',
    );
    if (
      value.learnerId !== learnerId ||
      value.expectedRevision !== expectedRevision ||
      !Number.isSafeInteger(value.nextRevision) ||
      value.nextRevision !== expectedRevision + 1
    ) {
      throw new TypeError('Spelling command plan revision identity is invalid.');
    }
    const result = await connection.execute(
      'UPDATE spelling_aggregates SET revision = ?, updated_at = ? WHERE learner_id = ? AND revision = ?',
      [value.nextRevision, nowMs, learnerId, expectedRevision],
    );
    return requireExactChanges(result, [0, 1], 'Aggregate compare-and-set result');
  }

  return Object.freeze({
    read,
    writeSubjectState,
    writePracticeSession,
    appendEvents,
    syncMonsters,
    syncCamp,
    compareAndSetAggregate,
  });
}
