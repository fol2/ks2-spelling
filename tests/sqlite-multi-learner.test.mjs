import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalJson } from '../src/platform/database/canonical-json.js';

import {
  applyB2Command,
  B2_COMMANDS,
  B2_COMMAND_TIMESTAMPS,
  createB2ScenarioClock,
  randomFrom,
  runB2Scenario,
  unchangedB2Plan,
} from './fixtures/b2-command-scenarios.mjs';
import {
  createB2DatabaseHarness,
  databaseLogicalDigest,
  expectedB2Snapshot,
  logicalSnapshotDigest,
} from './helpers/b2-database-harness.mjs';

const FORBIDDEN_JSON_TOKENS = Object.freeze([
  'parent',
  'parentProgress',
  'monsterRatio',
  'campAnalytics',
  '"Ada"',
  '"Ben"',
  '"Y3"',
  '"Y5"',
  '#2E7D8A',
  '#A7633B',
]);

async function storedJsonBytes(connection) {
  const sources = [
    ['app_metadata', 'value_json'],
    ['spelling_aggregates', 'granted_entitlement_ids_json'],
    ['spelling_subject_states', 'state_json'],
    ['spelling_practice_sessions', 'state_json'],
    ['spelling_events', 'event_json'],
    ['spelling_monster_states', 'state_json'],
    ['spelling_camp_states', 'state_json'],
  ];
  const values = [];
  for (const [table, column] of sources) {
    const rows = await connection.query(
      `SELECT ${column} AS json_bytes FROM ${table} ORDER BY 1`,
    );
    values.push(...rows.map(({ json_bytes }) => json_bytes));
  }
  return values;
}

test('same-learner concurrent commands serialise against freshly committed state', async (t) => {
  const harness = await createB2DatabaseHarness();
  t.after(() => harness.close());
  let releaseFirst;
  const holdFirst = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted;
  const waitForFirst = new Promise((resolve) => {
    firstStarted = resolve;
  });
  let clockIndex = 0;
  const random = randomFrom(42);
  const seen = [];
  const repository = harness.createCommandRepository({
    now: () => B2_COMMAND_TIMESTAMPS[clockIndex++],
  });

  const first = repository.runCommandTransaction('learner-a', async (fresh, context) => {
    seen.push(['first', fresh.revision]);
    firstStarted();
    await holdFirst;
    return applyB2Command(
      fresh,
      B2_COMMANDS[0],
      harness.catalogue,
      context.nowMs,
      random,
    );
  });
  await waitForFirst;
  const second = repository.runCommandTransaction('learner-a', (fresh, context) => {
    seen.push(['second', fresh.revision]);
    return applyB2Command(
      fresh,
      B2_COMMANDS[1],
      harness.catalogue,
      context.nowMs,
      random,
    );
  });
  await Promise.resolve();
  assert.deepEqual(seen, [['first', 0]]);
  releaseFirst();

  const [firstPlan, secondPlan] = await Promise.all([first, second]);
  assert.deepEqual(seen, [['first', 0], ['second', 1]]);
  assert.equal(firstPlan.nextRevision, 1);
  assert.equal(secondPlan.nextRevision, 2);
  assert.equal((await harness.store.read('learner-a')).revision, 2);
});

test('learner A full round cannot mutate learner B or accept learner B plan data', async (t) => {
  const harness = await createB2DatabaseHarness();
  t.after(() => harness.close());
  const beforeB = await harness.store.read('learner-b');
  const beforeBDigest = logicalSnapshotDigest(beforeB);
  const clock = createB2ScenarioClock();
  const repository = harness.createCommandRepository({ now: clock.now });

  await runB2Scenario({
    repository,
    catalogue: harness.catalogue,
    clock,
  });
  assert.equal(
    logicalSnapshotDigest(await harness.store.read('learner-b')),
    beforeBDigest,
  );

  const beforeForeignAttempt = await databaseLogicalDigest(harness.connection);
  await assert.rejects(
    repository.runCommandTransaction('learner-a', (fresh, context) => {
      const foreign = unchangedB2Plan(fresh, context);
      foreign.learnerId = expectedB2Snapshot('learner-b').learnerId;
      return foreign;
    }),
    /learner|ownership/i,
  );
  assert.equal(
    await databaseLogicalDigest(harness.connection),
    beforeForeignAttempt,
  );
  assert.equal(
    logicalSnapshotDigest(await harness.store.read('learner-b')),
    beforeBDigest,
  );
});

test('Starter round stores only spelling-derived Monster state and no Parent or profile sentinels', async (t) => {
  const harness = await createB2DatabaseHarness();
  t.after(() => harness.close());
  const clock = createB2ScenarioClock();
  const repository = harness.createCommandRepository({ now: clock.now });
  await runB2Scenario({
    repository,
    catalogue: harness.catalogue,
    clock,
  });

  const snapshot = await harness.store.read('learner-a');
  assert.equal(snapshot.packId, 'ks2-core');
  assert.equal(snapshot.catalogueId, 'ks2-core:starter');
  assert.deepEqual(snapshot.grantedEntitlementIds, []);
  assert.deepEqual(snapshot.campStateByPackId, {});
  assert.deepEqual(snapshot.monsterStateByRewardTrackId, {
    'spelling-core-inklet': {
      branch: 'b2',
      caught: false,
      derivedStage: 0,
      earnedStageHighWater: 0,
      monsterId: 'inklet',
      packId: 'ks2-core',
      rewardTrackId: 'spelling-core-inklet',
      secureCount: 0,
    },
  });
  assert.equal(snapshot.subjectState.data.progress['ks2-core:answer'].attempts, 1);
  assert.equal(snapshot.subjectState.data.progress['ks2-core:answer'].wrong, 1);

  const schemaRows = await harness.connection.query(
    'SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name',
  );
  const jsonValues = await storedJsonBytes(harness.connection);
  for (const bytes of jsonValues) {
    assert.equal(canonicalJson(JSON.parse(bytes)), bytes);
  }
  const scanned = [
    ...schemaRows.map(({ sql }) => sql),
    ...jsonValues,
  ];
  for (const bytes of scanned) {
    for (const token of FORBIDDEN_JSON_TOKENS) {
      assert.equal(
        bytes.toLowerCase().includes(token.toLowerCase()),
        false,
        `forbidden token ${token} found in ${bytes}`,
      );
    }
  }
});
