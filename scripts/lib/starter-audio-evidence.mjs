import { createHash } from 'node:crypto';

import { canonicaliseRfc8785Bytes } from '../../src/domain/packs/rfc8785.js';
import {
  createStarterAudioInventory,
} from '../../src/domain/spelling/starter-audio-contract.js';
import {
  STARTER_AUDIO_AUTHORING_AUTHORITY as STARTER_AUDIO_AUTHORITY,
} from './starter-audio-authoring-authority.mjs';

const HASH = /^[a-f0-9]{64}$/u;
const ROOT_KEYS = Object.freeze([
  'schemaVersion',
  'status',
  'catalogueId',
  'authoritySha256',
  'catalogueSha256',
  'inventorySha256',
  'assetCount',
  'format',
  'assets',
]);
const ASSET_KEYS = Object.freeze([
  'sequence',
  'audioKey',
  'assetPath',
  'inputSha256',
  'generationSpecSha256',
  'byteSize',
  'sha256',
  'codec',
  'sampleRateHz',
  'channels',
  'durationMs',
  'meanDbfs',
  'peakDbfs',
  'leadingSilenceMs',
  'trailingSilenceMs',
]);

function fail(detail) {
  throw new TypeError(`Starter audio evidence ${detail}.`);
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalDigest(value) {
  return digest(canonicaliseRfc8785Bytes(value));
}

function exactKeys(value, keys, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    fail(`${label} must contain exactly the approved fields`);
  }
}

