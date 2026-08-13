import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';

import { validateDataOnlyInventory } from '../src/domain/packs/data-only-pack-contract.js';

const ROOT = resolve(import.meta.dirname, '..');
const BUILDER = 'scripts/build-starter-pack.mjs';
const STARTER_AUTHORITY = 'config/packs/ks2-core.json';
const LEGACY_STARTER_AUTHORITY = 'config/starter-pack-payload.json';
const TOY_AUTHORITY = 'config/packs/e3-toy.json';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function runBuilder(extraArguments = []) {
  return spawnSync(process.execPath, [BUILDER, ...extraArguments], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

test('starter payload authority is copied into config/packs without loosening the original', async () => {
  const original = await readFile(resolve(ROOT, LEGACY_STARTER_AUTHORITY));
  const perPack = await readFile(resolve(ROOT, STARTER_AUTHORITY));
  assert.deepEqual(perPack, original);
});

test('toy authority builds a distinct valid pack artifact', async (t) => {
  const output = await mkdtemp(join(tmpdir(), 'ks2-e3-toy-pack-'));
  t.after(() => rm(output, { recursive: true, force: true }));

  const result = runBuilder([
    `--authority=${TOY_AUTHORITY}`,
    `--output-directory=${output}`,
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const tracked = JSON.parse(
    await readFile(resolve(ROOT, 'reports/c1/starter-pack-build.json'), 'utf8'),
  );
  const archive = await readFile(join(output, 'e3-toy-1.0.0.zip'));
  const manifest = JSON.parse(
    await readFile(join(output, 'unsigned-canonical-manifest.json'), 'utf8'),
  );
  assert.notEqual(sha256(archive), tracked.archive.sha256);
  assert.equal(manifest.packId, 'e3-toy');
  assert.equal(manifest.version, '1.0.0');
  assert.equal(manifest.archive.name, 'e3-toy-1.0.0.zip');
  assert.equal(manifest.archive.sha256, sha256(archive));
  assert.equal(manifest.files.length, 2);
  assert.deepEqual(
    validateDataOnlyInventory({
      manifest: {
        allowedExtensions: manifest.allowedExtensions,
        ceilings: manifest.ceilings,
        files: manifest.files,
      },
      entries: manifest.files.map((file) => ({
        path: file.path,
        compressedBytes: file.bytes,
        extractedBytes: file.bytes,
      })),
    }).fileCount,
    2,
  );
});

test('builder rejects an unknown option and a closed-schema authority drift', async (t) => {
  const unknown = runBuilder(['--author']);
  assert.notEqual(unknown.status, 0);
  assert.match(`${unknown.stderr}\n${unknown.stdout}`, /authority|unsupported|unknown/i);

  await mkdir(join(ROOT, '.native-build'), { recursive: true });
  const scratch = await mkdtemp(join(ROOT, '.native-build', 'e3-authority-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const drifted = JSON.parse(await readFile(resolve(ROOT, TOY_AUTHORITY), 'utf8'));
  drifted.extraField = true;
  const driftedPath = join(scratch, 'drifted.json');
  await writeFile(driftedPath, `${JSON.stringify(drifted, null, 2)}\n`);
  const result = runBuilder([`--authority=${relative(ROOT, driftedPath)}`]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /exactly the reviewed fields|authority/i);
});
