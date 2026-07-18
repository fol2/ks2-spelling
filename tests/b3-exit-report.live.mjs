import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

test('committed B3 live evidence is a complete exact-byte successor', async () => {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ['scripts/build-b3-exit-report.mjs', '--check-ci'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
  );
  assert.equal(stderr, '');
  const value = JSON.parse(stdout);
  assert.equal(value.ok, true);
  assert.equal(value.mode, 'complete');
});
