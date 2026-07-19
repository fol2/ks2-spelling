import assert from 'node:assert/strict';
import test from 'node:test';

import { createB4LocalAudioPlayer } from '../src/app/b4-local-audio.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

function fakeAudioFactory() {
  const elements = [];
  function create() {
    const playCall = deferred();
    const listeners = new Map();
    const element = {
      currentTime: 99,
      preload: '',
      src: '',
      paused: false,
      loaded: 0,
      removed: [],
      addEventListener(name, listener) { listeners.set(name, listener); },
      emit(name) { listeners.get(name)?.(); },
      play() { return playCall.promise; },
      pause() { this.paused = true; },
      load() { this.loaded += 1; },
      removeAttribute(name) { this.removed.push(name); this.src = ''; },
      playCall,
    };
    elements.push(element);
    return element;
  }
  return { create, elements };
}

test('local player resolves on playing and sequences pooled path elements', async () => {
  const fake = fakeAudioFactory();
  const play = createB4LocalAudioPlayer({ createAudioElement: fake.create });
  const resultPromise = play(['audio/b4/b4-01.wav', 'audio/b4/b4-02.wav']);
  assert.equal(fake.elements.length, 1);
  assert.equal(fake.elements[0].src, 'audio/b4/b4-01.wav');
  assert.equal(fake.elements[0].preload, 'auto');
  assert.equal(fake.elements[0].currentTime, 0);
  fake.elements[0].playCall.resolve();
  fake.elements[0].emit('playing');
  assert.deepEqual(await resultPromise, { status: 'playing', path: 'audio/b4/b4-01.wav' });

  fake.elements[0].emit('ended');
  await Promise.resolve();
  assert.equal(fake.elements.length, 2);
  assert.equal(fake.elements[0].currentTime, 0);
  assert.equal(fake.elements[0].src, 'audio/b4/b4-01.wav', 'post-play reset keeps src for reuse');
  assert.deepEqual(fake.elements[0].removed, []);
  assert.equal(fake.elements[1].src, 'audio/b4/b4-02.wav');

  fake.elements[1].playCall.resolve();
  fake.elements[1].emit('playing');
  fake.elements[1].emit('ended');
  await Promise.resolve();
  const replay = play('audio/b4/b4-01.wav');
  assert.equal(fake.elements.length, 2, 'replay reuses the pooled element for the same path');
  fake.elements[0].playCall.resolve();
  fake.elements[0].emit('playing');
  assert.deepEqual(await replay, { status: 'playing', path: 'audio/b4/b4-01.wav' });
});

test('warm preloads paths without playing and play reuses warmed elements', async () => {
  const fake = fakeAudioFactory();
  const play = createB4LocalAudioPlayer({ createAudioElement: fake.create });
  play.warm(['audio/b4/b4-01.wav', 'audio/b4/b4-02.wav']);
  assert.equal(fake.elements.length, 2);
  assert.equal(fake.elements[0].preload, 'auto');
  assert.equal(fake.elements[0].src, 'audio/b4/b4-01.wav');
  assert.equal(fake.elements[0].loaded, 1);
  assert.equal(fake.elements[0].paused, false);
  assert.equal(fake.elements[1].preload, 'auto');
  assert.equal(fake.elements[1].src, 'audio/b4/b4-02.wav');
  assert.equal(fake.elements[1].loaded, 1);

  const resultPromise = play('audio/b4/b4-01.wav');
  assert.equal(fake.elements.length, 2, 'play after warm must not create another element');
  fake.elements[0].playCall.resolve();
  fake.elements[0].emit('playing');
  assert.deepEqual(await resultPromise, { status: 'playing', path: 'audio/b4/b4-01.wav' });
});

test('warming a ninth path evicts the oldest element with a full reset', () => {
  const fake = fakeAudioFactory();
  const play = createB4LocalAudioPlayer({ createAudioElement: fake.create });
  const paths = Array.from({ length: 8 }, (_, index) => `audio/b4/b4-0${index + 1}.wav`);
  play.warm(paths);
  assert.equal(fake.elements.length, 8);
  const oldest = fake.elements[0];
  assert.equal(oldest.src, 'audio/b4/b4-01.wav');

  play.warm(['audio/b4/b4-09.wav']);
  assert.equal(fake.elements.length, 9);
  assert.equal(oldest.paused, true);
  assert.equal(oldest.currentTime, 0);
  assert.deepEqual(oldest.removed, ['src']);
  assert.equal(oldest.src, '');
  assert.ok(oldest.loaded >= 2, 'eviction must call load after clearing src');
  assert.equal(fake.elements[8].src, 'audio/b4/b4-09.wav');
});

