import { validateB4AudioManifest } from './b4-round-contract.js';
import { markB4, measureB4 } from './b4-performance-marks.js';

const SAFE_LOCAL_PATH = /^audio\/b4\/[a-z0-9-]+\.wav$/u;
const CACHE_CAP = 8;

function audioError(code, options) {
  const error = new Error(code, options);
  error.code = code;
  return error;
}

export function resolveB4AudioPath(manifestValue, { runtimeItemId, sentence = null, slow = false }) {
  const manifest = validateB4AudioManifest(manifestValue);
  const kind = sentence === null
    ? 'word-natural'
    : slow ? 'dictation-slow' : 'dictation-normal';
  const asset = manifest.assets.find((candidate) =>
    candidate.runtimeItemId === runtimeItemId &&
    candidate.sentence === sentence &&
    candidate.kind === kind,
  );
  if (!asset || !SAFE_LOCAL_PATH.test(asset.path)) throw audioError('b4_audio_asset_missing');
  return asset.path;
}

export function createB4LocalAudioPlayer({
  createAudioElement = () => new Audio(),
  onError = () => {},
} = {}) {
  if (typeof createAudioElement !== 'function') throw new TypeError('createAudioElement must be a function.');
  if (typeof onError !== 'function') throw new TypeError('onError must be a function.');
  let active = null;
  let generation = 0;
  let disposed = false;
  const cache = new Map();

  function softReset(element) {
    element.pause();
    element.currentTime = 0;
  }

  function fullReset(element) {
    softReset(element);
    element.removeAttribute?.('src');
    element.load?.();
  }

  function remember(path, element) {
    if (cache.has(path)) return;
    while (cache.size >= CACHE_CAP) {
      const oldest = [...cache.keys()].find((key) => cache.get(key) !== active?.element);
      if (oldest === undefined) break;
      const evicted = cache.get(oldest);
      cache.delete(oldest);
      fullReset(evicted);
    }
    cache.set(path, element);
  }

  function flush() {
    for (const element of cache.values()) fullReset(element);
    cache.clear();
  }

  function acquire(path) {
    const cached = cache.get(path);
    if (cached && !cached.error) return cached;
    if (cached) {
      cache.delete(path);
      fullReset(cached);
    }
    const element = createAudioElement();
    if (!element || typeof element.play !== 'function' || typeof element.pause !== 'function') {
      throw new TypeError('createAudioElement must return an audio-like element.');
    }
    element.preload = 'auto';
    element.src = path;
    remember(path, element);
    return element;
  }

  function stop(reason = 'b4_audio_interrupted') {
    generation += 1;
    if (!active) return;
    const current = active;
    active = null;
    softReset(current.element);
    current.reject?.(audioError(reason));
  }

  async function startPath(paths, index, token, settle) {
    if (disposed || token !== generation) return;
    const path = paths[index];
    if (!path) return;
    const element = acquire(path);
    element.currentTime = 0;
    let playing = false;
    const rejectPending = (error) => {
      if (token !== generation) return;
      active = null;
      softReset(element);
      const normalised = error?.code ? error : audioError('b4_audio_play_failed', { cause: error });
      if (!settle.started) settle.reject(normalised);
      else onError(normalised);
    };
    active = {
      element,
      reject(error) {
        if (!playing) settle.reject(error);
        else onError(error);
      },
    };
    element.addEventListener('playing', () => {
      if (token !== generation || playing) return;
      playing = true;
      active.reject = null;
      if (!settle.started) {
        settle.started = true;
        measureB4('b4:audio-start', 'b4:audio-play-start');
        settle.resolve(Object.freeze({ status: 'playing', path: paths[0] }));
      }
    }, { once: true });
    element.addEventListener('ended', () => {
      if (token !== generation) return;
      softReset(element);
      active = null;
      void startPath(paths, index + 1, token, settle).catch(rejectPending);
    }, { once: true });
    element.addEventListener('error', () => rejectPending(audioError('b4_audio_play_failed')), { once: true });
    try {
      await element.play();
    } catch (error) {
      rejectPending(error);
    }
  }

  function play(paths) {
    if (disposed) return Promise.reject(audioError('b4_audio_player_disposed'));
    const sequence = Array.isArray(paths) ? [...paths] : [paths];
    if (sequence.length === 0 || sequence.some((path) => typeof path !== 'string' || !SAFE_LOCAL_PATH.test(path))) {
      return Promise.reject(audioError('b4_audio_path_invalid'));
    }
    markB4('b4:audio-play-start');
    stop();
    const token = generation;
    return new Promise((resolve, reject) => {
      void startPath(sequence, 0, token, { resolve, reject, started: false }).catch(reject);
    });
  }

  function warm(paths) {
    if (disposed) return;
    const sequence = Array.isArray(paths) ? paths : [paths];
    for (const path of sequence) {
      if (typeof path !== 'string' || !SAFE_LOCAL_PATH.test(path)) continue;
      if (cache.has(path)) continue;
      try {
        const element = createAudioElement();
        if (!element || typeof element.play !== 'function' || typeof element.pause !== 'function') continue;
        element.preload = 'auto';
        element.src = path;
        element.load?.();
        remember(path, element);
      } catch {
        // Warming is best-effort.
      }
    }
  }

  play.stop = () => stop();
  play.warm = warm;
  play.flush = flush;
  play.dispose = () => {
    if (disposed) return;
    disposed = true;
    stop('b4_audio_player_disposed');
    flush();
  };
  return Object.freeze(play);
}
