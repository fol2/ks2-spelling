/**
 * Deterministic offline synthesis for the product sound-effects layer.
 * Pure Node: no dependencies, no network, no Math.random / Date.now.
 * Byte-identical across runs on the same IEEE-754 float64 runtime.
 */

import { createHash } from 'node:crypto';

export const PRODUCT_SFX_GENERATOR_VERSION = '1';
export const PRODUCT_SFX_SAMPLE_RATE_HZ = 24_000;
export const PRODUCT_SFX_MAX_FILE_BYTES = 48 * 1024;
export const PRODUCT_SFX_MAX_TOTAL_BYTES = 300 * 1024;

/** Fixed LCG seed per sound name — never Math.random. */
const NOISE_SEEDS = Object.freeze({
  correct: 0xc0ffee01,
  retry: 0xc0ffee02,
  catch: 0xc0ffee03,
  evolve: 0xc0ffee04,
  flourish: 0xc0ffee05,
  tick: 0xc0ffee06,
  sheet: 0xc0ffee07,
  stamp: 0xc0ffee08,
});

/**
 * Synthesis parameters for each cue. Durations are wall-clock milliseconds;
 * amplitudes are peak linear gains before soft limiting.
 */
export const PRODUCT_SFX_SPECS = Object.freeze({
  // Warm B-major paper chord (F#3–B3–D#4 bloom), not a coin fifth.
  correct: Object.freeze({
    durationMs: 420,
    partials: Object.freeze([
      Object.freeze({ kind: 'sine', hz: 185, amp: 0.11, attackMs: 32, decayMs: 380 }),
      Object.freeze({ kind: 'sine', hz: 247, amp: 0.22, attackMs: 24, decayMs: 350 }),
      Object.freeze({ kind: 'sine', hz: 311, amp: 0.13, attackMs: 40, decayMs: 300, delayMs: 80 }),
    ]),
    noise: Object.freeze({ amp: 0.014, attackMs: 22, decayMs: 240, delayMs: 0, colour: 'pinkish' }),
  }),
  retry: Object.freeze({
    durationMs: 300,
    partials: Object.freeze([
      Object.freeze({ kind: 'sine', hz: 196, amp: 0.22, attackMs: 10, decayMs: 240 }),
      Object.freeze({ kind: 'sine', hz: 147, amp: 0.18, attackMs: 40, decayMs: 220 }),
    ]),
    noise: null,
  }),
  catch: Object.freeze({
    durationMs: 700,
    partials: Object.freeze([
      Object.freeze({ kind: 'sine', hz: 294, amp: 0.2, attackMs: 12, decayMs: 220, delayMs: 0 }),
      Object.freeze({ kind: 'sine', hz: 370, amp: 0.2, attackMs: 12, decayMs: 240, delayMs: 180 }),
      Object.freeze({ kind: 'triangle', hz: 440, amp: 0.22, attackMs: 14, decayMs: 320, delayMs: 360 }),
    ]),
    noise: null,
  }),
  evolve: Object.freeze({
    durationMs: 900,
    partials: Object.freeze([
      Object.freeze({ kind: 'sine', hz: 262, amp: 0.18, attackMs: 10, decayMs: 400, delayMs: 0 }),
      Object.freeze({ kind: 'sine', hz: 330, amp: 0.16, attackMs: 10, decayMs: 420, delayMs: 80 }),
      Object.freeze({ kind: 'sine', hz: 392, amp: 0.16, attackMs: 10, decayMs: 440, delayMs: 160 }),
      Object.freeze({ kind: 'triangle', hz: 523, amp: 0.12, attackMs: 20, decayMs: 500, delayMs: 240 }),
      Object.freeze({ kind: 'sine', hz: 784, amp: 0.06, attackMs: 30, decayMs: 380, delayMs: 320 }),
      Object.freeze({ kind: 'sine', hz: 1047, amp: 0.04, attackMs: 40, decayMs: 360, delayMs: 400 }),
    ]),
    noise: Object.freeze({ amp: 0.03, attackMs: 40, decayMs: 500, delayMs: 280, colour: 'pinkish' }),
  }),
  flourish: Object.freeze({
    durationMs: 600,
    partials: Object.freeze([
      Object.freeze({ kind: 'sine', hz: 349, amp: 0.2, attackMs: 14, decayMs: 360, delayMs: 0 }),
      Object.freeze({ kind: 'triangle', hz: 440, amp: 0.16, attackMs: 16, decayMs: 400, delayMs: 40 }),
      Object.freeze({ kind: 'sine', hz: 523, amp: 0.14, attackMs: 18, decayMs: 420, delayMs: 90 }),
    ]),
    noise: null,
  }),
  tick: Object.freeze({
    durationMs: 80,
    partials: Object.freeze([
      Object.freeze({ kind: 'sine', hz: 1200, amp: 0.12, attackMs: 2, decayMs: 55 }),
      Object.freeze({ kind: 'triangle', hz: 2400, amp: 0.05, attackMs: 1, decayMs: 40 }),
    ]),
    noise: Object.freeze({ amp: 0.04, attackMs: 1, decayMs: 35, delayMs: 0, colour: 'tap' }),
  }),
  sheet: Object.freeze({
    durationMs: 180,
    partials: Object.freeze([
      Object.freeze({ kind: 'sine', hz: 180, amp: 0.06, attackMs: 20, decayMs: 140 }),
    ]),
    noise: Object.freeze({ amp: 0.12, attackMs: 8, decayMs: 150, delayMs: 0, colour: 'whoosh' }),
  }),
  stamp: Object.freeze({
    durationMs: 400,
    partials: Object.freeze([
      Object.freeze({ kind: 'sine', hz: 90, amp: 0.32, attackMs: 4, decayMs: 180 }),
      Object.freeze({ kind: 'triangle', hz: 140, amp: 0.14, attackMs: 6, decayMs: 160 }),
      Object.freeze({ kind: 'sine', hz: 660, amp: 0.1, attackMs: 8, decayMs: 280, delayMs: 40 }),
    ]),
    noise: Object.freeze({ amp: 0.08, attackMs: 2, decayMs: 90, delayMs: 0, colour: 'thud' }),
  }),
});

