import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

// Tripwire for the standing compliance position
// (docs/compliance/kids-category-position.md, Gap 2 / #158): the App Privacy
// "Data Not Collected" declaration is only as true as this configuration, so
// each load-bearing fact gets an assertion that goes red when it regresses.

const ROOT = new URL('../', import.meta.url);

async function trackedConfig() {
  return JSON.parse(await readFile(new URL('gateway/wrangler.jsonc', ROOT), 'utf8'));
}

async function derivedConfig() {
  const { buildB3DerivedWranglerConfig } = await import(
    '../scripts/lib/b3-cloudflare-live-adapter.mjs'
  );
  return buildB3DerivedWranglerConfig({
    accountId: '6d00cb4a0396c17ad6ba617bcbcaa45d',
    mainModulePath: '/authority/worker.mjs',
    baseDirPath: '/authority',
  });
}

async function gatewaySources() {
  const directory = new URL('gateway/src/', ROOT);
  const sources = new Map();
  for (const name of (await readdir(directory)).filter((entry) => entry.endsWith('.js'))) {
    sources.set(name, await readFile(new URL(name, directory), 'utf8'));
  }
  assert.ok(sources.size > 0, 'gateway sources must be readable');
  return sources;
}

test('platform invocation logs are disabled in both drift-locked configs', async () => {
  for (const config of [await trackedConfig(), await derivedConfig()]) {
    assert.equal(config.observability?.logs?.invocation_logs, false);
    // Application logs must keep flowing: createRedactedLogger's output is the
    // only observability the worker has once invocation logs are off.
    assert.equal(config.observability?.logs?.enabled, true);
  }
});

test('the worker declares no storage binding beyond the read-only pack bucket', async () => {
  for (const config of [await trackedConfig(), await derivedConfig()]) {
    for (const binding of ['kv_namespaces', 'd1_databases', 'durable_objects']) {
      assert.equal(config[binding], undefined);
    }
    assert.equal(config.r2_buckets?.length, 1);
  }
});

test('gateway sources never write to R2', async () => {
  for (const [name, source] of await gatewaySources()) {
    assert.doesNotMatch(source, /\.put\s*\(/, name);
    assert.doesNotMatch(source, /createMultipartUpload/, name);
    if (name !== 'refresh-handle.js') {
      // The one .delete( in the graph is the nonce registry's in-memory Map
      // eviction; everywhere else a delete call would be a new writer.
      assert.doesNotMatch(source, /\.delete\s*\(/, name);
    }
  }
});

test('rate limiting stays keyed to the shared global counter', async () => {
  const handler = await readFile(new URL('gateway/src/handler.js', ROOT), 'utf8');
  // Deliberate: a per-client key would put a client identifier into platform
  // infrastructure, reopening the retention question the position closed.
  assert.match(handler, /\.limit\(\{ key: 'global' \}\)/);
});

test('the application log allowlist is exactly the four audited fields', async () => {
  const source = await readFile(new URL('gateway/src/redacted-logging.js', ROOT), 'utf8');
  assert.match(
    source,
    /const ALLOWED_FIELDS = Object\.freeze\(\['operation', 'status', 'store', 'retryable'\]\);/,
  );
});
