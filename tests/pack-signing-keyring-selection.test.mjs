import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import fullKeyring from '../config/pack-signing-public-keys.json' with { type: 'json' };
import productionKeyring from '../config/production/pack-signing-public-keys.json' with { type: 'json' };
import {
  selectPackSigningKeyring,
} from '../scripts/select-pack-signing-keyring.mjs';

test('production keyring is the strict production-key projection of the full keyring', () => {
  assert.deepEqual(productionKeyring, {
    schemaVersion: 1,
    keys: [fullKeyring.keys[1]],
  });

  const production = selectPackSigningKeyring('production');
  const productionBytes = JSON.stringify(production);
  assert.equal(productionBytes.includes('production-ks2-p256-2026-08'), true);
  for (const forbidden of [
    'b3-gateway.eugnel.uk',
    'b3-test-p256-2026-07',
    'b3-sandbox-proof',
  ]) {
    assert.equal(productionBytes.includes(forbidden), false);
  }
});

test('sandbox keyring selection retains the full proof authority', () => {
  const sandbox = selectPackSigningKeyring('sandbox');
  assert.deepEqual(sandbox, fullKeyring);
  const sandboxBytes = JSON.stringify(sandbox);
  assert.equal(sandboxBytes.includes('b3-test-p256-2026-07'), true);
  assert.equal(sandboxBytes.includes('b3-sandbox-proof'), true);
  assert.throws(() => selectPackSigningKeyring('test'), /release channel is invalid/u);
});

test('the production pack-keyring module does not name sandbox-only identities', async () => {
  const source = await readFile(
    new URL('../src/domain/packs/pack-keyring.js', import.meta.url),
    'utf8',
  );
  for (const forbidden of [
    'b3-gateway.eugnel.uk',
    'b3-test-p256-2026-07',
    'b3-sandbox-proof',
  ]) {
    assert.equal(source.includes(forbidden), false, source);
  }
});

test('the tracked Android keyring remains the byte-identical full two-key document', async () => {
  const tracked = await readFile(
    new URL('../config/pack-signing-public-keys.json', import.meta.url),
  );
  assert.deepEqual(
    await readFile(
      new URL('../android/app/src/main/assets/pack-signing-public-keys.json', import.meta.url),
    ),
    tracked,
  );
});