export const PRODUCT_SFX_NAMES = Object.freeze(Object.keys(PRODUCT_SFX_SPECS).sort());

function createLcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function wave(kind, phase) {
  const cycle = phase - Math.floor(phase);
  if (kind === 'triangle') {
    return cycle < 0.5 ? cycle * 4 - 1 : 3 - cycle * 4;
  }
  return Math.sin(phase * Math.PI * 2);
}

function envelope(tMs, attackMs, decayMs) {
  if (tMs < 0) return 0;
  if (tMs < attackMs) {
    const attack = attackMs <= 0 ? 1 : tMs / attackMs;
    return attack * attack;
  }
  const intoDecay = tMs - attackMs;
  // Soft exponential: ~60 dB down by ~4× decayMs.
  return Math.exp((-intoDecay * 4) / Math.max(1, decayMs));
}

function noiseSample(rng, colour) {
  const white = rng() * 2 - 1;
  if (colour === 'whoosh' || colour === 'pinkish') {
    // One-pole low-pass approximation of pinkish texture (state held by closure).
    return white;
  }
  if (colour === 'tap' || colour === 'thud') {
    return white;
  }
  return white;
}

function renderSpec(name, spec) {
  const sampleRate = PRODUCT_SFX_SAMPLE_RATE_HZ;
  const length = Math.round((spec.durationMs / 1000) * sampleRate);
  const samples = new Float64Array(length);
  const rng = createLcg(NOISE_SEEDS[name]);

  // Coloured noise needs a running filter state for whoosh/pinkish.
  let noiseState = 0;

  for (let i = 0; i < length; i += 1) {
    const tMs = (i / sampleRate) * 1000;
    let sample = 0;

    for (const partial of spec.partials) {
      const delayMs = partial.delayMs ?? 0;
      const localMs = tMs - delayMs;
      if (localMs < 0) continue;
      const env = envelope(localMs, partial.attackMs, partial.decayMs);
      const phase = (partial.hz * localMs) / 1000;
      sample += wave(partial.kind, phase) * partial.amp * env;
    }

    if (spec.noise) {
      const delayMs = spec.noise.delayMs ?? 0;
      const localMs = tMs - delayMs;
      if (localMs >= 0) {
        const env = envelope(localMs, spec.noise.attackMs, spec.noise.decayMs);
        let n = noiseSample(rng, spec.noise.colour);
        if (spec.noise.colour === 'whoosh' || spec.noise.colour === 'pinkish') {
          noiseState = noiseState * 0.92 + n * 0.08;
          n = noiseState;
        } else if (spec.noise.colour === 'thud') {
          noiseState = noiseState * 0.7 + n * 0.3;
          n = noiseState;
        }
        sample += n * spec.noise.amp * env;
      } else {
        // Keep LCG sequence aligned when noise is delayed: still advance RNG? No —
        // delay means we simply do not sample yet; sequence starts when noise starts.
      }
    }

    samples[i] = sample;
  }

  // Soft peak limit so PCM never clips harshly.
  let peak = 0;
  for (let i = 0; i < length; i += 1) {
    const abs = samples[i] < 0 ? -samples[i] : samples[i];
    if (abs > peak) peak = abs;
  }
  if (peak > 0.95) {
    const scale = 0.95 / peak;
    for (let i = 0; i < length; i += 1) samples[i] *= scale;
  }

  return samples;
}

