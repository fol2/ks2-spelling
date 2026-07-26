import assert from 'node:assert/strict';
import test from 'node:test';

import { createProductAudioPlayer } from '../src/app/product-audio-player.js';
import {
  createFullAudioInventory,
} from '../src/domain/spelling/starter-audio-contract.js';
import { loadFullSpellingCatalogue } from '../src/domain/spelling/index.js';

test('product audio resolves Full Y5–6 normal and slow sentence assets', async () => {
  const catalogue = await loadFullSpellingCatalogue();
  const inventory = createFullAudioInventory(catalogue);
  const reads = [];
  const installedAudio = Object.freeze({
    async readInstalledAudio(request) {
      reads.push(structuredClone(request));
      return Object.freeze({ base64: Buffer.alloc(request.byteSize).toString('base64') });
    },
  });
  const audioFactory = () => ({
    preload: '',
    src: '',
    pause() {},
    removeAttribute() {},
    load() {},
    async play() {},
  });
  const player = createProductAudioPlayer({
    catalogue,
    installedAudio,
    audioFactory,
    audioEvidence: {
      schemaVersion: 1,
      status: 'pass',
      catalogueId: catalogue.catalogueId,
      assetCount: inventory.length,
      assets: inventory.map(({ assetPath }) => ({
        assetPath,
        sha256: '0'.repeat(64),
        byteSize: 1,
      })),
    },
  });
  const item = catalogue.items.find(({ yearBand }) => yearBand === '5-6');
  const sentence = item.sentencePrompts[0].text;

  await player.play({
    version: '1.0.0',
    runtimeItemId: item.runtimeItemId,
    sentence,
    voiceId: 'Iapetus',
    kind: 'sentence',
  });
  await player.play({
    version: '1.0.0',
    runtimeItemId: item.runtimeItemId,
    sentence,
    voiceId: 'Iapetus',
    kind: 'slow-sentence',
  });

  assert.deepEqual(
    reads.map(({ assetPath }) => assetPath),
    [
      `audio/iapetus/${item.itemId}/sentence-01-normal.m4a`,
      `audio/iapetus/${item.itemId}/sentence-01-slow.m4a`,
    ],
  );
  await player.dispose();
});
