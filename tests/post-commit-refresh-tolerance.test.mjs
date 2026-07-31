import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));

// Every awaited parent-progress refresh runs after a mutation that has already
// committed, so its rejection would report committed work as failed. A refresh
// that is merely returned or fired-and-forgotten is not in that position: the
// explicit "check progress" action must still surface its own failure.
const AWAITED_REFRESH = /await\s+(?:services\.)?parentProgress\.refresh\(\)([^;]*);/gu;

const SOURCES = [
  'src/app/create-product-app-services.js',
  'src/app/ProductApp.jsx',
];

async function readSource(relativePath) {
  return readFile(join(root, relativePath), 'utf8');
}

test('every awaited parent-progress refresh tolerates its own failure', async () => {
  for (const relativePath of SOURCES) {
    const source = await readSource(relativePath);
    const matches = [...source.matchAll(AWAITED_REFRESH)];
    assert.ok(
      matches.length > 0,
      `${relativePath} must still await a parent-progress refresh`,
    );
    for (const [statement, tail] of matches) {
      assert.match(
        tail,
        /\.catch\(/u,
        `${relativePath} awaits a parent-progress refresh without tolerating ` +
        `its failure, so a committed mutation would be reported as failed: ` +
        `${statement.trim()}`,
      );
    }
  }
});

test('the standalone progress check still surfaces its own failure', async () => {
  const productApp = await readSource('src/app/ProductApp.jsx');

  // onRefreshProgress is the parent asking for a rebuild and nothing else.
  // Swallowing its rejection would leave the request with no outcome at all.
  assert.match(
    productApp,
    /onRefreshProgress=\{\(\) => services\.parentProgress\.refresh\(\)\}/u,
  );
});
