import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { createB3DeviceGatewaySmokeProbe } from '../src/app/b3-device-gateway-smoke.js';
import {
  extractB3DeviceGatewaySmokeProjection,
} from '../scripts/lib/b3-live-capture-adapters.mjs';

const ARCHIVE = Buffer.from('exact-b3-archive-bytes');
const ARCHIVE_SHA = createHash('sha256').update(ARCHIVE).digest('hex');
const MANIFEST_SHA = 'b'.repeat(64);
const ETAG = '913d2b2485ca6cd31d467bd7228d7e75';
const EXPIRES = 1_784_192_600;
const CAPABILITY = 'A'.repeat(43);
const CAPABILITY_URL = `https://b3-gateway.eugnel.uk/v1/packs/b3-sandbox-proof/1.0.0-b3.1/b3-sandbox-proof.zip?expires=${EXPIRES}&cap=${CAPABILITY}`;

function authorisation() {
  return {
    workerVersionId: 'a8f32f60-16b9-4ca6-9b4a-f771dd5302f7',
    workerScriptAuthoritySha256: 'a'.repeat(64),
    signedEnvelopeSha256: MANIFEST_SHA,
    objects: [
      { objectKind: 'manifest', sha256: MANIFEST_SHA, size: 1_135, etag: 'c76b2858b8345814279a1c92ae64e365' },
      { objectKind: 'archive', sha256: ARCHIVE_SHA, size: ARCHIVE.length, etag: ETAG },
    ],
    archiveCapability: {
      packId: 'b3-sandbox-proof', version: '1.0.0-b3.1',
      archiveName: 'b3-sandbox-proof.zip', sha256: ARCHIVE_SHA,
      compressedBytes: ARCHIVE.length, etag: ETAG, capabilityUrl: CAPABILITY_URL,
    },
  };
}

test('device probe proves exact bytes, Range and a real 600-second expiry without exporting authority', async () => {
  let now = (EXPIRES - 600) * 1_000;
  const waits = [];
  const requests = [];
  const fetchImpl = async (input, options) => {
    requests.push({ input, options });
    const url = String(input);
    const headers = new Headers({
      'cache-control': 'private, no-store',
      etag: `"${ETAG}"`,
      'accept-ranges': 'bytes',
    });
    if (url !== CAPABILITY_URL) return new Response('{}', { status: 400 });
    if (now > EXPIRES * 1_000) return new Response('{}', { status: 400 });
    if (options.headers?.['If-None-Match']) return new Response(null, { status: 304, headers });
    if (options.headers?.Range === `bytes=${ARCHIVE.length}-${ARCHIVE.length}`) {
      headers.set('content-range', `bytes */${ARCHIVE.length}`);
      return new Response(null, { status: 416, headers });
    }
    if (options.headers?.Range === 'bytes=0-0') {
      headers.set('content-range', `bytes 0-0/${ARCHIVE.length}`);
      headers.set('content-length', '1');
      return new Response(ARCHIVE.subarray(0, 1), { status: 206, headers });
    }
    headers.set('content-length', String(ARCHIVE.length));
    return new Response(ARCHIVE, { status: 200, headers });
  };
  const projection = await createB3DeviceGatewaySmokeProbe({
    fetchImpl,
    clock: () => now,
    wait: async (milliseconds) => { waits.push(milliseconds); now += milliseconds; },
  })(authorisation());

  assert.equal(waits.reduce((total, value) => total + value, 0) >= 600_000, true);
  assert.deepEqual(projection.accessBehaviour, {
    ttlSeconds: 600, valid: true, tamperedRejected: true,
    expiredRejected: true, canonicalEncodingRequired: true,
  });
  assert.deepEqual(projection.byteServingBehaviour, {
    full200: true, partial206: true, conditional304: true,
    unsatisfied416: true, noRedirects: true, cacheControl: 'private, no-store',
  });
  assert.equal(JSON.stringify(projection).includes('cap='), false);
  assert.equal(JSON.stringify(projection).includes('capabilityUrl'), false);
  assert.equal(JSON.stringify(projection).includes('sealedRefreshHandle'), false);
  assert.equal(requests.length, 7);
  assert.equal(requests.every(({ options }) => options.redirect === 'error'), true);
});

test('device probe fails closed on redirects, oversized bodies and expiry before 600 seconds', async () => {
  const input = authorisation();
  await assert.rejects(
    createB3DeviceGatewaySmokeProbe({
      fetchImpl: async () => ({ status: 200, redirected: true, headers: new Headers(), body: null }),
      clock: () => (EXPIRES - 600) * 1_000,
      wait: async () => {},
    })(input),
    /redirect|response/i,
  );
  await assert.rejects(
    createB3DeviceGatewaySmokeProbe({
      fetchImpl: async () => new Response(Buffer.alloc(ARCHIVE.length + 1), {
        status: 200,
        headers: {
          'cache-control': 'private, no-store',
          'content-length': String(ARCHIVE.length + 1),
          etag: `"${ETAG}"`,
          'accept-ranges': 'bytes',
        },
      }),
      clock: () => (EXPIRES - 600) * 1_000,
      wait: async () => {},
    })(input),
    /body|byte|size/i,
  );
  let calls = 0;
  await assert.rejects(
    createB3DeviceGatewaySmokeProbe({
      fetchImpl: async () => {
        const call = calls++;
        const headers = {
          'cache-control': 'private, no-store', etag: `"${ETAG}"`, 'accept-ranges': 'bytes',
        };
        if (call === 0) return new Response(ARCHIVE, { status: 200, headers });
        if (call === 1) return new Response(ARCHIVE.subarray(0, 1), {
          status: 206, headers: { ...headers, 'content-range': `bytes 0-0/${ARCHIVE.length}` },
        });
        if (call === 2) return new Response(null, { status: 304, headers });
        if (call === 3) return new Response(null, {
          status: 416, headers: { ...headers, 'content-range': `bytes */${ARCHIVE.length}` },
        });
        return new Response('{}', { status: 400 });
      },
      clock: () => (EXPIRES - 600) * 1_000,
      wait: async () => {},
    })(input),
    /expiry|600|clock/i,
  );
});

