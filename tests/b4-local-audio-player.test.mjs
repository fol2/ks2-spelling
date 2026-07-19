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
