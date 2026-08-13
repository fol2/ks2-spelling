import assert from 'node:assert/strict';
import test from 'node:test';

import { createPackReconciler } from '../src/app/pack-reconciler.js';
import { createPurchaseCoordinator } from '../src/app/purchase-coordinator.js';
import {
  assertStoreProductCatalogue,
  findStoreProductByEntitlementId,
  listStoreProducts,
  mapStoreProductToEntitlement,
} from '../src/domain/commerce/commerce-contracts.js';
import {
  deriveTransactionReplayJournalId,
  resolveCommerceProduct,
  resolvePackJobAuthorities,
} from '../src/domain/commerce/purchase-state.js';

// The only pack any approved signing key can verify today. A catalogue may not sell a
// pack outside this set, so every synthetic product below delivers this one.
const SIGNED_PACK_ID = 'b3-sandbox-proof';

function product(overrides = {}) {
  return {
    entitlementId: 'full-ks2',
    type: 'non-consumable',
    appleProductId: 'uk.eugnel.ks2spelling.fullks2',
    googleProductId: 'full_ks2',
    packIds: [SIGNED_PACK_ID],
    ...overrides,
  };
}

const THEMED_PACK = product({
  entitlementId: 'year-3-spelling',
  appleProductId: 'uk.eugnel.ks2spelling.year3',
  googleProductId: 'year_3_spelling',
});

function catalogue(products) {
  return { schemaVersion: 1, products };
}

test('the catalogue validates a list of products, not a single frozen entry', () => {
  const many = catalogue([product(), THEMED_PACK]);
  assert.equal(assertStoreProductCatalogue(many), many);

  const shipped = catalogue([product()]);
  assert.equal(assertStoreProductCatalogue(shipped), shipped);

  assert.throws(() => assertStoreProductCatalogue(catalogue([])), /at least one product/);
});

test('one entitlement may own many packs and packs may be shared between products', () => {
  const shards = catalogue([
    product({ packIds: [SIGNED_PACK_ID, SIGNED_PACK_ID] }),
  ]);
  assert.throws(() => assertStoreProductCatalogue(shards), /repeat a packId/);

  // A bundle and a narrower product legitimately deliver the same shard.
  const overlapping = catalogue([product(), THEMED_PACK]);
  assert.equal(assertStoreProductCatalogue(overlapping), overlapping);

  assert.throws(
    () => assertStoreProductCatalogue(catalogue([product({ packIds: [] })])),
    /at least one pack/,
  );
});

test('type is a closed enum with exactly one implementation behind it', () => {
  for (const type of ['subscription', 'Non-Consumable', '', null, 'non_consumable']) {
    assert.throws(
      () => assertStoreProductCatalogue(catalogue([product({ type })])),
      /unapproved type/,
      `expected ${String(type)} to be outside the closed enum`,
    );
  }

  // Known kinds still fail closed until someone implements them: the enum is the seam,
  // it is not a second code path.
  for (const type of ['consumable', 'auto-renewing-subscription']) {
    assert.throws(
      () => assertStoreProductCatalogue(catalogue([product({ type })])),
      /has no implementation/,
    );
  }
});

test('entitlements and store product ids stay unique across the whole catalogue', () => {
  const collisions = [
    ['entitlementId', 'full-ks2'],
    ['appleProductId', 'uk.eugnel.ks2spelling.fullks2'],
    ['googleProductId', 'full_ks2'],
  ];
  for (const [field, value] of collisions) {
    assert.throws(
      () => assertStoreProductCatalogue(
        catalogue([product(), { ...THEMED_PACK, [field]: value }]),
      ),
      /claim an identity twice/,
      `expected a duplicate ${field} to be rejected`,
    );
  }
});

test('every product identity is validated structurally, not against one literal', () => {
  const rejected = [
    ['entitlementId', 'Full-KS2'],
    ['entitlementId', 'full_ks2'],
    ['entitlementId', ''],
    ['appleProductId', 'placeholder'],
    ['appleProductId', 'uk.eugnel.KS2spelling.fullks2'],
    ['googleProductId', 'full-ks2'],
    ['googleProductId', '3full'],
    ['packIds', ['Not A Pack']],
  ];
  for (const [field, value] of rejected) {
    assert.throws(
      () => assertStoreProductCatalogue(catalogue([product({ [field]: value })])),
      /Store product catalogue/,
      `expected ${field}=${JSON.stringify(value)} to be rejected`,
    );
  }
});

test('a catalogue may not sell a pack no approved signing key can verify', () => {
  assert.throws(
    () => assertStoreProductCatalogue(catalogue([product({ packIds: ['themed-y3-shard'] })])),
    /no approved signing key can verify/,
  );
  assert.throws(
    () => assertStoreProductCatalogue(
      catalogue([product(), { ...THEMED_PACK, packIds: [SIGNED_PACK_ID, 'unsigned-shard'] }]),
    ),
    /no approved signing key can verify/,
  );
});

test('multi-product validation still refuses to invoke accessors', () => {
  let getterCalls = 0;
  const hostile = catalogue([product(), THEMED_PACK]);
  Object.defineProperty(hostile.products[1], 'packIds', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return [SIGNED_PACK_ID];
    },
  });
  assert.throws(() => assertStoreProductCatalogue(hostile), /Store product catalogue/);

  const hostileList = catalogue([product()]);
  Object.defineProperty(hostileList.products, '0', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return product();
    },
  });
  assert.throws(() => assertStoreProductCatalogue(hostileList), /Store product catalogue/);
  assert.equal(getterCalls, 0);
});

