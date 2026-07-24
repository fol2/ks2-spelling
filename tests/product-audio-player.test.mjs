import assert from 'node:assert/strict';
import test from 'node:test';

import evidence from '../reports/c1/starter-audio-evidence.json' with { type: 'json' };
import { createProductAudioPlayer } from '../src/app/product-audio-player.js';
import { loadStarterSpellingCatalogue } from '../src/domain/spelling/index.js';

function createAudioHarness() {
  const reads = [];
  const players = [];
  const installedAudio = Object.freeze({
    async readInstalledAudio(request) {
      reads.push(structuredClone(request));
      return Object.freeze({ base64: Buffer.alloc(request.byteSize).toString('base64') });
    },
  });
  const audioFactory = () => {
    const player = {
      preload: '',
      src: '',
      paused: false,
      loaded: 0,
      played: 0,
      removed: [],
      pause() {
        this.paused = true;
      },
      removeAttribute(name) {
        this.removed.push(name);
        if (name === 'src') this.src = '';
      },
      load() {
        this.loaded += 1;
      },
      async play() {
        this.played += 1;
      },
    };
    players.push(player);
    return player;
  };
  return Object.freeze({
    reads,
    players,
    player: createProductAudioPlayer({
      catalogue: loadStarterSpellingCatalogue(),
      installedAudio,
      audioFactory,
    }),
  });
}

function evidenceFor(path) {
  const asset = evidence.assets.find(({ assetPath }) => assetPath === path);
  assert.ok(asset, `missing C1 evidence for ${path}`);
  return asset;
}

test('product audio reads and plays the exact verified installed word asset', async () => {
  const harness = createAudioHarness();
  const result = await harness.player.play({
    version: '1.0.0',
    runtimeItemId: 'ks2-core:answer',
    sentence: 'I knew the answer at once.',
    voiceId: 'Iapetus',
    kind: 'word',
  });
  const expected = evidenceFor('audio/iapetus/answer/word.m4a');

  assert.deepEqual(harness.reads, [{
    packId: 'ks2-core',
    version: '1.0.0',
    assetPath: expected.assetPath,
    sha256: expected.sha256,
    byteSize: expected.byteSize,
  }]);
  assert.deepEqual(result, {
    status: 'playing',
    audioKey: 'ks2-core:answer|word|Iapetus|natural|word-natural',
  });
  assert.equal(harness.players.length, 1);
  assert.equal(harness.players[0].preload, 'auto');
  assert.match(harness.players[0].src, /^data:audio\/mp4;base64,/u);
  assert.equal(harness.players[0].played, 1);

  await harness.player.dispose();
  assert.equal(harness.players[0].paused, true);
  assert.deepEqual(harness.players[0].removed, ['src']);
});

test('product audio resolves normal and slow sentence variants without target fallback', async () => {
  const harness = createAudioHarness();
  const sentence = 'I knew the answer at once.';
  await harness.player.play({
    version: '1.0.0',
    runtimeItemId: 'ks2-core:answer',
    sentence,
    voiceId: 'Sulafat',
    kind: 'sentence',
  });
  await harness.player.play({
    version: '1.0.0',
    runtimeItemId: 'ks2-core:answer',
    sentence,
    voiceId: 'Sulafat',
    kind: 'slow-sentence',
  });

  assert.deepEqual(
    harness.reads.map(({ assetPath }) => assetPath),
    [
      'audio/sulafat/answer/sentence-01-normal.m4a',
      'audio/sulafat/answer/sentence-01-slow.m4a',
    ],
  );
  assert.equal(harness.players.length, 2);
  assert.equal(harness.players[0].paused, true);
  assert.deepEqual(harness.players[0].removed, ['src']);
  assert.equal(harness.players[1].played, 1);
  await harness.player.dispose();
});

test('product audio rejects requests outside the Starter authority before native access', async () => {
  const harness = createAudioHarness();
  for (const request of [
    {
      version: '1.0.0',
      runtimeItemId: 'ks2-core:answer',
      sentence: 'Not an approved sentence.',
      voiceId: 'Iapetus',
      kind: 'sentence',
    },
    {
      version: '1.0.0',
      runtimeItemId: 'ks2-core:answer',
      sentence: 'I knew the answer at once.',
      voiceId: 'Device voice',
      kind: 'word',
    },
    {
      version: '1.0.0',
      runtimeItemId: 'ks2-core:answer',
      sentence: 'I knew the answer at once.',
      voiceId: 'Iapetus',
      kind: 'network-speech',
    },
  ]) {
    await assert.rejects(
      harness.player.play(request),
      (error) => error?.code === 'product_audio_request_invalid',
    );
  }
  assert.deepEqual(harness.reads, []);
  assert.deepEqual(harness.players, []);
  await harness.player.dispose();
});