test('warm ignores invalid paths without throwing', () => {
  const fake = fakeAudioFactory();
  const play = createB4LocalAudioPlayer({ createAudioElement: fake.create });
  assert.doesNotThrow(() => play.warm([
    'https://example.test/audio.wav',
    'audio/b4/b4-01.wav',
    '/audio/b4/b4-02.wav',
    null,
    'audio/b4/../secret.wav',
  ]));
  assert.equal(fake.elements.length, 1);
  assert.equal(fake.elements[0].src, 'audio/b4/b4-01.wav');
});

test('flush fully resets the pool so post-background plays start from fresh elements', async () => {
  const fake = fakeAudioFactory();
  const play = createB4LocalAudioPlayer({ createAudioElement: fake.create });
  play.warm(['audio/b4/b4-01.wav', 'audio/b4/b4-02.wav']);
  assert.equal(fake.elements.length, 2);

  play.flush();
  assert.equal(fake.elements[0].removed.includes('src'), true, 'flush must fully reset pooled elements');
  assert.equal(fake.elements[1].removed.includes('src'), true);

  const replay = play('audio/b4/b4-01.wav');
  assert.equal(fake.elements.length, 3, 'a flushed path must play through a fresh element');
  fake.elements[2].playCall.resolve();
  fake.elements[2].emit('playing');
  assert.deepEqual(await replay, { status: 'playing', path: 'audio/b4/b4-01.wav' });
});

test('an errored pooled element is discarded instead of reused', async () => {
  const fake = fakeAudioFactory();
  const play = createB4LocalAudioPlayer({ createAudioElement: fake.create });
  play.warm(['audio/b4/b4-01.wav']);
  fake.elements[0].error = { code: 4 };

  const replay = play('audio/b4/b4-01.wav');
  assert.equal(fake.elements.length, 2, 'an errored element must be replaced with a fresh one');
  fake.elements[1].playCall.resolve();
  fake.elements[1].emit('playing');
  assert.deepEqual(await replay, { status: 'playing', path: 'audio/b4/b4-01.wav' });
});

test('play rejection, interruption, stale completion and rapid replay are safe', async () => {
  const fake = fakeAudioFactory();
  const errors = [];
  const play = createB4LocalAudioPlayer({
    createAudioElement: fake.create,
    onError: (error) => errors.push(error.code),
  });

  const rejected = play('audio/b4/b4-01.wav');
  fake.elements[0].playCall.reject(new Error('autoplay denied'));
  await assert.rejects(rejected, (error) => error?.code === 'b4_audio_play_failed');

  const interrupted = play('audio/b4/b4-02.wav');
  const replacement = play('audio/b4/b4-03.wav');
  await assert.rejects(interrupted, (error) => error?.code === 'b4_audio_interrupted');
  assert.equal(fake.elements[1].paused, true);
  fake.elements[1].emit('playing');
  fake.elements[1].emit('ended');
  assert.equal(fake.elements.length, 3, 'stale completion cannot create another element');

  fake.elements[2].playCall.resolve();
  fake.elements[2].emit('playing');
  await replacement;
  const rapid = play('audio/b4/b4-04.wav');
  fake.elements[3].playCall.resolve();
  fake.elements[3].emit('playing');
  await rapid;
  play.stop();
  play.dispose();
  await assert.rejects(play('audio/b4/b4-05.wav'), (error) => error?.code === 'b4_audio_player_disposed');
  assert.deepEqual(errors, []);
});

test('a stalled load retries once through a fresh element and then plays', async () => {
  const fake = fakeAudioFactory();
  const play = createB4LocalAudioPlayer({ createAudioElement: fake.create, stallRetryMs: 20 });
  const result = play('audio/b4/b4-01.wav');
  assert.equal(fake.elements.length, 1);
  // First element stalls: play() never settles, no events fire.
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(fake.elements.length, 2, 'a stalled element must be replaced by a fresh one');
  assert.equal(fake.elements[0].removed.includes('src'), true, 'the stalled element must be fully reset');
  fake.elements[1].playCall.resolve();
  fake.elements[1].emit('playing');
  assert.deepEqual(await result, { status: 'playing', path: 'audio/b4/b4-01.wav' });
});

