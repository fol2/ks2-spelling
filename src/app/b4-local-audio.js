import { validateB4AudioManifest } from './b4-round-contract.js';
import { markB4, measureB4 } from './b4-performance-marks.js';

const SAFE_LOCAL_PATH = /^audio\/b4\/[a-z0-9-]+\.wav$/u;
const CACHE_CAP = 8;

function audioError(code, options) {
  const error = new Error(code, options);
  error.code = code;
  return error;
}

function dataUriToArrayBuffer(dataUri) {
  const base64 = dataUri.slice(dataUri.indexOf(',') + 1);
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
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
  createAudioContext = () => (typeof AudioContext !== 'undefined' ? new AudioContext() : null),
  loadAudioData = () => import('./b4-audio-data.js').then((module) => module.B4_AUDIO_DATA),
  onError = () => {},
  stallRetryMs = 1_500,
} = {}) {
  if (typeof createAudioElement !== 'function') throw new TypeError('createAudioElement must be a function.');
  if (typeof createAudioContext !== 'function') throw new TypeError('createAudioContext must be a function.');
  if (typeof loadAudioData !== 'function') throw new TypeError('loadAudioData must be a function.');
  if (typeof onError !== 'function') throw new TypeError('onError must be a function.');
  let active = null;
  let generation = 0;
  let disposed = false;
  let context = undefined;
  let audioData = undefined;
  const cache = new Map();
  const buffers = new Map();

  function getContext() {
    if (context !== undefined) return context;
    try {
      context = createAudioContext() ?? null;
    } catch {
      context = null;
    }
    return context;
  }

  async function ensureAudioData() {
    if (audioData !== undefined) return audioData;
    try {
      audioData = await loadAudioData();
    } catch {
      audioData = null;
    }
    return audioData;
  }

  async function decodePath(path) {
    if (buffers.has(path)) return buffers.get(path);
    const ctx = getContext();
    if (!ctx) return null;
    try {
      const data = await ensureAudioData();
      const dataUri = data?.[path];
      if (typeof dataUri !== 'string') return null;
      const buffer = await ctx.decodeAudioData(dataUriToArrayBuffer(dataUri));
      buffers.set(path, buffer);
      return buffer;
    } catch {
      return null;
    }
  }

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

  function stopSource(source) {
    if (!source) return;
    try {
      source.stop();
    } catch {
      // Stopping an already-finished BufferSource throws.
    }
    try {
      source.disconnect?.();
    } catch {
      // Best-effort disconnect.
    }
  }

  function stop(reason = 'b4_audio_interrupted') {
    generation += 1;
    if (!active) return;
    const current = active;
    active = null;
    stopSource(current.source);
    if (current.element) softReset(current.element);
    current.reject?.(audioError(reason));
  }

  async function startPath(paths, index, token, settle, retried = false) {
    if (disposed || token !== generation) return;
    const path = paths[index];
    if (!path) return;
    const element = acquire(path);
    element.currentTime = 0;
    let playing = false;
    let watchdog = null;
    const clearWatchdog = () => {
      if (watchdog !== null) clearTimeout(watchdog);
      watchdog = null;
    };
    const rejectPending = (error) => {
      if (token !== generation) return;
      clearWatchdog();
      active = null;
      softReset(element);
      const normalised = error?.code ? error : audioError('b4_audio_play_failed', { cause: error });
      if (!settle.started) settle.reject(normalised);
      else onError(normalised);
    };
    // WebKit can stall a media load without ever firing 'error' or settling
    // play(); the watchdog discards the stalled element and retries once
    // through a fresh one so a single stall cannot hang the round.
    watchdog = setTimeout(() => {
      watchdog = null;
      if (token !== generation || playing) return;
      cache.delete(path);
      fullReset(element);
      if (retried) {
        rejectPending(audioError('b4_audio_play_failed'));
        return;
      }
      active = null;
      void startPath(paths, index, token, settle, true).catch(rejectPending);
    }, stallRetryMs);
    watchdog.unref?.();
    active = {
      element,
      source: null,
      reject(error) {
        clearWatchdog();
        if (!playing) settle.reject(error);
        else onError(error);
      },
    };
    element.addEventListener('playing', () => {
      if (token !== generation || playing) return;
      playing = true;
      clearWatchdog();
      active.reject = null;
      if (!settle.started) {
        settle.started = true;
        measureB4('b4:audio-start', 'b4:audio-play-start');
        settle.resolve(Object.freeze({ status: 'playing', path: paths[0] }));
      }
    }, { once: true });
    element.addEventListener('ended', () => {
      if (token !== generation) return;
      clearWatchdog();
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

  async function startWebAudioPath(paths, index, token, settle) {
    if (disposed || token !== generation) return;
    const path = paths[index];
    if (!path) return;
    const ctx = getContext();
    const buffer = await decodePath(path);
    if (disposed || token !== generation) return;
    if (!buffer) {
      if (index === 0) {
        void startPath(paths, 0, token, settle).catch((error) => {
          if (!settle.started) settle.reject(error);
          else onError(error);
        });
      }
      return;
    }
    if (ctx.state !== 'running') void ctx.resume();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const rejectPending = (error) => {
      if (token !== generation) return;
      active = null;
      stopSource(source);
      const normalised = error?.code ? error : audioError('b4_audio_play_failed', { cause: error });
      if (!settle.started) settle.reject(normalised);
      else onError(normalised);
    };
    active = {
      element: null,
      source,
      reject(error) {
        if (!settle.started) settle.reject(error);
        else onError(error);
      },
    };
    source.onended = () => {
      if (token !== generation) return;
      active = null;
      void startWebAudioPath(paths, index + 1, token, settle).catch(rejectPending);
    };
    try {
      source.start(0);
    } catch (error) {
      rejectPending(error);
      return;
    }
    if (!settle.started) {
      settle.started = true;
      measureB4('b4:audio-start', 'b4:audio-play-start');
      settle.resolve(Object.freeze({ status: 'playing', path: paths[0] }));
      if (active) active.reject = null;
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
      const settle = { resolve, reject, started: false };
      if (getContext()) {
        void startWebAudioPath(sequence, 0, token, settle).catch(reject);
        return;
      }
      void startPath(sequence, 0, token, settle).catch(reject);
    });
  }

  async function warmWebAudio(paths) {
    for (const path of paths) {
      if (typeof path !== 'string' || !SAFE_LOCAL_PATH.test(path)) continue;
      if (buffers.has(path)) continue;
      await decodePath(path);
    }
  }

  function warm(paths) {
    if (disposed) return;
    const sequence = Array.isArray(paths) ? paths : [paths];
    if (getContext()) return warmWebAudio(sequence);
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
    if (context) {
      try {
        void context.close?.();
      } catch {
        // Best-effort close.
      }
    }
  };
  return Object.freeze(play);
}
