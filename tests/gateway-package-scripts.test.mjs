import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const repositoryRoot = new URL('../', import.meta.url);
const gatewayPackageUrl = new URL('gateway/package.json', repositoryRoot);

const EXPECTED_GATEWAY_TESTS = [
  'gateway-contract.test.mjs',
  'gateway-pack-access.test.mjs',
  'gateway-package-scripts.test.mjs',
  'gateway-privacy-boundary.test.mjs',
  'gateway-r2-capability.test.mjs',
  'gateway-refresh-handle.test.mjs',
  'gateway-store-verifiers.test.mjs',
  'gateway-workerd-runtime.test.mjs',
];

test('gateway package owns complete test and lint scripts', async () => {
  const gatewayPackage = JSON.parse(await readFile(gatewayPackageUrl, 'utf8'));

  assert.equal(gatewayPackage.scripts?.test, 'node --test ../tests/gateway-*.test.mjs');
  assert.equal(
    gatewayPackage.scripts?.lint,
    'cd .. && node_modules/.bin/oxlint gateway/src tests/gateway-*.test.mjs',
  );
});

test('gateway test inventory remains explicit and complete', async () => {
  const testNames = (await readdir(new URL('tests/', repositoryRoot)))
    .filter((name) => /^gateway-.*\.test\.mjs$/u.test(name))
    .sort();

  assert.deepEqual(testNames, EXPECTED_GATEWAY_TESTS);
});
