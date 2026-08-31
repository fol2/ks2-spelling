import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createSfxEngine } from '../src/app/sfx/sfx-engine.js';
import { autoAdvanceDelayMs } from '../src/app/practice-feel.js';
import {
  PRODUCT_SFX_MANIFEST,
  SFX_SPEECH_DUCK_GAIN,
  sfxGateDecision,
} from '../src/app/sfx/sfx-model.js';
import {
  PRODUCT_SFX_AUTHORED_SOURCES,
  PRODUCT_SFX_SPECS,
  isAuthoredProductSfx,
  loadAuthoredProductSfxBytes,
  renderProductSfxBytes,
  sha256Hex,
} from '../scripts/lib/product-sfx-synthesis.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('sfxGateDecision truth table covers enablement, lock, tiers and ducking', () => {
  const base = {
    name: 'correct',
    tier: 'feedback',
    enabled: true,
    unlocked: true,
    speechUntil: 0,
    now: 1000,
  };

  assert.deepEqual(sfxGateDecision({ ...base, enabled: false }), { play: false });
  assert.deepEqual(sfxGateDecision({ ...base, unlocked: false }), { play: false });
  assert.deepEqual(sfxGateDecision(base), { play: true });

  assert.deepEqual(
    sfxGateDecision({
      ...base,
      name: 'tick',
      tier: 'ui',
      speechUntil: 2000,
      now: 1500,
    }),
    { play: false },
  );

  const duckedFeedback = sfxGateDecision({
    ...base,
    name: 'correct',
    tier: 'feedback',
    speechUntil: 2000,
    now: 1500,
  });
  assert.equal(duckedFeedback.play, true);
  assert.ok(Math.abs(duckedFeedback.gainAdjust - SFX_SPEECH_DUCK_GAIN) < 1e-12);
  assert.ok(Math.abs(duckedFeedback.gainAdjust - 0.31622776601683794) < 1e-12);

  const duckedCelebration = sfxGateDecision({
    ...base,
    name: 'catch',
    tier: 'celebration',
    speechUntil: 2000,
    now: 1500,
  });
  assert.equal(duckedCelebration.play, true);
  assert.equal(duckedCelebration.gainAdjust, SFX_SPEECH_DUCK_GAIN);

  const speakingFeedback = sfxGateDecision({
    ...base,
    speaking: true,
    speechUntil: 0,
    now: 10_000,
  });
  assert.equal(speakingFeedback.play, true);
  assert.equal(speakingFeedback.gainAdjust, SFX_SPEECH_DUCK_GAIN);

  assert.deepEqual(
    sfxGateDecision({
      ...base,
      speaking: false,
      speechUntil: 0,
      now: 10_000,
    }),
    { play: true },
  );

  assert.deepEqual(
    sfxGateDecision({
      ...base,
      name: 'tick',
      tier: 'ui',
      speechUntil: 1000,
      now: 1000,
    }),
    { play: true },
  );
});

test('PRODUCT_SFX_MANIFEST hashes and sizes match public/sfx bytes', async () => {
  for (const [name, entry] of Object.entries(PRODUCT_SFX_MANIFEST)) {
    assert.equal(entry.path, `/sfx/${name}.wav`);
    assert.match(entry.tier, /^(ui|feedback|celebration)$/);
    assert.ok(entry.gain > 0 && entry.gain <= 1);
    const bytes = await readFile(join(ROOT, 'public', 'sfx', `${name}.wav`));
    assert.equal(bytes.byteLength, entry.byteSize, name);
    assert.equal(sha256Hex(bytes), entry.sha256, name);
  }
});

