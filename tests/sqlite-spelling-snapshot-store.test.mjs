import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applySpellingCommand,
  validateSpellingCommandSnapshotV1,
} from '../src/domain/spelling/index.js';
import { canonicalJson } from '../src/platform/database/canonical-json.js';
import { seedB2Learners } from '../src/platform/database/b2-seed.js';
import { createSQLiteSpellingSnapshotStore } from '../src/platform/database/sqlite-spelling-snapshot-store.js';

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

const SMART_ROUND_COMMANDS = Object.freeze([
  SMART_START,
  Object.freeze({
    type: 'submit-answer',
    payload: Object.freeze({ typed: 'wrong' }),
  }),
  Object.freeze({
    type: 'submit-answer',
    payload: Object.freeze({ typed: 'answer' }),
  }),
  Object.freeze({ type: 'continue-session', payload: Object.freeze({}) }),
  Object.freeze({
    type: 'submit-answer',
    payload: Object.freeze({ typed: 'answer' }),
  }),
  Object.freeze({ type: 'continue-session', payload: Object.freeze({}) }),
]);

function applyAt(snapshot, command, catalogue, nowMs) {
  return applySpellingCommand({
    snapshot,
    command,
    contentSnapshot: catalogue,
    now: () => nowMs,
    random: () => 0.25,
  });
}

async function progressCommands(harness, commandCount) {
  let current = await harness.store.read('learner-a');
  for (const [index, command] of SMART_ROUND_COMMANDS.slice(
    0,
    commandCount,
  ).entries()) {
    const nowMs = B2_NOW_MS + index;
    const plan = applyAt(current, command, harness.catalogue, nowMs);
    await persistPlanWithStore({ ...harness, current, plan, nowMs });
    current = snapshotAfterPlan(current, plan);
  }
  return validateSpellingCommandSnapshotV1(current, harness.catalogue);
}

async function progressThreeCommands(harness) {
  return progressCommands(harness, 3);
}

async function progressCompleteRound(harness) {
  return progressCommands(harness, SMART_ROUND_COMMANDS.length);
}

function deriveNextValidEvent(snapshot, catalogue) {
  let current = structuredClone(snapshot);
  let appendedEvents = [];
  for (const [offset, command] of SMART_ROUND_COMMANDS.slice(0, 3).entries()) {
    const plan = applyAt(
      current,
      command,
      catalogue,
      B2_NOW_MS + SMART_ROUND_COMMANDS.length + offset,
    );
    current = snapshotAfterPlan(current, plan);
    appendedEvents = plan.appendedEvents;
  }
  assert.equal(appendedEvents.length, 1);
  return appendedEvents[0];
}

async function readCompleteDatabaseState(connection) {
  const queries = {
    metadata: 'SELECT * FROM app_metadata ORDER BY key',
    profiles: 'SELECT * FROM learner_profiles ORDER BY learner_id',
    aggregates: 'SELECT * FROM spelling_aggregates ORDER BY learner_id',
    subjects: 'SELECT * FROM spelling_subject_states ORDER BY learner_id',
    practice: 'SELECT * FROM spelling_practice_sessions ORDER BY learner_id',
    events: 'SELECT * FROM spelling_events ORDER BY learner_id, sequence_no',
    monsters:
      'SELECT * FROM spelling_monster_states ORDER BY learner_id, reward_track_id',
    camp: 'SELECT * FROM spelling_camp_states ORDER BY learner_id, pack_id',
  };
  return Object.fromEntries(
    await Promise.all(
      Object.entries(queries).map(async ([label, sql]) => [
        label,
        await connection.query(sql),
      ]),
    ),
  );
}

async function readLearnerDatabaseState(connection, learnerId) {
  const tables = [
    'learner_profiles',
    'spelling_aggregates',
    'spelling_subject_states',
    'spelling_practice_sessions',
    'spelling_events',
    'spelling_monster_states',
    'spelling_camp_states',
  ];
  return Object.fromEntries(
    await Promise.all(
      tables.map(async (table) => [
        table,
        await connection.query(
          `SELECT * FROM ${table} WHERE learner_id = ? ORDER BY 1, 2`,
          [learnerId],
        ),
      ]),
    ),
  );
}

