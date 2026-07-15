import { mapStoreProductToEntitlement } from '../../domain/commerce/commerce-contracts.js';
import { MAX_SEALED_REFRESH_HANDLE_CHARS } from '../gateway/gateway-payload-limits.js';

import { assertSqlConnection } from './sql-connection-contract.js';
import {
  runExclusive,
  runOwnedTransaction,
} from './sqlite-transaction-runner.js';

const IDENTIFIER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PRODUCT_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const APPLE_TRANSACTION_ID = /^[1-9][0-9]*$/;
const GOOGLE_TRANSACTION_ID = /^GPA\.[0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{5}$/;
const JOURNAL_KEYS = Object.freeze([
  'journalId',
  'store',
  'productId',
  'storeTransactionId',
  'observationState',
  'processingState',
  'opaqueProof',
  'createdAt',
  'updatedAt',
]);
const ENTITLEMENT_KEYS = Object.freeze([
  'entitlementId',
  'store',
  'productId',
  'storeTransactionId',
  'state',
  'sealedRefreshHandle',
  'refreshHandleVersion',
  'verifiedAt',
  'refreshedAt',
  'revocationAt',
]);
const PERMANENT_REJECTIONS = Object.freeze([
  'authenticated-permanent',
  'definitive-malformed-proof',
]);

function observationEventKind(value) {
  return value === 'pending' || value === 'purchased' ? 'acquisition' : value;
}

function isActiveCallbackJournal(journal) {
  return journal.journalId === `purchase-${journal.store}-full-ks2-active-callback`;
}

function commerceError(code, message = code, options) {
  const error = new Error(message, options);
  error.code = code;
  return error;
}

function requireExactInput(value, keys, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be an ordinary record.`);
  }
  const actualKeys = Reflect.ownKeys(value);
  if (
    actualKeys.length !== keys.length ||
    actualKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) {
    throw new TypeError(`${label} has an invalid shape.`);
  }
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, 'value') ||
      !descriptor.enumerable
    ) {
      throw new TypeError(`${label}.${key} must be an enumerable own data property.`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function requireIdentifier(value, label) {
  if (typeof value !== 'string' || value.length > 64 || !IDENTIFIER.test(value)) {
    throw new TypeError(`${label} must be a canonical identifier.`);
  }
  return value;
}

function requireProductId(value) {
  if (typeof value !== 'string' || value.length > 128 || !PRODUCT_ID.test(value)) {
    throw new TypeError('productId must be canonical.');
  }
  return value;
}

function requireTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a safe non-negative integer.`);
  }
  return value;
}

