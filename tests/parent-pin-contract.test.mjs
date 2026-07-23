import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createParentPinCrypto,
  validateParentPin,
} from '../src/domain/security/parent-pin-contract.js';

test('Parent PIN crypto derives a salted verifier and compares it without storing the PIN', async () => {
  const salt = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
  const pinCrypto = createParentPinCrypto({
    crypto: globalThis.crypto,
    randomBytes: () => salt,
  });
  const credential = await pinCrypto.create('739251');

  assert.deepEqual(Object.keys(credential), [
    'algorithm',
    'iterations',
    'saltBase64',
    'verifierBase64',
  ]);
  assert.equal(credential.algorithm, 'PBKDF2-SHA-256');
  assert.equal(credential.iterations, 210_000);
  assert.equal(credential.saltBase64, 'AQIDBAUGBwgJCgsMDQ4PEA==');
  assert.doesNotMatch(JSON.stringify(credential), /739251/u);
  assert.equal(await pinCrypto.verify('739251', credential), true);
  assert.equal(await pinCrypto.verify('852963', credential), false);
});

test('Parent PIN contract accepts six non-trivial digits only', () => {
  assert.equal(validateParentPin('739251'), '739251');
  for (const value of [
    '123456',
    '654321',
    '000000',
    '73925',
    '7392510',
    '73 251',
    739251,
  ]) {
    assert.throws(() => validateParentPin(value), /Parent PIN/u);
  }
});
