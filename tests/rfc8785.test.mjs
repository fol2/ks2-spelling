import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  canonicaliseRfc8785,
  canonicaliseRfc8785Bytes,
} from '../src/domain/packs/rfc8785.js';

const vectors = JSON.parse(
  await readFile(new URL('./fixtures/rfc8785-vectors.json', import.meta.url), 'utf8'),
);

for (const vector of vectors) {
  test(`RFC 8785 canonicalises ${vector.name}`, () => {
    assert.equal(canonicaliseRfc8785(vector.value), vector.canonical);
    assert.deepEqual(
      canonicaliseRfc8785Bytes(vector.value),
      new TextEncoder().encode(vector.canonical),
    );
  });
}

test('RFC 8785 uses ECMAScript number serialisation at format boundaries', () => {
  assert.equal(
    canonicaliseRfc8785([-0, 1e-7, 1e-6, 1e20, 1e21]),
    '[0,1e-7,0.000001,100000000000000000000,1e+21]',
  );
});

test('RFC 8785 preserves Unicode without normalisation', () => {
  const composed = '\u00e9';
  const decomposed = 'e\u0301';

  assert.equal(canonicaliseRfc8785({ [decomposed]: decomposed, [composed]: composed }),
    '{"é":"é","é":"é"}');
});

test('RFC 8785 rejects unsupported JSON data and invalid Unicode', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const hostile = {};
  let getterReads = 0;
  Object.defineProperty(hostile, 'value', {
    enumerable: true,
    get() {
      getterReads += 1;
      return 'not safe';
    },
  });
  const sparse = Array(2);
  sparse[1] = 'sparse';

  for (const value of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    undefined,
    1n,
    new Date(0),
    cyclic,
    { value: '\ud800' },
    { '\udfff': 'value' },
    hostile,
    sparse,
  ]) {
    assert.throws(() => canonicaliseRfc8785(value), /RFC 8785/i);
  }
  assert.equal(getterReads, 0);
});
