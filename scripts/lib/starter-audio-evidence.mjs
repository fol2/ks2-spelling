import { createHash } from 'node:crypto';

import { canonicaliseRfc8785Bytes } from '../../src/domain/packs/rfc8785.js';
import {
  createFullAudioInventory,
  createStarterAudioInventory,
} from '../../src/domain/spelling/starter-audio-contract.js';
import {
  FULL_AUDIO_AUTHORING_AUTHORITY,
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
  'sourceKind',
  'sourceKey',
  'sourcePath',
  'sourceByteSize',
  'sourceSha256',
  'tempoFactor',
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

function fail(detail, label = 'Starter') {
  throw new TypeError(`${label} audio evidence ${detail}.`);
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalDigest(value) {
  return digest(canonicaliseRfc8785Bytes(value));
}

export function createAudioSourceKey(asset) {
  const trackedPath = asset.generationSpec.sourceTrackedPath;
  if (asset.sourceKind === 'word') {
    const legacyWordPath = new RegExp(
      `^audio/${asset.voiceId}/word/[a-z0-9-]+\\.m4a$`,
      'u',
    );
    if (
      asset.sentenceId !== 'word' ||
      asset.audioKind !== 'word-natural' ||
      asset.generationSpec.sourceId !== 'piper-reviewed-word-assets' ||
      asset.generationSpec.sourceModel !== null ||
      !trackedPath?.endsWith(asset.assetPath) ||
      (asset.sourcePath !== trackedPath && !legacyWordPath.test(asset.sourcePath))
    ) {
      fail('source mapping drifted');
    }
    return `git/${asset.generationSpec.sourceRevision}/${trackedPath}`;
  }
  if (trackedPath !== null) {
    if (
      asset.sourcePath !== trackedPath ||
      !trackedPath.endsWith(asset.assetPath) ||
      !trackedPath.endsWith('.m4a') ||
      asset.generationSpec.sourceId !== 'gemini-pre-generated-audio' ||
      asset.generationSpec.sourceModel !== 'gemini-3.1-flash-tts-preview'
    ) {
      fail('source mapping drifted');
    }
    return `git/${asset.generationSpec.sourceRevision}/${trackedPath}`;
  }
  const prefix = `audio/${asset.voiceId}/`;
  const relativePath = asset.sourcePath.startsWith(prefix) &&
    asset.sourcePath.endsWith('.mp3')
    ? asset.sourcePath.slice(prefix.length, -'.mp3'.length)
    : '';
  const match = /^(standard|slow)\/([a-z0-9-]+)\/([0-9]+)$/u
    .exec(relativePath);
  const speed = asset.pace === 'normal' ? 'standard' : 'slow';
  const sentenceIndex = Number(asset.sentenceId.slice('sentence-'.length)) - 1;
  if (
    asset.sourceKind !== 'sentence' ||
    !match ||
    match[1] !== speed ||
    Number(match[3]) !== sentenceIndex
  ) {
    fail('source mapping drifted');
  }
  const slug = match[2];
  return `spelling-audio/v1/${asset.generationSpec.sourceModel}/${asset.voiceId}/${speed}/${slug}/${sentenceIndex}.mp3`;
}

function exactKeys(value, keys, field, label = 'Starter') {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    fail(`${field} must contain exactly the approved fields`, label);
  }
}

function finite(value, field, label = 'Starter') {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${field} must be finite`, label);
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
    label = 'Starter',
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
    fail('PCM input is invalid', label);
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
    fail('PCM input contains no measurable signal', label);
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

function createAudioEvidenceAuthority(catalogue, authority, inventory) {
  return Object.freeze({
    authoritySha256: canonicalDigest(authority),
    catalogueSha256: canonicalDigest(catalogue),
    inventorySha256: canonicalDigest(inventory),
  });
}

export function createStarterAudioEvidenceAuthority(
  catalogue,
  { inventory = createStarterAudioInventory(catalogue) } = {},
) {
  return createAudioEvidenceAuthority(
    catalogue,
    STARTER_AUDIO_AUTHORITY,
    inventory,
  );
}

export function createFullAudioEvidenceAuthority(
  catalogue,
  { inventory = createFullAudioInventory(catalogue) } = {},
) {
  return createAudioEvidenceAuthority(
    catalogue,
    FULL_AUDIO_AUTHORING_AUTHORITY,
    inventory,
  );
}

function durationRange(audioKind, authority) {
  const validation = authority.validation;
  if (audioKind === 'word-natural') return validation.wordDurationMs;
  if (audioKind === 'dictation-normal') return validation.normalDurationMs;
  return validation.slowDurationMs;
}

function inRange(value, range) {
  return value >= range.minimum && value <= range.maximum;
}

function validateAudioEvidence(
  candidate,
  { catalogue, inventory: suppliedInventory },
  { authority, createInventory, createEvidenceAuthority, label },
) {
  const inventory = suppliedInventory ?? createInventory(catalogue);
  const evidenceAuthority = createEvidenceAuthority(catalogue, { inventory });
  exactKeys(candidate, ROOT_KEYS, 'root', label);
  if (
    candidate.schemaVersion !== 1 ||
    candidate.status !== 'pass' ||
    candidate.catalogueId !== authority.catalogueId ||
    candidate.authoritySha256 !== evidenceAuthority.authoritySha256 ||
    candidate.catalogueSha256 !== evidenceAuthority.catalogueSha256 ||
    candidate.inventorySha256 !== evidenceAuthority.inventorySha256 ||
    candidate.assetCount !== inventory.length ||
    candidate.format !== authority.encoding.format ||
    !Array.isArray(candidate.assets) ||
    candidate.assets.length !== inventory.length
  ) {
    fail('root authority or inventory drifted', label);
  }

  const normalDurationByPrompt = new Map();
  for (const [index, record] of candidate.assets.entries()) {
    const expected = inventory[index];
    exactKeys(record, ASSET_KEYS, `asset ${index + 1}`, label);
    const inputSha256 = digest(Buffer.from(expected.input));
    const generationSpecSha256 = digest(
      Buffer.from(JSON.stringify(expected.generationSpec)),
    );
    const durationMs = finite(record.durationMs, 'duration', label);
    const meanDbfs = finite(record.meanDbfs, 'mean level', label);
    const peakDbfs = finite(record.peakDbfs, 'peak level', label);
    const leadingSilenceMs = finite(
      record.leadingSilenceMs,
      'leading silence',
      label,
    );
    const trailingSilenceMs = finite(
      record.trailingSilenceMs,
      'trailing silence',
      label,
    );
    const validation = authority.validation;
    const outputEncoding = expected.sourceKind === 'word'
      ? authority.sourceEncoding.word
      : authority.encoding;
    const sourceKey = createAudioSourceKey(expected);
    if (
      record.sequence !== expected.sequence ||
      record.audioKey !== expected.audioKey ||
      record.assetPath !== expected.assetPath ||
      record.sourceKind !== expected.sourceKind ||
      record.sourceKey !== sourceKey ||
      record.sourcePath !== expected.sourcePath ||
      !Number.isSafeInteger(record.sourceByteSize) ||
      record.sourceByteSize <= 0 ||
      typeof record.sourceSha256 !== 'string' ||
      !HASH.test(record.sourceSha256) ||
      typeof record.tempoFactor !== 'number' ||
      !Number.isFinite(record.tempoFactor) ||
      record.tempoFactor <= 0 ||
      (expected.audioKind !== 'dictation-slow' && record.tempoFactor !== 1) ||
      record.inputSha256 !== inputSha256 ||
      record.generationSpecSha256 !== generationSpecSha256 ||
      !Number.isSafeInteger(record.byteSize) ||
      record.byteSize <= 0 ||
      typeof record.sha256 !== 'string' ||
      !HASH.test(record.sha256) ||
      record.codec !== 'aac' ||
      record.sampleRateHz !== outputEncoding.sampleRateHz ||
      record.channels !== outputEncoding.channels ||
      !inRange(durationMs, durationRange(expected.audioKind, authority)) ||
      !inRange(meanDbfs, validation.meanDbfs) ||
      !inRange(peakDbfs, validation.peakDbfs) ||
      peakDbfs < meanDbfs ||
      leadingSilenceMs < 0 ||
      leadingSilenceMs > validation.maximumLeadingSilenceMs ||
      trailingSilenceMs < 0 ||
      trailingSilenceMs > validation.maximumTrailingSilenceMs
    ) {
      fail(
        `asset ${index + 1} differs from its authority or quality bounds`,
        label,
      );
    }
    if (
      expected.sourceKind === 'word' &&
      (record.sourceByteSize !== record.byteSize ||
        record.sourceSha256 !== record.sha256)
    ) {
      fail(
        `asset ${index + 1} word bytes differ from the pinned interim source`,
        label,
      );
    }
    const promptKey =
      `${expected.runtimeItemId}|${expected.sentenceId}|${expected.voiceId}`;
    if (expected.audioKind === 'dictation-normal') {
      normalDurationByPrompt.set(promptKey, durationMs);
    } else if (expected.audioKind === 'dictation-slow') {
      const normalDuration = normalDurationByPrompt.get(promptKey);
      const ratio = authority.validation.slowDurationRatio;
      if (
        normalDuration === undefined ||
        durationMs < normalDuration * ratio.minimum ||
        durationMs > normalDuration * ratio.maximum
      ) {
        fail(`asset ${index + 1} is not a bounded slow variant`, label);
      }
    }
  }
  return structuredClone(candidate);
}

export function validateStarterAudioEvidence(
  candidate,
  { catalogue, inventory } = {},
) {
  return validateAudioEvidence(candidate, { catalogue, inventory }, {
    authority: STARTER_AUDIO_AUTHORITY,
    createInventory: createStarterAudioInventory,
    createEvidenceAuthority: createStarterAudioEvidenceAuthority,
    label: 'Starter',
  });
}

export function validateFullAudioEvidence(
  candidate,
  { catalogue, inventory } = {},
) {
  return validateAudioEvidence(candidate, { catalogue, inventory }, {
    authority: FULL_AUDIO_AUTHORING_AUTHORITY,
    createInventory: createFullAudioInventory,
    createEvidenceAuthority: createFullAudioEvidenceAuthority,
    label: 'Full',
  });
}
