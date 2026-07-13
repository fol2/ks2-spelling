import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/platform/database/canonical-json.js';
import { configureAndMigrateDatabase } from '../src/platform/database/migrate-database.js';
import { createSqliteCommerceRepositories } from '../src/platform/database/sqlite-commerce-repositories.js';

import { createNodeSqliteConnection } from './helpers/node-sqlite-connection.mjs';

const ASYNC_FUNCTION_PROTOTYPE = Object.getPrototypeOf(async function () {});
const REPOSITORY_METHODS = Object.freeze([
  'observeTransaction',
  'markVerified',
  'commitEntitlementAndReadyToComplete',
  'markStoreCompleteAndClearProof',
  'markRejectedAndClearProof',
  'replaceSealedRefreshHandle',
  'applyRevocationAndDeleteHandle',
  'listRecoverableTransactions',
  'listEntitlements',
]);
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
  'state',
  'sealedRefreshHandle',
  'refreshHandleVersion',
  'verifiedAt',
  'refreshedAt',
  'revocationAt',
]);

function assertClosedFrozenRecord(value, keys) {
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal(Object.isFrozen(value), true);
  assert.deepEqual(Reflect.ownKeys(value), keys);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assert.ok(descriptor);
    assert.equal(Object.hasOwn(descriptor, 'value'), true);
    assert.equal(descriptor.enumerable, true);
    assert.equal(descriptor.configurable, false);
    assert.equal(descriptor.writable, false);
  }
}

function assertJournal(value, expected) {
  assertClosedFrozenRecord(value, JOURNAL_KEYS);
  assert.deepEqual(value, expected);
}

function assertEntitlement(value, expected) {
  assertClosedFrozenRecord(value, ENTITLEMENT_KEYS);
  assert.deepEqual(value, expected);
}

function createConnectionFacade(base, hooks = {}) {
  async function callHook(name, ...args) {
    if (hooks[name]) await hooks[name](...args);
  }
  return Object.freeze({
    async open() {
      await callHook('beforeOpen');
      const result = await base.open();
      await callHook('afterOpen');
      return result;
    },
    async close() {
      await callHook('beforeClose');
      const result = await base.close();
      await callHook('afterClose');
      return result;
    },
    async execute(sql, values) {
      await callHook('beforeExecute', sql, values);
      const result = await base.execute(sql, values);
      await callHook('afterExecute', sql, values, result);
      return result;
    },
    async query(sql, values = []) {
      await callHook('beforeQuery', sql, values);
      const result = await base.query(sql, values);
      await callHook('afterQuery', sql, values, result);
      return result;
    },
    async begin() {
      await callHook('beforeBegin');
      const result = await base.begin();
      await callHook('afterBegin');
      return result;
    },
    async commit() {
      await callHook('beforeCommit');
      const result = await base.commit();
      await callHook('afterCommit');
      return result;
    },
    async rollback() {
      await callHook('beforeRollback');
      const result = await base.rollback();
      await callHook('afterRollback');
      return result;
    },
    async isTransactionActive() {
      await callHook('beforeIsTransactionActive');
      const result = await base.isTransactionActive();
      await callHook('afterIsTransactionActive', result);
      return result;
    },
  });
}

async function withDatabase(run) {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-spelling-commerce-'));
  const connection = createNodeSqliteConnection(join(directory, 'commerce.sqlite'));
  try {
    await connection.open();
    await configureAndMigrateDatabase(connection);
    await run(connection);
  } finally {
    if (await connection.isTransactionActive()) await connection.rollback();
    await connection.close();
    await rm(directory, { force: true, recursive: true });
  }
}

async function commerceDigest(connection) {
  const state = {
    entitlements: await connection.query(
      'SELECT * FROM app_entitlements ORDER BY entitlement_id',
    ),
    journal: await connection.query(
      'SELECT * FROM transaction_journal ORDER BY created_at, journal_id',
    ),
  };
  return createHash('sha256').update(canonicalJson(state)).digest('hex');
}

