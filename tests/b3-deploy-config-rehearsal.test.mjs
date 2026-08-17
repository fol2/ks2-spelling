import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { main } from '../scripts/rehearse-b3-deploy-config.mjs';
import { B3_SCRIPT_AUTHORITY_PLACEHOLDER } from '../scripts/lib/b3-cloudflare-evidence.mjs';

test('the rehearsal compiles the deploy-shaped config through dryRunBundle', async () => {
  const calls = [];
  const exitCode = await main({
    root: '/repo',
    createPrimitives: ({ root }) => ({
      dryRunBundle: async ({ placeholder }) => {
        calls.push({ root, placeholder });
        return { source: 'worker source', normalised: true };
      },
    }),
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [{ root: '/repo', placeholder: B3_SCRIPT_AUTHORITY_PLACEHOLDER }]);
  assert.equal(
    createHash('sha256').update('worker source', 'utf8').digest('hex').length,
    64,
  );
});

test('a failing deploy-shaped compile exits non-zero', async () => {
  const exitCode = await main({
    root: '/repo',
    createPrimitives: () => ({
      dryRunBundle: async () => {
        const error = new Error('derived config compile failed');
        error.code = 'b3_cloudflare_live_adapter_invalid';
        throw error;
      },
    }),
  });
  assert.equal(exitCode, 4);
});
