import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { configureAndMigrateDatabase } from '../src/platform/database/migrate-database.js';
import { createSqliteCommerceAttemptRepository } from '../src/platform/database/sqlite-commerce-attempt-repository.js';
import { createSqliteCommerceRepositories } from '../src/platform/database/sqlite-commerce-repositories.js';

import { createNodeSqliteConnection } from './helpers/node-sqlite-connection.mjs';

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

async function withDatabase(run) {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-spelling-attempt-'));
  const connection = createNodeSqliteConnection(join(directory, 'commerce.sqlite'));
  await connection.open();
  try {
    await configureAndMigrateDatabase(connection);
    await run(connection);
  } finally {
    await connection.close();
    await rm(directory, { force: true, recursive: true });
  }
}

function assertJournal(value, expected) {
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal(Object.isFrozen(value), true);
  assert.deepEqual(Reflect.ownKeys(value), JOURNAL_KEYS);
  assert.deepEqual(value, expected);
}

test('commerce attempt repository has an exact two-method async surface and fixed platform authority', async () => {
  await withDatabase(async (connection) => {
    const repository = createSqliteCommerceAttemptRepository(connection, { store: 'google' });
    assert.equal(Object.getPrototypeOf(repository), Object.prototype);
    assert.equal(Object.isFrozen(repository), true);
    assert.deepEqual(Reflect.ownKeys(repository), [
      'preparePendingAttempt',
      'discardPendingAttempt',
    ]);
    for (const method of Reflect.ownKeys(repository)) {
      assert.equal(Object.getPrototypeOf(repository[method]), Object.getPrototypeOf(async function () {}));
    }
    assert.throws(
      () => createSqliteCommerceAttemptRepository(connection, { store: 'apple', productId: 'full_ks2' }),
      TypeError,
    );
    assert.throws(
      () => createSqliteCommerceAttemptRepository(connection, { store: 'unknown' }),
      TypeError,
    );
  });
});

test('prepare and discard use one proof-free platform-mapped pending row', async () => {
  await withDatabase(async (connection) => {
    const repository = createSqliteCommerceAttemptRepository(connection, { store: 'google' });
    const prepared = await repository.preparePendingAttempt({
      journalId: 'explicit-attempt-one',
      observedAt: 1_768_478_400_000,
    });
    assertJournal(prepared, {
      journalId: 'purchase-google-full-ks2-acquisition',
      store: 'google',
      productId: 'full_ks2',
      storeTransactionId: null,
      observationState: 'pending',
      processingState: 'observed',
      opaqueProof: null,
      createdAt: 1_768_478_400_000,
      updatedAt: 1_768_478_400_000,
    });
    assert.equal(JSON.stringify(prepared).match(/learner|child|monster|session|progress/gi), null);
    assert.deepEqual(
      await repository.discardPendingAttempt({ journalId: 'explicit-attempt-one' }),
      Object.freeze({ discarded: false }),
    );
    assert.deepEqual(
      await repository.discardPendingAttempt({
        journalId: 'purchase-google-full-ks2-acquisition',
      }),
      Object.freeze({ discarded: true }),
    );
    assert.deepEqual(
      await connection.query('SELECT * FROM transaction_journal'),
      [],
    );
  });
});

test('attempt input is closed and foreign or progressed rows cannot be reused or discarded', async () => {
  await withDatabase(async (connection) => {
    const attempts = createSqliteCommerceAttemptRepository(connection, { store: 'google' });
    const commerce = createSqliteCommerceRepositories(connection);
    await commerce.observeTransaction({
      journalId: 'foreign-attempt',
      store: 'apple',
      productId: 'uk.eugnel.ks2spelling.fullks2',
      observationState: 'pending',
      opaqueProof: null,
      observedAt: 1_768_478_400_000,
    });
    await commerce.observeTransaction({
      journalId: 'progressed-attempt',
      store: 'google',
      productId: 'full_ks2',
      observationState: 'purchased',
      opaqueProof: 'proof-must-survive',
      observedAt: 1_768_478_400_001,
    });
    for (const journalId of ['foreign-attempt', 'progressed-attempt']) {
      await assert.rejects(
        attempts.preparePendingAttempt({ journalId, observedAt: 1_768_478_400_002 }),
        { code: 'sqlite_commerce_attempt_conflict' },
      );
      await assert.rejects(
        attempts.discardPendingAttempt({ journalId }),
        { code: 'sqlite_commerce_attempt_conflict' },
      );
    }
    await assert.rejects(
      attempts.preparePendingAttempt({
        journalId: 'unknown-field',
        observedAt: 1_768_478_400_003,
        learnerId: 'forbidden',
      }),
      TypeError,
    );
    await assert.rejects(
      attempts.discardPendingAttempt(Object.create({ journalId: 'foreign-attempt' })),
      TypeError,
    );
    assert.deepEqual(
      await connection.query(
        'SELECT journal_id, opaque_proof FROM transaction_journal ORDER BY journal_id',
      ),
      [
        { journal_id: 'foreign-attempt', opaque_proof: null },
        { journal_id: 'progressed-attempt', opaque_proof: 'proof-must-survive' },
      ],
    );
  });
});

test('concurrent prepare and discard operations serialise without duplicate or foreign deletion', async () => {
  await withDatabase(async (connection) => {
    const attempts = createSqliteCommerceAttemptRepository(connection, { store: 'google' });
    const [first, second] = await Promise.all([
      attempts.preparePendingAttempt({ journalId: 'concurrent-attempt', observedAt: 10_000 }),
      attempts.preparePendingAttempt({ journalId: 'concurrent-attempt', observedAt: 10_000 }),
    ]);
    assert.deepEqual(first, second);
    assert.equal(
      (await connection.query(
        'SELECT COUNT(*) AS count FROM transaction_journal WHERE journal_id = ?',
        [first.journalId],
      ))[0].count,
      1,
    );
    const discarded = await Promise.all([
      attempts.discardPendingAttempt({ journalId: first.journalId }),
      attempts.discardPendingAttempt({ journalId: first.journalId }),
    ]);
    assert.deepEqual(
      discarded.map((value) => value.discarded).sort(),
      [false, true],
    );
  });
});
