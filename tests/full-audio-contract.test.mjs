import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import fullAudioManifest from '../config/full-audio-manifest.json' with { type: 'json' };
import { loadFullSpellingCatalogue } from '../src/domain/spelling/index.js';
import {
  FULL_AUDIO_AUTHORITY,
  createFullAudioInventory,
} from '../src/domain/spelling/starter-audio-contract.js';
import {
  FULL_AUDIO_AUTHORING_AUTHORITY,
} from '../scripts/lib/starter-audio-authoring-authority.mjs';
import {
  createFullAudioEvidenceAuthority,
  validateFullAudioEvidence,
} from '../scripts/lib/starter-audio-evidence.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');

test('Full runtime manifest carries only verified playback fields', () => {
  assert.deepEqual(Object.keys(fullAudioManifest), [
    'schemaVersion',
    'status',
    'catalogueId',
    'assetCount',
    'assets',
  ]);
  assert.equal(fullAudioManifest.catalogueId, 'ks2-core:full');
  assert.equal(fullAudioManifest.assetCount, 8_946);
  assert.equal(fullAudioManifest.assets.length, 8_946);
  assert.deepEqual(
    Object.keys(fullAudioManifest.assets[0]),
    ['assetPath', 'sha256', 'byteSize'],
  );
  assert.equal(
    new Set(fullAudioManifest.assets.map(({ assetPath }) => assetPath)).size,
    8_946,
  );
});

test('Full audio derives the complete frozen 8,946-asset matrix', async () => {
  const catalogue = await loadFullSpellingCatalogue();
  const inventory = createFullAudioInventory(catalogue);

  assert.equal(FULL_AUDIO_AUTHORITY.catalogueId, 'ks2-core:full');
  assert.equal(FULL_AUDIO_AUTHORITY.assetCount, 8_946);
  assert.equal(FULL_AUDIO_AUTHORING_AUTHORITY.catalogueId, 'ks2-core:full');
  assert.equal(FULL_AUDIO_AUTHORING_AUTHORITY.assetCount, 8_946);
  assert.equal(
    FULL_AUDIO_AUTHORING_AUTHORITY.engine.sourceUrl,
    'https://pypi.org/project/piper-tts/1.5.0/',
  );
  assert.equal(inventory.length, 8_946);
  assert.equal(new Set(inventory.map(({ audioKey }) => audioKey)).size, 8_946);
  assert.equal(new Set(inventory.map(({ assetPath }) => assetPath)).size, 8_946);
  assert.deepEqual(
    Object.fromEntries(
      ['Iapetus', 'Sulafat'].map((voiceId) => [
        voiceId,
        inventory.filter((asset) => asset.voiceId === voiceId).length,
      ]),
    ),
    { Iapetus: 4_473, Sulafat: 4_473 },
  );
  assert.deepEqual(
    Object.fromEntries(
      ['word-natural', 'dictation-normal', 'dictation-slow'].map((audioKind) => [
        audioKind,
        inventory.filter((asset) => asset.audioKind === audioKind).length,
      ]),
    ),
    {
      'word-natural': 426,
      'dictation-normal': 4_260,
      'dictation-slow': 4_260,
    },
  );
  assert.equal(
    inventory[0].audioKey,
    'ks2-core:accident|word|Iapetus|natural|word-natural',
  );
  assert.equal(
    inventory.at(-1).audioKey,
    'ks2-core:yacht|sentence-10|Sulafat|slow|dictation-slow',
  );
});

test('Full evidence binds all generated assets to the frozen authority', async () => {
  const catalogue = await loadFullSpellingCatalogue();
  const inventory = createFullAudioInventory(catalogue);
  const evidence = {
    schemaVersion: 1,
    status: 'pass',
    catalogueId: catalogue.catalogueId,
    ...createFullAudioEvidenceAuthority(catalogue),
    assetCount: inventory.length,
    format: FULL_AUDIO_AUTHORITY.encoding.format,
    assets: inventory.map((asset) => ({
      sequence: asset.sequence,
      audioKey: asset.audioKey,
      assetPath: asset.assetPath,
      inputSha256: digest(Buffer.from(asset.input)),
      generationSpecSha256: digest(Buffer.from(JSON.stringify(asset.generationSpec))),
      byteSize: 1_000 + asset.sequence,
      sha256: digest(Buffer.from(`audio-${asset.sequence}`)),
      codec: 'aac',
      sampleRateHz: 22_050,
      channels: 1,
      durationMs:
        asset.audioKind === 'word-natural' ? 800
          : asset.audioKind === 'dictation-normal' ? 1_600 : 2_160,
      meanDbfs: -16,
      peakDbfs: -3,
      leadingSilenceMs: 80,
      trailingSilenceMs: 120,
    })),
  };

  const validated = validateFullAudioEvidence(evidence, { catalogue });
  assert.equal(validated.assetCount, 8_946);
  assert.throws(
    () => validateFullAudioEvidence({}, { catalogue, inventory }),
    /Full audio evidence root/u,
  );
  evidence.assets[0].durationMs = Number.NaN;
  assert.throws(
    () => validateFullAudioEvidence(evidence, { catalogue, inventory }),
    /Full audio evidence duration must be finite/u,
  );
  evidence.assets[0].durationMs = 800;
  evidence.assets[0].audioKey = evidence.assets[1].audioKey;
  assert.throws(
    () => validateFullAudioEvidence(evidence, { catalogue }),
    /Full audio evidence/u,
  );
});