test('a stall on the retry rejects instead of hanging forever', async () => {
  const fake = fakeAudioFactory();
  const play = createB4LocalAudioPlayer({ createAudioElement: fake.create, stallRetryMs: 20 });
  const result = play('audio/b4/b4-01.wav');
  await assert.rejects(result, (error) => error?.code === 'b4_audio_play_failed');
  assert.equal(fake.elements.length, 2, 'exactly one retry is allowed');
});

test('a fast playing start never triggers the stall retry', async () => {
  const fake = fakeAudioFactory();
  const play = createB4LocalAudioPlayer({ createAudioElement: fake.create, stallRetryMs: 20 });
  const result = play('audio/b4/b4-01.wav');
  fake.elements[0].playCall.resolve();
  fake.elements[0].emit('playing');
  assert.deepEqual(await result, { status: 'playing', path: 'audio/b4/b4-01.wav' });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(fake.elements.length, 1, 'no retry element may be created after a clean start');
});

test('local player refuses every non-local runtime source', async () => {
  const play = createB4LocalAudioPlayer({ createAudioElement: () => assert.fail('must not create audio') });
  for (const path of [
    'https://example.test/audio.wav',
    '//example.test/audio.wav',
    'data:audio/mpeg;base64,AA==',
    'blob:audio',
    '/audio/b4/b4-01.wav',
    'audio/b4/../secret.wav',
  ]) {
    await assert.rejects(play(path), (error) => error?.code === 'b4_audio_path_invalid');
  }
});

function fakeAudioContext() {
  let decodeCount = 0;
  const sources = [];
  return {
    state: 'running',
    resume() {},
    destination: {},
    async decodeAudioData(buf) {
      decodeCount += 1;
      return { duration: 0.1, byteLength: buf.byteLength };
    },
    createBufferSource() {
      const source = {
        buffer: null,
        connected: null,
        started: false,
        connect(destination) { this.connected = destination; },
        start() { this.started = true; },
        stop() {},
        disconnect() {},
        onended: null,
      };
      sources.push(source);
      return source;
    },
    close() {},
    get decodeCount() { return decodeCount; },
    get sources() { return sources; },
  };
}

function stubAudioData(paths) {
  const data = Object.fromEntries(
    paths.map((path) => [
      path,
      `data:audio/wav;base64,${Buffer.from('RIFFdata').toString('base64')}`,
    ]),
  );
  return async () => data;
}

test('web audio play resolves without creating an audio element', async () => {
  const ctx = fakeAudioContext();
  let elementCreates = 0;
  const play = createB4LocalAudioPlayer({
    createAudioElement: () => {
      elementCreates += 1;
      assert.fail('web audio path must not create an audio element');
    },
    createAudioContext: () => ctx,
    loadAudioData: stubAudioData(['audio/b4/b4-01.wav']),
  });
  const result = await play('audio/b4/b4-01.wav');
  assert.deepEqual(result, { status: 'playing', path: 'audio/b4/b4-01.wav' });
  assert.equal(ctx.sources.length, 1);
  assert.equal(ctx.sources[0].started, true);
  assert.equal(elementCreates, 0);
});

test('web audio sequences the next path when the source ends', async () => {
  const ctx = fakeAudioContext();
  const play = createB4LocalAudioPlayer({
    createAudioElement: () => assert.fail('web audio path must not create an audio element'),
    createAudioContext: () => ctx,
    loadAudioData: stubAudioData(['audio/b4/b4-01.wav', 'audio/b4/b4-02.wav']),
  });
  const result = await play(['audio/b4/b4-01.wav', 'audio/b4/b4-02.wav']);
  assert.deepEqual(result, { status: 'playing', path: 'audio/b4/b4-01.wav' });
  assert.equal(ctx.sources.length, 1);
  ctx.sources[0].onended();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ctx.sources.length, 2);
  assert.equal(ctx.sources[1].started, true);
});

