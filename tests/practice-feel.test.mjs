import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { autoAdvanceDelayMs } from '../src/app/practice-feel.js';

test('autoAdvanceDelayMs returns 320 for test and 500 otherwise', () => {
  assert.equal(autoAdvanceDelayMs('test'), 320);
  assert.equal(autoAdvanceDelayMs('smart'), 500);
  assert.equal(autoAdvanceDelayMs('trouble'), 500);
  assert.equal(autoAdvanceDelayMs(undefined), 500);
});

test('PracticeScreen answer input keeps writingsuggestions="false"', async () => {
  const source = await readFile(
    resolve(import.meta.dirname, '../src/app/ProductApp.jsx'),
    'utf8',
  );
  assert.ok(
    source.includes('writingsuggestions="false"'),
    'answer input must keep writingsuggestions="false"',
  );
});
