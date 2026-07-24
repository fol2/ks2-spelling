import evidence from '../../reports/c1/starter-audio-evidence.json' with { type: 'json' };
import {
  createStarterAudioInventory,
} from '../domain/spelling/starter-audio-contract.js';
import { validateCatalogueV1 } from '../domain/spelling/index.js';

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

function createEvidenceByPath() {
  if (
    evidence.schemaVersion !== 1 ||
    evidence.status !== 'pass' ||
    evidence.assetCount !== 840 ||
    !Array.isArray(evidence.assets) ||
    evidence.assets.length !== evidence.assetCount
  ) {
    throw new TypeError('Starter audio playback evidence is invalid.');
  }
  const byPath = new Map();
  for (const asset of evidence.assets) {
    if (
      !asset ||
      typeof asset.assetPath !== 'string' ||
      !SHA256.test(asset.sha256) ||
      !Number.isSafeInteger(asset.byteSize) ||
      asset.byteSize < 1 ||
      asset.byteSize > 131_072 ||
      byPath.has(asset.assetPath)
    ) {
      throw new TypeError('Starter audio playback evidence contains an invalid asset.');
    }
    byPath.set(asset.assetPath, Object.freeze({
      sha256: asset.sha256,
      byteSize: asset.byteSize,
    }));
  }
  return byPath;
}

const EVIDENCE_BY_PATH = createEvidenceByPath();

function resolveAsset({ request, catalogue, inventory }) {
  const item = catalogue.items.find(
    ({ runtimeItemId }) => runtimeItemId === request.runtimeItemId,
  );
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
  const asset = inventory.find(
    (candidate) =>
      candidate.runtimeItemId === request.runtimeItemId &&
      candidate.sentenceId === sentenceId &&
      candidate.voiceId === request.voiceId &&
      candidate.audioKind === audioKind &&
      candidate.pace === pace,
  );
  const expected = asset && EVIDENCE_BY_PATH.get(asset.assetPath);
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

function defaultAudioFactory() {
  if (typeof globalThis.Audio !== 'function') {
    throw playerError('product_audio_runtime_unavailable');
  }
  return new globalThis.Audio();
}

export function createProductAudioPlayer({
  catalogue: candidateCatalogue,
  installedAudio,
  audioFactory = defaultAudioFactory,
} = {}) {
  requireMethod(installedAudio, 'readInstalledAudio', 'installedAudio');
  if (typeof audioFactory !== 'function') {
    throw new TypeError('Product audio player requires audioFactory().');
  }
  const catalogue = validateCatalogueV1(candidateCatalogue);
  const inventory = createStarterAudioInventory(catalogue);
  let activePlayer = null;
  let generation = 0;
  let disposed = false;

  return Object.freeze({
    async play(candidate) {
      if (disposed) throw playerError('product_audio_player_disposed');
      const request = requireRequest(candidate);
      const { asset, expected } = resolveAsset({
        request,
        catalogue,
        inventory,
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
      stopPlayer(activePlayer);
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
      await player.play();
      return Object.freeze({
        status: 'playing',
        audioKey: asset.audioKey,
      });
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      stopPlayer(activePlayer);
      activePlayer = null;
    },
  });
}
