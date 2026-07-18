import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertStoreProductCatalogue,
  mapStoreProductToEntitlement,
} from '../src/domain/commerce/commerce-contracts.js';

const STORE_PRODUCTS_URL = new URL('../config/store-products.json', import.meta.url);

async function readCatalogue() {
  return JSON.parse(await readFile(STORE_PRODUCTS_URL, 'utf8'));
}

function clone(value) {
  return structuredClone(value);
}

test('the catalogue freezes one non-consumable product and exact store mapping', async () => {
  const catalogue = await readCatalogue();

  assert.equal(assertStoreProductCatalogue(catalogue), catalogue);
  assert.deepEqual(catalogue, {
    schemaVersion: 1,
    products: [
      {
        entitlementId: 'full-ks2',
        type: 'non-consumable',
        appleProductId: 'uk.eugnel.ks2spelling.fullks2',
        googleProductId: 'full_ks2',
        packIds: ['b3-sandbox-proof'],
      },
    ],
  });
  assert.equal(
    mapStoreProductToEntitlement({
      store: 'apple',
      productId: 'uk.eugnel.ks2spelling.fullks2',
    }),
    'full-ks2',
  );
  assert.equal(
    mapStoreProductToEntitlement({ store: 'google', productId: 'full_ks2' }),
    'full-ks2',
  );
});

test('the catalogue rejects aliases, duplicates and unknown fields', async () => {
  const valid = await readCatalogue();
  const mutations = [
    (value) => { value.aliases = {}; },
    (value) => { value.products.push(clone(value.products[0])); },
    (value) => { value.products[0].alias = 'full'; },
    (value) => { value.products[0].type = 'consumable'; },
    (value) => { value.products[0].packIds.push('extra-pack'); },
    (value) => { value.products[0].appleProductId = 'placeholder'; },
    (value) => { value.products[0].googleProductId = 'full-ks2'; },
  ];

  for (const mutate of mutations) {
    const candidate = clone(valid);
    mutate(candidate);
    assert.throws(() => assertStoreProductCatalogue(candidate), /catalogue/i);
  }
});

test('mapping fails closed for unknown stores, products and client overrides', () => {
  for (const candidate of [
    { store: 'microsoft', productId: 'full_ks2' },
    { store: 'apple', productId: 'full_ks2' },
    { store: 'google', productId: 'uk.eugnel.ks2spelling.fullks2' },
    { store: 'google', productId: 'unknown' },
    { store: 'google', productId: 'FULL_KS2' },
    { store: 'google', productId: 'full_ks2', entitlementId: 'full-ks2' },
    { store: 'google', productId: 'full_ks2', alias: 'full' },
  ]) {
    assert.throws(() => mapStoreProductToEntitlement(candidate), /store product/i);
  }
});

test('catalogue and mapping reject accessors without invoking them', async () => {
  const catalogue = await readCatalogue();
  let getterCalls = 0;
  Object.defineProperty(catalogue.products[0], 'type', {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error('getter must not run');
    },
  });
  assert.throws(() => assertStoreProductCatalogue(catalogue), /catalogue/i);

  const request = { store: 'google', productId: 'full_ks2' };
  Object.defineProperty(request, 'productId', {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error('getter must not run');
    },
  });
  assert.throws(() => mapStoreProductToEntitlement(request), /store product/i);
  assert.equal(getterCalls, 0);
});
