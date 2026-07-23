import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createProductCommerceWorkflow,
} from '../src/app/create-product-commerce-workflow.js';
import { createB3FakeGateway } from '../src/platform/fakes/create-b3-fake-gateway.js';
import {
  createB3FakePackTransfer,
} from '../src/platform/fakes/create-b3-fake-pack-transfer.js';
import { createB3FakeStore } from '../src/platform/fakes/create-b3-fake-store.js';
import { createDatabaseCommandGate } from '../src/platform/database/database-command-gate.js';
import {
  configureAndMigrateDatabase,
} from '../src/platform/database/migrate-database.js';
import {
  createSqlitePackRepositories,
} from '../src/platform/database/sqlite-pack-repositories.js';
import { createNodeSqliteConnection } from './helpers/node-sqlite-connection.mjs';

test('product commerce composes the existing durable engines behind one Parent snapshot', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-product-commerce-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const connection = createNodeSqliteConnection(join(directory, 'commerce.sqlite'));
  await connection.open();
  await configureAndMigrateDatabase(connection);
  const workflow = createProductCommerceWorkflow({
    runtime: Object.freeze({
      isNativePlatform: true,
      platform: 'android',
    }),
    connection,
    commandGate: createDatabaseCommandGate(),
    packRepository: createSqlitePackRepositories(connection),
    packTransfer: createB3FakePackTransfer({
      inventoryOutcomes: [[], []],
    }),
    store: createB3FakeStore(),
    gateway: createB3FakeGateway(),
    clock: () => 100,
    idFactory: () => 'product-commerce-attempt',
  });
  t.after(async () => {
    await workflow.dispose();
    await connection.close();
  });

  assert.deepEqual(await workflow.start(), {
    displayPrice: '£4.99',
    entitlementState: 'none',
    packState: 'missing',
    syncFailed: false,
  });
});
