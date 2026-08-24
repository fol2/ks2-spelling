import {
  createFullAudioInventory,
  createStarterAudioInventory,
} from '../domain/spelling/starter-audio-contract.js';
import {
  createAudioKeyV1,
  validateCatalogueV1,
} from '../domain/spelling/index.js';
import { markB4 } from './b4-performance-marks.js';

const REQUEST_KEYS = Object.freeze([
  'version',
  'runtimeItemId',
  'sentence',
  'voiceId',
  'kind',
]);
const VOICES = new Set(['Iapetus', 'Sulafat']);
const KINDS = new Set(['word', 'sentence', 'slow-sentence']);
const SAFE_VERSION = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function playerError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireMethod(value, method, label) {
  if (!value || typeof value !== 'object' || typeof value[method] !== 'function') {
    throw new TypeError(`${label}.${method} must be a function.`);
  }
}

function requireRequest(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== REQUEST_KEYS.length ||
    REQUEST_KEYS.some((key) => !Object.hasOwn(value, key)) ||
    typeof value.version !== 'string' ||
    !SAFE_VERSION.test(value.version) ||
    typeof value.runtimeItemId !== 'string' ||
    typeof value.sentence !== 'string' ||
    !VOICES.has(value.voiceId) ||
    !KINDS.has(value.kind)
  ) {
    throw playerError('product_audio_request_invalid');
  }
  return value;
}

function createEvidenceByPath(candidate, catalogue, inventory) {
  if (
    candidate?.schemaVersion !== 1 ||
    candidate.status !== 'pass' ||
    candidate.catalogueId !== catalogue.catalogueId ||
    candidate.assetCount !== inventory.length ||
    !Array.isArray(candidate.assets) ||
    candidate.assets.length !== candidate.assetCount
  ) {
    throw new TypeError('Product audio playback evidence is invalid.');
  }
  const expectedPaths = new Set(inventory.map(({ assetPath }) => assetPath));
  const byPath = new Map();
  for (const asset of candidate.assets) {
    if (
      !asset ||
      typeof asset.assetPath !== 'string' ||
      !expectedPaths.has(asset.assetPath) ||
      !SHA256.test(asset.sha256) ||
      !Number.isSafeInteger(asset.byteSize) ||
      asset.byteSize < 1 ||
      asset.byteSize > 131_072 ||
      byPath.has(asset.assetPath)
    ) {
      throw new TypeError('Product audio playback evidence contains an invalid asset.');
    }
    byPath.set(asset.assetPath, Object.freeze({
      sha256: asset.sha256,
      byteSize: asset.byteSize,
    }));
  }
  if (byPath.size !== expectedPaths.size) {
    throw new TypeError('Product audio playback evidence is incomplete.');
  }
  return byPath;
}

function resolveAsset({
  request,
  itemByRuntimeId,
  assetByAudioKey,
  evidenceByPath,
}) {
  const item = itemByRuntimeId.get(request.runtimeItemId);
  if (!item) throw playerError('product_audio_request_invalid');
  let sentenceId = 'word';
  let audioKind = 'word-natural';
  let pace = 'natural';
  if (request.kind !== 'word') {
    const prompt = item.sentencePrompts.find(
      ({ text }) => text === request.sentence,
    );
    if (!prompt) throw playerError('product_audio_request_invalid');
    sentenceId = prompt.sentenceId;
    audioKind = request.kind === 'sentence'
      ? 'dictation-normal'
      : 'dictation-slow';
    pace = request.kind === 'sentence' ? 'normal' : 'slow';
  }
  const audioKey = createAudioKeyV1({
    runtimeItemId: request.runtimeItemId,
    sentenceId,
    voiceId: request.voiceId,
    pace,
    audioKind,
  });
  const asset = assetByAudioKey.get(audioKey);
  const expected = asset && evidenceByPath.get(asset.assetPath);
  if (!asset || !expected) {
    throw playerError('product_audio_request_invalid');
  }
  return Object.freeze({ asset, expected });
}

function stopPlayer(player) {
  if (!player) return;
  player.pause();
  if (typeof player.removeAttribute === 'function') {
    player.removeAttribute('src');
  } else {
    player.src = '';
  }
  if (typeof player.load === 'function') player.load();
}