test('device probe owns bounded fetch, body-read and cancellation deadlines', async () => {
  let hangingReadCancelCalls = 0;
  await assert.rejects(
    createB3DeviceGatewaySmokeProbe({
      fetchImpl: async () => new Promise(() => {}),
      clock: () => (EXPIRES - 600) * 1_000,
      wait: async () => {},
      operationTimeoutMs: 5,
    })(authorisation()),
    /deadline|timeout/i,
  );
  await assert.rejects(
    createB3DeviceGatewaySmokeProbe({
      fetchImpl: async () => ({
        status: 200, redirected: false,
        headers: new Headers({
          'cache-control': 'private, no-store', 'content-length': String(ARCHIVE.length),
          etag: `"${ETAG}"`, 'accept-ranges': 'bytes',
        }),
        body: { getReader: () => ({
          read: async () => new Promise(() => {}),
          cancel: async () => { hangingReadCancelCalls += 1; return new Promise(() => {}); },
        }) },
      }),
      clock: () => (EXPIRES - 600) * 1_000,
      wait: async () => {},
      operationTimeoutMs: 5,
    })(authorisation()),
    /deadline|timeout/i,
  );
  assert.equal(hangingReadCancelCalls, 1);
  await assert.rejects(
    createB3DeviceGatewaySmokeProbe({
      fetchImpl: async () => ({
        status: 200, redirected: false,
        headers: new Headers({
          'cache-control': 'private, no-store', 'content-length': String(ARCHIVE.length),
          etag: `"${ETAG}"`, 'accept-ranges': 'bytes',
        }),
        body: { getReader: () => ({
          read: async () => ({ done: false, value: new Uint8Array(ARCHIVE.length + 1) }),
          cancel: async () => new Promise(() => {}),
        }) },
      }),
      clock: () => (EXPIRES - 600) * 1_000,
      wait: async () => {},
      operationTimeoutMs: 5,
    })(authorisation()),
    /deadline|timeout|body|byte/i,
  );
});

test('host extracts exactly one pack-install smoke without a duplicate diagnostic file', () => {
  const authority = {
    schemaVersion: 1,
    deploymentVersionId: authorisation().workerVersionId,
    scriptAuthoritySha256: authorisation().workerScriptAuthoritySha256,
    signedEnvelopeSha256: MANIFEST_SHA,
    objects: [
      { role: 'signed-manifest', key: 'packs/b3-sandbox-proof/1.0.0-b3.1/signed-manifest.json', sha256: MANIFEST_SHA, size: 1_135, etag: 'c76b2858b8345814279a1c92ae64e365' },
      { role: 'archive', key: 'packs/b3-sandbox-proof/1.0.0-b3.1/b3-sandbox-proof.zip', sha256: ARCHIVE_SHA, size: ARCHIVE.length, etag: ETAG },
    ],
    accessBehaviour: { ttlSeconds: 600, valid: true, tamperedRejected: true, expiredRejected: true, canonicalEncodingRequired: true },
    byteServingBehaviour: { full200: true, partial206: true, conditional304: true, unsatisfied416: true, noRedirects: true, cacheControl: 'private, no-store' },
  };
  const retained = [
    { observation: { scenario: 'product-query', phase: 'SCENARIO_COMPLETE', proofProjection: { gatewaySmokeAuthority: null, gatewayCalls: [] } } },
    { observation: { scenario: 'pack-install', phase: 'SCENARIO_COMPLETE', proofProjection: {
      gatewaySmokeAuthority: authority,
      gatewayCalls: [{ operation: 'authorise', relation: 'download-capability-authorisation', traceId: '018f1d7b-97e8-4a52-8cf2-783e5089c001' }],
    } } },
  ];
  assert.throws(
    () => extractB3DeviceGatewaySmokeProjection({ retained: [] }),
    (error) => error?.code === 'b3_live_capture_invalid' && /empty/i.test(error.message),
  );
  assert.throws(
    () => extractB3DeviceGatewaySmokeProjection({ retained: [retained[0]] }),
    (error) => error?.code === 'b3_live_capture_invalid' && /exactly once/i.test(error.message),
  );
  const projection = extractB3DeviceGatewaySmokeProjection({ retained });
  assert.deepEqual(projection.capability, authority.accessBehaviour);
  assert.deepEqual(projection.range, authority.byteServingBehaviour);
  assert.throws(
    () => extractB3DeviceGatewaySmokeProjection({ retained: [...retained, retained[1]] }),
    /exactly once/i,
  );
  const wrongScenario = structuredClone(retained);
  wrongScenario[1].observation.scenario = 'redownload';
  assert.throws(
    () => extractB3DeviceGatewaySmokeProjection({ retained: wrongScenario }),
    /pack-install/i,
  );

});
