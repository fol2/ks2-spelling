import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('compiled owned Swift inspector accepts the proof pack and rejects the full hostile corpus', () => {
  const result = spawnSync(process.execPath, ['scripts/test-ios-pack-inspector.mjs'], {
    cwd: new URL('../', import.meta.url),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const evidence = JSON.parse(result.stdout.trim());
  assert.deepEqual(evidence, {
    ok: true,
    approvedRuntimeSmoke: true,
    starterPayloadFiles: 841,
    securityMatrix: true,
    hostileFixturesRejected: 53,
  });
});
