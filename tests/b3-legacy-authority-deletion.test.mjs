import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import test from 'node:test';

import {
  B3_DELETED_AUTHORITY_MODULES,
  B3_FINAL_OUTPUTS,
  B3_OBSOLETE_AUTHORITY_SYMBOLS,
  B3_OBSOLETE_DEVICE_SMOKE_OUTPUT,
  findB3RepositoryInvariantViolations,
  scanB3RepositorySources,
} from './helpers/b3-repository-invariant-scanner.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const DELETED_DIRECTORY = 'scripts/lib';
const FINAL_PUBLISHER = 'scripts/lib/b3-final-proof-output.mjs';

async function repositoryScan() {
  return scanB3RepositorySources({ root: ROOT });
}

test('D5 removes every superseded filesystem capture authority', async () => {
  for (const name of B3_DELETED_AUTHORITY_MODULES) {
    await assert.rejects(access(resolve(ROOT, DELETED_DIRECTORY, name)), /ENOENT/u);
  }
});

test('D5 bounded repository scan proves deleted imports, obsolete symbols and output authority are absent',
  async () => {
    const scan = await repositoryScan();
    assert.ok(scan.filesScanned > 100);
    assert.ok(scan.bytesScanned > 0);
    assert.deepEqual(findB3RepositoryInvariantViolations(scan.files), []);
  });

test('D5 bounded scanner detects an otherwise-unloaded stale import and obsolete writer',
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'b3-repository-invariant-fixture-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, 'scripts'), { recursive: true });
    const deletedModule = B3_DELETED_AUTHORITY_MODULES.at(-1);
    const obsoleteSymbol = B3_OBSOLETE_AUTHORITY_SYMBOLS.at(-1);
    await writeFile(join(root, 'scripts', 'prove-b3-unloaded-stale.mjs'), [
      `import '../lib/${deletedModule}';`,
      `const stale = globalThis.${obsoleteSymbol};`,
      `await writeFile('${B3_OBSOLETE_DEVICE_SMOKE_OUTPUT}', '{}');`,
      'void stale;',
      '',
    ].join('\n'));
    const scan = await scanB3RepositorySources({ root, roots: ['scripts'] });
    assert.deepEqual(findB3RepositoryInvariantViolations(scan.files).map((entry) =>
      [entry.kind, entry.path, entry.authority]), [
      ['deleted-module-import', 'scripts/prove-b3-unloaded-stale.mjs', deletedModule],
      ['obsolete-authority-symbol', 'scripts/prove-b3-unloaded-stale.mjs', obsoleteSymbol],
      [
        'obsolete-device-smoke-authority',
        'scripts/prove-b3-unloaded-stale.mjs',
        B3_OBSOLETE_DEVICE_SMOKE_OUTPUT,
      ],
    ]);
  });

test('D5 store-backed controller is filesystem-free and pure proof derivation stays isolated',
  async () => {
    const controller = await readFile(
      resolve(ROOT, 'scripts/lib/b3-store-backed-live-capture.mjs'),
      'utf8',
    );
    assert.doesNotMatch(
      controller,
      /node:(?:fs|path)|\.native-build|reports\/|B3_CAPTURE_STATE_REPOSITORY_ROOT/u,
    );
    const domain = await readFile(
      resolve(ROOT, 'scripts/lib/b3-capture-proof-domain.mjs'),
      'utf8',
    );
    assert.doesNotMatch(
      domain,
      /node:(?:fs|path)|capture-store|capture-state|process\.env|transport|check-b3-external-prerequisites/u,
    );
    assert.match(domain, /signed-manifest-contract\.js/u);
  });

test('D5 every final identity is closed under reports/b3 and every external writer uses the publisher',
  async () => {
    assert.equal(new Set(B3_FINAL_OUTPUTS).size, 6);
    for (const output of B3_FINAL_OUTPUTS) {
      assert.equal(output.startsWith('reports/b3/'), true, output);
      assert.equal(basename(output).length > 0, true, output);
    }
    const scan = await repositoryScan();
    const references = scan.files.filter(({ path, source }) =>
      path.startsWith('scripts/') && path !== FINAL_PUBLISHER &&
      B3_FINAL_OUTPUTS.some((output) => source.includes(output)));
    assert.deepEqual(references.map(({ path }) => path), [
      'scripts/prove-b3-android.mjs',
      'scripts/prove-b3-cloudflare.mjs',
      'scripts/prove-b3-ios.mjs',
    ]);
    for (const { path, source } of references) {
      assert.match(source, /publishB3FinalProofOutput/u, path);
    }
    const publisher = await readFile(resolve(ROOT, FINAL_PUBLISHER), 'utf8');
    for (const output of B3_FINAL_OUTPUTS) assert.match(publisher, new RegExp(output));
  });
