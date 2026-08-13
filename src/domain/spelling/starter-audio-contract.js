import authority from '../../../config/starter-audio-runtime.json' with { type: 'json' };
import fullAuthority from '../../../config/full-audio-runtime.json' with { type: 'json' };
import {
  createAudioKeyV1,
  validateCatalogueV1,
} from './index.js';

const GEMINI_MODEL = 'gemini-3.1-flash-tts-preview';
const WORD_ASSET_REVISION = '3d6c0e939b298a9f5d7e22ec369cecf802a5dd80';
const STARTER_SENTENCE_SOURCE_REVISION =
  '2f838751806c75be26d78e1ebf89bd95a86a1f2e';
const UPSTREAM_REVISION = 'dff6f57f8bf0b24e960c46d712afdbcf59c54b7d';
const VOICE_IDS = Object.freeze(['Iapetus', 'Sulafat']);
const AUDIO_KINDS = Object.freeze([
  'word-natural',
  'dictation-normal',
  'dictation-slow',
]);

function fail(detail) {
  throw new TypeError(`Spelling audio authority ${detail}.`);
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

export function validateAudioAuthority(value, { catalogueId, assetCount }) {
  if (
    typeof catalogueId !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(catalogueId) ||
    !Number.isSafeInteger(assetCount) ||
    assetCount < 1
  ) {
    fail('expected catalogue identity or asset count is not a reviewed value');
  }
  const starter = catalogueId === 'ks2-core:starter';
  exactKeys(value, [
    'schemaVersion',
    'catalogueId',
    'assetCount',
    'runtimeGeneration',
    'runtimeProviderAccess',
    'runtimeFallback',
    'sources',
    'sourceEncoding',
    'encoding',
    'profiles',
    'validation',
    'forbiddenRuntimeTts',
    'inputData',
    'disclosure',
  ], 'root');
  if (
    value.schemaVersion !== 1 ||
    value.catalogueId !== catalogueId ||
    value.assetCount !== assetCount ||
    value.runtimeGeneration !== false ||
    value.runtimeProviderAccess !== false ||
    value.runtimeFallback !== null
  ) {
    fail('root identity or runtime boundary drifted');
  }

  exactKeys(value.sources, ['word', 'sentence'], 'sources');
  exactKeys(value.sources.word, [
    'id',
    'revision',
    'assetRoot',
    'distribution',
  ], 'word source');
  if (
    value.sources.word.id !== 'piper-reviewed-word-assets' ||
    value.sources.word.revision !== WORD_ASSET_REVISION ||
    value.sources.word.assetRoot !== 'content/full-pack' ||
    value.sources.word.distribution !==
      'complete reviewed interim M4A set copied byte-for-byte; replace all words atomically'
  ) {
    fail('word source identity or atomic interim boundary drifted');
  }

  exactKeys(
    value.sources.sentence,
    starter
      ? ['id', 'model', 'revision', 'assetRoot', 'distribution']
      : ['id', 'model', 'distribution'],
    'sentence source',
  );
  if (
    value.sources.sentence.id !== 'gemini-pre-generated-audio' ||
    value.sources.sentence.model !== GEMINI_MODEL ||
    (starter
      ? value.sources.sentence.revision !== STARTER_SENTENCE_SOURCE_REVISION ||
        value.sources.sentence.assetRoot !== 'content/full-pack' ||
        value.sources.sentence.distribution !==
          'complete reviewed Full-pack M4A set re-encoded for the Starter payload; no provider access at runtime'
      : value.sources.sentence.distribution !==
        'pre-generated source audio only; no provider SDK, credentials or network access at runtime')
  ) {
    fail('sentence source identity or distribution drifted');
  }

  exactKeys(value.sourceEncoding, ['word', 'sentence'], 'source encoding');
  exactKeys(value.sourceEncoding.word, [
    'format',
    'codec',
    'sampleRateHz',
    'channels',
  ], 'word source encoding');
  if (
    value.sourceEncoding.word.format !==
      'm4a-aac-lc-mono-22050hz-48kbps' ||
    value.sourceEncoding.word.codec !== 'aac' ||
    value.sourceEncoding.word.sampleRateHz !== 22050 ||
    value.sourceEncoding.word.channels !== 1
  ) {
    fail('word source encoding drifted');
  }
  exactKeys(value.sourceEncoding.sentence, [
    'format',
    'codec',
    'sampleRateHz',
    'channels',
  ], 'sentence source encoding');
  if (
    value.sourceEncoding.sentence.format !== (starter
      ? 'm4a-aac-lc-mono-22050hz-48kbps'
      : 'mp3-mpeg-layer-iii-mono-24000hz-48kbps') ||
    value.sourceEncoding.sentence.codec !== (starter ? 'aac' : 'mp3') ||
    value.sourceEncoding.sentence.sampleRateHz !== (starter ? 22050 : 24000) ||
    value.sourceEncoding.sentence.channels !== 1
  ) {
    fail('sentence source encoding drifted');
  }

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
    value.encoding.format !== (starter
      ? 'm4a-aac-lc-mono'
      : 'm4a-aac-lc-mono-22050hz-48kbps') ||
    value.encoding.sampleRateHz !== (starter ? 16000 : 22050) ||
    value.encoding.channels !== 1 ||
    value.encoding.bitrateKbps !== (starter ? 18 : 48)
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
    ], 'profile');
    if (
      profile.voiceId !== VOICE_IDS[index] ||
      profile.role !== ['male', 'female'][index] ||
      typeof profile.description !== 'string' ||
      !profile.description.startsWith(`Gemini ${profile.voiceId} sentences `) ||
      !profile.description.includes('Piper word set')
    ) {
      fail('profile identity or provenance drifted');
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

export const STARTER_AUDIO_AUTHORITY = validateAudioAuthority(authority, {
  catalogueId: 'ks2-core:starter',
  assetCount: 840,
});
export const FULL_AUDIO_AUTHORITY = validateAudioAuthority(fullAuthority, {
  catalogueId: 'ks2-core:full',
  assetCount: 8_946,
});

function createAsset({
  authority,
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
  const sourceKind = sentenceId === 'word' ? 'word' : 'sentence';
  const sentenceIndex = sentenceId === 'word'
    ? null
    : Number(sentenceId.slice('sentence-'.length)) - 1;
  const sourceSpeed = pace === 'normal' ? 'standard' : pace;
  const sourceSlug = String(item.itemId).replace(/\s+/gu, ' ').trim()
    .toLowerCase();
  const sourceWord = String(item.target).replace(/\s+/gu, ' ').trim();
  const assetPath =
    `audio/${profile.voiceId.toLowerCase()}/${item.itemId}/${suffix}.m4a`;
  const source = authority.sources[sourceKind === 'word' ? 'word' : 'sentence'];
  // A tracked sentence source is the one that declares an in-repository
  // assetRoot; an external one is fetched by the authoring host.
  const trackedSentenceSource = Object.hasOwn(authority.sources.sentence, 'assetRoot');
  const sourcePath = trackedSentenceSource
    ? `${source.assetRoot}/${assetPath}`
    : sourceKind === 'word'
      ? `audio/${profile.voiceId}/word/${sourceSlug}.m4a`
      : `audio/${profile.voiceId}/${sourceSpeed}/${sourceSlug}/${sentenceIndex}.mp3`;
  return freezeDeep({
    sequence,
    audioKey: createAudioKeyV1({
      runtimeItemId: item.runtimeItemId,
      sentenceId,
      voiceId: profile.voiceId,
      pace,
      audioKind,
    }),
    assetPath,
    runtimeItemId: item.runtimeItemId,
    sentenceId,
    voiceId: profile.voiceId,
    pace,
    audioKind,
    input: sentenceId === 'word'
      ? sourceWord
      : `The word is ${sourceWord}. ${prompt.text} The word is ${sourceWord}.`,
    sourceKind,
    sourcePath,
    generationSpec: {
      sourceId: source.id,
      sourceRevision: source.revision ?? UPSTREAM_REVISION,
      sourceModel: source.model ?? null,
      sourceVoice: profile.voiceId,
      sourceKind,
      sourceFormat: authority.sourceEncoding[sourceKind].format,
      sourceTrackedPath: sourceKind === 'word' || trackedSentenceSource
        ? `${source.assetRoot}/${assetPath}`
        : null,
      slowTempoPolicy: audioKind === 'dictation-slow'
        ? {
          triggerMinimumRatio: authority.validation.slowDurationRatio.minimum,
          triggerMaximumRatio: authority.validation.slowDurationRatio.maximum,
          targetRatio: 1.25,
          filter: 'ffmpeg-atempo',
        }
        : null,
      outputFormat: sourceKind === 'word'
        ? authority.sourceEncoding.word.format
        : authority.encoding.format,
    },
  });
}

export function createAudioInventory(candidate, authority) {
  const catalogue = validateCatalogueV1(candidate);
  if (
    catalogue.catalogueId !== authority.catalogueId ||
    catalogue.audio.requiredAssetCount !== authority.assetCount ||
    JSON.stringify(catalogue.audio.profiles) !== JSON.stringify(VOICE_IDS) ||
    JSON.stringify(catalogue.audio.kinds) !== JSON.stringify(AUDIO_KINDS)
  ) {
    fail('catalogue identity or complete audio matrix drifted');
  }
  const inventory = [];
  for (const profile of authority.profiles) {
    for (const item of catalogue.items) {
      inventory.push(createAsset({
        authority,
        item,
        profile,
        audioKind: 'word-natural',
        sequence: inventory.length + 1,
      }));
      for (const prompt of item.sentencePrompts) {
        for (const audioKind of ['dictation-normal', 'dictation-slow']) {
          inventory.push(createAsset({
            authority,
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
    inventory.length !== authority.assetCount ||
    new Set(inventory.map(({ audioKey }) => audioKey)).size !== inventory.length ||
    new Set(inventory.map(({ assetPath }) => assetPath)).size !== inventory.length
  ) {
    fail('derived inventory is incomplete or duplicated');
  }
  return Object.freeze(inventory);
}

export function createStarterAudioInventory(candidate) {
  return createAudioInventory(candidate, STARTER_AUDIO_AUTHORITY);
}

export function createFullAudioInventory(candidate) {
  return createAudioInventory(candidate, FULL_AUDIO_AUTHORITY);
}
