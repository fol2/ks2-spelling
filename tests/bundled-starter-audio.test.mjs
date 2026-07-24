import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  createBundledStarterAudio,
} from '../src/app/bundled-starter-audio.js';

const BYTES = Uint8Array.from([0, 1, 2, 3, 254, 255]);
const SHA256 = createHash('sha256').update(BYTES).digest('hex');
const AUTHORITY = Object.freeze({
  packId: 'ks2-core',
  version: '1.0.0',
  sentinel: Object.freeze({
    assetPath: 'audio/iapetus/answer/word.m4a',
    sha256: SHA256,
    byteSize: BYTES.byteLength,
  }),
});

function response(bytes = BYTES) {
  return Object.freeze({
    ok: true,
    async arrayBuffer() {
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      );
    },
  });
}

test('bundled Starter audio verifies local bytes before exposing them', async () => {
  const requested = [];
  const source = createBundledStarterAudio({
    authority: AUTHORITY,
    baseUrl: 'capacitor://localhost/starter/',
    fetchImpl: async (url) => {
      requested.push(url);
      return response();
    },
    encodeBase64: (bytes) => Buffer.from(bytes).toString('base64'),
  });

  assert.deepEqual(await source.checkAvailability(), {
    version: '1.0.0',
  });
  assert.deepEqual(await source.readInstalledAudio({
    packId: 'ks2-core',
    version: '1.0.0',
    assetPath: AUTHORITY.sentinel.assetPath,
    sha256: SHA256,
    byteSize: BYTES.byteLength,
  }), {
    base64: Buffer.from(BYTES).toString('base64'),
  });
  assert.deepEqual(requested, [
    'capacitor://localhost/starter/audio/iapetus/answer/word.m4a',
    'capacitor://localhost/starter/audio/iapetus/answer/word.m4a',
  ]);
});

test('bundled Starter audio accepts a verified status-zero response only from Capacitor', async () => {
  const source = createBundledStarterAudio({
    authority: AUTHORITY,
    baseUrl: 'capacitor://localhost/starter/',
    fetchImpl: async () => Object.freeze({
      ...response(),
      ok: false,
      status: 0,
      type: 'basic',
    }),
    encodeBase64: (bytes) => Buffer.from(bytes).toString('base64'),
  });

  assert.deepEqual(await source.checkAvailability(), {
    version: '1.0.0',
  });

  const remote = createBundledStarterAudio({
    authority: AUTHORITY,
    baseUrl: 'https://example.test/starter/',
    fetchImpl: async () => Object.freeze({
      ...response(),
      ok: false,
      status: 0,
      type: 'opaque',
    }),
    encodeBase64: (bytes) => Buffer.from(bytes).toString('base64'),
  });
  await assert.rejects(
    remote.checkAvailability(),
    ({ code }) => code === 'bundled_starter_audio_unavailable',
  );
});

test('bundled Starter audio fails closed on missing or changed bytes', async () => {
  const missing = createBundledStarterAudio({
    authority: AUTHORITY,
    baseUrl: 'capacitor://localhost/starter/',
    fetchImpl: async () => Object.freeze({ ok: false }),
  });
  await assert.rejects(
    missing.checkAvailability(),
    ({ code }) => code === 'bundled_starter_audio_unavailable',
  );

  const changed = createBundledStarterAudio({
    authority: AUTHORITY,
    baseUrl: 'capacitor://localhost/starter/',
    fetchImpl: async () => response(Uint8Array.from([0, 1, 2])),
  });
  await assert.rejects(
    changed.readInstalledAudio({
      packId: 'ks2-core',
      version: '1.0.0',
      assetPath: AUTHORITY.sentinel.assetPath,
      sha256: SHA256,
      byteSize: BYTES.byteLength,
    }),
    ({ code }) => code === 'bundled_starter_audio_unavailable',
  );
});
