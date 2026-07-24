import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAudioKeyV1,
  loadStarterSpellingCatalogue,
} from '../src/domain/spelling/index.js';
import {
  STARTER_AUDIO_AUTHORITY,
  createStarterAudioInventory,
} from '../src/domain/spelling/starter-audio-contract.js';

test('Starter audio derives the complete frozen 840-asset matrix', () => {
  const catalogue = loadStarterSpellingCatalogue();
  const inventory = createStarterAudioInventory(catalogue);

  assert.equal(inventory.length, 840);
  assert.equal(new Set(inventory.map(({ audioKey }) => audioKey)).size, 840);
  assert.equal(new Set(inventory.map(({ assetPath }) => assetPath)).size, 840);
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
    input: 'answer.',
    generationSpec: {
      engine: 'piper-tts',
      engineVersion: '1.5.0',
      model: 'en_GB-northern_english_male-medium',
      modelSha256: '57a219ae8e638873db7d18893304be5069c42868f392bb95c3ff17f0690d0689',
      configSha256: '69557ed3d974463453e9b0c09dd99a7ed0e52b8b87b64b357dbeeb2540a97d47',
      noiseScale: 0,
      noiseWScale: 0,
      lengthScale: 1,
      outputFormat: 'm4a-aac-lc-mono-22050hz-48kbps',
    },
  });
  assert.equal(
    inventory.at(-1).audioKey,
    'ks2-core:heart|sentence-10|Sulafat|slow|dictation-slow',
  );
  assert.equal(
    inventory.at(-1).assetPath,
    'audio/sulafat/heart/sentence-10-slow.m4a',
  );
});

test('Starter audio authority is authoring-only, local at runtime and licence-explicit', () => {
  assert.equal(STARTER_AUDIO_AUTHORITY.schemaVersion, 1);
  assert.equal(STARTER_AUDIO_AUTHORITY.assetCount, 840);
  assert.equal(STARTER_AUDIO_AUTHORITY.runtimeGeneration, false);
  assert.equal(STARTER_AUDIO_AUTHORITY.runtimeProviderAccess, false);
  assert.equal(STARTER_AUDIO_AUTHORITY.runtimeFallback, null);
  assert.equal(STARTER_AUDIO_AUTHORITY.engine.id, 'piper-tts');
  assert.equal(STARTER_AUDIO_AUTHORITY.engine.version, '1.5.0');
  assert.equal(
    STARTER_AUDIO_AUTHORITY.engine.sourceSha256,
    '6053a505a61bbc8fa16dc06498355ae202c3470d0571397afa54e2d106ef5259',
  );
  assert.deepEqual(
    STARTER_AUDIO_AUTHORITY.profiles.map(
      ({ voiceId, role, model, datasetLicence, outputLicence }) => ({
        voiceId,
        role,
        model,
        datasetLicence,
        outputLicence,
      }),
    ),
    [
      {
        voiceId: 'Iapetus',
        role: 'male',
        model: 'en_GB-northern_english_male-medium',
        datasetLicence: 'CC-BY-SA-4.0',
        outputLicence: 'CC-BY-SA-4.0',
      },
      {
        voiceId: 'Sulafat',
        role: 'female',
        model: 'en_GB-cori-medium',
        datasetLicence: 'Public-Domain',
        outputLicence: 'Public-Domain',
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
