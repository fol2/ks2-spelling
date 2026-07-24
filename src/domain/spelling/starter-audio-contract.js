import authority from '../../../config/starter-audio-runtime.json' with { type: 'json' };
import {
  createAudioKeyV1,
  validateCatalogueV1,
} from './index.js';

const HASH = /^[a-f0-9]{64}$/u;
const GIT_OBJECT_ID = /^[a-f0-9]{40}$/u;
const VOICE_IDS = Object.freeze(['Iapetus', 'Sulafat']);
const AUDIO_KINDS = Object.freeze([
  'word-natural',
  'dictation-normal',
  'dictation-slow',
]);

function fail(detail) {
  throw new TypeError(`Starter audio authority ${detail}.`);
}

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function exactKeys(value, keys, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    fail(`${label} must contain exactly the approved fields`);
  }
  return value;
}

function validateHash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) {
    fail(`${label} must be a lower-case SHA-256 digest`);
  }
}

function validateAuthority(value) {
  exactKeys(value, [
    'schemaVersion',
    'catalogueId',
    'assetCount',
    'runtimeGeneration',
    'runtimeProviderAccess',
    'runtimeFallback',
    'engine',
    'encoding',
    'profiles',
    'validation',
    'forbiddenRuntimeTts',
    'inputData',
    'disclosure',
  ], 'root');
  if (
    value.schemaVersion !== 1 ||
    value.catalogueId !== 'ks2-core:starter' ||
    value.assetCount !== 840 ||
    value.runtimeGeneration !== false ||
    value.runtimeProviderAccess !== false ||
    value.runtimeFallback !== null
  ) {
    fail('root identity or runtime boundary drifted');
  }

  exactKeys(value.engine, [
    'id',
    'version',
    'licence',
    'distribution',
    'sourceSha256',
  ], 'engine');
  if (
    value.engine.id !== 'piper-tts' ||
    value.engine.version !== '1.5.0' ||
    value.engine.licence !== 'GPL-3.0-or-later' ||
    value.engine.distribution !==
      'authoring tool only; never shipped or linked in the client'
  ) {
    fail('engine identity or distribution drifted');
  }
  validateHash(value.engine.sourceSha256, 'engine source');

  exactKeys(value.encoding, [
    'tool',
    'version',
    'distribution',
    'format',
    'sampleRateHz',
    'channels',
    'bitrateKbps',
  ], 'encoding');
  if (
    value.encoding.tool !== 'ffmpeg' ||
    value.encoding.version !== '8.1.2' ||
    value.encoding.distribution !==
      'authoring tool only; never shipped or linked in the client' ||
    value.encoding.format !== 'm4a-aac-lc-mono-22050hz-48kbps' ||
    value.encoding.sampleRateHz !== 22050 ||
    value.encoding.channels !== 1 ||
    value.encoding.bitrateKbps !== 48
  ) {
    fail('encoding authority drifted');
  }

  if (
    !Array.isArray(value.profiles) ||
    value.profiles.length !== VOICE_IDS.length
  ) {
    fail('profiles must contain the exact two approved voices');
  }
  for (const [index, profile] of value.profiles.entries()) {
    exactKeys(profile, [
      'voiceId',
      'role',
      'description',
      'model',
      'modelCommit',
      'modelSha256',
      'configSha256',
      'modelCardSha256',
      'datasetLicence',
      'outputLicence',
      'attribution',
    ], 'profile');
    if (
      profile.voiceId !== VOICE_IDS[index] ||
      !['male', 'female'].includes(profile.role) ||
      typeof profile.description !== 'string' ||
      !profile.description.includes('British English') ||
      !/^[a-zA-Z0-9_-]+$/u.test(profile.model) ||
      !GIT_OBJECT_ID.test(profile.modelCommit) ||
      !['CC-BY-SA-4.0', 'Public-Domain'].includes(profile.datasetLicence) ||
      profile.outputLicence !== profile.datasetLicence ||
      typeof profile.attribution !== 'string' ||
      profile.attribution.length === 0
    ) {
      fail('profile identity, provenance or licence drifted');
    }
    for (const [name, digest] of [
      ['model', profile.modelSha256],
      ['config', profile.configSha256],
      ['model card', profile.modelCardSha256],
    ]) {
      validateHash(digest, `${profile.voiceId} ${name}`);
    }
  }

  exactKeys(value.validation, [
    'wordDurationMs',
    'normalDurationMs',
    'slowDurationMs',
    'meanDbfs',
    'peakDbfs',
    'slowDurationRatio',
    'silenceThresholdDbfs',
    'maximumLeadingSilenceMs',
    'maximumTrailingSilenceMs',
  ], 'validation');
  for (const label of [
    'wordDurationMs',
    'normalDurationMs',
    'slowDurationMs',
    'meanDbfs',
    'peakDbfs',
    'slowDurationRatio',
  ]) {
    const range = exactKeys(value.validation[label], ['minimum', 'maximum'], label);
    if (
      typeof range.minimum !== 'number' ||
      typeof range.maximum !== 'number' ||
      !Number.isFinite(range.minimum) ||
      !Number.isFinite(range.maximum) ||
      range.minimum >= range.maximum
    ) {
      fail(`${label} must be a finite increasing range`);
    }
  }
  if (
    typeof value.validation.silenceThresholdDbfs !== 'number' ||
    !Number.isFinite(value.validation.silenceThresholdDbfs) ||
    value.validation.silenceThresholdDbfs >= 0 ||
    !Number.isSafeInteger(value.validation.maximumLeadingSilenceMs) ||
    !Number.isSafeInteger(value.validation.maximumTrailingSilenceMs) ||
    value.validation.maximumLeadingSilenceMs < 0 ||
    value.validation.maximumTrailingSilenceMs < 0
  ) {
    fail('silence ceilings must be non-negative safe integers');
  }
  if (
    JSON.stringify(value.forbiddenRuntimeTts) !==
      JSON.stringify([
        'Web SpeechSynthesis',
        'iOS AVSpeechSynthesizer',
        'Android TextToSpeech',
        'runtime network fallback',
      ]) ||
    typeof value.inputData !== 'string' ||
    !value.inputData.includes('no minor, learner or operator data') ||
    typeof value.disclosure !== 'string' ||
    value.disclosure.length === 0
  ) {
    fail('runtime fallback, input-data or disclosure boundary drifted');
  }
  return freezeDeep(structuredClone(value));
}

