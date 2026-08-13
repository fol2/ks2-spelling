import authority from '../../config/starter-audio-authority.json' with { type: 'json' };
import {
  FULL_AUDIO_AUTHORITY,
  STARTER_AUDIO_AUTHORITY,
  validateAudioAuthority,
} from '../../src/domain/spelling/starter-audio-contract.js';

const ROOT_KEYS = Object.freeze([
  'schemaVersion',
  'catalogueId',
  'assetCount',
  'runtimeGeneration',
  'runtimeProviderAccess',
  'runtimeFallback',
  'sources',
  'sentenceUpstream',
  'sourceEncoding',
  'sourceLayout',
  'encoding',
  'profiles',
  'validation',
  'forbiddenRuntimeTts',
  'inputData',
  'disclosure',
]);
const EXTERNAL_SENTENCE_SOURCE_KEYS = Object.freeze([
  'id',
  'model',
  'distribution',
]);
const TRACKED_SENTENCE_SOURCE_KEYS = Object.freeze([
  'id',
  'model',
  'revision',
  'assetRoot',
  'distribution',
]);
const WORD_SOURCE_KEYS = Object.freeze([
  'id',
  'revision',
  'assetRoot',
  'distribution',
]);
const PROFILE_KEYS = Object.freeze([
  'voiceId',
  'role',
  'description',
]);

function fail(detail) {
  throw new TypeError(`Spelling audio authoring authority ${detail}.`);
}

function exactKeys(value, keys, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    fail(`${label} must contain exactly the reviewed fields`);
  }
}

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function stripAuthoringFields(value) {
  const runtime = structuredClone(value);
  delete runtime.sentenceUpstream;
  delete runtime.sourceLayout;
  return runtime;
}

function validate(value, runtimeAuthority) {
  const starter = runtimeAuthority.catalogueId === 'ks2-core:starter';
  exactKeys(value, ROOT_KEYS, 'root');
  exactKeys(value.sources, ['word', 'sentence'], 'sources');
  exactKeys(value.sources.word, WORD_SOURCE_KEYS, 'word source');
  exactKeys(
    value.sources.sentence,
    starter ? TRACKED_SENTENCE_SOURCE_KEYS : EXTERNAL_SENTENCE_SOURCE_KEYS,
    'sentence source',
  );
  if (
    value.sources.word.id !== 'piper-reviewed-word-assets' ||
    value.sources.sentence.id !== 'gemini-pre-generated-audio' ||
    value.sources.sentence.model !== 'gemini-3.1-flash-tts-preview'
  ) {
    fail('source identity drifted');
  }
  exactKeys(value.sourceLayout, ['word', 'sentence'], 'source layout');
  if (
    value.sourceLayout.word !== (starter
      ? 'content/full-pack/audio/<voice>/<slug>/word.m4a'
      : 'audio/<Voice>/word/<slug>.m4a') ||
    value.sourceLayout.sentence !== (starter
      ? 'content/full-pack/audio/<voice>/<slug>/sentence-<one-based index>-<normal|slow>.m4a'
      : 'audio/<Voice>/<standard|slow>/<slug>/<zero-based index>.mp3')
  ) {
    fail('source layout drifted');
  }
  if (!Array.isArray(value.profiles) || value.profiles.length !== 2) {
    fail('profiles must contain the exact two voices');
  }
  for (const profile of value.profiles) {
    exactKeys(profile, PROFILE_KEYS, 'profile');
  }
  if (
    JSON.stringify(stripAuthoringFields(value)) !==
      JSON.stringify(runtimeAuthority)
  ) {
    fail('does not reduce to the runtime-safe authority');
  }
  return freezeDeep(structuredClone(value));
}

// Any pack's audio authority document is validated by the same closed runtime
// validator its own declared identity selects; nothing here is looser than the
// two reviewed documents, which still reduce to their bundled runtime twins.
export function loadAudioAuthoringAuthority(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    fail('document must be an object');
  }
  const runtimeAuthority = validateAudioAuthority(stripAuthoringFields(document), {
    catalogueId: document.catalogueId,
    assetCount: document.assetCount,
  });
  return validate(document, runtimeAuthority);
}

export const STARTER_AUDIO_AUTHORING_AUTHORITY = validate(
  authority,
  STARTER_AUDIO_AUTHORITY,
);

const fullAuthority = {
  ...structuredClone(FULL_AUDIO_AUTHORITY),
  sentenceUpstream: structuredClone(authority.sentenceUpstream),
  sourceLayout: {
    word: 'audio/<Voice>/word/<slug>.m4a',
    sentence: 'audio/<Voice>/<standard|slow>/<slug>/<zero-based index>.mp3',
  },
};

export const FULL_AUDIO_AUTHORING_AUTHORITY = validate(
  fullAuthority,
  FULL_AUDIO_AUTHORITY,
);
