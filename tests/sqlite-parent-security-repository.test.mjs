import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createDatabaseCommandGate } from '../src/platform/database/database-command-gate.js';
import { configureAndMigrateDatabase } from '../src/platform/database/migrate-database.js';
import {
  createSQLiteParentSecurityRepository,
} from '../src/platform/database/sqlite-parent-security-repository.js';
import { createNodeSqliteConnection } from './helpers/node-sqlite-connection.mjs';

const RECORD = Object.freeze({
  schemaVersion: 1,
  algorithm: 'PBKDF2-SHA-256',
  iterations: 210_000,
  saltBase64: 'MTIzNDU2Nzg5MDEyMzQ1Ng==',
  verifierBase64: 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=',
  failedAttempts: 0,
  lockedUntil: 0,
  biometricEnabled: false,
  updatedAt: 100,
});

test('Parent security repository round-trips one canonical app-local record', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-parent-security-'));
  const path = join(directory, 'parent.sqlite');
  const connection = createNodeSqliteConnection(path);
  await connection.open();
  await configureAndMigrateDatabase(connection);
  t.after(async () => {
    await connection.close();
    await rm(directory, { force: true, recursive: true });
  });

  const repository = createSQLiteParentSecurityRepository({
    connection,
    gate: createDatabaseCommandGate(),
  });
  assert.deepEqual(Object.keys(repository), ['read', 'write']);
  assert.equal(await repository.read(), null);
  assert.deepEqual(await repository.write(RECORD), RECORD);
  assert.deepEqual(await repository.read(), RECORD);

  const rows = await connection.query(
    'SELECT key, value_json, updated_at FROM app_metadata WHERE key = ?',
    ['parent-security-v1'],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].updated_at, 100);
  assert.equal(rows[0].value_json, JSON.stringify({
    algorithm: 'PBKDF2-SHA-256',
    biometricEnabled: false,
    failedAttempts: 0,
    iterations: 210000,
    lockedUntil: 0,
    saltBase64: 'MTIzNDU2Nzg5MDEyMzQ1Ng==',
    schemaVersion: 1,
    updatedAt: 100,
    verifierBase64: 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=',
  }));
});

test('Parent security repository fails closed on non-canonical or invalid state', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-parent-security-invalid-'));
  const connection = createNodeSqliteConnection(join(directory, 'parent.sqlite'));
  await connection.open();
  await configureAndMigrateDatabase(connection);
  t.after(async () => {
    await connection.close();
    await rm(directory, { force: true, recursive: true });
  });
  const repository = createSQLiteParentSecurityRepository({
    connection,
    gate: createDatabaseCommandGate(),
  });

  await assert.rejects(
    repository.write({ ...RECORD, failedAttempts: 6 }),
    /Parent security|failed attempts/i,
  );
  await connection.execute(
    'INSERT INTO app_metadata (key, value_json, updated_at) VALUES (?, ?, ?)',
    ['parent-security-v1', '{"schemaVersion":1}', 100],
  );
  await assert.rejects(
    repository.read(),
    (error) => error?.code === 'parent_security_row_invalid',
  );
});