// One element serves the whole app. A fresh element per prompt left a media
// element behind for every word a learner ever heard, each still holding the
// encoded audio it was handed, and the WebKit renderer does not survive that
// for long: it fell over part-way through a round and took the page with it.
// Reusing one element keeps exactly one decoded source alive at a time.
let sharedAudioElement = null;

function defaultAudioFactory() {
  if (typeof globalThis.Audio !== 'function') {
    throw playerError('product_audio_runtime_unavailable');
  }
  if (!sharedAudioElement) sharedAudioElement = new globalThis.Audio();
  return sharedAudioElement;
}

export function createProductAudioPlayer({
  catalogue: candidateCatalogue,
  installedAudio,
  audioFactory = defaultAudioFactory,
  audioEvidence,
} = {}) {
  requireMethod(installedAudio, 'readInstalledAudio', 'installedAudio');
  if (typeof audioFactory !== 'function') {
    throw new TypeError('Product audio player requires audioFactory().');
  }
  const catalogue = validateCatalogueV1(candidateCatalogue);
  const inventory = catalogue.catalogueId === 'ks2-core:full'
    ? createFullAudioInventory(catalogue)
    : createStarterAudioInventory(catalogue);
  const evidenceByPath = createEvidenceByPath(
    audioEvidence,
    catalogue,
    inventory,
  );
  const itemByRuntimeId = new Map(
    catalogue.items.map((item) => [item.runtimeItemId, item]),
  );
  const assetByAudioKey = new Map(
    inventory.map(({ audioKey, assetPath }) => [
      audioKey,
      Object.freeze({ audioKey, assetPath }),
    ]),
  );
  let activePlayer = null;
  let activeEndedListener = null;
  let activeSpeechStarted = false;
  let generation = 0;
  let disposed = false;

  function finishActiveSpeech() {
    if (
      activePlayer &&
      activeEndedListener &&
      typeof activePlayer.removeEventListener === 'function'
    ) {
      activePlayer.removeEventListener('ended', activeEndedListener);
    }
    activeEndedListener = null;
    if (!activeSpeechStarted) return;
    activeSpeechStarted = false;
    markB4('product:speech-end');
  }

  function stopActivePlayer() {
    finishActiveSpeech();
    stopPlayer(activePlayer);
  }

  return Object.freeze({
    async play(candidate) {
      if (disposed) throw playerError('product_audio_player_disposed');
      const request = requireRequest(candidate);
      const { asset, expected } = resolveAsset({
        request,
        itemByRuntimeId,
        assetByAudioKey,
        evidenceByPath,
      });
      const ownGeneration = ++generation;
      const { base64 } = await installedAudio.readInstalledAudio({
        packId: catalogue.packId,
        version: request.version,
        assetPath: asset.assetPath,
        sha256: expected.sha256,
        byteSize: expected.byteSize,
      });
      if (disposed || ownGeneration !== generation) {
        return Object.freeze({
          status: 'superseded',
          audioKey: asset.audioKey,
        });
      }
      stopActivePlayer();
      const player = audioFactory();
      if (
        !player ||
        typeof player !== 'object' ||
        typeof player.play !== 'function' ||
        typeof player.pause !== 'function'
      ) {
        throw playerError('product_audio_runtime_unavailable');
      }
      player.preload = 'auto';
      player.src = `data:audio/mp4;base64,${base64}`;
      activePlayer = player;
      if (typeof player.addEventListener === 'function') {
        activeEndedListener = () => {
          if (activePlayer === player) finishActiveSpeech();
        };
        player.addEventListener('ended', activeEndedListener);
      }
      try {
        await player.play();
      } catch (error) {
        // Loading the next prompt aborts the one still starting. That is this
        // player replacing itself, not a fault with the listening pack, and
        // reporting it as one puts a repair notice in front of a learner whose
        // audio is about to play perfectly well.
        if (error?.name !== 'AbortError' && ownGeneration === generation) throw error;
        return Object.freeze({
          status: 'superseded',
          audioKey: asset.audioKey,
        });
      }
      if (disposed || ownGeneration !== generation) {
        return Object.freeze({
          status: 'superseded',
          audioKey: asset.audioKey,
        });
      }
      activeSpeechStarted = true;
      markB4('product:speech-start');
      return Object.freeze({
        status: 'playing',
        audioKey: asset.audioKey,
      });
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      stopActivePlayer();
      activePlayer = null;
    },
  });
}