async function observePurchased(repository, overrides = {}) {
  return repository.observeTransaction({
    journalId: 'journal-apple',
    store: 'apple',
    productId: 'uk.eugnel.ks2spelling.fullks2',
    observationState: 'purchased',
    opaqueProof: 'eyJhbGciOiJFUzI1NiJ9.test.signature',
    observedAt: 1_768_478_400_000,
    ...overrides,
  });
}

async function grantApple(repository, overrides = {}) {
  const journalId = overrides.journalId ?? 'journal-apple';
  await observePurchased(repository, { journalId });
  await repository.markVerified({
    journalId,
    verifiedAt: 1_768_478_400_100,
  });
  return repository.commitEntitlementAndReadyToComplete({
    journalId,
    entitlementId: overrides.entitlementId ?? 'full-ks2',
    storeTransactionId: overrides.storeTransactionId ?? '2000001234567890',
    sealedRefreshHandle:
      overrides.sealedRefreshHandle ?? 'b3rh1.1.nonce.ciphertext-and-tag',
    refreshHandleVersion: overrides.refreshHandleVersion ?? 1,
    committedAt: overrides.committedAt ?? 1_768_478_400_200,
  });
}

test('commerce repository exposes exactly nine frozen async public methods', async () => {
  await withDatabase(async (connection) => {
    const repository = createSqliteCommerceRepositories(connection);

    assert.equal(Object.getPrototypeOf(repository), Object.prototype);
    assert.equal(Object.isFrozen(repository), true);
    assert.deepEqual(Reflect.ownKeys(repository), REPOSITORY_METHODS);
    for (const method of REPOSITORY_METHODS) {
      const descriptor = Object.getOwnPropertyDescriptor(repository, method);
      assert.ok(descriptor);
      assert.equal(Object.hasOwn(descriptor, 'value'), true);
      assert.equal(descriptor.enumerable, true);
      assert.equal(descriptor.configurable, false);
      assert.equal(descriptor.writable, false);
      assert.equal(Object.getPrototypeOf(descriptor.value), ASYNC_FUNCTION_PROTOTYPE);
    }
  });

  assert.throws(() => createSqliteCommerceRepositories(null), TypeError);
  assert.throws(
    () => createSqliteCommerceRepositories(Object.freeze({})),
    TypeError,
  );
});

test('purchase progresses through observed, verified, ready-to-complete and proof-cleared complete', async () => {
  await withDatabase(async (connection) => {
    const repository = createSqliteCommerceRepositories(connection);
    const observed = await observePurchased(repository);
    assertJournal(observed, {
      journalId: 'journal-apple',
      store: 'apple',
      productId: 'uk.eugnel.ks2spelling.fullks2',
      storeTransactionId: null,
      observationState: 'purchased',
      processingState: 'observed',
      opaqueProof: 'eyJhbGciOiJFUzI1NiJ9.test.signature',
      createdAt: 1_768_478_400_000,
      updatedAt: 1_768_478_400_000,
    });

    const verified = await repository.markVerified({
      journalId: 'journal-apple',
      verifiedAt: 1_768_478_400_100,
    });
    assertJournal(verified, {
      ...observed,
      processingState: 'verified',
      updatedAt: 1_768_478_400_100,
    });

    const committed = await repository.commitEntitlementAndReadyToComplete({
      journalId: 'journal-apple',
      entitlementId: 'full-ks2',
      storeTransactionId: '2000001234567890',
      sealedRefreshHandle: 'b3rh1.1.nonce.ciphertext-and-tag',
      refreshHandleVersion: 1,
      committedAt: 1_768_478_400_200,
    });
    assertClosedFrozenRecord(committed, ['journal', 'entitlement']);
    assertJournal(committed.journal, {
      ...verified,
      storeTransactionId: '2000001234567890',
      processingState: 'store-completion-pending',
      updatedAt: 1_768_478_400_200,
    });
    assertEntitlement(committed.entitlement, {
      entitlementId: 'full-ks2',
      store: 'apple',
      productId: 'uk.eugnel.ks2spelling.fullks2',
      state: 'active',
      sealedRefreshHandle: 'b3rh1.1.nonce.ciphertext-and-tag',
      refreshHandleVersion: 1,
      verifiedAt: 1_768_478_400_200,
      refreshedAt: 1_768_478_400_200,
      revocationAt: null,
    });

    const completed = await repository.markStoreCompleteAndClearProof({
      journalId: 'journal-apple',
      completedAt: 1_768_478_400_300,
    });
    assertJournal(completed, {
      ...committed.journal,
      processingState: 'complete',
      opaqueProof: null,
      updatedAt: 1_768_478_400_300,
    });

    const entitlements = await repository.listEntitlements();
    assert.equal(Object.isFrozen(entitlements), true);
    assert.deepEqual(entitlements, [committed.entitlement]);
    assert.equal(Object.isFrozen(entitlements[0]), true);
    assert.deepEqual(await repository.listRecoverableTransactions(), []);
  });
});