function finite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${label} must be finite`);
  }
  return value;
}

function roundMetric(value) {
  return Math.round(value * 1_000) / 1_000;
}

export function analysePcm16le(
  bytes,
  {
    sampleRateHz,
    silenceThresholdDbfs =
      STARTER_AUDIO_AUTHORITY.validation.silenceThresholdDbfs,
  } = {},
) {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength % 2 !== 0 ||
    !Number.isSafeInteger(sampleRateHz) ||
    sampleRateHz <= 0 ||
    typeof silenceThresholdDbfs !== 'number' ||
    !Number.isFinite(silenceThresholdDbfs) ||
    silenceThresholdDbfs >= 0
  ) {
    fail('PCM input is invalid');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sampleCount = bytes.byteLength / 2;
  const silenceAmplitude = 32768 * (10 ** (silenceThresholdDbfs / 20));
  let sumSquares = 0;
  let peak = 0;
  let firstSignal = -1;
  let lastSignal = -1;
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = view.getInt16(index * 2, true);
    const magnitude = Math.abs(sample);
    sumSquares += sample * sample;
    peak = Math.max(peak, magnitude);
    if (magnitude > silenceAmplitude) {
      if (firstSignal === -1) firstSignal = index;
      lastSignal = index;
    }
  }
  if (firstSignal === -1 || peak === 0 || sumSquares === 0) {
    fail('PCM input contains no measurable signal');
  }
  const rms = Math.sqrt(sumSquares / sampleCount);
  return Object.freeze({
    durationMs: roundMetric((sampleCount / sampleRateHz) * 1_000),
    meanDbfs: roundMetric(20 * Math.log10(rms / 32768)),
    peakDbfs: roundMetric(20 * Math.log10(peak / 32768)),
    leadingSilenceMs: roundMetric((firstSignal / sampleRateHz) * 1_000),
    trailingSilenceMs: roundMetric(
      ((sampleCount - lastSignal - 1) / sampleRateHz) * 1_000,
    ),
  });
}

export function createStarterAudioEvidenceAuthority(catalogue) {
  const inventory = createStarterAudioInventory(catalogue);
  return Object.freeze({
    authoritySha256: canonicalDigest(STARTER_AUDIO_AUTHORITY),
    catalogueSha256: canonicalDigest(catalogue),
    inventorySha256: canonicalDigest(inventory),
  });
}

function durationRange(audioKind) {
  const validation = STARTER_AUDIO_AUTHORITY.validation;
  if (audioKind === 'word-natural') return validation.wordDurationMs;
  if (audioKind === 'dictation-normal') return validation.normalDurationMs;
  return validation.slowDurationMs;
}

function inRange(value, range) {
  return value >= range.minimum && value <= range.maximum;
}

export function validateStarterAudioEvidence(candidate, { catalogue } = {}) {
  const inventory = createStarterAudioInventory(catalogue);
  const authority = createStarterAudioEvidenceAuthority(catalogue);
  exactKeys(candidate, ROOT_KEYS, 'root');
  if (
    candidate.schemaVersion !== 1 ||
    candidate.status !== 'pass' ||
    candidate.catalogueId !== STARTER_AUDIO_AUTHORITY.catalogueId ||
    candidate.authoritySha256 !== authority.authoritySha256 ||
    candidate.catalogueSha256 !== authority.catalogueSha256 ||
    candidate.inventorySha256 !== authority.inventorySha256 ||
    candidate.assetCount !== inventory.length ||
    candidate.format !== STARTER_AUDIO_AUTHORITY.encoding.format ||
    !Array.isArray(candidate.assets) ||
    candidate.assets.length !== inventory.length
  ) {
    fail('root authority or inventory drifted');
  }

  const normalDurationByPrompt = new Map();
  for (const [index, record] of candidate.assets.entries()) {
    const expected = inventory[index];
    exactKeys(record, ASSET_KEYS, `asset ${index + 1}`);
    const inputSha256 = digest(Buffer.from(expected.input));
    const generationSpecSha256 = digest(
      Buffer.from(JSON.stringify(expected.generationSpec)),
    );
    const durationMs = finite(record.durationMs, 'duration');
    const meanDbfs = finite(record.meanDbfs, 'mean level');
    const peakDbfs = finite(record.peakDbfs, 'peak level');
    const leadingSilenceMs = finite(record.leadingSilenceMs, 'leading silence');
    const trailingSilenceMs = finite(record.trailingSilenceMs, 'trailing silence');
    const validation = STARTER_AUDIO_AUTHORITY.validation;
    if (
      record.sequence !== expected.sequence ||
      record.audioKey !== expected.audioKey ||
      record.assetPath !== expected.assetPath ||
      record.inputSha256 !== inputSha256 ||
      record.generationSpecSha256 !== generationSpecSha256 ||
      !Number.isSafeInteger(record.byteSize) ||
      record.byteSize <= 0 ||
      typeof record.sha256 !== 'string' ||
      !HASH.test(record.sha256) ||
      record.codec !== 'aac' ||
      record.sampleRateHz !== STARTER_AUDIO_AUTHORITY.encoding.sampleRateHz ||
      record.channels !== STARTER_AUDIO_AUTHORITY.encoding.channels ||
      !inRange(durationMs, durationRange(expected.audioKind)) ||
      !inRange(meanDbfs, validation.meanDbfs) ||
      !inRange(peakDbfs, validation.peakDbfs) ||
      peakDbfs < meanDbfs ||
      leadingSilenceMs < 0 ||
      leadingSilenceMs > validation.maximumLeadingSilenceMs ||
      trailingSilenceMs < 0 ||
      trailingSilenceMs > validation.maximumTrailingSilenceMs
    ) {
      fail(`asset ${index + 1} differs from its authority or quality bounds`);
    }
    const promptKey =
      `${expected.runtimeItemId}|${expected.sentenceId}|${expected.voiceId}`;
    if (expected.audioKind === 'dictation-normal') {
      normalDurationByPrompt.set(promptKey, durationMs);
    } else if (expected.audioKind === 'dictation-slow') {
      const normalDuration = normalDurationByPrompt.get(promptKey);
      const ratio = STARTER_AUDIO_AUTHORITY.validation.slowDurationRatio;
      if (
        normalDuration === undefined ||
        durationMs < normalDuration * ratio.minimum ||
        durationMs > normalDuration * ratio.maximum
      ) {
        fail(`asset ${index + 1} is not a bounded slow variant`);
      }
    }
  }
  return structuredClone(candidate);
}
