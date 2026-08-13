import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const BUILDER = 'scripts/build-starter-pack.mjs';
const STARTER_AUTHORITY = 'config/packs/ks2-core.json';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function runBuilder(extraArguments = []) {
  return spawnSync(process.execPath, [BUILDER, ...extraArguments], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

test('rebuilding with the starter authority is byte-identical to the C1 archive', async (t) => {
  const tracked = JSON.parse(
    await readFile(resolve(ROOT, 'reports/c1/starter-pack-build.json'), 'utf8'),
  );
  for (const extra of [[`--authority=${STARTER_AUTHORITY}`], []]) {
    const output = await mkdtemp(join(tmpdir(), 'ks2-e3-starter-pack-'));
    t.after(() => rm(output, { recursive: true, force: true }));
    const result = runBuilder([...extra, `--output-directory=${output}`]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const archive = await readFile(join(output, tracked.archive.file));
    assert.equal(archive.length, tracked.archive.bytes);
    assert.equal(sha256(archive), tracked.archive.sha256);
  }
});
