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

  assert.deepEqual(Object.keys(store), ['profiles', 'selection']);
  assert.equal(validateSpellingProfileRepository(store.profiles), store.profiles);
  assert.deepEqual(Object.keys(store.selection), [
    'readSelectedLearnerId',
    'selectLearner',
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