function createFakeContext({ initialState = 'suspended' } = {}) {
  let state = initialState;
  const started = [];
  const gains = [];

  return {
    get state() {
      return state;
    },
    async resume() {
      state = 'running';
    },
    async suspend() {
      state = 'suspended';
    },
    async close() {
      state = 'closed';
    },
    async decodeAudioData(arrayBuffer) {
      return { __fakeBuffer: true, byteLength: arrayBuffer.byteLength };
    },
    createBufferSource() {
      const source = {
        buffer: null,
        connected: null,
        start(when = 0) {
          started.push({ source, when, buffer: source.buffer });
        },
        connect(node) {
          source.connected = node;
          return node;
        },
      };
      return source;
    },
    createGain() {
      const node = {
        gain: { value: 1 },
        connected: null,
        connect(dest) {
          node.connected = dest;
          gains.push(node);
          return dest;
        },
      };
      return node;
    },
    destination: { __destination: true },
    __started: started,
    __gains: gains,
  };
}

function createFetchImpl(fileBytesByPath) {
  return async (url) => {
    const href = String(url);
    const path = href.replace(/^https?:\/\/[^/]+/, '');
    const bytes = fileBytesByPath.get(path);
    if (!bytes) {
      return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    return {
      ok: true,
      status: 200,
      url: href,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };
}

async function loadPublicSfxBytes() {
  const map = new Map();
  for (const [name, entry] of Object.entries(PRODUCT_SFX_MANIFEST)) {
    const bytes = await readFile(join(ROOT, 'public', 'sfx', `${name}.wav`));
    map.set(entry.path, bytes);
  }
  return map;
}

test('sfx engine no-ops when locked or disabled', async () => {
  const fileBytes = await loadPublicSfxBytes();
  const ctx = createFakeContext();
  const engine = createSfxEngine({
    manifest: PRODUCT_SFX_MANIFEST,
    fetchImpl: createFetchImpl(fileBytes),
    createContext: () => ctx,
    initiallyEnabled: true,
    now: () => 1000,
  });

  engine.play('correct');
  assert.equal(ctx.__started.length, 0);

  engine.setEnabled(false);
  engine.attachGestureUnlock({
    addEventListener() {},
    removeEventListener() {},
  });
  // Manually cannot unlock without gesture firing — still locked.
  engine.play('correct');
  assert.equal(ctx.__started.length, 0);
  engine.dispose();
});

test('sfx engine unlock decodes buffers and marks running', async () => {
  const fileBytes = await loadPublicSfxBytes();
  const ctx = createFakeContext({ initialState: 'suspended' });
  const listeners = [];
  const target = {
    addEventListener(type, handler, options) {
      listeners.push({ type, handler, options });
    },
    removeEventListener(type, handler) {
      const index = listeners.findIndex((entry) => entry.type === type && entry.handler === handler);
      if (index >= 0) listeners.splice(index, 1);
    },
  };

  const engine = createSfxEngine({
    manifest: PRODUCT_SFX_MANIFEST,
    fetchImpl: createFetchImpl(fileBytes),
    createContext: () => ctx,
    initiallyEnabled: true,
    now: () => 1000,
  });

  engine.attachGestureUnlock(target);
  assert.equal(listeners.length, 2);
  assert.ok(listeners.every((entry) => entry.options?.capture === true && entry.options?.passive === true));

  listeners[0].handler();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    engine.play('correct');
    if (ctx.__started.length > 0) break;
  }

  assert.equal(ctx.state, 'running');
  assert.equal(listeners.length, 0, 'unlock listeners removed once running');
  assert.equal(ctx.__started.length, 1);
  assert.equal(ctx.__gains[0].gain.value, PRODUCT_SFX_MANIFEST.correct.gain);

  engine.dispose();
  assert.equal(ctx.state, 'closed');
});

test('sfx engine ducks feedback during speech and suppresses ui', async () => {
  const fileBytes = await loadPublicSfxBytes();
  const ctx = createFakeContext({ initialState: 'running' });
  let clock = 1000;
  const listeners = [];
  const target = {
    addEventListener(type, handler) {
      listeners.push({ type, handler });
    },
    removeEventListener(type, handler) {
      const index = listeners.findIndex((entry) => entry.type === type && entry.handler === handler);
      if (index >= 0) listeners.splice(index, 1);
    },
  };

  const engine = createSfxEngine({
    manifest: PRODUCT_SFX_MANIFEST,
    fetchImpl: createFetchImpl(fileBytes),
    createContext: () => ctx,
    initiallyEnabled: true,
    now: () => clock,
  });

  engine.attachGestureUnlock(target);
  listeners[0].handler();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    engine.play('correct');
    if (ctx.__started.length > 0) break;
  }
  assert.equal(ctx.__started.length, 1, 'precondition: unlock decoded correct');
  ctx.__started.length = 0;
  ctx.__gains.length = 0;

  engine.noteSpeechStarted(500);
  clock = 1200;

  engine.play('tick');
  assert.equal(ctx.__started.length, 0, 'ui suppressed during speech');

  engine.play('correct');
  assert.equal(ctx.__started.length, 1);
  assert.ok(
    Math.abs(ctx.__gains[0].gain.value - PRODUCT_SFX_MANIFEST.correct.gain * SFX_SPEECH_DUCK_GAIN) < 1e-12,
  );

  engine.noteSpeechEnded();
  ctx.__started.length = 0;
  ctx.__gains.length = 0;
  engine.play('correct');
  assert.equal(ctx.__started.length, 1, 'correct plays after speech end');
  assert.equal(
    ctx.__gains[0].gain.value,
    PRODUCT_SFX_MANIFEST.correct.gain,
    'success sting returns to full feedback gain once dictation has ended',
  );

  engine.dispose();
});

