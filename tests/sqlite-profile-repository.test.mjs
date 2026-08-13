import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { validateSpellingProfileRepository } from '../src/domain/spelling/index.js';
import { createDatabaseCommandGate } from '../src/platform/database/database-command-gate.js';
import { configureAndMigrateDatabase } from '../src/platform/database/migrate-database.js';
import { createSQLiteSpellingProfileStore } from '../src/platform/database/sqlite-spelling-profile-store.js';
import { createNodeSqliteConnection } from './helpers/node-sqlite-connection.mjs';

function profile(learnerId, overrides = {}) {
  return {
    learnerId,
    nickname: learnerId === 'learner-a' ? 'Ada' : 'Ben',
    yearGroup: learnerId === 'learner-a' ? 'Y3' : 'Y5',
    goal: 10,
    colour: learnerId === 'learner-a' ? '#2E7D8A' : '#A7633B',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

async function createHarness(t, { now = () => 100 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-spelling-profiles-'));
  const connection = createNodeSqliteConnection(join(directory, 'profiles.sqlite'));
  await connection.open();
  await configureAndMigrateDatabase(connection);
  t.after(async () => {
    await connection.close();
    await rm(directory, { force: true, recursive: true });
  });
  const store = createSQLiteSpellingProfileStore({
    connection,
    gate: createDatabaseCommandGate(),
    now,
  });
  return { connection, store };
}

test('SQLite profile store exposes the frozen async profile contract and selects its first learner', async (t) => {
  const { connection, store } = await createHarness(t);

  assert.deepEqual(Object.keys(store), ['profiles', 'selection', 'administration']);
  assert.equal(validateSpellingProfileRepository(store.profiles), store.profiles);
  assert.deepEqual(Object.keys(store.selection), [
    'readSelectedLearnerId',
    'selectLearner',
  ]);
  assert.deepEqual(Object.keys(store.administration), [
    'resetLearning',
    'alignCatalogueLearning',
  ]);
  assert.deepEqual(await store.profiles.listProfiles(), []);
  assert.equal(await store.selection.readSelectedLearnerId(), null);

  assert.deepEqual(await store.profiles.writeProfile(profile('learner-a')), {
    ...profile('learner-a'),
    createdAt: 100,
    updatedAt: 100,
  });
  assert.equal(await store.selection.readSelectedLearnerId(), 'learner-a');
  assert.deepEqual(
    await connection.query(
      'SELECT learner_id, revision, pack_id, catalogue_id FROM spelling_aggregates',
    ),
    [{
      learner_id: 'learner-a',
      revision: 0,
      pack_id: 'ks2-core',
      catalogue_id: 'ks2-core:starter',
    }],
  );
  assert.deepEqual(
    await connection.query(
      'SELECT learner_id, state_json FROM spelling_subject_states',
    ),
    [{
      learner_id: 'learner-a',
      state_json: '{"data":{"achievements":{},"guardianMap":{},"pattern":{"wobblingByRuntimeItemId":{}},"persistenceWarning":null,"postMega":null,"prefs":{"autoSpeak":false},"progress":{}},"ui":{}}',
    }],
  );
});

test('Full catalogue initialisation and reset remain scoped to the configured product store', async (t) => {
  const { connection } = await createHarness(t);
  const fullStore = createSQLiteSpellingProfileStore({
    connection,
    gate: createDatabaseCommandGate(),
    now: () => 200,
    initialCatalogueId: 'ks2-core:full',
  });

  await fullStore.profiles.writeProfile(profile('learner-a'));
  assert.deepEqual(
    await connection.query(
      'SELECT catalogue_id FROM spelling_aggregates WHERE learner_id = ?',
      ['learner-a'],
    ),
    [{ catalogue_id: 'ks2-core:full' }],
  );

  await connection.execute(
    'UPDATE spelling_aggregates SET catalogue_id = ? WHERE learner_id = ?',
    ['ks2-core:starter', 'learner-a'],
  );
  await fullStore.administration.resetLearning('learner-a');
  assert.deepEqual(
    await connection.query(
      'SELECT catalogue_id FROM spelling_aggregates WHERE learner_id = ?',
      ['learner-a'],
    ),
    [{ catalogue_id: 'ks2-core:full' }],
  );

  assert.throws(
    () => createSQLiteSpellingProfileStore({
      connection,
      gate: createDatabaseCommandGate(),
      now: () => 200,
      initialCatalogueId: 'KS2 core full',
    }),
    /catalogue|canonical/i,
  );
  assert.throws(
    () => createSQLiteSpellingProfileStore({
      connection,
      gate: createDatabaseCommandGate(),
      now: () => 200,
      initialCatalogueId: 'ks2-core:other',
    }),
    /catalogue|supported/i,
  );
});

test('the first alignment on an unmarked device wipes dev-era full-catalogue learning, and later alignments never wipe again', async (t) => {
  let timestamp = 100;
  const { connection, store } = await createHarness(t, { now: () => timestamp });
  await store.profiles.writeProfile(profile('learner-a'));
  await store.profiles.writeProfile(profile('learner-b'));
  // learner-a looks like a dev-era TestFlight install: promoted to the full
  // catalogue, granted full-ks2, with learning state hanging off it.
  await connection.execute(
    'UPDATE spelling_aggregates SET catalogue_id = ?, revision = ?, granted_entitlement_ids_json = ?, updated_at = ? WHERE learner_id = ?',
    ['ks2-core:full', 7, '["full-ks2"]', 321, 'learner-a'],
  );
  await connection.execute(
    'INSERT INTO spelling_practice_sessions (learner_id, session_id, status, state_json) VALUES (?, ?, ?, ?)',
    ['learner-a', 'session-a', 'active', '{"id":"session-a","status":"active"}'],
  );
  await connection.execute(
    'INSERT INTO spelling_events (learner_id, event_id, sequence_no, created_at, event_json) VALUES (?, ?, ?, ?, ?)',
    ['learner-a', 'event-a', 0, 123, '{"event":"wiped"}'],
  );
  await connection.execute(
    'INSERT INTO spelling_monster_states (learner_id, reward_track_id, state_json) VALUES (?, ?, ?)',
    ['learner-a', 'track-a', '{"reward":"wiped"}'],
  );
  await connection.execute(
    'INSERT INTO spelling_camp_states (learner_id, pack_id, state_json) VALUES (?, ?, ?)',
    ['learner-a', 'ks2-core', '{"camp":"wiped"}'],
  );
  const starterBefore = await connection.query(
    'SELECT revision, granted_entitlement_ids_json, updated_at FROM spelling_aggregates WHERE learner_id = ?',
    ['learner-b'],
  );

  timestamp = 400;
  const alignToStarter = () => store.administration.alignCatalogueLearning({
    entitled: false,
    canRepresent: async () => true,
  });
  assert.equal(await alignToStarter(), 'ks2-core:starter');
  assert.equal(await alignToStarter(), 'ks2-core:starter');
  assert.deepEqual(
    await connection.query(
      'SELECT learner_id, revision, catalogue_id, granted_entitlement_ids_json, updated_at FROM spelling_aggregates ORDER BY learner_id',
    ),
    [
      {
        learner_id: 'learner-a',
        revision: 0,
        catalogue_id: 'ks2-core:starter',
        granted_entitlement_ids_json: '[]',
        updated_at: 400,
      },
      {
        learner_id: 'learner-b',
        revision: starterBefore[0].revision,
        catalogue_id: 'ks2-core:starter',
        granted_entitlement_ids_json:
          starterBefore[0].granted_entitlement_ids_json,
        updated_at: starterBefore[0].updated_at,
      },
    ],
  );
  // The cascade wipes every per-learner learning table for the reset learner.
  for (const table of [
    'spelling_practice_sessions',
    'spelling_events',
    'spelling_monster_states',
    'spelling_camp_states',
  ]) {
    assert.deepEqual(
      await connection.query(
        `SELECT learner_id FROM ${table} WHERE learner_id = ?`,
        ['learner-a'],
      ),
      [],
    );
  }
  // Both profiles survive untouched.
  assert.deepEqual(
    (await store.profiles.listProfiles()).map(({ learnerId }) => learnerId),
    ['learner-a', 'learner-b'],
  );

  // The marker is now written, so a full-catalogue aggregate appearing after
  // this point is a purchase, not dev-era residue: it is never wiped, only
  // re-tagged when that is provably lossless.
  timestamp = 500;
  await connection.execute(
    'UPDATE spelling_aggregates SET catalogue_id = ?, revision = ?, granted_entitlement_ids_json = ? WHERE learner_id = ?',
    ['ks2-core:full', 11, '["full-ks2"]', 'learner-a'],
  );
  await connection.execute(
    'UPDATE spelling_aggregates SET catalogue_id = ?, granted_entitlement_ids_json = ? WHERE learner_id = ?',
    ['ks2-core:full', '["full-ks2"]', 'learner-b'],
  );
  assert.equal(await alignToStarter(), 'ks2-core:starter');
  assert.deepEqual(
    await connection.query(
      'SELECT learner_id, revision, catalogue_id, granted_entitlement_ids_json, updated_at FROM spelling_aggregates ORDER BY learner_id',
    ),
    [
      {
        learner_id: 'learner-a',
        revision: 11,
        catalogue_id: 'ks2-core:starter',
        granted_entitlement_ids_json: '[]',
        updated_at: 500,
      },
      {
        learner_id: 'learner-b',
        revision: starterBefore[0].revision,
        catalogue_id: 'ks2-core:starter',
        granted_entitlement_ids_json: '[]',
        updated_at: 500,
      },
    ],
  );
});

test('alignment re-tags the catalogue and its grant together, and refuses the move when a learner cannot be represented', async (t) => {
  let timestamp = 100;
  const { connection, store } = await createHarness(t, { now: () => timestamp });
  await store.profiles.writeProfile(profile('learner-a'));
  await store.profiles.writeProfile(profile('learner-b'));
  await connection.execute(
    'UPDATE spelling_aggregates SET revision = ? WHERE learner_id = ?',
    [7, 'learner-a'],
  );

  timestamp = 200;
  const asked = [];
  assert.equal(
    await store.administration.alignCatalogueLearning({
      entitled: true,
      canRepresent: async (learnerId, catalogueId) => {
        asked.push([learnerId, catalogueId]);
        return true;
      },
    }),
    'ks2-core:full',
  );
  assert.deepEqual(asked, [
    ['learner-a', 'ks2-core:full'],
    ['learner-b', 'ks2-core:full'],
  ]);
  assert.deepEqual(
    await connection.query(
      'SELECT learner_id, revision, catalogue_id, granted_entitlement_ids_json FROM spelling_aggregates ORDER BY learner_id',
    ),
    [
      {
        learner_id: 'learner-a',
        revision: 7,
        catalogue_id: 'ks2-core:full',
        granted_entitlement_ids_json: '["full-ks2"]',
      },
      {
        learner_id: 'learner-b',
        revision: 0,
        catalogue_id: 'ks2-core:full',
        granted_entitlement_ids_json: '["full-ks2"]',
      },
    ],
  );

  // One learner who cannot be shown under Starter holds the whole device on
  // Full: the app composes a single catalogue for every learner on it.
  timestamp = 300;
  assert.equal(
    await store.administration.alignCatalogueLearning({
      entitled: false,
      canRepresent: async (learnerId) => learnerId !== 'learner-b',
    }),
    'ks2-core:full',
  );
  assert.deepEqual(
    await connection.query(
      'SELECT catalogue_id, granted_entitlement_ids_json FROM spelling_aggregates ORDER BY learner_id',
    ),
    [
      { catalogue_id: 'ks2-core:full', granted_entitlement_ids_json: '["full-ks2"]' },
      { catalogue_id: 'ks2-core:full', granted_entitlement_ids_json: '["full-ks2"]' },
    ],
  );

  // Mixed aggregates would leave some learner unable to load under whichever
  // catalogue the app composed, so they are reported rather than guessed at.
  await connection.execute(
    'UPDATE spelling_aggregates SET catalogue_id = ? WHERE learner_id = ?',
    ['ks2-core:starter', 'learner-a'],
  );
  await assert.rejects(
    store.administration.alignCatalogueLearning({
      entitled: false,
      canRepresent: async () => true,
    }),
    { code: 'sqlite_profile_catalogue_not_uniform' },
  );
});

test('alignment refuses a caller that does not state the entitlement or supply a representation check', async (t) => {
  const { store } = await createHarness(t);
  await assert.rejects(
    store.administration.alignCatalogueLearning({ canRepresent: async () => true }),
    /entitled boolean/,
  );
  await assert.rejects(
    store.administration.alignCatalogueLearning({ entitled: true }),
    /canRepresent/,
  );
});

test('alignment preserves learning progress on an entitled device with full-catalogue aggregate and no marker', async (t) => {
  let timestamp = 100;
  const { connection, store } = await createHarness(t, { now: () => timestamp });
  await store.profiles.writeProfile(profile('learner-a'));
  
  // Set up an entitled device (simulating a TestFlight user who purchased)
  // with a full-catalogue aggregate and real learning progress, but no marker yet
  await connection.execute(
    'UPDATE spelling_aggregates SET catalogue_id = ?, revision = ?, granted_entitlement_ids_json = ?, updated_at = ? WHERE learner_id = ?',
    ['ks2-core:full', 5, '["full-ks2"]', 150, 'learner-a'],
  );
  
  // Add real learning progress
  await connection.execute(
    'INSERT INTO spelling_practice_sessions (learner_id, session_id, status, state_json) VALUES (?, ?, ?, ?)',
    ['learner-a', 'session-progress', 'active', '{"progress":"learner_made_real_progress"}'],
  );
  await connection.execute(
    'INSERT INTO spelling_events (learner_id, event_id, sequence_no, created_at, event_json) VALUES (?, ?, ?, ?, ?)',
    ['learner-a', 'event-progress', 0, 123, '{"learned":"words"}'],
  );
  
  // Verify progress exists before alignment
  const sessionsBefore = await connection.query(
    'SELECT COUNT(*) as count FROM spelling_practice_sessions WHERE learner_id = ?',
    ['learner-a'],
  );
  assert.equal(sessionsBefore[0].count, 1);
  
  // Align as entitled (should NOT wipe progress)
  timestamp = 200;
  const result = await store.administration.alignCatalogueLearning({
    entitled: true,
    canRepresent: async () => true,
  });
  
  // Verify catalogue remains full and progress is preserved
  assert.equal(result, 'ks2-core:full');
  const aggregate = await connection.query(
    'SELECT catalogue_id, granted_entitlement_ids_json, revision FROM spelling_aggregates WHERE learner_id = ?',
    ['learner-a'],
  );
  assert.equal(aggregate[0].catalogue_id, 'ks2-core:full');
  assert.equal(aggregate[0].granted_entitlement_ids_json, '["full-ks2"]');
  assert.equal(aggregate[0].revision, 5);
  
  // The critical assertion: learning progress must survive
  const sessionsAfter = await connection.query(
    'SELECT state_json FROM spelling_practice_sessions WHERE learner_id = ?',
    ['learner-a'],
  );
  assert.equal(sessionsAfter.length, 1);
  assert.deepEqual(
    JSON.parse(sessionsAfter[0].state_json),
    { progress: 'learner_made_real_progress' },
  );
  
  const events = await connection.query(
    'SELECT event_json FROM spelling_events WHERE learner_id = ?',
    ['learner-a'],
  );
  assert.equal(events.length, 1);
  assert.deepEqual(
    JSON.parse(events[0].event_json),
    { learned: 'words' },
  );
});

test('resetting learning is atomic, learner-scoped and preserves the profile', async (t) => {
  let timestamp = 100;
  const { connection, store } = await createHarness(t, { now: () => timestamp });
  const ada = await store.profiles.writeProfile(profile('learner-a'));
  timestamp = 200;
  await store.profiles.writeProfile(profile('learner-b'));
  await connection.execute(
    'UPDATE spelling_aggregates SET revision = ? WHERE learner_id = ?',
    [7, 'learner-a'],
  );
  await connection.execute(
    'UPDATE spelling_aggregates SET revision = ? WHERE learner_id = ?',
    [9, 'learner-b'],
  );
  await connection.execute(
    'INSERT INTO spelling_practice_sessions (learner_id, session_id, status, state_json) VALUES (?, ?, ?, ?)',
    ['learner-a', 'session-a', 'active', '{}'],
  );
  await connection.execute(
    'INSERT INTO spelling_events (learner_id, event_id, sequence_no, created_at, event_json) VALUES (?, ?, ?, ?, ?)',
    ['learner-a', 'event-a', 0, 100, '{}'],
  );
  await connection.execute(
    'INSERT INTO spelling_monster_states (learner_id, reward_track_id, state_json) VALUES (?, ?, ?)',
    ['learner-a', 'track-a', '{}'],
  );
  await connection.execute(
    'INSERT INTO spelling_camp_states (learner_id, pack_id, state_json) VALUES (?, ?, ?)',
    ['learner-a', 'ks2-core', '{}'],
  );

  timestamp = 300;
  assert.equal(await store.administration.resetLearning('learner-a'), true);
  assert.deepEqual(await store.profiles.readProfile('learner-a'), ada);
  assert.equal(await store.selection.readSelectedLearnerId(), 'learner-a');
  assert.deepEqual(
    await connection.query(
      'SELECT revision, updated_at FROM spelling_aggregates WHERE learner_id = ?',
      ['learner-a'],
    ),
    [{ revision: 0, updated_at: 300 }],
  );
  assert.deepEqual(
    await connection.query(
      'SELECT revision FROM spelling_aggregates WHERE learner_id = ?',
      ['learner-b'],
    ),
    [{ revision: 9 }],
  );
  for (const table of [
    'spelling_practice_sessions',
    'spelling_events',
    'spelling_monster_states',
    'spelling_camp_states',
  ]) {
    assert.deepEqual(
      await connection.query(
        `SELECT learner_id FROM ${table} WHERE learner_id = ?`,
        ['learner-a'],
      ),
      [],
    );
  }
});

test('profile writes retain creation time and list deterministically without resetting progress', async (t) => {
  let timestamp = 100;
  const { connection, store } = await createHarness(t, { now: () => timestamp });

  await store.profiles.writeProfile(profile('learner-b'));
  timestamp = 200;
  await store.profiles.writeProfile(profile('learner-a'));
  await connection.execute(
    'UPDATE spelling_aggregates SET revision = ? WHERE learner_id = ?',
    [7, 'learner-a'],
  );
  timestamp = 300;
  assert.deepEqual(
    await store.profiles.writeProfile(profile('learner-a', { nickname: 'Ada Two' })),
    {
      ...profile('learner-a', { nickname: 'Ada Two' }),
      createdAt: 200,
      updatedAt: 300,
    },
  );

  assert.deepEqual(
    (await store.profiles.listProfiles()).map(({ learnerId }) => learnerId),
    ['learner-a', 'learner-b'],
  );
  assert.equal((await store.profiles.readProfile('learner-a')).nickname, 'Ada Two');
  assert.deepEqual(
    await connection.query(
      'SELECT revision FROM spelling_aggregates WHERE learner_id = ?',
      ['learner-a'],
    ),
    [{ revision: 7 }],
  );
  assert.equal(await store.selection.selectLearner('learner-a'), 'learner-a');
  assert.equal(await store.selection.readSelectedLearnerId(), 'learner-a');
});

test('removing a selected profile cascades learner data and chooses the first remaining learner', async (t) => {
  let timestamp = 100;
  const { connection, store } = await createHarness(t, { now: () => timestamp });
  await store.profiles.writeProfile(profile('learner-b'));
  timestamp = 200;
  await store.profiles.writeProfile(profile('learner-a'));
  await store.selection.selectLearner('learner-b');

  timestamp = 300;
  assert.equal(await store.profiles.removeProfile('learner-b'), true);
  assert.equal(await store.selection.readSelectedLearnerId(), 'learner-a');
  for (const table of [
    'learner_profiles',
    'spelling_aggregates',
    'spelling_subject_states',
    'spelling_practice_sessions',
    'spelling_events',
    'spelling_monster_states',
    'spelling_camp_states',
  ]) {
    assert.deepEqual(
      await connection.query(
        `SELECT learner_id FROM ${table} WHERE learner_id = ?`,
        ['learner-b'],
      ),
      [],
    );
  }

  timestamp = 400;
  assert.equal(await store.profiles.removeProfile('learner-a'), true);
  assert.equal(await store.selection.readSelectedLearnerId(), null);
  assert.equal(await store.profiles.removeProfile('learner-a'), false);
});

test('invalid inputs fail before clock sampling and failed initialisation rolls back the profile', async (t) => {
  let samples = 0;
  const { connection, store } = await createHarness(t, {
    now() {
      samples += 1;
      return 100;
    },
  });
  await assert.rejects(
    store.profiles.writeProfile(profile('Learner A')),
    /learner|canonical/i,
  );
  assert.equal(samples, 0);

  const originalExecute = connection.execute;
  const failingConnection = Object.freeze({
    ...connection,
    async execute(sql, values) {
      if (sql.startsWith('INSERT INTO spelling_aggregates')) {
        throw new Error('injected_initial_snapshot_failure');
      }
      return originalExecute(sql, values);
    },
  });
  const failing = createSQLiteSpellingProfileStore({
    connection: failingConnection,
    gate: createDatabaseCommandGate(),
    now: () => 200,
  });
  await assert.rejects(
    failing.profiles.writeProfile(profile('learner-a')),
    /injected_initial_snapshot_failure/,
  );
  assert.deepEqual(
    await connection.query(
      'SELECT learner_id FROM learner_profiles WHERE learner_id = ?',
      ['learner-a'],
    ),
    [],
  );
  assert.equal(await connection.isTransactionActive(), false);
});
