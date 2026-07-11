import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createInMemorySpellingCommandRepository,
} from '../src/domain/spelling/index.js';
import { canonicalJson } from '../src/platform/database/canonical-json.js';

import {
  createB2ScenarioClock,
  observeRepositorySnapshot,
  runB2Scenario,
} from './fixtures/b2-command-scenarios.mjs';
import {
  createB2DatabaseHarness,
  expectedB2Snapshot,
  logicalSnapshotDigest,
} from './helpers/b2-database-harness.mjs';

test('memory and SQLite adapters produce identical canonical plans and final snapshots', async (t) => {
  const harness = await createB2DatabaseHarness();
  t.after(() => harness.close());
  const memoryClock = createB2ScenarioClock();
  const sqliteClock = createB2ScenarioClock();
  const cataloguesById = harness.cataloguesById;
  const memory = createInMemorySpellingCommandRepository({
    snapshots: [expectedB2Snapshot('learner-a'), expectedB2Snapshot('learner-b')],
    cataloguesById,
    now: memoryClock.now,
  });
  const sqlite = harness.createCommandRepository({ now: sqliteClock.now });

  const memoryPlans = await runB2Scenario({
    repository: memory,
    catalogue: harness.catalogue,
    clock: memoryClock,
  });
  const sqlitePlans = await runB2Scenario({
    repository: sqlite,
    catalogue: harness.catalogue,
    clock: sqliteClock,
  });

  assert.equal(canonicalJson(sqlitePlans), canonicalJson(memoryPlans));
  const memoryFinal = await observeRepositorySnapshot(memory, 'learner-a');
  const sqliteFinal = await harness.store.read('learner-a');
  assert.equal(canonicalJson(sqliteFinal), canonicalJson(memoryFinal));
  assert.equal(logicalSnapshotDigest(sqliteFinal), logicalSnapshotDigest(memoryFinal));
  assert.equal(sqliteFinal.revision, 6);
});