test('pending remains recoverable with null store ID and cannot be verified or granted', async () => {
  await withDatabase(async (connection) => {
    const repository = createSqliteCommerceRepositories(connection);
    const pending = await repository.observeTransaction({
      journalId: 'journal-pending',
      store: 'google',
      productId: 'full_ks2',
      observationState: 'pending',
      opaqueProof: null,
      observedAt: 1_768_478_400_000,
    });
    assert.equal(pending.storeTransactionId, null);
    assert.equal(pending.processingState, 'observed');
    const before = await commerceDigest(connection);

    await assert.rejects(
      repository.markVerified({
        journalId: 'journal-pending',
        verifiedAt: 1_768_478_400_100,
      }),
      /pending|state/i,
    );
    await assert.rejects(
      repository.commitEntitlementAndReadyToComplete({
        journalId: 'journal-pending',
        entitlementId: 'full-ks2',
        storeTransactionId: 'GPA.1234-5678-9012-34567',
        sealedRefreshHandle: 'b3rh1.1.nonce.ciphertext',
        refreshHandleVersion: 1,
        committedAt: 1_768_478_400_200,
      }),
      /verified|state/i,
    );
    assert.equal(await commerceDigest(connection), before);
    assert.deepEqual(await repository.listRecoverableTransactions(), [pending]);
    assert.deepEqual(await repository.listEntitlements(), []);
  });
});

