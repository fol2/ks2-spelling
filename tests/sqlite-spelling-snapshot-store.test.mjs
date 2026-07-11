import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applySpellingCommand,
  validateSpellingCommandSnapshotV1,
} from '../src/domain/spelling/index.js';
import { canonicalJson } from '../src/platform/database/canonical-json.js';
import { seedB2Learners } from '../src/platform/database/b2-seed.js';

import {
  B2_NOW_MS,
  createB2DatabaseHarness,
  expectedB2Snapshot,
  persistPlanWithStore,
  snapshotAfterPlan,
} from './helpers/b2-database-harness.mjs';

const EXPECTED_LEARNERS = Object.freeze([
  Object.freeze({
    learner_id: 'learner-a',
    nickname: 'Ada',
    year_group: 'Y3',
    goal: 10,
    colour: '#2E7D8A',
    created_at: B2_NOW_MS,
    updated_at: B2_NOW_MS,
  }),
  Object.freeze({
    learner_id: 'learner-b',
    nickname: 'Ben',
    year_group: 'Y5',
    goal: 10,
    colour: '#A7633B',
    created_at: B2_NOW_MS,
    updated_at: B2_NOW_MS,
  }),
]);

const SMART_START = Object.freeze({
  type: 'start-session',
  payload: Object.freeze({
    mode: 'smart',
    yearFilter: 'core',
    length: 1,
    practiceOnly: false,
    words: Object.freeze(['ks2-core:answer']),
  }),
});

function applyAt(snapshot, command, catalogue, nowMs) {
  return applySpellingCommand({
    snapshot,
    command,
    contentSnapshot: catalogue,
    now: () => nowMs,
    random: () => 0.25,
  });
}

async function progressThreeCommands(harness) {
  let current = await harness.store.read('learner-a');
  const commands = [
    SMART_START,
    { type: 'submit-answer', payload: { typed: 'wrong' } },
    { type: 'submit-answer', payload: { typed: 'answer' } },
  ];
  for (const [index, command] of commands.entries()) {
    const nowMs = B2_NOW_MS + index;
    const plan = applyAt(current, command, harness.catalogue, nowMs);
    await persistPlanWithStore({ ...harness, current, plan, nowMs });
    current = snapshotAfterPlan(current, plan);
  }
  return validateSpellingCommandSnapshotV1(current, harness.catalogue);
}

test('seed creates exactly two deterministic learner snapshots and is idempotent', async (t) => {
  const harness = await createB2DatabaseHarness();
  t.after(() => harness.close());

  assert.deepEqual(Object.keys(harness.store), [
    'read',
    'writeSubjectState',
    'writePracticeSession',
    'appendEvents',
    'syncMonsters',
    'syncCamp',
    'compareAndSetAggregate',
  ]);
  assert.equal(Object.isFrozen(harness.store), true);

  assert.deepEqual(
    await harness.connection.query(
      'SELECT learner_id, nickname, year_group, goal, colour, created_at, updated_at FROM learner_profiles ORDER BY learner_id',
    ),
    EXPECTED_LEARNERS,
  );
  assert.deepEqual(await harness.store.read('learner-a'), expectedB2Snapshot('learner-a'));
  assert.deepEqual(await harness.store.read('learner-b'), expectedB2Snapshot('learner-b'));

  await seedB2Learners(harness.connection);
  assert.deepEqual(
    await harness.connection.query('SELECT COUNT(*) AS count FROM learner_profiles'),
    [{ count: 2 }],
  );
  assert.deepEqual(await harness.store.read('learner-a'), expectedB2Snapshot('learner-a'));
});

test('seed rejects changed learner bytes and never overwrites the drift', async (t) => {
  const harness = await createB2DatabaseHarness();
  t.after(() => harness.close());
  await harness.connection.execute(
    'UPDATE learner_profiles SET nickname = ? WHERE learner_id = ?',
    ['Changed Ada', 'learner-a'],
  );

  await assert.rejects(seedB2Learners(harness.connection), /seed.*drift|byte/i);
  assert.deepEqual(
    await harness.connection.query(
      'SELECT nickname FROM learner_profiles WHERE learner_id = ?',
      ['learner-a'],
    ),
    [{ nickname: 'Changed Ada' }],
  );
  assert.equal(await harness.connection.isTransactionActive(), false);
});

