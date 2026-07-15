import assert from 'node:assert/strict';
import test from 'node:test';

const FORBIDDEN = ['learnerId', 'nickname', 'yearGroup', 'progress', 'session', 'monster', 'camp', 'appAccountToken', 'obfuscatedAccountId', 'deviceId', 'advertisingId'];

test('gateway rejects every learner, profile, progress and tracking field', async () => {
  const { assertVerifyRequest, assertHandleRequest } = await import('../gateway/src/store-verifier-port.js');
  const verify = { store: 'google', environment: 'sandbox', productId: 'full_ks2', opaqueProof: 'secret-proof' };
  for (const field of FORBIDDEN) {
    assert.throws(() => assertVerifyRequest({ ...verify, [field]: 'private-value' }), /request/i);
    assert.throws(() => assertHandleRequest({ sealedRefreshHandle: 'secret-handle', [field]: 'private-value' }), /request/i);
  }
});

test('structured logger emits only allow-listed safe metadata', async () => {
  const { createRedactedLogger } = await import('../gateway/src/redacted-logging.js');
  const records = [];
  const logger = createRedactedLogger({ write: (record) => records.push(record) });
  logger.info('gateway_request', {
    operation: 'verify', status: 200, store: 'google', retryable: false,
    endpoint: 'https://b3-gateway.eugnel.uk/v1/x?cap=secret',
    opaqueProof: 'raw-proof', sealedRefreshHandle: 'raw-handle', token: 'raw-token',
    capability: 'raw-capability', traceId: 'private-trace', learnerId: 'child',
  });
  assert.deepEqual(records, [{
    level: 'info', event: 'gateway_request', operation: 'verify', status: 200,
    store: 'google', retryable: false,
  }]);
  assert.doesNotMatch(JSON.stringify(records), /secret|proof|handle|token|capability|trace|child|endpoint/i);
});

test('public errors never echo proof, handle, token, query or upstream details', async () => {
  const { safeGatewayError } = await import('../gateway/src/store-verifier-port.js');
  const error = safeGatewayError('PROOF_REJECTED', new Error('secret-token https://x.test/?cap=raw'));
  assert.deepEqual(Object.keys(error), ['code', 'status', 'retryable']);
  assert.equal(error.code, 'PROOF_REJECTED');
  assert.doesNotMatch(error.message, /secret|token|cap=|https/i);
  assert.doesNotMatch(JSON.stringify(error), /secret|token|cap=|https/i);
});

test('gateway sources contain no persistence or learner-owned authority', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const names = await readdir(new URL('../gateway/src/', import.meta.url));
  const source = (await Promise.all(names.filter((name) => name.endsWith('.js')).map((name) => readFile(new URL(`../gateway/src/${name}`, import.meta.url), 'utf8')))).join('\n');
  assert.doesNotMatch(source, /learner_id|nickname|year_group|monster_state|camp_state/i);
  assert.doesNotMatch(source, /localStorage|indexedDB|D1Database|put\s*\(/i);
});
