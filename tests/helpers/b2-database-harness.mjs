import {
  loadStarterSpellingCatalogue,
  validateSpellingCommandSnapshotV1,
} from '../../src/domain/spelling/index.js';
import { configureAndMigrateDatabase } from '../../src/platform/database/migrate-database.js';
import { seedB2Learners } from '../../src/platform/database/b2-seed.js';
import { createSQLiteSpellingSnapshotStore } from '../../src/platform/database/sqlite-spelling-snapshot-store.js';

import { createNodeSqliteConnection } from './node-sqlite-connection.mjs';

export const B2_NOW_MS = 1_768_478_400_000;

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

  return Object.freeze({
    connection,
    catalogue,
    cataloguesById,
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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