/**
 * Encode float samples as little-endian PCM 16-bit mono WAV.
 * Quantisation uses truncating toward zero for cross-run stability.
 */
export function encodeWavPcm16Mono(samples, sampleRate = PRODUCT_SFX_SAMPLE_RATE_HZ) {
  const dataBytes = samples.length * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);

  function writeAscii(offset, text) {
    for (let i = 0; i < text.length; i += 1) {
      bytes[offset + i] = text.charCodeAt(i);
    }
  }

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i += 1) {
    let s = samples[i];
    if (s > 1) s = 1;
    if (s < -1) s = -1;
    const int16 = s < 0 ? Math.ceil(s * 0x8000) : Math.floor(s * 0x7fff);
    view.setInt16(44 + i * 2, int16, true);
  }

  return bytes;
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Stable digest of the synthesis-parameter table (not the rendered audio). */
export function synthesisParameterDigest() {
  const payload = JSON.stringify({
    generatorVersion: PRODUCT_SFX_GENERATOR_VERSION,
    sampleRateHz: PRODUCT_SFX_SAMPLE_RATE_HZ,
    noiseSeeds: NOISE_SEEDS,
    specs: PRODUCT_SFX_SPECS,
  });
  return sha256Hex(Buffer.from(payload, 'utf8'));
}

export function renderProductSfxBytes() {
  const files = Object.create(null);
  let totalBytes = 0;

  for (const name of PRODUCT_SFX_NAMES) {
    const samples = renderSpec(name, PRODUCT_SFX_SPECS[name]);
    const wav = encodeWavPcm16Mono(samples);
    if (wav.byteLength > PRODUCT_SFX_MAX_FILE_BYTES) {
      throw new Error(`Product SFX ${name} exceeds ${PRODUCT_SFX_MAX_FILE_BYTES} bytes.`);
    }
    files[name] = wav;
    totalBytes += wav.byteLength;
  }

  if (totalBytes > PRODUCT_SFX_MAX_TOTAL_BYTES) {
    throw new Error(`Product SFX set exceeds ${PRODUCT_SFX_MAX_TOTAL_BYTES} bytes.`);
  }

  return { files, totalBytes, synthesisParameterDigest: synthesisParameterDigest() };
}

export function buildProductSfxProvenance(rendered = renderProductSfxBytes()) {
  const fileRecords = PRODUCT_SFX_NAMES.map((name) => {
    const bytes = rendered.files[name];
    return Object.freeze({
      name,
      path: `public/sfx/${name}.wav`,
      sha256: sha256Hex(bytes),
      byteSize: bytes.byteLength,
    });
  });

  return Object.freeze({
    generatorVersion: PRODUCT_SFX_GENERATOR_VERSION,
    sampleRateHz: PRODUCT_SFX_SAMPLE_RATE_HZ,
    synthesisParameterDigest: rendered.synthesisParameterDigest,
    totalBytes: rendered.totalBytes,
    files: Object.freeze(fileRecords),
  });
}
