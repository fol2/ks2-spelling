import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadFullSpellingCatalogue,
  loadStarterSpellingCatalogue,
  validateCatalogueV1,
} from '../src/domain/spelling/index.js';

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

test('frozen catalogues reuse the validated identity across nested calls', () => {
  const full = loadFullSpellingCatalogue();
  const first = validateCatalogueV1(full);
  const second = validateCatalogueV1(full);
  const nested = validateCatalogueV1(first);

  assert.equal(second, first);
  assert.equal(nested, first);
  assert.equal(first.catalogueId, 'ks2-core:full');
  assert.equal(first.items.length, 213);

  const starter = loadStarterSpellingCatalogue();
  const starterFirst = validateCatalogueV1(starter);
  assert.equal(validateCatalogueV1(starter), starterFirst);
  assert.equal(validateCatalogueV1(starterFirst), starterFirst);
  assert.equal(starterFirst.catalogueId, 'ks2-core:starter');
});

test('a mutated unfrozen draft still fails catalogue validation', () => {
  const draft = structuredClone(loadStarterSpellingCatalogue());
  validateCatalogueV1(draft);
  draft.schemaVersion = 2;
  assert.throws(() => validateCatalogueV1(draft), /schema version/i);
});

test('a shallow-frozen catalogue with a mutable nest is not served from cache', () => {
  const draft = structuredClone(loadStarterSpellingCatalogue());
  Object.freeze(draft);
  assert.equal(Object.isFrozen(draft), true);
  assert.equal(Object.isFrozen(draft.items), false);

  const first = validateCatalogueV1(draft);
  assert.notEqual(first, draft);
  assert.equal(first.items[0].packId, draft.items[0].packId);

  draft.items[0].packId = 'not-the-pack';
  assert.throws(
    () => validateCatalogueV1(draft),
    /pack namespace/i,
  );
});

test('a frozen catalogue with a getter-backed nest is not served from cache', () => {
  const draft = structuredClone(loadStarterSpellingCatalogue());
  const item = draft.items[0];
  let packId = item.packId;
  assert.equal(packId, 'ks2-core');
  delete item.packId;
  Object.defineProperty(item, 'packId', {
    configurable: true,
    enumerable: true,
    get() {
      return packId;
    },
  });
  freezeDeep(draft);
  assert.equal(Object.isFrozen(draft), true);
  assert.equal(Object.isFrozen(draft.items), true);
  assert.equal(Object.isFrozen(item), true);
  assert.equal(typeof Object.getOwnPropertyDescriptor(item, 'packId').get, 'function');

  const first = validateCatalogueV1(draft);
  assert.notEqual(first, draft);
  assert.equal(first.items[0].packId, 'ks2-core');

  packId = 'not-the-pack';
  assert.equal(draft.items[0].packId, 'not-the-pack');
  assert.throws(() => validateCatalogueV1(draft), /pack namespace/i);
  assert.equal(first.items[0].packId, 'ks2-core');
});