test('sfx engine open-ended speech duck releases only on noteSpeechEnded', async () => {
  const fileBytes = await loadPublicSfxBytes();
  const ctx = createFakeContext({ initialState: 'running' });
  const listeners = [];
  const target = {
    addEventListener(type, handler) {
      listeners.push({ type, handler });
    },
    removeEventListener(type, handler) {
      const index = listeners.findIndex((entry) => entry.type === type && entry.handler === handler);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
  let clock = 1000;
  const engine = createSfxEngine({
    manifest: PRODUCT_SFX_MANIFEST,
    fetchImpl: createFetchImpl(fileBytes),
    createContext: () => ctx,
    initiallyEnabled: true,
    now: () => clock,
  });

  engine.attachGestureUnlock(target);
  listeners[0].handler();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    engine.play('correct');
    if (ctx.__started.length > 0) break;
  }
  ctx.__started.length = 0;
  ctx.__gains.length = 0;

  engine.noteSpeechStarted();
  clock = 8000;
  engine.play('correct');
  assert.equal(ctx.__started.length, 1);
  assert.ok(
    Math.abs(ctx.__gains[0].gain.value - PRODUCT_SFX_MANIFEST.correct.gain * SFX_SPEECH_DUCK_GAIN) < 1e-12,
    'open-ended speech duck must still apply after 6s',
  );

  engine.noteSpeechEnded();
  ctx.__started.length = 0;
  ctx.__gains.length = 0;
  engine.play('correct');
  assert.equal(ctx.__gains[0].gain.value, PRODUCT_SFX_MANIFEST.correct.gain);

  engine.dispose();
});

test('sfx-engine and sfx-model source contracts forbid HTMLAudio and focus paths', async () => {
  const engineSource = await readFile(join(ROOT, 'src/app/sfx/sfx-engine.js'), 'utf8');
  const modelSource = await readFile(join(ROOT, 'src/app/sfx/sfx-model.js'), 'utf8');
  const forbidden = [
    /new Audio\(/,
    /product-audio-player/,
    /\.focus\(/,
    /preventDefault/,
    /visualViewport/,
  ];
  for (const pattern of forbidden) {
    assert.equal(pattern.test(engineSource), false, `sfx-engine.js must not match ${pattern}`);
    assert.equal(pattern.test(modelSource), false, `sfx-model.js must not match ${pattern}`);
  }
});

test('correct is a one-shot synthesised winning sting; retry stays authored', async () => {
  assert.equal(isAuthoredProductSfx('correct'), false);
  assert.equal(isAuthoredProductSfx('retry'), true);
  assert.equal(isAuthoredProductSfx('catch'), false);
  assert.equal(PRODUCT_SFX_AUTHORED_SOURCES.retry, 'assets/sfx/authored/retry.wav');
  assert.equal(Object.hasOwn(PRODUCT_SFX_AUTHORED_SOURCES, 'correct'), false);

  const spec = PRODUCT_SFX_SPECS.correct;
  assert.ok(spec, 'correct must be synthesised from PRODUCT_SFX_SPECS');
  assert.ok(spec.durationMs >= 1000, `winning sting must last at least 1s, got ${spec.durationMs}`);
  assert.ok(spec.durationMs <= 1500, `winning sting must stay inside 1.5s, got ${spec.durationMs}`);
  assert.ok(
    spec.durationMs <= autoAdvanceDelayMs(),
    'sting must finish before the next card autoplays',
  );
  assert.equal(spec.noise, null);
  assert.ok(spec.partials.length >= 4, 'winning sting needs a musical arpeggio, not a single ping');
  const pitches = spec.partials.map((partial) => partial.hz);
  assert.equal(
    pitches.join(','),
    [...pitches].sort((left, right) => left - right).join(','),
    'correct arpeggio must rise so the cue reads as a win',
  );

  assert.ok(PRODUCT_SFX_MANIFEST.correct.gain < PRODUCT_SFX_MANIFEST.flourish.gain);
  assert.ok(PRODUCT_SFX_MANIFEST.correct.gain < PRODUCT_SFX_MANIFEST.evolve.gain);
  assert.equal(PRODUCT_SFX_MANIFEST.correct.tier, 'feedback');

  const authored = await loadAuthoredProductSfxBytes(ROOT);
  const { files } = renderProductSfxBytes(authored);

  assert.equal(sha256Hex(files.correct), PRODUCT_SFX_MANIFEST.correct.sha256);
  assert.equal(files.correct.byteLength, PRODUCT_SFX_MANIFEST.correct.byteSize);
  assert.equal(sha256Hex(files.retry), PRODUCT_SFX_MANIFEST.retry.sha256);
  assert.equal(files.retry.byteLength, PRODUCT_SFX_MANIFEST.retry.byteSize);

  const oldDing = 'a361b62a75ce9d8c90300286f7b069225095a5a6341e74f19171842c0e5a86a7';
  const synthPaper = '74db88b68c73a79635738fd44831e891d02ec4e7ae342260628c3c655942d784';
  const quizShow = 'e601e787863d75c2fb92b5e3c0b1a4b84fafa3d7bd476adccaeee7ced619c027';
  assert.notEqual(PRODUCT_SFX_MANIFEST.correct.sha256, oldDing);
  assert.notEqual(PRODUCT_SFX_MANIFEST.correct.sha256, synthPaper);
  assert.notEqual(PRODUCT_SFX_MANIFEST.correct.sha256, quizShow);

  const pcmBytes = PRODUCT_SFX_MANIFEST.correct.byteSize - 44;
  const durationMs = (pcmBytes / 2 / 24_000) * 1000;
  assert.ok(durationMs >= 1000 && durationMs <= 1500, `public correct.wav duration ${durationMs}`);
});

test('product audio and app services arm SFX duck from speech start/end, not a timer', async () => {
  const [playerSource, servicesSource, fullSource] = await Promise.all([
    readFile(join(ROOT, 'src/app/product-audio-player.js'), 'utf8'),
    readFile(join(ROOT, 'src/app/create-product-app-services.js'), 'utf8'),
    readFile(join(ROOT, 'src/app/full-product-audio.js'), 'utf8'),
  ]);
  assert.match(playerSource, /onSpeechStarted/);
  assert.match(playerSource, /onSpeechEnded/);
  assert.match(servicesSource, /onSpeechStarted:\s*\(\)\s*=>\s*\{?\s*sfx\.noteSpeechStarted/);
  assert.match(servicesSource, /onSpeechEnded:\s*\(\)\s*=>\s*\{?\s*sfx\.noteSpeechEnded/);
  assert.match(fullSource, /onSpeechStarted/);
  assert.match(fullSource, /onSpeechEnded/);
  assert.doesNotMatch(servicesSource, /noteSpeechStarted\(6000\)/);
});