test('only canonical Apple decimal and Google GPA gateway IDs become durable authority', async () => {
  await withDatabase(async (connection) => {
    const repository = createSqliteCommerceRepositories(connection);
    await observePurchased(repository);
    await repository.markVerified({
      journalId: 'journal-apple',
      verifiedAt: 1_768_478_400_100,
    });
    const beforeApple = await commerceDigest(connection);
    const baseApple = {
      journalId: 'journal-apple',
      entitlementId: 'full-ks2',
      storeTransactionId: '2000001234567890',
      sealedRefreshHandle: 'b3rh1.1.nonce.ciphertext',
      refreshHandleVersion: 1,
      committedAt: 1_768_478_400_200,
    };
    for (const storeTransactionId of [
      '0',
      '01',
      '-1',
      '1.5',
      ' 2000001234567890',
      2_000_001_234_567_890,
      'eyJhbGciOiJFUzI1NiJ9.test.signature',
      'native-transaction-ref',
    ]) {
      await assert.rejects(
        repository.commitEntitlementAndReadyToComplete({
          ...baseApple,
          storeTransactionId,
        }),
        TypeError,
      );
      assert.equal(await commerceDigest(connection), beforeApple);
    }
    await assert.rejects(
      repository.commitEntitlementAndReadyToComplete({
        ...baseApple,
        transactionRef: 'native-ref-must-not-enter-SQLite',
      }),
      TypeError,
    );
    assert.equal(await commerceDigest(connection), beforeApple);
    await assert.rejects(
      repository.commitEntitlementAndReadyToComplete({
        ...baseApple,
        entitlementId: 'future-pack',
      }),
      /entitlement|product|authority/i,
    );
    assert.equal(await commerceDigest(connection), beforeApple);

    await repository.observeTransaction({
      journalId: 'journal-google',
      store: 'google',
      productId: 'full_ks2',
      observationState: 'purchased',
      opaqueProof: 'google-purchase-token-secret',
      observedAt: 1_768_478_401_000,
    });
    await repository.markVerified({
      journalId: 'journal-google',
      verifiedAt: 1_768_478_401_100,
    });
    const baseGoogle = {
      journalId: 'journal-google',
      entitlementId: 'full-ks2',
      storeTransactionId: 'GPA.1234-5678-9012-34567',
      sealedRefreshHandle: 'b3rh1.1.google.ciphertext',
      refreshHandleVersion: 1,
      committedAt: 1_768_478_401_200,
    };
    const beforeGoogle = await commerceDigest(connection);
    for (const storeTransactionId of [
      'gpa.1234-5678-9012-34567',
      'GPA.1234-5678-9012-3456',
      'GPA.1234-5678-9012-345678',
      'GPA.1234-5678-9012-34567..0',
      'google-purchase-token-secret',
    ]) {
      await assert.rejects(
        repository.commitEntitlementAndReadyToComplete({
          ...baseGoogle,
          storeTransactionId,
        }),
        TypeError,
      );
      assert.equal(await commerceDigest(connection), beforeGoogle);
    }

    const googleCommit = await repository.commitEntitlementAndReadyToComplete(
      baseGoogle,
    );
    assert.equal(
      googleCommit.journal.storeTransactionId,
      'GPA.1234-5678-9012-34567',
    );

    await repository.observeTransaction({
      journalId: 'journal-proof-equality',
      store: 'google',
      productId: 'full_ks2',
      observationState: 'purchased',
      opaqueProof: 'GPA.9999-9999-9999-99999',
      observedAt: 1_768_478_402_000,
    });
    await repository.markVerified({
      journalId: 'journal-proof-equality',
      verifiedAt: 1_768_478_402_100,
    });
    await assert.rejects(
      repository.commitEntitlementAndReadyToComplete({
        ...baseGoogle,
        journalId: 'journal-proof-equality',
        entitlementId: 'another-pack',
        storeTransactionId: 'GPA.9999-9999-9999-99999',
        committedAt: 1_768_478_402_200,
      }),
      /proof|transaction/i,
    );
  });
});

test('durable product mapping rejects client-chosen grant and revoke entitlements', async () => {
  await withDatabase(async (connection) => {
    const repository = createSqliteCommerceRepositories(connection);
    await observePurchased(repository);
    await repository.markVerified({
      journalId: 'journal-apple',
      verifiedAt: 1_768_478_400_100,
    });
    const beforeGrant = await commerceDigest(connection);
    await assert.rejects(
      repository.commitEntitlementAndReadyToComplete({
        journalId: 'journal-apple',
        entitlementId: 'future-pack',
        storeTransactionId: '2000001234567890',
        sealedRefreshHandle: 'b3rh1.1.nonce.ciphertext',
        refreshHandleVersion: 1,
        committedAt: 1_768_478_400_200,
      }),
      /entitlement|product|authority/i,
    );
    assert.equal(await commerceDigest(connection), beforeGrant);

    await repository.commitEntitlementAndReadyToComplete({
      journalId: 'journal-apple',
      entitlementId: 'full-ks2',
      storeTransactionId: '2000001234567890',
      sealedRefreshHandle: 'b3rh1.1.nonce.ciphertext',
      refreshHandleVersion: 1,
      committedAt: 1_768_478_400_200,
    });
    await repository.observeTransaction({
      journalId: 'journal-revocation-mapping',
      store: 'apple',
      productId: 'uk.eugnel.ks2spelling.fullks2',
      observationState: 'revoked',
      opaqueProof: 'proof-distinct-from-safe-store-id',
      observedAt: 1_768_478_401_000,
    });
    await repository.markVerified({
      journalId: 'journal-revocation-mapping',
      verifiedAt: 1_768_478_401_100,
    });
    const beforeRevoke = await commerceDigest(connection);
    await assert.rejects(
      repository.applyRevocationAndDeleteHandle({
        journalId: 'journal-revocation-mapping',
        entitlementId: 'future-pack',
        storeTransactionId: '2000001234567890',
        revokedAt: 1_768_478_401_200,
      }),
      /entitlement|product|authority/i,
    );
    assert.equal(await commerceDigest(connection), beforeRevoke);
  });
});

