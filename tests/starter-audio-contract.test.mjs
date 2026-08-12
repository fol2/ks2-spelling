import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createAudioKeyV1,
  loadStarterSpellingCatalogue,
} from '../src/domain/spelling/index.js';
import {
  FULL_AUDIO_AUTHORITY,
  STARTER_AUDIO_AUTHORITY,
  createStarterAudioInventory,
} from '../src/domain/spelling/starter-audio-contract.js';

test('Starter audio derives the complete frozen 840-asset matrix', () => {
  const catalogue = loadStarterSpellingCatalogue();
  const inventory = createStarterAudioInventory(catalogue);

  assert.equal(inventory.length, 840);
  assert.equal(new Set(inventory.map(({ audioKey }) => audioKey)).size, 840);
  assert.equal(new Set(inventory.map(({ assetPath }) => assetPath)).size, 840);
  assert.equal(new Set(inventory.map(({ sourcePath }) => sourcePath)).size, 840);
  assert.deepEqual(
    Object.fromEntries(
      ['Iapetus', 'Sulafat'].map((voiceId) => [
        voiceId,
        inventory.filter((asset) => asset.voiceId === voiceId).length,
      ]),
    ),
    { Iapetus: 420, Sulafat: 420 },
  );
  assert.deepEqual(
    Object.fromEntries(
      ['word-natural', 'dictation-normal', 'dictation-slow'].map((audioKind) => [
        audioKind,
        inventory.filter((asset) => asset.audioKind === audioKind).length,
      ]),
    ),
    {
      'word-natural': 40,
      'dictation-normal': 400,
      'dictation-slow': 400,
    },
  );
  assert.deepEqual(
    Object.fromEntries(
      ['word', 'sentence'].map((sourceKind) => [
        sourceKind,
        inventory.filter((asset) => asset.sourceKind === sourceKind).length,
      ]),
    ),
    { word: 40, sentence: 800 },
  );

  for (const asset of inventory) {
    assert.equal(
      asset.audioKey,
      createAudioKeyV1({
        runtimeItemId: asset.runtimeItemId,
        sentenceId: asset.sentenceId,
        voiceId: asset.voiceId,
        pace: asset.pace,
        audioKind: asset.audioKind,
      }),
    );
    assert.match(
      asset.assetPath,
      /^audio\/(?:iapetus|sulafat)\/[a-z0-9-]+\/(?:word|sentence-[0-9]{2}-(?:normal|slow))\.m4a$/u,
    );
    assert.ok(Object.isFrozen(asset));
    assert.ok(Object.isFrozen(asset.generationSpec));
  }

  assert.deepEqual(inventory[0], {
    sequence: 1,
    audioKey: 'ks2-core:answer|word|Iapetus|natural|word-natural',
    assetPath: 'audio/iapetus/answer/word.m4a',
    runtimeItemId: 'ks2-core:answer',
    sentenceId: 'word',
    voiceId: 'Iapetus',
    pace: 'natural',
    audioKind: 'word-natural',
    input: 'answer',
    sourceKind: 'word',
    sourcePath: 'content/full-pack/audio/iapetus/answer/word.m4a',
    generationSpec: {
      sourceId: 'piper-reviewed-word-assets',
      sourceRevision: '3d6c0e939b298a9f5d7e22ec369cecf802a5dd80',
      sourceModel: null,
      sourceVoice: 'Iapetus',
      sourceKind: 'word',
      sourceFormat: 'm4a-aac-lc-mono-22050hz-48kbps',
      sourceTrackedPath: 'content/full-pack/audio/iapetus/answer/word.m4a',
      slowTempoPolicy: null,
      outputFormat: 'm4a-aac-lc-mono-22050hz-48kbps',
    },
  });
  assert.equal(
    inventory[1].sourcePath,
    'content/full-pack/audio/iapetus/answer/sentence-01-normal.m4a',
  );
  assert.equal(
    inventory[1].generationSpec.sourceRevision,
    '2f838751806c75be26d78e1ebf89bd95a86a1f2e',
  );
  assert.equal(
    inventory[1].generationSpec.sourceTrackedPath,
    inventory[1].sourcePath,
  );
  assert.equal(
    inventory[1].generationSpec.outputFormat,
    'm4a-aac-lc-mono',
  );
  assert.equal(
    inventory.at(-1).audioKey,
    'ks2-core:heart|sentence-10|Sulafat|slow|dictation-slow',
  );
  assert.equal(
    inventory.at(-1).assetPath,
    'audio/sulafat/heart/sentence-10-slow.m4a',
  );
});

