import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import shardPartition from '../config/full-ks2-shard-partition.json' with { type: 'json' };
import { createInstalledShardAudio } from '../src/app/installed-shard-audio.js';
import { createFullProductAudioPlayer } from '../src/app/full-product-audio.js';
import { loadFullSpellingCatalogue } from '../src/domain/spelling/index.js';

const ROOT = resolve(import.meta.dirname, '..');

function recordingPort() {
  const reads = [];
  return {
    reads,
    installedAudio: Object.freeze({
      async readInstalledAudio(request) {
        reads.push(structuredClone(request));
        return Object.freeze({
          base64: Buffer.alloc(request.byteSize).toString('base64'),
        });
      },
    }),
  };
}

test('every shard manifest asset routes to its owning shard pack', async () => {
  const { reads, installedAudio } = recordingPort();
  const source = createInstalledShardAudio({ installedAudio });
  assert.equal(source.requiredPacks.length, shardPartition.shardCount);
  for (const shard of shardPartition.shards) {
    const manifest = JSON.parse(await readFile(
      resolve(ROOT, `config/packs/full-ks2-shards/${shard.packId}.manifest.json`),
      'utf8',
    ));
    for (const asset of manifest.assets) {
      reads.length = 0;
      await source.readInstalledAudio({
        packId: 'ks2-core',
        version: '1.0.0',
        assetPath: asset.assetPath,
        sha256: asset.sha256,
        byteSize: asset.byteSize,
      });
      assert.equal(reads.length, 1);
      assert.equal(reads[0].packId, shard.packId, asset.assetPath);
      assert.equal(reads[0].version, shard.version, asset.assetPath);
      assert.equal(reads[0].assetPath, asset.assetPath);
      assert.equal(reads[0].sha256, asset.sha256);
    }
  }
});

test('unknown assets fail closed before any native read', async () => {
  const { reads, installedAudio } = recordingPort();
  const source = createInstalledShardAudio({ installedAudio });
  for (const assetPath of [
    'audio/iapetus/not-a-real-item/word.m4a',
    'audio/word.m4a',
    '../escape/word.m4a',
    undefined,
  ]) {
    await assert.rejects(
      source.readInstalledAudio({ assetPath, sha256: 'a'.repeat(64), byteSize: 1 }),
      { code: 'installed_shard_audio_unavailable' },
    );
  }
  assert.equal(reads.length, 0);
});

test('the full player serves catalogue requests from installed shards', async () => {
  const { reads, installedAudio } = recordingPort();
  const player = createFullProductAudioPlayer({
    installedAudio,
    audioFactory: () => ({
      preload: '',
      src: '',
      pause() {},
      removeAttribute() {},
      load() {},
      async play() {},
    }),
  });
  assert.equal(player.requiredPacks.length, shardPartition.shardCount);
  const catalogue = loadFullSpellingCatalogue();
  const firstItem = catalogue.items[0];
  const lastItem = catalogue.items.at(-1);
  for (const item of [firstItem, lastItem]) {
    const result = await player.play({
      version: '1.0.0',
      runtimeItemId: item.runtimeItemId,
      sentence: item.sentencePrompts[0].text,
      voiceId: 'Sulafat',
      kind: 'sentence',
    });
    assert.equal(result.status, 'playing');
  }
  // First catalogue item lives in the first shard, last item in the last.
  assert.equal(reads.length, 2);
  assert.equal(reads[0].packId, shardPartition.shards[0].packId);
  assert.equal(reads[1].packId, shardPartition.shards.at(-1).packId);
  await player.dispose();
});