test('products are looked up by entitlement and handed back frozen', () => {
  const products = listStoreProducts();
  assert.ok(Object.isFrozen(products));
  assert.equal(products.length, 1);

  const found = findStoreProductByEntitlementId('full-ks2');
  assert.ok(Object.isFrozen(found));
  assert.ok(Object.isFrozen(found.packIds));
  assert.equal(found.entitlementId, 'full-ks2');

  for (const unknown of ['year-3-spelling', '', 'FULL-KS2', null, undefined, 0]) {
    assert.throws(
      () => findStoreProductByEntitlementId(unknown),
      /Store product entitlement/,
      `expected ${String(unknown)} to be unresolvable`,
    );
  }
});

test('store mapping scans the whole catalogue and still fails closed', () => {
  assert.equal(
    mapStoreProductToEntitlement({
      store: 'apple',
      productId: 'uk.eugnel.ks2spelling.fullks2',
    }),
    'full-ks2',
  );
  for (const candidate of [
    { store: 'constructor', productId: 'full_ks2' },
    { store: 'toString', productId: 'full_ks2' },
    { store: 'apple', productId: 'uk.eugnel.ks2spelling.year3' },
  ]) {
    assert.throws(() => mapStoreProductToEntitlement(candidate), /Store product mapping/);
  }
});

test('commerce identities derive from the entitlement rather than a baked-in product', () => {
  const resolved = resolveCommerceProduct('full-ks2');
  assert.deepEqual([...resolved.productIds], [
    'uk.eugnel.ks2spelling.fullks2',
    'full_ks2',
  ]);
  assert.deepEqual([...resolved.packIds], [SIGNED_PACK_ID]);
  assert.throws(() => resolveCommerceProduct('year-3-spelling'), /Store product entitlement/);

  for (const store of ['apple', 'google']) {
    const productId = store === 'apple' ? 'uk.eugnel.ks2spelling.fullks2' : 'full_ks2';
    const entitlementId = mapStoreProductToEntitlement({ store, productId });
    assert.equal(
      deriveTransactionReplayJournalId({ store, productId, outcome: 'purchased' }),
      `purchase-${store}-${entitlementId}-acquisition`,
    );
    assert.equal(
      deriveTransactionReplayJournalId({ store, productId, outcome: 'revoked' }),
      `purchase-${store}-${entitlementId}-revocation`,
    );
  }
});

test('the download path resolves every tracked pack from the registry', () => {
  const authorities = resolvePackJobAuthorities(resolveCommerceProduct('full-ks2'));
  assert.deepEqual([...authorities].map((authority) => ({ ...authority })), [{
    entitlementId: 'full-ks2',
    packId: SIGNED_PACK_ID,
    version: '1.0.0-b3.1',
    jobId: `${SIGNED_PACK_ID}.1.0.0-b3.1`,
  }]);

  // Fail closed: a product with no packs, an unregistered pack, or a registered
  // pack bound to a different entitlement never yields a download authority.
  assert.throws(
    () => resolvePackJobAuthorities({ entitlementId: 'full-ks2', packIds: [] }),
    /at least one tracked pack/,
  );
  assert.throws(
    () => resolvePackJobAuthorities({ entitlementId: 'full-ks2', packIds: ['second-shard'] }),
    /not registered/,
  );
  assert.throws(
    () => resolvePackJobAuthorities({
      entitlementId: 'year-3-spelling',
      packIds: [SIGNED_PACK_ID],
    }),
    /not bound to the product entitlement/,
  );
});

test('coordinators require an entitlement binding and reject an unapproved one', () => {
  const stub = (methods) => Object.fromEntries(
    methods.map((method) => [method, async () => undefined]),
  );
  const ports = {
    store: stub(['purchase', 'queryTransactions', 'restore', 'finishTransaction']),
    gateway: stub([
      'verifyTransaction', 'completeTransaction', 'refreshEntitlement', 'authorisePackDownload',
    ]),
    commerceRepository: stub([
      'observeTransaction', 'markVerified', 'commitEntitlementAndReadyToComplete',
      'markStoreCompleteAndClearProof', 'markRejectedAndClearProof',
      'replaceSealedRefreshHandle', 'applyRevocationAndDeleteHandle',
      'listRecoverableTransactions', 'listEntitlements',
    ]),
    attemptRepository: stub(['preparePendingAttempt', 'discardPendingAttempt']),
    downloadRepository: stub(['listDownloadJobs', 'upsertDownloadJob']),
    clock: () => 0,
    idFactory: () => 'x',
    failureInjector: async () => undefined,
  };
  assert.throws(
    () => createPurchaseCoordinator({ ...ports }),
    /Purchase coordinator dependencies are invalid/,
  );
  assert.throws(
    () => createPurchaseCoordinator({ entitlementId: 'year-3-spelling', ...ports }),
    /Store product entitlement/,
  );

  const reconcilerPorts = {
    packTransfer: {
      inventoryInstalledVersions: async () => [],
      removeOwnedTemporaryState: async () => undefined,
    },
    packRepository: {
      getActiveVersion: async () => null,
      listDownloadJobs: async () => [],
      listInstalledVersions: async () => [],
      registerAndFlipActiveVersion: async () => null,
      retireInstalledVersion: async () => undefined,
      updateDownloadJob: async () => null,
    },
    activeEntitlementProjection: async () => null,
    clock: () => 0,
  };
  assert.throws(
    () => createPackReconciler({ ...reconcilerPorts }),
    /Pack reconciler dependencies are invalid/,
  );
  assert.throws(
    () => createPackReconciler({ entitlementId: 'year-3-spelling', ...reconcilerPorts }),
    /Store product entitlement/,
  );
});