export const STARTER_AUDIO_AUTHORITY = validateAuthority(authority);

function createAsset({
  item,
  prompt,
  profile,
  audioKind,
  sequence,
}) {
  const sentenceId = prompt?.sentenceId ?? 'word';
  const pace = audioKind === 'word-natural'
    ? 'natural'
    : audioKind === 'dictation-normal' ? 'normal' : 'slow';
  const suffix = sentenceId === 'word'
    ? 'word'
    : `sentence-${String(Number(sentenceId.slice('sentence-'.length))).padStart(2, '0')}-${pace}`;
  const lengthScale = pace === 'slow' ? 1.35 : 1;
  return freezeDeep({
    sequence,
    audioKey: createAudioKeyV1({
      runtimeItemId: item.runtimeItemId,
      sentenceId,
      voiceId: profile.voiceId,
      pace,
      audioKind,
    }),
    assetPath:
      `audio/${profile.voiceId.toLowerCase()}/${item.itemId}/${suffix}.m4a`,
    runtimeItemId: item.runtimeItemId,
    sentenceId,
    voiceId: profile.voiceId,
    pace,
    audioKind,
    input: sentenceId === 'word' ? `${item.target}.` : prompt.text,
    generationSpec: {
      engine: STARTER_AUDIO_AUTHORITY.engine.id,
      engineVersion: STARTER_AUDIO_AUTHORITY.engine.version,
      model: profile.model,
      modelSha256: profile.modelSha256,
      configSha256: profile.configSha256,
      noiseScale: 0,
      noiseWScale: 0,
      lengthScale,
      outputFormat: STARTER_AUDIO_AUTHORITY.encoding.format,
    },
  });
}

export function createStarterAudioInventory(candidate) {
  const catalogue = validateCatalogueV1(candidate);
  if (
    catalogue.catalogueId !== STARTER_AUDIO_AUTHORITY.catalogueId ||
    catalogue.audio.requiredAssetCount !== STARTER_AUDIO_AUTHORITY.assetCount ||
    JSON.stringify(catalogue.audio.profiles) !== JSON.stringify(VOICE_IDS) ||
    JSON.stringify(catalogue.audio.kinds) !== JSON.stringify(AUDIO_KINDS)
  ) {
    fail('catalogue identity or complete audio matrix drifted');
  }
  const inventory = [];
  for (const profile of STARTER_AUDIO_AUTHORITY.profiles) {
    for (const item of catalogue.items) {
      inventory.push(createAsset({
        item,
        profile,
        audioKind: 'word-natural',
        sequence: inventory.length + 1,
      }));
      for (const prompt of item.sentencePrompts) {
        for (const audioKind of ['dictation-normal', 'dictation-slow']) {
          inventory.push(createAsset({
            item,
            prompt,
            profile,
            audioKind,
            sequence: inventory.length + 1,
          }));
        }
      }
    }
  }
  if (
    inventory.length !== STARTER_AUDIO_AUTHORITY.assetCount ||
    new Set(inventory.map(({ audioKey }) => audioKey)).size !== inventory.length ||
    new Set(inventory.map(({ assetPath }) => assetPath)).size !== inventory.length
  ) {
    fail('derived inventory is incomplete or duplicated');
  }
  return Object.freeze(inventory);
}