test('closed input records reject unknown keys, prototypes and accessors before SQL', async () => {
  await withDatabase(async (base) => {
    let sqlCalls = 0;
    const connection = createConnectionFacade(base, {
      beforeExecute() {
        sqlCalls += 1;
      },
      beforeQuery() {
        sqlCalls += 1;
      },
    });
    const repository = createSqliteCommerceRepositories(connection);
    const valid = {
      journalId: 'journal-apple',
      store: 'apple',
      productId: 'uk.eugnel.ks2spelling.fullks2',
      observationState: 'purchased',
      opaqueProof: 'proof',
      observedAt: 1_768_478_400_000,
    };
    const inherited = Object.assign(Object.create({ hidden: true }), valid);
    const accessor = { ...valid };
    let getterCalled = false;
    Object.defineProperty(accessor, 'opaqueProof', {
      enumerable: true,
      get() {
        getterCalled = true;
        return 'proof';
      },
    });
    const withSymbol = { ...valid, [Symbol('secret')]: 'proof' };
    for (const input of [
      null,
      [],
      { ...valid, unknown: true },
      inherited,
      accessor,
      withSymbol,
    ]) {
      await assert.rejects(repository.observeTransaction(input), TypeError);
      assert.equal(sqlCalls, 0);
    }
    assert.equal(getterCalled, false);
  });
});

test('permanent rejection clears proof atomically while retryable causes execute zero SQL', async () => {
  await withDatabase(async (base) => {
    let sqlCalls = 0;
    const connection = createConnectionFacade(base, {
      beforeExecute() {
        sqlCalls += 1;
      },
      beforeQuery() {
        sqlCalls += 1;
      },
    });
    const repository = createSqliteCommerceRepositories(connection);
    await observePurchased(repository);
    const beforeRetryable = await commerceDigest(base);
    sqlCalls = 0;
    for (const rejectionKind of [
      'dns',
      'abort',
      'timeout',
      'http-429',
      'http-500',
      'http-599',
    ]) {
      await assert.rejects(
        repository.markRejectedAndClearProof({
          journalId: 'journal-apple',
          rejectionKind,
          rejectedAt: 1_768_478_400_100,
        }),
        TypeError,
      );
      assert.equal(sqlCalls, 0, rejectionKind);
      assert.equal(await commerceDigest(base), beforeRetryable, rejectionKind);
    }

    const rejected = await repository.markRejectedAndClearProof({
      journalId: 'journal-apple',
      rejectionKind: 'authenticated-permanent',
      rejectedAt: 1_768_478_400_200,
    });
    assert.equal(rejected.processingState, 'rejected');
    assert.equal(rejected.opaqueProof, null);
    assert.deepEqual(await repository.listRecoverableTransactions(), []);

    await assert.rejects(
      repository.markVerified({
        journalId: 'journal-apple',
        verifiedAt: 1_768_478_400_300,
      }),
      /rejected|state/i,
    );
    assert.deepEqual(await repository.listRecoverableTransactions(), []);

    await observePurchased(repository, {
      journalId: 'journal-malformed',
      observedAt: 1_768_478_401_000,
    });
    const malformed = await repository.markRejectedAndClearProof({
      journalId: 'journal-malformed',
      rejectionKind: 'definitive-malformed-proof',
      rejectedAt: 1_768_478_401_100,
    });
    assert.equal(malformed.processingState, 'rejected');
    assert.equal(malformed.opaqueProof, null);
  });
});