function createCasProbeConnection(executeResult) {
  return Object.freeze({
    async open() {},
    async close() {},
    async execute() {
      return executeResult;
    },
    async query() {
      return [];
    },
    async begin() {},
    async commit() {},
    async rollback() {},
    async isTransactionActive() {
      return true;
    },
  });
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

test('revision-zero reseed rejects every initial-state drift and rolls back unchanged', async () => {
  const changedSubject = canonicalJson({
    ui: {},
    data: {
      prefs: { autoSpeak: true },
      progress: {},
      guardianMap: {},
      pattern: { wobblingByRuntimeItemId: {} },
      postMega: null,
      achievements: {},
      persistenceWarning: null,
    },
  });
  const cases = [
    {
      label: 'aggregate timestamp drift',
      mutate: (connection) =>
        connection.execute(
          'UPDATE spelling_aggregates SET updated_at = ? WHERE learner_id = ?',
          [B2_NOW_MS + 1, 'learner-a'],
        ),
    },
    {
      label: 'subject byte drift',
      mutate: (connection) =>
        connection.execute(
          'UPDATE spelling_subject_states SET state_json = ? WHERE learner_id = ?',
          [changedSubject, 'learner-a'],
        ),
    },
    {
      label: 'missing subject row',
      mutate: (connection) =>
        connection.execute(
          'DELETE FROM spelling_subject_states WHERE learner_id = ?',
          ['learner-a'],
        ),
    },
    {
      label: 'missing aggregate row for an existing profile',
      mutate: (connection) =>
        connection.execute(
          'DELETE FROM spelling_aggregates WHERE learner_id = ?',
          ['learner-a'],
        ),
    },
    {
      label: 'extra practice row',
      mutate: (connection) =>
        connection.execute(
          'INSERT INTO spelling_practice_sessions (learner_id, session_id, status, state_json) VALUES (?, ?, ?, ?)',
          ['learner-a', 'seed-drift', 'active', canonicalJson({ id: 'seed-drift' })],
        ),
    },
    {
      label: 'extra event row',
      mutate: (connection) =>
        connection.execute(
          'INSERT INTO spelling_events (learner_id, event_id, sequence_no, created_at, event_json) VALUES (?, ?, ?, ?, ?)',
          ['learner-a', 'seed-drift', 0, 0, canonicalJson({ id: 'seed-drift' })],
        ),
    },
    {
      label: 'extra Monster row',
      mutate: (connection) =>
        connection.execute(
          'INSERT INTO spelling_monster_states (learner_id, reward_track_id, state_json) VALUES (?, ?, ?)',
          [
            'learner-a',
            'seed-drift',
            canonicalJson({ rewardTrackId: 'seed-drift' }),
          ],
        ),
    },
    {
      label: 'extra Camp row',
      mutate: (connection) =>
        connection.execute(
          'INSERT INTO spelling_camp_states (learner_id, pack_id, state_json) VALUES (?, ?, ?)',
          ['learner-a', 'seed-drift', canonicalJson({ packId: 'seed-drift' })],
        ),
    },
    {
      label: 'late profile drift after a tentative metadata insert',
      async mutate(connection) {
        await connection.execute('DELETE FROM app_metadata WHERE key = ?', [
          'b2-seed-v1',
        ]);
        await connection.execute(
          'UPDATE learner_profiles SET nickname = ? WHERE learner_id = ?',
          ['Changed Ben', 'learner-b'],
        );
      },
    },
  ];

  for (const { label, mutate } of cases) {
    const harness = await createB2DatabaseHarness();
    try {
      await mutate(harness.connection);
      const before = await readCompleteDatabaseState(harness.connection);
      await assert.rejects(
        seedB2Learners(harness.connection),
        /seed.*drift/i,
        label,
      );
      assert.deepEqual(
        await readCompleteDatabaseState(harness.connection),
        before,
        `${label} must remain byte-for-byte unchanged`,
      );
      assert.equal(
        await harness.connection.isTransactionActive(),
        false,
        `${label} must leave no active transaction`,
      );
    } finally {
      await harness.close();
    }
  }
});

test('progressed reseed requires a present canonical subject envelope without repairing it', async () => {
  const cases = [
    {
      label: 'missing subject',
      mutate: (connection) =>
        connection.execute(
          'DELETE FROM spelling_subject_states WHERE learner_id = ?',
          ['learner-a'],
        ),
    },
    {
      label: 'non-canonical subject',
      async mutate(connection) {
        const [row] = await connection.query(
          'SELECT state_json FROM spelling_subject_states WHERE learner_id = ?',
          ['learner-a'],
        );
        await connection.execute(
          'UPDATE spelling_subject_states SET state_json = ? WHERE learner_id = ?',
          [`${row.state_json}\n`, 'learner-a'],
        );
      },
    },
    {
      label: 'structurally invalid subject',
      mutate: (connection) =>
        connection.execute(
          'UPDATE spelling_subject_states SET state_json = ? WHERE learner_id = ?',
          [canonicalJson({ data: {}, ui: [] }), 'learner-a'],
        ),
    },
  ];

  for (const { label, mutate } of cases) {
    const harness = await createB2DatabaseHarness();
    try {
      await progressThreeCommands(harness);
      await mutate(harness.connection);
      const before = await readCompleteDatabaseState(harness.connection);
      await assert.rejects(
        seedB2Learners(harness.connection),
        /seed.*drift|subject/i,
        label,
      );
      assert.deepEqual(await readCompleteDatabaseState(harness.connection), before);
      assert.equal(await harness.connection.isTransactionActive(), false);
    } finally {
      await harness.close();
    }
  }
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

test('appendEvents requires an exact stored prefix and prevalidates the complete append', async (t) => {
  const harness = await createB2DatabaseHarness();
  t.after(() => harness.close());
  const current = await progressCompleteRound(harness);
  const nextEvent = deriveNextValidEvent(current, harness.catalogue);

  await harness.connection.begin();
  await harness.store.appendEvents('learner-a', current.eventLog, [nextEvent]);
  assert.deepEqual(
    await harness.connection.query(
      'SELECT sequence_no, event_id FROM spelling_events WHERE learner_id = ? ORDER BY sequence_no',
      ['learner-a'],
    ),
    [
      { sequence_no: 0, event_id: current.eventLog[0].id },
      { sequence_no: 1, event_id: current.eventLog[1].id },
      { sequence_no: 2, event_id: nextEvent.id },
    ],
  );
  await harness.connection.rollback();

  const invalidCases = [
    {
      label: 'reordered prefix',
      existing: current.eventLog.toReversed(),
      appended: [nextEvent],
    },
    {
      label: 'changed prefix bytes',
      existing: [
        { ...current.eventLog[0], createdAt: current.eventLog[0].createdAt + 1 },
        current.eventLog[1],
      ],
      appended: [nextEvent],
    },
    {
      label: 'duplicate prefix',
      existing: [current.eventLog[0], current.eventLog[0]],
      appended: [nextEvent],
    },
    {
      label: 'event ID collision',
      existing: current.eventLog,
      appended: [current.eventLog[0]],
    },
    {
      label: 'foreign event',
      existing: current.eventLog,
      appended: [{ ...nextEvent, learnerId: 'learner-b' }],
    },
    {
      label: 'malformed event',
      existing: current.eventLog,
      appended: [Object.fromEntries(
        Object.entries(nextEvent).filter(([key]) => key !== 'createdAt'),
      )],
    },
    {
      label: 'later invalid event cannot leave an earlier insert',
      existing: current.eventLog,
      appended: [nextEvent, { ...nextEvent, id: `${nextEvent.id}:foreign`, learnerId: 'learner-b' }],
    },
  ];

  for (const { label, existing, appended } of invalidCases) {
    await harness.connection.begin();
    await assert.rejects(
      harness.store.appendEvents('learner-a', existing, appended),
      /event|prefix|collision|learner|canonical/i,
      label,
    );
    assert.deepEqual(
      await harness.connection.query(
        'SELECT sequence_no, event_id FROM spelling_events WHERE learner_id = ? ORDER BY sequence_no',
        ['learner-a'],
      ),
      [
        { sequence_no: 0, event_id: current.eventLog[0].id },
        { sequence_no: 1, event_id: current.eventLog[1].id },
      ],
      `${label} must perform no write`,
    );
    await harness.connection.rollback();
  }

  await harness.connection.begin();
  await harness.connection.execute(
    'UPDATE spelling_events SET sequence_no = 2 WHERE learner_id = ? AND sequence_no = 1',
    ['learner-a'],
  );
  await assert.rejects(
    harness.store.appendEvents('learner-a', current.eventLog, [nextEvent]),
    /event|prefix|sequence|contiguous/i,
  );
  assert.deepEqual(
    await harness.connection.query(
      'SELECT sequence_no FROM spelling_events WHERE learner_id = ? ORDER BY sequence_no',
      ['learner-a'],
    ),
    [{ sequence_no: 0 }, { sequence_no: 2 }],
  );
  await harness.connection.rollback();
});

test('store covers practice, Monster and Camp upsert/delete, CAS and learner isolation', async (t) => {
  const harness = await createB2DatabaseHarness();
  t.after(() => harness.close());
  const learnerBBefore = await readLearnerDatabaseState(
    harness.connection,
    'learner-b',
  );

  let current = await harness.store.read('learner-a');
  for (const [index, command] of SMART_ROUND_COMMANDS.slice(0, 2).entries()) {
    const nowMs = B2_NOW_MS + index;
    const plan = applyAt(current, command, harness.catalogue, nowMs);
    await persistPlanWithStore({ ...harness, current, plan, nowMs });
    current = snapshotAfterPlan(current, plan);
  }
  const [practice] = await harness.connection.query(
    'SELECT session_id, status, state_json FROM spelling_practice_sessions WHERE learner_id = ?',
    ['learner-a'],
  );
  assert.equal(practice.session_id, current.practiceSession.id);
  assert.equal(practice.status, 'active');
  assert.equal(practice.state_json, canonicalJson(current.practiceSession));
  assert.equal(
    (
      await harness.connection.query(
        'SELECT COUNT(*) AS count FROM spelling_monster_states WHERE learner_id = ?',
        ['learner-a'],
      )
    )[0].count,
    1,
  );

  const camp = Object.freeze({
    packId: 'ks2-core',
    campHighWater: 0,
    lastCreditedGuardianDay: null,
    lastCreditedEventId: null,
    acknowledgements: Object.freeze(['store-proof']),
  });
  const initial = expectedB2Snapshot('learner-a');
  await harness.connection.begin();
  await harness.store.writeSubjectState('learner-a', initial.subjectState);
  await harness.store.writePracticeSession('learner-a', null);
  await harness.store.syncMonsters('learner-a', {});
  await harness.store.syncCamp('learner-a', { 'ks2-core': camp });
  assert.equal(
    await harness.store.compareAndSetAggregate(
      'learner-a',
      2,
      { learnerId: 'learner-a', expectedRevision: 2, nextRevision: 3 },
      B2_NOW_MS + 2,
    ),
    1,
  );
  assert.equal(
    await harness.store.compareAndSetAggregate(
      'learner-a',
      2,
      { learnerId: 'learner-a', expectedRevision: 2, nextRevision: 3 },
      B2_NOW_MS + 2,
    ),
    0,
  );
  await harness.connection.commit();

  const populated = await harness.store.read('learner-a');
  assert.equal(populated.revision, 3);
  assert.equal(populated.practiceSession, null);
  assert.deepEqual(populated.monsterStateByRewardTrackId, {});
  assert.deepEqual(populated.campStateByPackId, { 'ks2-core': camp });
  assert.deepEqual(
    await readLearnerDatabaseState(harness.connection, 'learner-b'),
    learnerBBefore,
  );

  await harness.connection.begin();
  await harness.store.syncCamp('learner-a', {});
  await harness.connection.commit();
  assert.deepEqual((await harness.store.read('learner-a')).campStateByPackId, {});
  assert.deepEqual(
    await readLearnerDatabaseState(harness.connection, 'learner-b'),
    learnerBBefore,
  );
});

test('store rejects hostile containers and foreign state without invoking accessors', async (t) => {
  const harness = await createB2DatabaseHarness();
  t.after(() => harness.close());
  await harness.connection.begin();

  let reads = 0;
  const hostileSession = { id: 'hostile', status: 'active' };
  Object.defineProperty(hostileSession, 'learnerId', {
    enumerable: true,
    get() {
      reads += 1;
      throw new Error('session_accessor_invoked');
    },
  });
  await assert.rejects(
    harness.store.writePracticeSession('learner-a', hostileSession),
    /accessor|data propert|canonical/i,
  );
  assert.equal(reads, 0);

  const hostileStates = {};
  Object.defineProperty(hostileStates, 'spelling-core-inklet', {
    enumerable: true,
    get() {
      reads += 1;
      throw new Error('state_accessor_invoked');
    },
  });
  await assert.rejects(
    harness.store.syncMonsters('learner-a', hostileStates),
    /accessor|data propert|canonical/i,
  );
  assert.equal(reads, 0);

  const hostilePlan = { expectedRevision: 0, nextRevision: 1 };
  Object.defineProperty(hostilePlan, 'learnerId', {
    enumerable: true,
    get() {
      reads += 1;
      throw new Error('plan_accessor_invoked');
    },
  });
  await assert.rejects(
    harness.store.compareAndSetAggregate(
      'learner-a',
      0,
      hostilePlan,
      B2_NOW_MS,
    ),
    /accessor|data propert|canonical/i,
  );
  assert.equal(reads, 0);

  const sparse = [];
  sparse.length = 1;
  const decorated = [];
  decorated.extra = true;
  const customPrototype = [];
  Object.setPrototypeOf(customPrototype, Object.create(Array.prototype));
  for (const invalid of [sparse, decorated, customPrototype]) {
    await assert.rejects(
      harness.store.appendEvents('learner-a', invalid, []),
      /array|canonical|standard|dense|prototyp/i,
    );
    await assert.rejects(
      harness.store.appendEvents('learner-a', [], invalid),
      /array|canonical|standard|dense|prototyp/i,
    );
  }

  const hostileEvent = { id: 'hostile-event', createdAt: B2_NOW_MS };
  Object.defineProperty(hostileEvent, 'learnerId', {
    enumerable: true,
    get() {
      reads += 1;
      throw new Error('event_accessor_invoked');
    },
  });
  await assert.rejects(
    harness.store.appendEvents('learner-a', [], [hostileEvent]),
    /accessor|data propert|canonical/i,
  );
  assert.equal(reads, 0);
  const customEvent = Object.assign(Object.create({}), {
    id: 'custom-event',
    learnerId: 'learner-a',
    createdAt: B2_NOW_MS,
  });
  await assert.rejects(
    harness.store.appendEvents('learner-a', [], [customEvent]),
    /canonical|plain|prototyp/i,
  );

  await assert.rejects(
    harness.store.writePracticeSession('learner-a', {
      id: 'foreign',
      learnerId: 'learner-b',
      status: 'active',
    }),
    /another learner/i,
  );
  await assert.rejects(
    harness.store.syncMonsters('learner-a', {
      wrong: { rewardTrackId: 'foreign' },
    }),
    /identity/i,
  );
  await harness.connection.rollback();

  const fresh = await harness.store.read('learner-a');
  fresh.subjectState.data.prefs.autoSpeak = true;
  fresh.grantedEntitlementIds.push('tampered');
  assert.deepEqual(await harness.store.read('learner-a'), expectedB2Snapshot('learner-a'));

  const hostileRegistry = {};
  Object.defineProperty(hostileRegistry, harness.catalogue.catalogueId, {
    enumerable: true,
    get() {
      reads += 1;
      throw new Error('catalogue_accessor_invoked');
    },
  });
  assert.throws(
    () =>
      createSQLiteSpellingSnapshotStore({
        connection: harness.connection,
        cataloguesById: hostileRegistry,
      }),
    /accessor|data propert|canonical/i,
  );
  assert.equal(reads, 0);
});

test('aggregate CAS accepts only exact zero-or-one change evidence and valid revisions', async (t) => {
  const harness = await createB2DatabaseHarness();
  t.after(() => harness.close());
  await harness.connection.begin();
  const invalidPlans = [
    { learnerId: 'learner-b', expectedRevision: 0, nextRevision: 1 },
    { learnerId: 'learner-a', expectedRevision: 1, nextRevision: 2 },
    { learnerId: 'learner-a', expectedRevision: 0, nextRevision: -1 },
    { learnerId: 'learner-a', expectedRevision: 0, nextRevision: 0.5 },
  ];
  for (const plan of invalidPlans) {
    await assert.rejects(
      harness.store.compareAndSetAggregate('learner-a', 0, plan, B2_NOW_MS),
      /plan|revision|learner/i,
    );
  }
  await harness.connection.rollback();

  const invalidResults = [
    { changes: -1 },
    { changes: 2 },
    { changes: 0.5 },
    { changes: '1' },
    {},
    { changes: 1, extra: true },
  ];
  for (const result of invalidResults) {
    const store = createSQLiteSpellingSnapshotStore({
      connection: createCasProbeConnection(result),
      cataloguesById: { [harness.catalogue.catalogueId]: harness.catalogue },
    });
    await assert.rejects(
      store.compareAndSetAggregate(
        'learner-a',
        0,
        { learnerId: 'learner-a', expectedRevision: 0, nextRevision: 1 },
        B2_NOW_MS,
      ),
      /change|result|zero|one/i,
    );
  }

  let reads = 0;
  const hostileResult = {};
  Object.defineProperty(hostileResult, 'changes', {
    enumerable: true,
    get() {
      reads += 1;
      throw new Error('changes_accessor_invoked');
    },
  });
  const hostileStore = createSQLiteSpellingSnapshotStore({
    connection: createCasProbeConnection(hostileResult),
    cataloguesById: { [harness.catalogue.catalogueId]: harness.catalogue },
  });
  await assert.rejects(
    hostileStore.compareAndSetAggregate(
      'learner-a',
      0,
      { learnerId: 'learner-a', expectedRevision: 0, nextRevision: 1 },
      B2_NOW_MS,
    ),
    /accessor|data propert|canonical|result/i,
  );
  assert.equal(reads, 0);
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
