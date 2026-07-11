import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadStarterSpellingCatalogue,
  validateSpellingCommandSnapshotV1,
} from '../../src/domain/spelling/index.js';
import { configureAndMigrateDatabase } from '../../src/platform/database/migrate-database.js';
import { seedB2Learners } from '../../src/platform/database/b2-seed.js';
import { createDatabaseCommandGate } from '../../src/platform/database/database-command-gate.js';
import { createSQLiteSpellingCommandRepository } from '../../src/platform/database/sqlite-spelling-command-repository.js';
import { createSQLiteSpellingSnapshotStore } from '../../src/platform/database/sqlite-spelling-snapshot-store.js';
import { canonicalJson } from '../../src/platform/database/canonical-json.js';

import { createNodeSqliteConnection } from './node-sqlite-connection.mjs';

export const B2_NOW_MS = 1_768_478_400_000;

export function logicalSnapshotDigest(snapshot) {
  return createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
}

const B2_LOGICAL_TABLES = Object.freeze([
  Object.freeze({ name: 'app_metadata', orderBy: 'key' }),
  Object.freeze({ name: 'learner_profiles', orderBy: 'learner_id' }),
  Object.freeze({ name: 'spelling_aggregates', orderBy: 'learner_id' }),
  Object.freeze({ name: 'spelling_subject_states', orderBy: 'learner_id' }),
  Object.freeze({ name: 'spelling_practice_sessions', orderBy: 'learner_id' }),
  Object.freeze({ name: 'spelling_events', orderBy: 'learner_id, sequence_no' }),
  Object.freeze({
    name: 'spelling_monster_states',
    orderBy: 'learner_id, reward_track_id',
  }),
  Object.freeze({ name: 'spelling_camp_states', orderBy: 'learner_id, pack_id' }),
]);

export async function databaseLogicalState(connection) {
  const schema = await connection.query(
    'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name',
  );
  const userVersion = await connection.query('PRAGMA user_version');
  const tables = {};
  for (const { name, orderBy } of B2_LOGICAL_TABLES) {
    tables[name] = await connection.query(
      `SELECT * FROM ${name} ORDER BY ${orderBy}`,
    );
  }
  return { schema, tables, userVersion };
}

export async function databaseLogicalDigest(connection) {
  return createHash('sha256')
    .update(canonicalJson(await databaseLogicalState(connection)))
    .digest('hex');
}

export function expectedB2Snapshot(learnerId) {
  const catalogue = loadStarterSpellingCatalogue();
  return validateSpellingCommandSnapshotV1(
    {
      schemaVersion: 1,
      learnerId,
      revision: 0,
      packId: 'ks2-core',
      catalogueId: 'ks2-core:starter',
      grantedEntitlementIds: [],
      subjectState: {
        ui: {},
        data: {
          prefs: { autoSpeak: false },
          progress: {},
          guardianMap: {},
          pattern: { wobblingByRuntimeItemId: {} },
          postMega: null,
          achievements: {},
          persistenceWarning: null,
        },
      },
      practiceSession: null,
      eventLog: [],
      monsterStateByRewardTrackId: {},
      campStateByPackId: {},
    },
    catalogue,
  );
}

export async function createB2DatabaseHarness() {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-spelling-b2-'));
  const connection = createNodeSqliteConnection(join(directory, 'b2.sqlite'));
  await connection.open();
  await configureAndMigrateDatabase(connection);
  await seedB2Learners(connection);

  const catalogue = loadStarterSpellingCatalogue();
  const cataloguesById = Object.freeze({ [catalogue.catalogueId]: catalogue });
  const store = createSQLiteSpellingSnapshotStore({ connection, cataloguesById });

  function createCommandRepository(options = {}) {
    return createSQLiteSpellingCommandRepository({
      connection,
      gate: createDatabaseCommandGate(),
      store,
      cataloguesById,
      now: () => B2_NOW_MS,
      ...options,
    });
  }

  return Object.freeze({
    connection,
    catalogue,
    cataloguesById,
    createCommandRepository,
    store,
    async close() {
      await connection.close();
      await rm(directory, { force: true, recursive: true });
    },
  });
}

export function snapshotAfterPlan(current, plan) {
  return {
    ...structuredClone(current),
    revision: plan.nextRevision,
    subjectState: structuredClone(plan.nextSubjectState),
    practiceSession: structuredClone(plan.nextPracticeSession),
    eventLog: structuredClone(plan.nextEventLog),
    monsterStateByRewardTrackId: structuredClone(
      plan.nextMonsterStateByRewardTrackId,
    ),
    campStateByPackId: structuredClone(plan.nextCampStateByPackId),
  };
}

export async function persistPlanWithStore({
  connection,
  store,
  current,
  plan,
  nowMs,
}) {
  await connection.begin();
  try {
    await store.writeSubjectState(current.learnerId, plan.nextSubjectState);
    await store.writePracticeSession(current.learnerId, plan.nextPracticeSession);
    await store.appendEvents(
      current.learnerId,
      current.eventLog,
      plan.appendedEvents,
    );
    await store.syncMonsters(
      current.learnerId,
      plan.nextMonsterStateByRewardTrackId,
    );
    await store.syncCamp(current.learnerId, plan.nextCampStateByPackId);
    const changes = await store.compareAndSetAggregate(
      current.learnerId,
      current.revision,
      plan,
      nowMs,
    );
    if (changes !== 1) throw new Error('test_compare_and_set_failed');
    await connection.commit();
  } catch (error) {
    if (await connection.isTransactionActive()) await connection.rollback();
    throw error;
  }
}
