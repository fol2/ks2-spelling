import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadStarterSpellingCatalogue } from '../src/domain/spelling/index.js';
import { createDatabaseCommandGate } from '../src/platform/database/database-command-gate.js';
import { configureAndMigrateDatabase } from '../src/platform/database/migrate-database.js';
import {
  createSQLiteLearningBackupRepository,
} from '../src/platform/database/sqlite-learning-backup-repository.js';
import {
  createSQLiteSpellingProfileStore,
} from '../src/platform/database/sqlite-spelling-profile-store.js';
import {
  createSQLiteSpellingSnapshotStore,
} from '../src/platform/database/sqlite-spelling-snapshot-store.js';
import { createNodeSqliteConnection } from './helpers/node-sqlite-connection.mjs';

const catalogue = loadStarterSpellingCatalogue();
const cataloguesById = Object.freeze({
  [catalogue.catalogueId]: catalogue,
});

function draft(learnerId, nickname) {
  return {
    learnerId,
    nickname,
    yearGroup: learnerId === 'learner-a' ? 'Y3' : 'Y5',
    goal: 10,
    colour: learnerId === 'learner-a' ? '#2E7D8A' : '#A7633B',
    createdAt: 0,
    updatedAt: 0,
  };
}

test('learning backup replaces learner state atomically and preserves app-wide authority', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-learning-backup-'));
  const connection = createNodeSqliteConnection(join(directory, 'backup.sqlite'));
  await connection.open();
  await configureAndMigrateDatabase(connection);
  t.after(async () => {
    await connection.close();
    await rm(directory, { force: true, recursive: true });
  });
  let timestamp = 100;
  const gate = createDatabaseCommandGate();
  const profiles = createSQLiteSpellingProfileStore({
    connection,
    gate,
    now: () => timestamp,
  });
  const snapshots = createSQLiteSpellingSnapshotStore({
    connection,
    cataloguesById,
  });
  const backups = createSQLiteLearningBackupRepository({
    connection,
    gate,
    cataloguesById,
    now: () => timestamp,
  });

  await profiles.profiles.writeProfile(draft('learner-a', 'Ada'));
  timestamp = 200;
  await profiles.profiles.writeProfile(draft('learner-b', 'Ben'));
  await profiles.selection.selectLearner('learner-b');
  await connection.execute(
    'INSERT INTO app_metadata (key, value_json, updated_at) VALUES (?, ?, ?)',
    ['parent-security-v1', '{"sentinel":true}', 200],
  );
  await connection.execute(
    'INSERT INTO app_entitlements (entitlement_id, store, product_id, state, sealed_refresh_handle, refresh_handle_version, verified_at, refreshed_at, revocation_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ['full-ks2', 'apple', 'product', 'active', null, null, 200, 200, null],
  );
  const backupBytes = await backups.exportBackup();

  timestamp = 300;
  await profiles.profiles.removeProfile('learner-a');
  await profiles.profiles.writeProfile(draft('learner-b', 'Changed'));
  const result = await backups.importBackup(backupBytes);

  assert.deepEqual(result, {
    learnerCount: 2,
    selectedLearnerId: 'learner-b',
  });
  assert.deepEqual(
    (await profiles.profiles.listProfiles()).map(({ nickname }) => nickname),
    ['Ada', 'Ben'],
  );
  assert.equal(await profiles.selection.readSelectedLearnerId(), 'learner-b');
  assert.equal((await snapshots.read('learner-a')).revision, 0);
  assert.deepEqual(
    await connection.query(
      'SELECT value_json FROM app_metadata WHERE key = ?',
      ['parent-security-v1'],
    ),
    [{ value_json: '{"sentinel":true}' }],
  );
  assert.deepEqual(
    await connection.query(
      'SELECT entitlement_id, state FROM app_entitlements',
    ),
    [{ entitlement_id: 'full-ks2', state: 'active' }],
  );

  assert.throws(() => backups.importBackup(`${backupBytes}\n`), /backup/i);
  assert.deepEqual(
    (await profiles.profiles.listProfiles()).map(({ nickname }) => nickname),
    ['Ada', 'Ben'],
  );

  timestamp = 400;
  await profiles.profiles.writeProfile(draft('learner-b', 'Changed'));
  const originalExecute = connection.execute;
  const failingConnection = Object.freeze({
    ...connection,
    async execute(sql, values) {
      if (
        sql.startsWith('INSERT INTO spelling_subject_states') &&
        values[0] === 'learner-b'
      ) {
        throw new Error('injected_backup_import_failure');
      }
      return originalExecute(sql, values);
    },
  });
  const failingImport = createSQLiteLearningBackupRepository({
    connection: failingConnection,
    gate,
    cataloguesById,
    now: () => timestamp,
  });
  await assert.rejects(
    failingImport.importBackup(backupBytes),
    /injected_backup_import_failure/,
  );
  assert.deepEqual(
    (await profiles.profiles.listProfiles()).map(({ nickname }) => nickname),
    ['Ada', 'Changed'],
  );
  assert.equal(await connection.isTransactionActive(), false);
});