test('grant transaction rolls back both entitlement and ready state on an intermediate write failure', async () => {
  await withDatabase(async (base) => {
    let failAfterEntitlementWrite = false;
    const connection = createConnectionFacade(base, {
      afterExecute(sql) {
        if (failAfterEntitlementWrite && /app_entitlements/i.test(sql)) {
          failAfterEntitlementWrite = false;
          throw new Error('injected_after_entitlement_write');
        }
      },
    });
    const repository = createSqliteCommerceRepositories(connection);
    await observePurchased(repository);
    await repository.markVerified({
      journalId: 'journal-apple',
      verifiedAt: 1_768_478_400_100,
    });
    const before = await commerceDigest(base);
    failAfterEntitlementWrite = true;

    await assert.rejects(
      repository.commitEntitlementAndReadyToComplete({
        journalId: 'journal-apple',
        entitlementId: 'full-ks2',
        storeTransactionId: '2000001234567890',
        sealedRefreshHandle: 'b3rh1.1.nonce.ciphertext',
        refreshHandleVersion: 1,
        committedAt: 1_768_478_400_200,
      }),
      /injected_after_entitlement_write/,
    );
    assert.equal(await base.isTransactionActive(), false);
    assert.equal(await commerceDigest(base), before);
    assert.deepEqual(await repository.listEntitlements(), []);
  });
});

test('permanent rejection cannot orphan an already committed entitlement', async () => {
  await withDatabase(async (connection) => {
    const repository = createSqliteCommerceRepositories(connection);
    const committed = await grantApple(repository);
    const before = await commerceDigest(connection);

    await assert.rejects(
      repository.markRejectedAndClearProof({
        journalId: committed.journal.journalId,
        rejectionKind: 'authenticated-permanent',
        rejectedAt: committed.journal.updatedAt + 1,
      }),
      /state/i,
    );

    assert.equal(await commerceDigest(connection), before);
    assert.deepEqual(await repository.listEntitlements(), [committed.entitlement]);
    assert.deepEqual(await repository.listRecoverableTransactions(), [committed.journal]);
  });
});

test('begin acknowledgement loss rolls back an active native transaction before rejecting', async () => {
  await withDatabase(async (base) => {
    let rollbackCalls = 0;
    const connection = createConnectionFacade(base, {
      afterBegin() {
        throw new Error('native_begin_ack_lost');
      },
      beforeRollback() {
        rollbackCalls += 1;
      },
    });
    const repository = createSqliteCommerceRepositories(connection);

    await assert.rejects(observePurchased(repository), /native_begin_ack_lost/);
    assert.equal(rollbackCalls, 1);
    assert.equal(await base.isTransactionActive(), false);
    assert.deepEqual(
      await base.query('SELECT * FROM transaction_journal'),
      [],
    );
  });
});

