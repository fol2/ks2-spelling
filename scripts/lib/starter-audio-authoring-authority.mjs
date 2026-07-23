import authority from '../../config/starter-audio-authority.json' with { type: 'json' };
import {
  STARTER_AUDIO_AUTHORITY,
} from '../../src/domain/spelling/starter-audio-contract.js';

const ROOT_KEYS = Object.freeze([
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
]);
const ENGINE_KEYS = Object.freeze([
  'id',
  'version',
  'licence',
  'distribution',
  'sourceUrl',
  'sourceSha256',
]);
const PROFILE_KEYS = Object.freeze([
  'voiceId',
  'role',
  'description',
  'model',
  'modelCommit',
  'modelUrl',
  'modelSha256',
  'configUrl',
  'configSha256',
  'modelCardUrl',
  'modelCardSha256',
  'datasetUrl',
  'datasetLicence',
  'outputLicence',
  'attribution',
]);

function fail(detail) {
  throw new TypeError(`Starter audio authoring authority ${detail}.`);
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

function stripAuthoringEndpoints(value) {
  const runtime = structuredClone(value);
  delete runtime.engine.sourceUrl;
  for (const profile of runtime.profiles) {
    delete profile.modelUrl;
    delete profile.configUrl;
    delete profile.modelCardUrl;
    delete profile.datasetUrl;
  }
  return runtime;
}

function validate(value) {
  exactKeys(value, ROOT_KEYS, 'root');
  exactKeys(value.engine, ENGINE_KEYS, 'engine');
  if (
    typeof value.engine.sourceUrl !== 'string' ||
    value.engine.sourceUrl !== 'https://pypi.org/project/piper-tts/1.5.0/'
  ) {
    fail('engine source endpoint drifted');
  }
  if (!Array.isArray(value.profiles) || value.profiles.length !== 2) {
    fail('profiles must contain the exact two voices');
  }
  for (const profile of value.profiles) {
    exactKeys(profile, PROFILE_KEYS, 'profile');
    const commit = profile.modelCommit;
    if (
      typeof profile.modelUrl !== 'string' ||
      !profile.modelUrl.startsWith(
        `https://huggingface.co/rhasspy/piper-voices/resolve/${commit}/`,
      ) ||
      typeof profile.configUrl !== 'string' ||
      !profile.configUrl.startsWith(
        `https://huggingface.co/rhasspy/piper-voices/resolve/${commit}/`,
      ) ||
      typeof profile.modelCardUrl !== 'string' ||
      !profile.modelCardUrl.startsWith(
        `https://huggingface.co/rhasspy/piper-voices/blob/${commit}/`,
      ) ||
      typeof profile.datasetUrl !== 'string' ||
      !profile.datasetUrl.startsWith('https://')
    ) {
      fail(`${profile.voiceId} source endpoint drifted`);
    }
  }
  if (
    JSON.stringify(stripAuthoringEndpoints(value)) !==
      JSON.stringify(STARTER_AUDIO_AUTHORITY)
  ) {
    fail('does not reduce to the runtime-safe authority');
  }
  return freezeDeep(structuredClone(value));
}

export const STARTER_AUDIO_AUTHORING_AUTHORITY = validate(authority);
