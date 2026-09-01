import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadFullSpellingCatalogue,
  loadStarterSpellingCatalogue,
  validateCatalogueV1,
} from '../src/domain/spelling/index.js';

test('frozen catalogues reuse the validated identity across nested calls', () => {
  const full = loadFullSpellingCatalogue();
  const first = validateCatalogueV1(full);
  const second = validateCatalogueV1(full);
  const nested = validateCatalogueV1(first);

  assert.equal(second, first);
  assert.equal(nested, first);
  assert.equal(first.catalogueId, 'ks2-core:full');
  assert.equal(first.items.length, 213);
});

test('a mutated unfrozen draft still fails catalogue validation', () => {
  const draft = structuredClone(loadStarterSpellingCatalogue());
  validateCatalogueV1(draft);
  draft.schemaVersion = 2;
  assert.throws(() => validateCatalogueV1(draft), /schema version/i);
});