test('sealed handle replacement is atomic and revocation writes state before deleting handle', async () => {
  await withDatabase(async (base) => {
    const trace = [];
    const connection = createConnectionFacade(base, {
      beforeBegin() {
        trace.push({ operation: 'begin' });
      },
      beforeExecute(sql, values) {
        trace.push({ operation: 'execute', sql, values });
      },
      beforeCommit() {
        trace.push({ operation: 'commit' });
      },
    });
    const repository = createSqliteCommerceRepositories(connection);
    await grantApple(repository);

    const replaced = await repository.replaceSealedRefreshHandle({
      entitlementId: 'full-ks2',
      sealedRefreshHandle: 'b3rh1.2.new-nonce.new-ciphertext',
      refreshHandleVersion: 2,
      refreshedAt: 1_768_478_401_000,
    });
    assert.equal(replaced.sealedRefreshHandle, 'b3rh1.2.new-nonce.new-ciphertext');
    assert.equal(replaced.refreshHandleVersion, 2);
    assert.equal(replaced.refreshedAt, 1_768_478_401_000);

    await assert.rejects(
      repository.replaceSealedRefreshHandle({
        entitlementId: 'full-ks2',
        sealedRefreshHandle: 'b3rh1.2.ambiguous.ciphertext',
        refreshHandleVersion: 2,
        refreshedAt: 1_768_478_401_000,
      }),
      /state|refresh|version/i,
    );

    const sameVersionRefresh = await repository.replaceSealedRefreshHandle({
      entitlementId: 'full-ks2',
      sealedRefreshHandle: 'b3rh1.2.fresh-nonce.fresh-ciphertext',
      refreshHandleVersion: 2,
      refreshedAt: 1_768_478_401_100,
    });
    assert.equal(
      sameVersionRefresh.sealedRefreshHandle,
      'b3rh1.2.fresh-nonce.fresh-ciphertext',
    );
    assert.equal(sameVersionRefresh.refreshHandleVersion, 2);

    await repository.observeTransaction({
      journalId: 'journal-revoked',
      store: 'apple',
      productId: 'uk.eugnel.ks2spelling.fullks2',
      observationState: 'revoked',
      opaqueProof: 'eyJhbGciOiJFUzI1NiJ9.revocation.signature',
      observedAt: 1_768_478_402_000,
    });
    await repository.markVerified({
      journalId: 'journal-revoked',
      verifiedAt: 1_768_478_402_100,
    });
    trace.length = 0;
    const revoked = await repository.applyRevocationAndDeleteHandle({
      journalId: 'journal-revoked',
      entitlementId: 'full-ks2',
      storeTransactionId: '2000001234567890',
      revokedAt: 1_768_478_402_200,
    });
    assertClosedFrozenRecord(revoked, ['journal', 'entitlement']);
    assert.equal(revoked.entitlement.state, 'revoked');
    assert.equal(revoked.entitlement.sealedRefreshHandle, null);
    assert.equal(revoked.entitlement.refreshHandleVersion, null);
    assert.equal(revoked.entitlement.revocationAt, 1_768_478_402_200);
    assert.equal(revoked.journal.processingState, 'store-completion-pending');
    assert.equal(revoked.journal.storeTransactionId, '2000001234567890');

    assert.equal(trace[0]?.operation, 'begin');
    assert.equal(trace.at(-1)?.operation, 'commit');
    assert.equal(trace.filter(({ operation }) => operation === 'commit').length, 1);
    const stateWrite = trace.findIndex(
      ({ sql }) =>
        typeof sql === 'string' &&
        /UPDATE\s+app_entitlements/i.test(sql) &&
        /state\s*=\s*['"]?revoked|state\s*=\s*\?/i.test(sql),
    );
    const handleDelete = trace.findIndex(
      ({ sql }) =>
        typeof sql === 'string' &&
        /UPDATE\s+app_entitlements/i.test(sql) &&
        /sealed_refresh_handle\s*=\s*NULL/i.test(sql),
    );
    assert.notEqual(stateWrite, -1);
    assert.notEqual(handleDelete, -1);
    assert.ok(stateWrite < handleDelete, 'revoked state must be written before handle deletion');

    const complete = await repository.markStoreCompleteAndClearProof({
      journalId: 'journal-revoked',
      completedAt: 1_768_478_402_300,
    });
    assert.equal(complete.processingState, 'complete');
    assert.equal(complete.opaqueProof, null);
  });
});

test('recoverable journal ordering is stable and terminal rows are excluded', async () => {
  await withDatabase(async (connection) => {
    const repository = createSqliteCommerceRepositories(connection);
    await observePurchased(repository, {
      journalId: 'journal-c',
      observedAt: 1_768_478_402_000,
    });
    await observePurchased(repository, {
      journalId: 'journal-b',
      observedAt: 1_768_478_401_000,
    });
    await observePurchased(repository, {
      journalId: 'journal-a',
      observedAt: 1_768_478_401_000,
    });
    await observePurchased(repository, {
      journalId: 'journal-complete',
      observedAt: 1_768_478_399_000,
    });
    await repository.markRejectedAndClearProof({
      journalId: 'journal-complete',
      rejectionKind: 'authenticated-permanent',
      rejectedAt: 1_768_478_399_100,
    });
    await repository.markVerified({
      journalId: 'journal-b',
      verifiedAt: 1_768_478_401_100,
    });

    const recoverable = await repository.listRecoverableTransactions();
    assert.equal(Object.isFrozen(recoverable), true);
    assert.deepEqual(
      recoverable.map(({ journalId, processingState }) => ({
        journalId,
        processingState,
      })),
      [
        { journalId: 'journal-a', processingState: 'observed' },
        { journalId: 'journal-b', processingState: 'verified' },
        { journalId: 'journal-c', processingState: 'observed' },
      ],
    );
    for (const row of recoverable) assertClosedFrozenRecord(row, JOURNAL_KEYS);
  });
});
