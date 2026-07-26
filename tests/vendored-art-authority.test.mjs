import assert from 'node:assert/strict';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const ART_ROOT = resolve(ROOT, 'content/mastery-art');
const PROVENANCE_PATH = resolve(ROOT, 'provenance/ks2-mastery-art.json');
const EXPECTED_FILE_COUNT = 55;
const EXPECTED_BYTES_BUDGET = 6_291_456;
const PROVENANCE_KEYS = Object.freeze([
  'authority',
  'extraction',
  'upstreamRepository',
  'upstreamCommit',
  'fileCount',
  'totalBytes',
  'totalBytesBudget',
  'files',
]);
const FILE_RECORD_KEYS = Object.freeze(['path', 'upstreamPath', 'sha256', 'bytes']);

async function listArtFiles(root) {
  const files = [];

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = resolve(directory, entry.name);
      assert.equal(entry.isSymbolicLink(), false, `unexpected art symlink: ${path}`);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        files.push(relative(ROOT, path).split(sep).join('/'));
      } else {
        assert.fail(`unexpected art filesystem entry: ${path}`);
      }
    }
  }

  await visit(root);
  return files.sort();
}

test('vendored art provenance pins the reviewed inventory without hashing bytes', async () => {
  const provenance = JSON.parse(await readFile(PROVENANCE_PATH, 'utf8'));

  assert.deepEqual(Object.keys(provenance).sort(), [...PROVENANCE_KEYS].sort());
  assert.equal(typeof provenance.authority, 'string');
  assert.ok(provenance.authority.length > 0);
  assert.equal(typeof provenance.extraction, 'string');
  assert.ok(provenance.extraction.length > 0);
  assert.equal(typeof provenance.upstreamRepository, 'string');
  assert.match(provenance.upstreamCommit, /^[0-9a-f]{40}$/u);
  assert.equal(provenance.fileCount, EXPECTED_FILE_COUNT);
  assert.equal(provenance.totalBytesBudget, EXPECTED_BYTES_BUDGET);
  assert.ok(Number.isInteger(provenance.totalBytes));
  assert.ok(provenance.totalBytes <= provenance.totalBytesBudget);
  assert.ok(Array.isArray(provenance.files));
  assert.equal(provenance.files.length, EXPECTED_FILE_COUNT);

  let summedBytes = 0;
  const listedPaths = [];
  for (const record of provenance.files) {
    assert.deepEqual(Object.keys(record).sort(), [...FILE_RECORD_KEYS].sort());
    assert.match(record.path, /^content\/mastery-art\//u);
    assert.equal(typeof record.upstreamPath, 'string');
    assert.ok(record.upstreamPath.length > 0);
    assert.match(record.sha256, /^[a-f0-9]{64}$/u);
    assert.ok(Number.isInteger(record.bytes));
    assert.ok(record.bytes > 0);
    listedPaths.push(record.path);
    summedBytes += record.bytes;
  }
  assert.equal(summedBytes, provenance.totalBytes);
  assert.equal(new Set(listedPaths).size, listedPaths.length);

  const onDiskPaths = await listArtFiles(ART_ROOT);
  assert.deepEqual(onDiskPaths, [...listedPaths].sort());

  for (const record of provenance.files) {
    const stats = await lstat(resolve(ROOT, record.path));
    assert.equal(stats.isFile(), true);
    assert.equal(stats.isSymbolicLink(), false);
    assert.equal(stats.size, record.bytes);
  }

  const viteConfig = await readFile(resolve(ROOT, 'vite.config.js'), 'utf8');
  assert.match(viteConfig, /createBundledArtAssets/);
  assert.match(
    viteConfig,
    /createBundledArtAssets[\s\S]*resolve\(outputRoot,\s*['"]mastery-art['"]\)/,
  );
});