test('web audio stop before onended prevents the next source', async () => {
  const ctx = fakeAudioContext();
  const play = createB4LocalAudioPlayer({
    createAudioElement: () => assert.fail('web audio path must not create an audio element'),
    createAudioContext: () => ctx,
    loadAudioData: stubAudioData([
      'audio/b4/b4-01.wav',
      'audio/b4/b4-02.wav',
      'audio/b4/b4-03.wav',
    ]),
  });
  const first = play(['audio/b4/b4-01.wav', 'audio/b4/b4-02.wav']);
  assert.deepEqual(await first, { status: 'playing', path: 'audio/b4/b4-01.wav' });
  assert.equal(ctx.sources.length, 1);

  const interrupted = play('audio/b4/b4-03.wav');
  assert.deepEqual(await interrupted, { status: 'playing', path: 'audio/b4/b4-03.wav' });
  assert.equal(ctx.sources.length, 2);

  ctx.sources[0].onended?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ctx.sources.length, 2, 'stale onended must not start the second path of the interrupted sequence');
  assert.equal(ctx.sources[1].started, true);
});

test('web audio warm decodes each path exactly once across repeated warms', async () => {
  const ctx = fakeAudioContext();
  const play = createB4LocalAudioPlayer({
    createAudioElement: () => assert.fail('web audio warm must not create an audio element'),
    createAudioContext: () => ctx,
    loadAudioData: stubAudioData(['audio/b4/b4-01.wav', 'audio/b4/b4-02.wav']),
  });
  await play.warm(['audio/b4/b4-01.wav', 'audio/b4/b4-02.wav']);
  assert.equal(ctx.decodeCount, 2);
  await play.warm(['audio/b4/b4-01.wav', 'audio/b4/b4-02.wav']);
  assert.equal(ctx.decodeCount, 2, 'repeated warm must not re-decode');
  await play.warm(['audio/b4/b4-01.wav']);
  assert.equal(ctx.decodeCount, 2);
});

test('web audio falls back to the element path when decode-on-demand fails', async () => {
  const fake = fakeAudioFactory();
  const ctx = fakeAudioContext();
  ctx.decodeAudioData = async () => {
    throw new Error('decode failed');
  };
  const play = createB4LocalAudioPlayer({
    createAudioElement: fake.create,
    createAudioContext: () => ctx,
    loadAudioData: async () => {
      throw new Error('audio data unavailable');
    },
  });
  const resultPromise = play('audio/b4/b4-01.wav');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fake.elements.length, 1, 'failed web audio decode must fall back to the element path');
  fake.elements[0].playCall.resolve();
  fake.elements[0].emit('playing');
  assert.deepEqual(await resultPromise, { status: 'playing', path: 'audio/b4/b4-01.wav' });
});

test('concurrent warm and play decode the same path only once', async () => {
  const ctx = fakeAudioContext();
  const path = 'audio/b4/b4-01.wav';
  const play = createB4LocalAudioPlayer({
    createAudioElement: () => assert.fail('web audio path must not create an audio element'),
    createAudioContext: () => ctx,
    loadAudioData: stubAudioData([path]),
  });
  const warmPromise = play.warm([path]);
  const resultPromise = play([path]);
  await warmPromise;
  assert.deepEqual(await resultPromise, { status: 'playing', path });
  assert.equal(ctx.decodeCount, 1, 'concurrent warm+play must share one in-flight decode');
});

test('a stale error on the discarded stall element does not reject the retry', async () => {
  const fake = fakeAudioFactory();
  const play = createB4LocalAudioPlayer({ createAudioElement: fake.create, stallRetryMs: 20 });
  const result = play('audio/b4/b4-01.wav');
  assert.equal(fake.elements.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(fake.elements.length, 2, 'a stalled element must be replaced by a fresh one');
  fake.elements[0].emit('error');
  fake.elements[1].playCall.resolve();
  fake.elements[1].emit('playing');
  assert.deepEqual(await result, { status: 'playing', path: 'audio/b4/b4-01.wav' });
});

test('a suspended AudioContext that fails to resume falls back to the element path', async () => {
  const fake = fakeAudioFactory();
  const ctx = fakeAudioContext();
  ctx.state = 'suspended';
  ctx.resume = async () => {};
  const play = createB4LocalAudioPlayer({
    createAudioElement: fake.create,
    createAudioContext: () => ctx,
    loadAudioData: stubAudioData(['audio/b4/b4-01.wav']),
  });
  const resultPromise = play('audio/b4/b4-01.wav');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fake.elements.length, 1, 'suspended context must fall back to the element path');
  assert.equal(ctx.sources.length, 0, 'web audio must not start when resume leaves the context suspended');
  fake.elements[0].playCall.resolve();
  fake.elements[0].emit('playing');
  assert.deepEqual(await resultPromise, { status: 'playing', path: 'audio/b4/b4-01.wav' });
});
