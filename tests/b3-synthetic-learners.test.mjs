import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadStarterSpellingCatalogue } from '../src/domain/spelling/index.js';
import { seedB2Learners } from '../src/platform/database/b2-seed.js';
import { canonicalJson } from '../src/platform/database/canonical-json.js';
import { configureAndMigrateDatabase } from '../src/platform/database/migrate-database.js';
import { createSQLiteSpellingSnapshotStore } from '../src/platform/database/sqlite-spelling-snapshot-store.js';

import { createNodeSqliteConnection } from './helpers/node-sqlite-connection.mjs';
import { learnerCellDigest } from './helpers/sqlite-v1-fixture.mjs';

const EXPECTED_AUTHORITY = Object.freeze({
  schemaVersion: 1,
  learners: Object.freeze([
    Object.freeze({
      learnerId: 'learner-a',
      nickname: 'Ada',
      beforePurchaseSnapshotSha256:
        'f938d0e0028f1b3de65bdbf7e8a3b0f873c3257de81f2cd5263ed8611af00342',
      afterFreshInstallReseedSnapshotSha256:
        'f938d0e0028f1b3de65bdbf7e8a3b0f873c3257de81f2cd5263ed8611af00342',
    }),
    Object.freeze({
      learnerId: 'learner-b',
      nickname: 'Ben',
      beforePurchaseSnapshotSha256:
        '6a5a50b2df1a0d7bdb4ab7d1f4b7d5a87a6c7a3e58dddf16a65b87e482d114cd',
      afterFreshInstallReseedSnapshotSha256:
        '6a5a50b2df1a0d7bdb4ab7d1f4b7d5a87a6c7a3e58dddf16a65b87e482d114cd',
    }),
  ]),
  v1CellTypeAndBytesSha256:
    'f1c4876c485df887b3184b3a78852c0d0df895f5a5fa1c6b8983e138bdeb5a11',
});

function sha256Canonical(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

async function openFreshSyntheticDatabase(filename) {
  const connection = createNodeSqliteConnection(filename);
  await connection.open();
  await configureAndMigrateDatabase(connection);
  await seedB2Learners(connection);
  const catalogue = loadStarterSpellingCatalogue();
  const store = createSQLiteSpellingSnapshotStore({
    connection,
    cataloguesById: Object.freeze({ [catalogue.catalogueId]: catalogue }),
  });
  return { connection, store };
}

test('B3 live-proof authority is exactly two explicit synthetic learners', async () => {
  const bytes = await readFile(
    new URL('../config/b3-synthetic-learners.json', import.meta.url),
    'utf8',
  );
  const authority = JSON.parse(bytes);

  assert.deepEqual(authority, EXPECTED_AUTHORITY);
  assert.equal(authority.learners.length, 2);
  assert.deepEqual(
    authority.learners.map(({ learnerId, nickname }) => ({ learnerId, nickname })),
    [
      { learnerId: 'learner-a', nickname: 'Ada' },
      { learnerId: 'learner-b', nickname: 'Ben' },
    ],
  );
  assert.equal(new Set(authority.learners.map(({ learnerId }) => learnerId)).size, 2);
  assert.equal(new Set(authority.learners.map(({ nickname }) => nickname)).size, 2);
  for (const learner of authority.learners) {
    assert.match(learner.beforePurchaseSnapshotSha256, /^[a-f0-9]{64}$/);
    assert.equal(
      learner.afterFreshInstallReseedSnapshotSha256,
      learner.beforePurchaseSnapshotSha256,
    );
  }
});

test('fresh install and idempotent reseed reproduce every authorised snapshot and V1 cell byte', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-spelling-b3-synthetic-'));
  try {
    for (const run of ['before-purchase', 'fresh-install-reseed']) {
      const { connection, store } = await openFreshSyntheticDatabase(
        join(directory, `${run}.sqlite`),
      );
      try {
        if (run === 'fresh-install-reseed') await seedB2Learners(connection);
        assert.equal(
          await learnerCellDigest(connection),
          EXPECTED_AUTHORITY.v1CellTypeAndBytesSha256,
        );
        for (const learner of EXPECTED_AUTHORITY.learners) {
          const snapshotDigest = sha256Canonical(await store.read(learner.learnerId));
          assert.equal(
            snapshotDigest,
            run === 'before-purchase'
              ? learner.beforePurchaseSnapshotSha256
              : learner.afterFreshInstallReseedSnapshotSha256,
          );
        }
      } finally {
        await connection.close();
      }
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
