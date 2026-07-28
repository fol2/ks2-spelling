import assert from 'node:assert/strict';
import test from 'node:test';

import { spellingOnly } from '../src/app/practice-feel.js';

test('spellingOnly keeps the letters a spelling can hold and drops the rest', () => {
  assert.equal(spellingOnly('bicycle'), 'bicycle');
  // The keyboard's number page is the one iOS will not let the page hide, so
  // a digit must not survive the trip into an answer.
  assert.equal(spellingOnly('bicy2cle'), 'bicycle');
  assert.equal(spellingOnly('12345'), '');
  // A word that carries an apostrophe or a hyphen keeps it, in either quote.
  assert.equal(spellingOnly("don't"), "don't");
  assert.equal(spellingOnly('don’t'), 'don’t');
  assert.equal(spellingOnly('self-respect'), 'self-respect');
  // Whitespace and punctuation cannot appear in a single-word answer.
  assert.equal(spellingOnly('  bi cycle!  '), 'bicycle');
  // Accented letters are letters: `\p{L}`, not `a-z`.
  assert.equal(spellingOnly('café'), 'café');
  assert.equal(spellingOnly(null), '');
  assert.equal(spellingOnly(42), '');
});