test('Starter authoring copies interim words and encodes Gemini sentences', async () => {
  const generator = await readFile(
    new URL('../scripts/generate-starter-audio.mjs', import.meta.url),
    'utf8',
  );
  assert.match(generator, /--source=<absolute directory>/u);
  assert.match(generator, /sourceEncoding/u);
  assert.match(generator, /copyFile/u);
  assert.doesNotMatch(generator, /\buvx\b|\bfetch\s*\(/iu);
});

test('Starter audio authority distinguishes interim Piper words from Gemini sentences', () => {
  assert.equal(STARTER_AUDIO_AUTHORITY.schemaVersion, 1);
  assert.equal(STARTER_AUDIO_AUTHORITY.assetCount, 840);
  assert.equal(STARTER_AUDIO_AUTHORITY.runtimeGeneration, false);
  assert.equal(STARTER_AUDIO_AUTHORITY.runtimeProviderAccess, false);
  assert.equal(STARTER_AUDIO_AUTHORITY.runtimeFallback, null);
  assert.equal(STARTER_AUDIO_AUTHORITY.encoding.sampleRateHz, 16000);
  assert.equal(STARTER_AUDIO_AUTHORITY.encoding.bitrateKbps, 18);
  assert.equal(FULL_AUDIO_AUTHORITY.encoding.bitrateKbps, 48);
  assert.equal(
    STARTER_AUDIO_AUTHORITY.sources.word.id,
    'piper-reviewed-word-assets',
  );
  assert.equal(
    STARTER_AUDIO_AUTHORITY.sources.word.revision,
    '3d6c0e939b298a9f5d7e22ec369cecf802a5dd80',
  );
  assert.equal(
    STARTER_AUDIO_AUTHORITY.sources.sentence.model,
    'gemini-3.1-flash-tts-preview',
  );
  assert.equal(Object.hasOwn(STARTER_AUDIO_AUTHORITY, 'sentenceUpstream'), false);
  assert.notEqual(
    STARTER_AUDIO_AUTHORITY.sources.word.id,
    STARTER_AUDIO_AUTHORITY.sources.sentence.id,
  );
  assert.deepEqual(
    STARTER_AUDIO_AUTHORITY.profiles.map(
      ({ voiceId, role }) => ({
        voiceId,
        role,
      }),
    ),
    [
      {
        voiceId: 'Iapetus',
        role: 'male',
      },
      {
        voiceId: 'Sulafat',
        role: 'female',
      },
    ],
  );
  assert.deepEqual(STARTER_AUDIO_AUTHORITY.forbiddenRuntimeTts, [
    'Web SpeechSynthesis',
    'iOS AVSpeechSynthesizer',
    'Android TextToSpeech',
    'runtime network fallback',
  ]);
  assert.ok(Object.isFrozen(STARTER_AUDIO_AUTHORITY));
  assert.ok(Object.isFrozen(STARTER_AUDIO_AUTHORITY.profiles));
});

test('Starter audio fails closed when catalogue authority drifts', () => {
  const catalogue = structuredClone(loadStarterSpellingCatalogue());
  catalogue.audio.requiredAssetCount = 839;
  assert.throws(
    () => createStarterAudioInventory(catalogue),
    /Catalogue audio requires exactly 840 assets/u,
  );

  const changedPrompt = structuredClone(loadStarterSpellingCatalogue());
  changedPrompt.items[0].sentencePrompts[0].sentenceId = 'sentence-2';
  assert.throws(
    () => createStarterAudioInventory(changedPrompt),
    /Sentence prompts must have unique sequential IDs/u,
  );
});