function requireNonEmptyString(value, label, maximumLength) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    (maximumLength !== undefined && value.length > maximumLength)
  ) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a safe positive integer.`);
  }
  return value;
}

function toSafeInteger(value, label) {
  const number = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 0) {
    throw commerceError('sqlite_commerce_row_invalid', `${label} is invalid.`);
  }
  return number;
}

function frozenRecord(keys, values) {
  const record = {};
  for (const key of keys) record[key] = values[key];
  return Object.freeze(record);
}

function mapJournal(row) {
  if (!row || typeof row !== 'object') {
    throw commerceError('sqlite_commerce_row_invalid');
  }
  return frozenRecord(JOURNAL_KEYS, {
    journalId: row.journal_id,
    store: row.store,
    productId: row.product_id,
    storeTransactionId: row.store_transaction_id,
    observationState: row.observation_state,
    processingState: row.processing_state,
    opaqueProof: row.opaque_proof,
    createdAt: toSafeInteger(row.created_at, 'created_at'),
    updatedAt: toSafeInteger(row.updated_at, 'updated_at'),
  });
}

function mapEntitlement(row) {
  if (!row || typeof row !== 'object') {
    throw commerceError('sqlite_commerce_row_invalid');
  }
  return frozenRecord(ENTITLEMENT_KEYS, {
    entitlementId: row.entitlement_id,
    store: row.store,
    productId: row.product_id,
    storeTransactionId: row.store_transaction_id,
    state: row.state,
    sealedRefreshHandle: row.sealed_refresh_handle,
    refreshHandleVersion:
      row.refresh_handle_version === null
        ? null
        : toSafeInteger(row.refresh_handle_version, 'refresh_handle_version'),
    verifiedAt: toSafeInteger(row.verified_at, 'verified_at'),
    refreshedAt: toSafeInteger(row.refreshed_at, 'refreshed_at'),
    revocationAt:
      row.revocation_at === null
        ? null
        : toSafeInteger(row.revocation_at, 'revocation_at'),
  });
}

function oneRow(rows, code, message) {
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw commerceError(code, message);
  }
  return rows[0];
}

function optionalRow(rows) {
  if (!Array.isArray(rows) || rows.length > 1) {
    throw commerceError('sqlite_commerce_row_invalid');
  }
  return rows[0] ?? null;
}

function requireOneChange(result, code, message) {
  if (!result || typeof result !== 'object' || result.changes !== 1) {
    throw commerceError(code, message);
  }
}

function freezeList(rows, mapper) {
  if (!Array.isArray(rows)) throw commerceError('sqlite_commerce_rows_invalid');
  return Object.freeze(rows.map(mapper));
}

function requireNoArguments(args, label) {
  if (args.length !== 0) throw new TypeError(`${label} does not accept input.`);
}

async function readJournal(connection, journalId) {
  return optionalRow(
    await connection.query(
      'SELECT journal_id, store, product_id, store_transaction_id, observation_state, processing_state, opaque_proof, created_at, updated_at FROM transaction_journal WHERE journal_id = ?',
      [journalId],
    ),
  );
}

async function readRawEntitlement(connection, entitlementId) {
  return optionalRow(
    await connection.query(
      'SELECT entitlement_id, store, product_id, state, sealed_refresh_handle, refresh_handle_version, verified_at, refreshed_at, revocation_at FROM app_entitlements WHERE entitlement_id = ?',
      [entitlementId],
    ),
  );
}

async function readEntitlement(connection, entitlementId) {
  const row = await readRawEntitlement(connection, entitlementId);
  return row ? attachCurrentTransactionAuthority(connection, row) : null;
}

function validateCurrentTransactionAuthority(entitlement, rows) {
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw commerceError('sqlite_commerce_transaction_authority_invalid');
  }
  const [owner] = rows;
  const validStoreId = entitlement.store === 'apple'
    ? APPLE_TRANSACTION_ID.test(owner.store_transaction_id)
    : GOOGLE_TRANSACTION_ID.test(owner.store_transaction_id);
  const expectedObservation = entitlement.state === 'active' ? 'purchased' : 'revoked';
  if (
    !validStoreId ||
    owner.observation_state !== expectedObservation ||
    !['store-completion-pending', 'complete'].includes(owner.processing_state)
  ) {
    throw commerceError('sqlite_commerce_transaction_authority_invalid');
  }
  return owner.store_transaction_id;
}

async function attachCurrentTransactionAuthority(connection, entitlement) {
  const rows = await connection.query(
    "SELECT store_transaction_id, observation_state, processing_state FROM transaction_journal WHERE store = ? AND product_id = ? AND store_transaction_id IS NOT NULL ORDER BY journal_id",
    [entitlement.store, entitlement.product_id],
  );
  return {
    ...entitlement,
    store_transaction_id: validateCurrentTransactionAuthority(entitlement, rows),
  };
}

export function createSqliteCommerceRepositories(connection) {
  assertSqlConnection(connection);

  async function observeTransaction(input) {
    const values = requireExactInput(
      input,
      ['journalId', 'store', 'productId', 'observationState', 'opaqueProof', 'observedAt'],
      'observeTransaction input',
    );
    requireIdentifier(values.journalId, 'journalId');
    if (!['apple', 'google'].includes(values.store)) {
      throw new TypeError('store is invalid.');
    }
    requireProductId(values.productId);
    if (!['pending', 'purchased', 'revoked'].includes(values.observationState)) {
      throw new TypeError('observationState is invalid.');
    }
    if (values.observationState === 'pending') {
      if (values.opaqueProof !== null) {
        throw new TypeError('Pending observations must not contain proof.');
      }
    } else {
      requireNonEmptyString(values.opaqueProof, 'opaqueProof', 65_536);
    }
    requireTimestamp(values.observedAt, 'observedAt');
    return runOwnedTransaction(connection, async () => {
      const existing = await readJournal(connection, values.journalId);
      if (existing) {
        const mapped = mapJournal(existing);
        const mayReopenActiveCallback =
          isActiveCallbackJournal(mapped) &&
          mapped.observationState === 'purchased' &&
          mapped.processingState === 'complete' &&
          mapped.storeTransactionId === null &&
          mapped.opaqueProof === null &&
          values.observationState === 'purchased' &&
          values.observedAt > mapped.updatedAt;
        if (mayReopenActiveCallback) {
          const entitlementId = mapStoreProductToEntitlement({
            store: mapped.store,
            productId: mapped.productId,
          });
          const entitlement = mapEntitlement(
            await readEntitlement(connection, entitlementId),
          );
          if (
            entitlement.state !== 'active' ||
            entitlement.store !== mapped.store ||
            entitlement.productId !== mapped.productId
          ) {
            throw commerceError('sqlite_commerce_entitlement_conflict');
          }
          requireOneChange(
            await connection.execute(
              'UPDATE transaction_journal SET processing_state = ?, opaque_proof = ?, updated_at = ? WHERE journal_id = ? AND processing_state = ? AND store_transaction_id IS NULL AND opaque_proof IS NULL',
              ['observed', values.opaqueProof, values.observedAt, values.journalId, 'complete'],
            ),
            'sqlite_commerce_journal_conflict',
          );
          return mapJournal(await readJournal(connection, values.journalId));
        }
        if (
          (mapped.processingState === 'complete' || mapped.processingState === 'rejected') &&
          mapped.store === values.store &&
          mapped.productId === values.productId &&
          observationEventKind(mapped.observationState) ===
            observationEventKind(values.observationState) &&
          mapped.opaqueProof === null
        ) {
          return mapped;
        }
        const expected = {
          journalId: values.journalId,
          store: values.store,
          productId: values.productId,
          storeTransactionId: null,
          observationState: values.observationState,
          processingState: 'observed',
          opaqueProof: values.opaqueProof,
          createdAt: values.observedAt,
          updatedAt: values.observedAt,
        };
        if (JOURNAL_KEYS.every((key) => mapped[key] === expected[key])) return mapped;
        if (
          mapped.store === values.store &&
          mapped.productId === values.productId &&
          mapped.storeTransactionId === null &&
          mapped.observationState === values.observationState &&
          mapped.processingState === 'observed' &&
          mapped.opaqueProof === values.opaqueProof
        ) {
          return mapped;
        }
        const mayPromotePending =
          mapped.store === values.store &&
          mapped.productId === values.productId &&
          mapped.storeTransactionId === null &&
          mapped.observationState === 'pending' &&
          mapped.processingState === 'observed' &&
          mapped.opaqueProof === null &&
          values.observationState === 'purchased' &&
          values.observedAt > mapped.updatedAt;
        if (mayPromotePending) {
          requireOneChange(
            await connection.execute(
              'UPDATE transaction_journal SET observation_state = ?, opaque_proof = ?, updated_at = ? WHERE journal_id = ? AND observation_state = ? AND processing_state = ? AND opaque_proof IS NULL AND store_transaction_id IS NULL',
              [
                values.observationState,
                values.opaqueProof,
                values.observedAt,
                values.journalId,
                'pending',
                'observed',
              ],
            ),
            'sqlite_commerce_journal_conflict',
          );
          return mapJournal(await readJournal(connection, values.journalId));
        }
        throw commerceError('sqlite_commerce_journal_conflict');
      }
      requireOneChange(
        await connection.execute(
          'INSERT INTO transaction_journal (journal_id, store, product_id, store_transaction_id, observation_state, processing_state, opaque_proof, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)',
          [
            values.journalId,
            values.store,
            values.productId,
            values.observationState,
            'observed',
            values.opaqueProof,
            values.observedAt,
            values.observedAt,
          ],
        ),
        'sqlite_commerce_write_failed',
      );
      return mapJournal(
        oneRow(
          await connection.query(
            'SELECT journal_id, store, product_id, store_transaction_id, observation_state, processing_state, opaque_proof, created_at, updated_at FROM transaction_journal WHERE journal_id = ?',
            [values.journalId],
          ),
          'sqlite_commerce_write_failed',
        ),
      );
    });
  }

  async function markVerified(input) {
    const values = requireExactInput(input, ['journalId', 'verifiedAt'], 'markVerified input');
    requireIdentifier(values.journalId, 'journalId');
    requireTimestamp(values.verifiedAt, 'verifiedAt');
    return runOwnedTransaction(connection, async () => {
      const journal = mapJournal(
        oneRow(
          await connection.query(
            'SELECT journal_id, store, product_id, store_transaction_id, observation_state, processing_state, opaque_proof, created_at, updated_at FROM transaction_journal WHERE journal_id = ?',
            [values.journalId],
          ),
          'sqlite_commerce_journal_missing',
          'Journal does not exist.',
        ),
      );
      if (journal.processingState === 'verified' && journal.updatedAt === values.verifiedAt) {
        return journal;
      }
      if (
        journal.observationState === 'pending' ||
        journal.processingState !== 'observed' ||
        values.verifiedAt < journal.updatedAt
      ) {
        throw commerceError(
          'sqlite_commerce_state_invalid',
          `Journal ${journal.observationState}/${journal.processingState} state cannot be verified.`,
        );
      }
      requireOneChange(
        await connection.execute(
          'UPDATE transaction_journal SET processing_state = ?, updated_at = ? WHERE journal_id = ? AND processing_state = ?',
          ['verified', values.verifiedAt, values.journalId, 'observed'],
        ),
        'sqlite_commerce_state_invalid',
      );
      return mapJournal(await readJournal(connection, values.journalId));
    });
  }

  async function commitEntitlementAndReadyToComplete(input) {
    const values = requireExactInput(
      input,
      ['journalId', 'entitlementId', 'storeTransactionId', 'sealedRefreshHandle', 'refreshHandleVersion', 'committedAt'],
      'commitEntitlementAndReadyToComplete input',
    );
    requireIdentifier(values.journalId, 'journalId');
    requireIdentifier(values.entitlementId, 'entitlementId');
    requireNonEmptyString(values.storeTransactionId, 'storeTransactionId', 64);
    requireNonEmptyString(
      values.sealedRefreshHandle,
      'sealedRefreshHandle',
      MAX_SEALED_REFRESH_HANDLE_CHARS,
    );
    requirePositiveInteger(values.refreshHandleVersion, 'refreshHandleVersion');
    requireTimestamp(values.committedAt, 'committedAt');
    return runOwnedTransaction(connection, async () => {
      const journal = mapJournal(
        oneRow(
          await connection.query(
            'SELECT journal_id, store, product_id, store_transaction_id, observation_state, processing_state, opaque_proof, created_at, updated_at FROM transaction_journal WHERE journal_id = ?',
            [values.journalId],
          ),
          'sqlite_commerce_journal_missing',
          'Journal does not exist.',
        ),
      );
      const existingEntitlementRow = await readEntitlement(
        connection,
        values.entitlementId,
      );
      const activeCallback = isActiveCallbackJournal(journal);
      if (
        journal.observationState === 'purchased' &&
        journal.processingState === 'store-completion-pending' &&
        (
          journal.storeTransactionId === values.storeTransactionId ||
          (activeCallback && journal.storeTransactionId === null)
        ) &&
        existingEntitlementRow
      ) {
        const existingEntitlement = mapEntitlement(existingEntitlementRow);
        if (
          existingEntitlement.state === 'active' &&
          existingEntitlement.store === journal.store &&
          existingEntitlement.productId === journal.productId &&
          existingEntitlement.storeTransactionId === values.storeTransactionId &&
          existingEntitlement.sealedRefreshHandle === values.sealedRefreshHandle &&
          existingEntitlement.refreshHandleVersion === values.refreshHandleVersion &&
          existingEntitlement.verifiedAt <= values.committedAt &&
          existingEntitlement.refreshedAt === values.committedAt
        ) {
          return frozenRecord(['journal', 'entitlement'], {
            journal,
            entitlement: existingEntitlement,
          });
        }
      }
      if (
        journal.observationState !== 'purchased' ||
        journal.processingState !== 'verified' ||
        values.committedAt < journal.updatedAt
      ) {
        throw commerceError(
          'sqlite_commerce_state_invalid',
          'Journal must be a verified purchase before entitlement commit.',
        );
      }
      const validStoreId = journal.store === 'apple'
        ? APPLE_TRANSACTION_ID.test(values.storeTransactionId)
        : GOOGLE_TRANSACTION_ID.test(values.storeTransactionId);
      if (!validStoreId) throw new TypeError('storeTransactionId is not canonical for its store.');
      if (journal.opaqueProof === values.storeTransactionId) {
        throw commerceError(
          'sqlite_commerce_transaction_proof_conflict',
          'Store transaction authority must not be copied from opaque proof.',
        );
      }
      const mappedEntitlementId = mapStoreProductToEntitlement({
        store: journal.store,
        productId: journal.productId,
      });
      if (values.entitlementId !== mappedEntitlementId) {
        throw new TypeError('entitlementId does not match durable store product authority.');
      }
      if (existingEntitlementRow) {
        const existingEntitlement = mapEntitlement(existingEntitlementRow);
        const sameAuthority =
          existingEntitlement.store === journal.store &&
          existingEntitlement.productId === journal.productId;
        const mayResealActive =
          existingEntitlement.state === 'active' &&
          existingEntitlement.revocationAt === null &&
          values.committedAt > existingEntitlement.refreshedAt &&
          values.refreshHandleVersion >= existingEntitlement.refreshHandleVersion;
        const mayReactivateRevoked =
          existingEntitlement.state === 'revoked' &&
          existingEntitlement.sealedRefreshHandle === null &&
          existingEntitlement.refreshHandleVersion === null &&
          existingEntitlement.revocationAt !== null &&
          values.committedAt > existingEntitlement.refreshedAt &&
          values.committedAt > existingEntitlement.revocationAt;
        if (!sameAuthority || (!mayResealActive && !mayReactivateRevoked)) {
          throw commerceError('sqlite_commerce_entitlement_conflict');
        }
        if (
          activeCallback &&
          (existingEntitlement.state !== 'active' ||
            existingEntitlement.storeTransactionId !== values.storeTransactionId)
        ) {
          throw commerceError('sqlite_commerce_transaction_authority_invalid');
        }
        requireOneChange(
          await connection.execute(
            'UPDATE app_entitlements SET state = ?, sealed_refresh_handle = ?, refresh_handle_version = ?, verified_at = ?, refreshed_at = ?, revocation_at = NULL WHERE entitlement_id = ? AND store = ? AND product_id = ?',
            [
              'active',
              values.sealedRefreshHandle,
              values.refreshHandleVersion,
              activeCallback ? existingEntitlement.verifiedAt : values.committedAt,
              values.committedAt,
              values.entitlementId,
              journal.store,
              journal.productId,
            ],
          ),
          'sqlite_commerce_entitlement_conflict',
        );
      } else {
        if (activeCallback) {
          throw commerceError('sqlite_commerce_entitlement_missing');
        }
        requireOneChange(
          await connection.execute(
            'INSERT INTO app_entitlements (entitlement_id, store, product_id, state, sealed_refresh_handle, refresh_handle_version, verified_at, refreshed_at, revocation_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)',
            [
              values.entitlementId,
              journal.store,
              journal.productId,
              'active',
              values.sealedRefreshHandle,
              values.refreshHandleVersion,
              values.committedAt,
              values.committedAt,
            ],
          ),
          'sqlite_commerce_entitlement_write_failed',
        );
      }
      if (activeCallback) {
        requireOneChange(
          await connection.execute(
            'UPDATE transaction_journal SET processing_state = ?, updated_at = ? WHERE journal_id = ? AND processing_state = ? AND store_transaction_id IS NULL',
            [
              'store-completion-pending',
              values.committedAt,
              values.journalId,
              'verified',
            ],
          ),
          'sqlite_commerce_state_invalid',
        );
        const entitlement = mapEntitlement(
          await readEntitlement(connection, values.entitlementId),
        );
        if (entitlement.storeTransactionId !== values.storeTransactionId) {
          throw commerceError('sqlite_commerce_transaction_authority_invalid');
        }
        return frozenRecord(['journal', 'entitlement'], {
          journal: mapJournal(await readJournal(connection, values.journalId)),
          entitlement,
        });
      }
      await connection.execute(
        'UPDATE transaction_journal SET store_transaction_id = NULL WHERE store = ? AND product_id = ? AND store_transaction_id IS NOT NULL AND journal_id <> ?',
        [journal.store, journal.productId, values.journalId],
      );
      requireOneChange(
        await connection.execute(
          'UPDATE transaction_journal SET store_transaction_id = ?, processing_state = ?, updated_at = ? WHERE journal_id = ? AND processing_state = ?',
          [
            values.storeTransactionId,
            'store-completion-pending',
            values.committedAt,
            values.journalId,
            'verified',
          ],
        ),
        'sqlite_commerce_state_invalid',
      );
      const authorityRows = await connection.query(
        'SELECT journal_id FROM transaction_journal WHERE store = ? AND store_transaction_id = ?',
        [journal.store, values.storeTransactionId],
      );
      if (
        !Array.isArray(authorityRows) ||
        authorityRows.length !== 1 ||
        authorityRows[0]?.journal_id !== values.journalId
      ) {
        throw commerceError('sqlite_commerce_transaction_authority_invalid');
      }
      return frozenRecord(['journal', 'entitlement'], {
        journal: mapJournal(await readJournal(connection, values.journalId)),
        entitlement: mapEntitlement(
          await readEntitlement(connection, values.entitlementId),
        ),
      });
    });
  }

  async function markStoreCompleteAndClearProof(input) {
    const values = requireExactInput(
      input,
      ['journalId', 'completedAt'],
      'markStoreCompleteAndClearProof input',
    );
    requireIdentifier(values.journalId, 'journalId');
    requireTimestamp(values.completedAt, 'completedAt');
    return runOwnedTransaction(connection, async () => {
      const existing = await readJournal(connection, values.journalId);
      if (!existing) throw commerceError('sqlite_commerce_journal_missing');
      const journal = mapJournal(existing);
      if (
        journal.processingState === 'complete' &&
        journal.opaqueProof === null &&
        journal.updatedAt === values.completedAt
      ) {
        return journal;
      }
      if (values.completedAt < journal.updatedAt) {
        throw commerceError('sqlite_commerce_state_invalid');
      }
      requireOneChange(
        await connection.execute(
          'UPDATE transaction_journal SET processing_state = ?, opaque_proof = NULL, updated_at = ? WHERE journal_id = ? AND processing_state = ?',
          ['complete', values.completedAt, values.journalId, 'store-completion-pending'],
        ),
        'sqlite_commerce_state_invalid',
        'Journal is not awaiting store completion.',
      );
      return mapJournal(await readJournal(connection, values.journalId));
    });
  }

  async function markRejectedAndClearProof(input) {
    const values = requireExactInput(
      input,
      ['journalId', 'rejectionKind', 'rejectedAt'],
      'markRejectedAndClearProof input',
    );
    requireIdentifier(values.journalId, 'journalId');
    if (!PERMANENT_REJECTIONS.includes(values.rejectionKind)) {
      throw new TypeError('rejectionKind must be a definitive permanent rejection.');
    }
    requireTimestamp(values.rejectedAt, 'rejectedAt');
    return runOwnedTransaction(connection, async () => {
      const existing = await readJournal(connection, values.journalId);
      if (!existing) throw commerceError('sqlite_commerce_journal_missing');
      const journal = mapJournal(existing);
      if (
        journal.processingState === 'rejected' &&
        journal.opaqueProof === null &&
        journal.updatedAt === values.rejectedAt
      ) {
        return journal;
      }
      if (values.rejectedAt < journal.updatedAt) {
        throw commerceError('sqlite_commerce_state_invalid');
      }
      requireOneChange(
        await connection.execute(
          "UPDATE transaction_journal SET processing_state = ?, opaque_proof = NULL, updated_at = ? WHERE journal_id = ? AND processing_state IN ('observed', 'verified')",
          ['rejected', values.rejectedAt, values.journalId],
        ),
        'sqlite_commerce_state_invalid',
      );
      return mapJournal(await readJournal(connection, values.journalId));
    });
  }

  async function replaceSealedRefreshHandle(input) {
    const values = requireExactInput(
      input,
      ['entitlementId', 'sealedRefreshHandle', 'refreshHandleVersion', 'refreshedAt'],
      'replaceSealedRefreshHandle input',
    );
    requireIdentifier(values.entitlementId, 'entitlementId');
    requireNonEmptyString(
      values.sealedRefreshHandle,
      'sealedRefreshHandle',
      MAX_SEALED_REFRESH_HANDLE_CHARS,
    );
    requirePositiveInteger(values.refreshHandleVersion, 'refreshHandleVersion');
    requireTimestamp(values.refreshedAt, 'refreshedAt');
    return runOwnedTransaction(connection, async () => {
      const existing = await readEntitlement(connection, values.entitlementId);
      if (!existing) throw commerceError('sqlite_commerce_entitlement_missing');
      const entitlement = mapEntitlement(existing);
      if (
        entitlement.state === 'active' &&
        entitlement.sealedRefreshHandle === values.sealedRefreshHandle &&
        entitlement.refreshHandleVersion === values.refreshHandleVersion &&
        entitlement.refreshedAt === values.refreshedAt
      ) {
        return entitlement;
      }
      if (values.refreshedAt <= entitlement.refreshedAt) {
        throw commerceError('sqlite_commerce_state_invalid');
      }
      if (values.refreshHandleVersion < entitlement.refreshHandleVersion) {
        throw commerceError('sqlite_commerce_refresh_version_invalid');
      }
      requireOneChange(
        await connection.execute(
          'UPDATE app_entitlements SET sealed_refresh_handle = ?, refresh_handle_version = ?, refreshed_at = ? WHERE entitlement_id = ? AND state = ?',
          [
            values.sealedRefreshHandle,
            values.refreshHandleVersion,
            values.refreshedAt,
            values.entitlementId,
            'active',
          ],
        ),
        'sqlite_commerce_state_invalid',
      );
      return mapEntitlement(await readEntitlement(connection, values.entitlementId));
    });
  }

  async function compareAndSwapSealedRefreshHandle(input) {
    const values = requireExactInput(
      input,
      [
        'entitlementId', 'expectedSealedRefreshHandle', 'sealedRefreshHandle',
        'refreshHandleVersion', 'refreshedAt',
      ],
      'compareAndSwapSealedRefreshHandle input',
    );
    requireIdentifier(values.entitlementId, 'entitlementId');
    requireNonEmptyString(
      values.expectedSealedRefreshHandle,
      'expectedSealedRefreshHandle',
      MAX_SEALED_REFRESH_HANDLE_CHARS,
    );
    requireNonEmptyString(
      values.sealedRefreshHandle,
      'sealedRefreshHandle',
      MAX_SEALED_REFRESH_HANDLE_CHARS,
    );
    requirePositiveInteger(values.refreshHandleVersion, 'refreshHandleVersion');
    requireTimestamp(values.refreshedAt, 'refreshedAt');
    return runOwnedTransaction(connection, async () => {
      const existing = await readRawEntitlement(connection, values.entitlementId);
      if (!existing) throw commerceError('sqlite_commerce_entitlement_missing');
      const entitlement = mapEntitlement({ ...existing, store_transaction_id: null });
      if (
        entitlement.state === 'active' &&
        entitlement.sealedRefreshHandle === values.sealedRefreshHandle &&
        entitlement.refreshHandleVersion === values.refreshHandleVersion &&
        entitlement.refreshedAt === values.refreshedAt
      ) {
        return mapEntitlement(await readEntitlement(connection, values.entitlementId));
      }
      if (
        entitlement.state !== 'active' ||
        entitlement.sealedRefreshHandle !== values.expectedSealedRefreshHandle
      ) {
        throw commerceError('sqlite_commerce_entitlement_conflict');
      }
      if (values.refreshedAt <= entitlement.refreshedAt) {
        throw commerceError('sqlite_commerce_state_invalid');
      }
      if (values.refreshHandleVersion < entitlement.refreshHandleVersion) {
        throw commerceError('sqlite_commerce_refresh_version_invalid');
      }
      requireOneChange(
        await connection.execute(
          'UPDATE app_entitlements SET sealed_refresh_handle = ?, refresh_handle_version = ?, refreshed_at = ? WHERE entitlement_id = ? AND state = ? AND sealed_refresh_handle = ? AND refreshed_at < ?',
          [
            values.sealedRefreshHandle,
            values.refreshHandleVersion,
            values.refreshedAt,
            values.entitlementId,
            'active',
            values.expectedSealedRefreshHandle,
            values.refreshedAt,
          ],
        ),
        'sqlite_commerce_entitlement_conflict',
      );
      return mapEntitlement(await readEntitlement(connection, values.entitlementId));
    });
  }

  async function applyRevocationAndDeleteHandle(input) {
    const values = requireExactInput(
      input,
      ['journalId', 'entitlementId', 'storeTransactionId', 'revokedAt'],
      'applyRevocationAndDeleteHandle input',
    );
    requireIdentifier(values.journalId, 'journalId');
    requireIdentifier(values.entitlementId, 'entitlementId');
    requireNonEmptyString(values.storeTransactionId, 'storeTransactionId', 64);
    requireTimestamp(values.revokedAt, 'revokedAt');
    return runOwnedTransaction(connection, async () => {
      const journal = mapJournal(
        oneRow(
          await connection.query(
            'SELECT journal_id, store, product_id, store_transaction_id, observation_state, processing_state, opaque_proof, created_at, updated_at FROM transaction_journal WHERE journal_id = ?',
            [values.journalId],
          ),
          'sqlite_commerce_journal_missing',
        ),
      );
      const validStoreId = journal.store === 'apple'
        ? APPLE_TRANSACTION_ID.test(values.storeTransactionId)
        : GOOGLE_TRANSACTION_ID.test(values.storeTransactionId);
      if (!validStoreId || journal.opaqueProof === values.storeTransactionId) {
        throw new TypeError('storeTransactionId is invalid revocation authority.');
      }
      const mappedEntitlementId = mapStoreProductToEntitlement({
        store: journal.store,
        productId: journal.productId,
      });
      if (values.entitlementId !== mappedEntitlementId) {
        throw new TypeError('entitlementId does not match durable store product authority.');
      }
      const entitlementRow = await readEntitlement(connection, values.entitlementId);
      const entitlement = entitlementRow ? mapEntitlement(entitlementRow) : null;
      if (
        journal.observationState === 'revoked' &&
        journal.processingState === 'store-completion-pending' &&
        journal.storeTransactionId === values.storeTransactionId &&
        journal.updatedAt === values.revokedAt &&
        entitlement?.state === 'revoked' &&
        entitlement.sealedRefreshHandle === null &&
        entitlement.refreshHandleVersion === null &&
        entitlement.revocationAt === values.revokedAt
      ) {
        return frozenRecord(['journal', 'entitlement'], { journal, entitlement });
      }
      if (
        journal.observationState !== 'revoked' ||
        journal.processingState !== 'verified' ||
        values.revokedAt < journal.updatedAt ||
        (entitlement && (
          entitlement.state !== 'active' ||
          journal.store !== entitlement.store ||
          journal.productId !== entitlement.productId ||
          values.revokedAt < entitlement.refreshedAt
        ))
      ) {
        throw commerceError('sqlite_commerce_state_invalid');
      }
      await connection.execute(
        'UPDATE transaction_journal SET store_transaction_id = NULL WHERE store = ? AND product_id = ? AND store_transaction_id IS NOT NULL AND journal_id <> ?',
        [journal.store, journal.productId, values.journalId],
      );
      if (entitlement) {
        requireOneChange(
          await connection.execute(
            'UPDATE app_entitlements SET state = ?, revocation_at = ? WHERE entitlement_id = ? AND state = ?',
            ['revoked', values.revokedAt, values.entitlementId, 'active'],
          ),
          'sqlite_commerce_state_invalid',
        );
        requireOneChange(
          await connection.execute(
            'UPDATE app_entitlements SET sealed_refresh_handle = NULL, refresh_handle_version = NULL WHERE entitlement_id = ? AND state = ?',
            [values.entitlementId, 'revoked'],
          ),
          'sqlite_commerce_state_invalid',
        );
      } else {
        requireOneChange(
          await connection.execute(
            'INSERT INTO app_entitlements (entitlement_id, store, product_id, state, sealed_refresh_handle, refresh_handle_version, verified_at, refreshed_at, revocation_at) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)',
            [
              values.entitlementId,
              journal.store,
              journal.productId,
              'revoked',
              values.revokedAt,
              values.revokedAt,
              values.revokedAt,
            ],
          ),
          'sqlite_commerce_entitlement_write_failed',
        );
      }
      requireOneChange(
        await connection.execute(
          'UPDATE transaction_journal SET store_transaction_id = ?, processing_state = ?, updated_at = ? WHERE journal_id = ? AND processing_state = ?',
          [
            values.storeTransactionId,
            'store-completion-pending',
            values.revokedAt,
            values.journalId,
            'verified',
          ],
        ),
        'sqlite_commerce_state_invalid',
      );
      const authorityRows = await connection.query(
        'SELECT journal_id FROM transaction_journal WHERE store = ? AND store_transaction_id = ?',
        [journal.store, values.storeTransactionId],
      );
      if (
        !Array.isArray(authorityRows) ||
        authorityRows.length !== 1 ||
        authorityRows[0]?.journal_id !== values.journalId
      ) {
        throw commerceError('sqlite_commerce_transaction_authority_invalid');
      }
      return frozenRecord(['journal', 'entitlement'], {
        journal: mapJournal(await readJournal(connection, values.journalId)),
        entitlement: mapEntitlement(
          await readEntitlement(connection, values.entitlementId),
        ),
      });
    });
  }

  async function listRecoverableTransactions() {
    requireNoArguments(arguments, 'listRecoverableTransactions');
    return runExclusive(connection, async () =>
      freezeList(
        await connection.query(
          "SELECT journal_id, store, product_id, store_transaction_id, observation_state, processing_state, opaque_proof, created_at, updated_at FROM transaction_journal WHERE processing_state NOT IN ('complete', 'rejected') ORDER BY created_at ASC, journal_id ASC",
        ),
        mapJournal,
      ),
    );
  }

  async function listEntitlements() {
    requireNoArguments(arguments, 'listEntitlements');
    return runExclusive(connection, async () => {
      const rows = await connection.query(
        'SELECT entitlement_id, store, product_id, state, sealed_refresh_handle, refresh_handle_version, verified_at, refreshed_at, revocation_at FROM app_entitlements ORDER BY entitlement_id ASC',
      );
      if (!Array.isArray(rows)) throw commerceError('sqlite_commerce_rows_invalid');
      const projected = [];
      for (const row of rows) {
        projected.push(mapEntitlement(await attachCurrentTransactionAuthority(connection, row)));
      }
      return Object.freeze(projected);
    });
  }

  return Object.freeze({
    observeTransaction,
    markVerified,
    commitEntitlementAndReadyToComplete,
    markStoreCompleteAndClearProof,
    markRejectedAndClearProof,
    replaceSealedRefreshHandle,
    compareAndSwapSealedRefreshHandle,
    applyRevocationAndDeleteHandle,
    listRecoverableTransactions,
    listEntitlements,
  });
}
