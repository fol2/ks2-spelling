import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('committed B2 exit evidence matches the exact application checkpoint', async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['scripts/build-b2-exit-report.mjs', '--check'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.exitReport, 'reports/b2/b2-exit-report.json');
  assert.equal(result.report.status, 'pass');
});
