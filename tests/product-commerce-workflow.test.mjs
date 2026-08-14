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

test('a download that the device cannot hold fails before the first shard is authorised', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-product-commerce-space-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const connection = createNodeSqliteConnection(join(directory, 'commerce.sqlite'));
  await connection.open();
  await configureAndMigrateDatabase(connection);
  const { findPackAuthority } = await import('../src/domain/packs/pack-registry.js');
  const { resolveCommerceProduct } = await import('../src/domain/commerce/purchase-state.js');
  const packIds = resolveCommerceProduct('full-ks2').packIds;
  const authorisations = [];
  const gateway = {
    ...createB3FakeGateway(),
    async authorisePackDownload(request) {
      authorisations.push(request);
      throw new Error('the aggregate preflight must run first');
    },
  };
  // Room for one shard many times over, but not for fifteen: the per-pack
  // preflight would wave this through and fail hundreds of MiB later.
  const oneShard = findPackAuthority(packIds[0]);
  const workflow = createProductCommerceWorkflow({
    runtime: Object.freeze({ isNativePlatform: true, platform: 'android' }),
    connection,
    commandGate: createDatabaseCommandGate(),
    packRepository: createSqlitePackRepositories(connection),
    packTransfer: {
      ...createB3FakePackTransfer({ inventoryOutcomes: [[], []] }),
      async getFreeBytes() {
        return (oneShard.archiveBytes + oneShard.ceilings.extractedBytes) * 4;
      },
    },
    store: createB3FakeStore(),
    gateway,
    clock: () => 100,
    idFactory: () => 'product-commerce-attempt',
  });
  t.after(async () => {
    await workflow.dispose();
    await connection.close();
  });

  await assert.rejects(workflow.download(), { code: 'DOWNLOAD_STORAGE_INSUFFICIENT' });
  assert.deepEqual(authorisations, []);
});

test('an install reports the shard it is starting, so the Parent card can say so', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-product-commerce-progress-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const connection = createNodeSqliteConnection(join(directory, 'commerce.sqlite'));
  await connection.open();
  await configureAndMigrateDatabase(connection);
  const { resolveCommerceProduct } = await import('../src/domain/commerce/purchase-state.js');
  const shardCount = resolveCommerceProduct('full-ks2').packIds.length;
  const workflow = createProductCommerceWorkflow({
    runtime: Object.freeze({ isNativePlatform: true, platform: 'android' }),
    connection,
    commandGate: createDatabaseCommandGate(),
    packRepository: createSqlitePackRepositories(connection),
    packTransfer: {
      ...createB3FakePackTransfer({ inventoryOutcomes: [[], []] }),
      // Room for the whole product: the aggregate preflight must wave this
      // through so the shard loop is reached at all.
      async getFreeBytes() {
        return Number.MAX_SAFE_INTEGER;
      },
    },
    store: createB3FakeStore(),
    gateway: createB3FakeGateway(),
    clock: () => 100,
    idFactory: () => 'product-commerce-attempt',
  });
  t.after(async () => {
    await workflow.dispose();
    await connection.close();
  });

  // No entitlement row, so the first shard stops on the re-read that guards
  // every iteration — after the loop has announced that it is starting it.
  const progress = [];
  await assert.rejects(
    workflow.download((value) => progress.push(value)),
    { code: 'product_commerce_entitlement_inactive' },
  );
  assert.deepEqual(progress, [{ completedShards: 0, totalShards: shardCount }]);
});