test('seed rejects aggregate identity drift without weakening mutable relaunch state', async (t) => {
  const harness = await createB2DatabaseHarness();
  t.after(() => harness.close());

  const progressed = await progressThreeCommands(harness);
  const mutableTables = [
    'spelling_aggregates',
    'spelling_subject_states',
    'spelling_practice_sessions',
    'spelling_events',
    'spelling_monster_states',
    'spelling_camp_states',
  ];
  const before = Object.fromEntries(
    await Promise.all(
      mutableTables.map(async (table) => [
        table,
        await harness.connection.query(
          `SELECT * FROM ${table} WHERE learner_id = ? ORDER BY 1, 2`,
          ['learner-a'],
        ),
      ]),
    ),
  );

  await seedB2Learners(harness.connection);
  assert.deepEqual(await harness.store.read('learner-a'), progressed);
  for (const table of mutableTables) {
    assert.deepEqual(
      await harness.connection.query(
        `SELECT * FROM ${table} WHERE learner_id = ? ORDER BY 1, 2`,
        ['learner-a'],
      ),
      before[table],
      `${table} must survive repeated seed byte-for-byte`,
    );
  }

  await harness.connection.execute(
    'UPDATE spelling_aggregates SET catalogue_id = ? WHERE learner_id = ?',
    ['ks2-core:tampered', 'learner-a'],
  );
  await assert.rejects(seedB2Learners(harness.connection), /seed.*drift|identity/i);
  assert.deepEqual(
    await harness.connection.query(
      'SELECT catalogue_id, revision FROM spelling_aggregates WHERE learner_id = ?',
      ['learner-a'],
    ),
    [{ catalogue_id: 'ks2-core:tampered', revision: 3 }],
  );
});

test('snapshot store rejects foreign learners and non-canonical JSON bytes', async (t) => {
  const harness = await createB2DatabaseHarness();
  t.after(() => harness.close());

  await assert.rejects(harness.store.read('learner-missing'), /unknown.*learner/i);

  const [{ state_json: canonical }] = await harness.connection.query(
    'SELECT state_json FROM spelling_subject_states WHERE learner_id = ?',
    ['learner-a'],
  );
  const nonCanonical = `${canonical}\n`;
  assert.notEqual(nonCanonical, canonical);
  await harness.connection.execute(
    'UPDATE spelling_subject_states SET state_json = ? WHERE learner_id = ?',
    [nonCanonical, 'learner-a'],
  );

  await assert.rejects(harness.store.read('learner-a'), /canonical.*JSON|JSON.*canonical/i);
});

test('snapshot store round-trips all populated targets with canonical logical bytes', async (t) => {
  const harness = await createB2DatabaseHarness();
  t.after(() => harness.close());

  const expected = await progressThreeCommands(harness);
  const actual = await harness.store.read('learner-a');

  assert.deepEqual(actual, expected);
  assert.equal(canonicalJson(actual), canonicalJson(expected));
  assert.equal(actual.revision, 3);
  assert.equal(actual.practiceSession?.status, 'active');
  assert.equal(actual.eventLog.length, 1);
  assert.deepEqual(Object.keys(actual.monsterStateByRewardTrackId), [
    'spelling-core-inklet',
  ]);
  assert.deepEqual(actual.campStateByPackId, {});
  assert.deepEqual(await harness.store.read('learner-b'), expectedB2Snapshot('learner-b'));
});

test('snapshot hydration rejects event sequence gaps before A3 validation', async (t) => {
  const harness = await createB2DatabaseHarness();
  t.after(() => harness.close());
  await progressThreeCommands(harness);
  await harness.connection.execute(
    'UPDATE spelling_events SET sequence_no = 1 WHERE learner_id = ?',
    ['learner-a'],
  );

  await assert.rejects(harness.store.read('learner-a'), /contiguous|sequence/i);
});

test('every snapshot write helper requires an active transaction', async (t) => {
  const harness = await createB2DatabaseHarness();
  t.after(() => harness.close());
  const snapshot = expectedB2Snapshot('learner-a');
  const plan = {
    learnerId: 'learner-a',
    expectedRevision: 0,
    nextRevision: 1,
  };
  const writes = [
    () => harness.store.writeSubjectState('learner-a', snapshot.subjectState),
    () => harness.store.writePracticeSession('learner-a', null),
    () => harness.store.appendEvents('learner-a', [], []),
    () => harness.store.syncMonsters('learner-a', {}),
    () => harness.store.syncCamp('learner-a', {}),
    () => harness.store.compareAndSetAggregate('learner-a', 0, plan, B2_NOW_MS),
  ];

  for (const write of writes) {
    await assert.rejects(write(), (error) => {
      assert.equal(error?.code, 'sqlite_transaction_required');
      return true;
    });
  }
});
