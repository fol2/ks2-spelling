import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCapacitorInstalledAudio,
} from '../src/platform/audio/capacitor-installed-audio.js';

const SHA256 = 'a'.repeat(64);
const REQUEST = Object.freeze({
  packId: 'ks2-core',
  version: '1.0.0',
  assetPath: 'audio/iapetus/answer/word.m4a',
  sha256: SHA256,
  byteSize: 4_990,
});

test('installed audio exposes one bounded native read with canonical base64', async () => {
  const calls = [];
  const port = createCapacitorInstalledAudio({
    InstalledAudio: {
      async readInstalledAudio(request) {
        calls.push(structuredClone(request));
        return { base64: Buffer.alloc(request.byteSize).toString('base64') };
      },
    },
  });

  assert.deepEqual(Reflect.ownKeys(port), ['readInstalledAudio']);
  assert.equal(Object.isFrozen(port), true);
  assert.deepEqual(await port.readInstalledAudio(REQUEST), {
    base64: Buffer.alloc(REQUEST.byteSize).toString('base64'),
  });
  assert.deepEqual(calls, [REQUEST]);
});

test('installed audio rejects traversal, unknown fields and corrupt native bytes', async () => {
  let calls = 0;
  const port = createCapacitorInstalledAudio({
    InstalledAudio: {
      async readInstalledAudio() {
        calls += 1;
        return { base64: 'YQ==' };
      },
    },
  });

  for (const request of [
    { ...REQUEST, assetPath: '../activation.json' },
    { ...REQUEST, assetPath: 'audio/iapetus/answer/word.wav' },
    { ...REQUEST, learnerId: 'learner-a' },
    { ...REQUEST, byteSize: 0 },
    { ...REQUEST, sha256: 'A'.repeat(64) },
  ]) {
    await assert.rejects(port.readInstalledAudio(request), /installed audio/i);
  }
  assert.equal(calls, 0);

  await assert.rejects(
    port.readInstalledAudio(REQUEST),
    /installed audio/i,
  );
  assert.equal(calls, 1);
});
