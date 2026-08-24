import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const FULL_CATALOGUE_URL = new URL(
  '../vendor/ks2-mastery/content/spelling.mobile-runtime-full.json',
  import.meta.url,
);

test('Full catalogue uses the approved famous sentence correction', async () => {
  const bytes = await readFile(FULL_CATALOGUE_URL, 'utf8');
  const catalogue = JSON.parse(bytes);
  const famous = catalogue.items.find(({ itemId }) => itemId === 'famous');

  assert.ok(famous);
  assert.equal(
    famous.sentencePrompts.find(({ sentenceId }) => sentenceId === 'sentence-6')?.text,
    'The castle is famous among visitors from many countries.',
  );
  assert.doesNotMatch(
    bytes,
    /The castle is famous with visitors from many countries\./,
  );
});
