import { assertSqlConnection } from './sql-connection-contract.js';
import { runOwnedTransaction } from './sqlite-transaction-runner.js';

const IDENTIFIER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PRODUCT_BY_STORE = Object.freeze({
  apple: 'uk.eugnel.ks2spelling.fullks2',
  google: 'full_ks2',
});

function attemptError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireExactRecord(value, keys, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !keys.includes(key))
  ) {
    throw new TypeError(`${label} has an invalid shape.`);
  }
  const output = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${label}.${key} must be an enumerable own data field.`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function requireJournalId(value) {
  if (typeof value !== 'string' || value.length > 64 || !IDENTIFIER.test(value)) {
    throw new TypeError('journalId must be a canonical identifier.');
  }
  return value;
}

function requireTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('observedAt must be a safe non-negative integer.');
  }
  return value;
}

function toTimestamp(value) {
  const number = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 0) {
    throw attemptError('sqlite_commerce_row_invalid');
  }
  return number;
}

function mapJournal(row) {
  if (!row || typeof row !== 'object') {
    throw attemptError('sqlite_commerce_row_invalid');
  }
  return Object.freeze({
    journalId: row.journal_id,
    store: row.store,
    productId: row.product_id,
    storeTransactionId: row.store_transaction_id,
    observationState: row.observation_state,
    processingState: row.processing_state,
    opaqueProof: row.opaque_proof,
    createdAt: toTimestamp(row.created_at),
    updatedAt: toTimestamp(row.updated_at),
  });
}

function isOwnedPending(row, store, productId) {
  return row.store === store &&
    row.product_id === productId &&
    row.store_transaction_id === null &&
    row.observation_state === 'pending' &&
    row.processing_state === 'observed' &&
    row.opaque_proof === null;
}

async function readJournal(connection, journalId) {
  const rows = await connection.query(
    'SELECT journal_id, store, product_id, store_transaction_id, observation_state, processing_state, opaque_proof, created_at, updated_at FROM transaction_journal WHERE journal_id = ?',
    [journalId],
  );
  if (!Array.isArray(rows) || rows.length > 1) {
    throw attemptError('sqlite_commerce_row_invalid');
  }
  return rows[0] ?? null;
}

export function createSqliteCommerceAttemptRepository(connection, rawAuthority) {
  assertSqlConnection(connection);
  const authority = requireExactRecord(rawAuthority, ['store'], 'Commerce attempt authority');
  if (!Object.hasOwn(PRODUCT_BY_STORE, authority.store)) {
    throw new TypeError('Commerce attempt store is invalid.');
  }
  const store = authority.store;
  const productId = PRODUCT_BY_STORE[store];

  // A pending row is a one-shot Parent authorisation to verify the next matching
  // native acquisition. It deliberately survives an ambiguous process loss after
  // the store returns; the gateway must still verify the opaque proof live.

  async function preparePendingAttempt(input) {
    const values = requireExactRecord(
      input,
      ['journalId', 'observedAt'],
      'preparePendingAttempt input',
    );
    requireJournalId(values.journalId);
    requireTimestamp(values.observedAt);
    return runOwnedTransaction(connection, async () => {
      const proposed = await readJournal(connection, values.journalId);
      if (proposed && !isOwnedPending(proposed, store, productId)) {
        throw attemptError('sqlite_commerce_attempt_conflict');
      }
      const pendingRows = await connection.query(
        "SELECT journal_id, store, product_id, store_transaction_id, observation_state, processing_state, opaque_proof, created_at, updated_at FROM transaction_journal WHERE store = ? AND product_id = ? AND store_transaction_id IS NULL AND observation_state = 'pending' AND processing_state = 'observed' AND opaque_proof IS NULL ORDER BY created_at, journal_id",
        [store, productId],
      );
      if (!Array.isArray(pendingRows) || pendingRows.length > 1) {
        throw attemptError('sqlite_commerce_attempt_conflict');
      }
      if (pendingRows.length === 1) return mapJournal(pendingRows[0]);

      const stableJournalId = `purchase-${store}-full-ks2-acquisition`;
      const stable = await readJournal(connection, stableJournalId);
      const entitlementRows = await connection.query(
        'SELECT entitlement_id FROM app_entitlements WHERE entitlement_id = ?',
        ['full-ks2'],
      );
      if (!Array.isArray(entitlementRows) || entitlementRows.length > 1) {
        throw attemptError('sqlite_commerce_row_invalid');
      }
      const journalId = stable === null && entitlementRows.length === 0
        ? stableJournalId
        : values.journalId;
      const existing = journalId === values.journalId ? proposed : stable;
      if (existing) {
        if (!isOwnedPending(existing, store, productId)) {
          throw attemptError('sqlite_commerce_attempt_conflict');
        }
        return mapJournal(existing);
      }
      const result = await connection.execute(
        'INSERT INTO transaction_journal (journal_id, store, product_id, store_transaction_id, observation_state, processing_state, opaque_proof, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, ?)',
        [
          journalId,
          store,
          productId,
          'pending',
          'observed',
          values.observedAt,
          values.observedAt,
        ],
      );
      if (!result || result.changes !== 1) {
        throw attemptError('sqlite_commerce_write_failed');
      }
      return mapJournal(await readJournal(connection, journalId));
    });
  }

  async function discardPendingAttempt(input) {
    const values = requireExactRecord(
      input,
      ['journalId'],
      'discardPendingAttempt input',
    );
    requireJournalId(values.journalId);
    return runOwnedTransaction(connection, async () => {
      const existing = await readJournal(connection, values.journalId);
      if (!existing) return Object.freeze({ discarded: false });
      if (!isOwnedPending(existing, store, productId)) {
        throw attemptError('sqlite_commerce_attempt_conflict');
      }
      const result = await connection.execute(
        "DELETE FROM transaction_journal WHERE journal_id = ? AND store = ? AND product_id = ? AND store_transaction_id IS NULL AND observation_state = 'pending' AND processing_state = 'observed' AND opaque_proof IS NULL",
        [values.journalId, store, productId],
      );
      if (!result || result.changes !== 1) {
        throw attemptError('sqlite_commerce_attempt_conflict');
      }
      return Object.freeze({ discarded: true });
    });
  }

  const repository = { preparePendingAttempt, discardPendingAttempt };
  if (Reflect.ownKeys(repository).join('|') !==
    'preparePendingAttempt|discardPendingAttempt') {
    throw new TypeError('Commerce attempt repository surface is invalid.');
  }
  return Object.freeze(repository);
}
