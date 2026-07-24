import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { loadStarterSpellingCatalogue } from '../src/domain/spelling/index.js';
import {
  STARTER_AUDIO_AUTHORITY,
  createStarterAudioInventory,
} from '../src/domain/spelling/starter-audio-contract.js';
import {
  analysePcm16le,
  createStarterAudioEvidenceAuthority,
  validateStarterAudioEvidence,
} from '../scripts/lib/starter-audio-evidence.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');

function validEvidence() {
  const catalogue = loadStarterSpellingCatalogue();
  const inventory = createStarterAudioInventory(catalogue);
  const authority = createStarterAudioEvidenceAuthority(catalogue);
  return {
    schemaVersion: 1,
    status: 'pass',
    catalogueId: catalogue.catalogueId,
    ...authority,
    assetCount: inventory.length,
    format: STARTER_AUDIO_AUTHORITY.encoding.format,
    assets: inventory.map((asset) => ({
      sequence: asset.sequence,
      audioKey: asset.audioKey,
      assetPath: asset.assetPath,
      inputSha256: digest(Buffer.from(asset.input)),
      generationSpecSha256: digest(Buffer.from(JSON.stringify(asset.generationSpec))),
      byteSize: 1_000 + asset.sequence,
      sha256: digest(Buffer.from(`audio-${asset.sequence}`)),
      codec: 'aac',
      sampleRateHz: 22050,
      channels: 1,
      durationMs:
        asset.audioKind === 'word-natural' ? 800
          : asset.audioKind === 'dictation-normal' ? 1600 : 2160,
      meanDbfs: -16,
      peakDbfs: -3,
      leadingSilenceMs: 80,
      trailingSilenceMs: 120,
    })),
  };
}

test('PCM analysis measures bounded duration, level and edge silence', () => {
  const sampleRateHz = 22050;
  const samples = new Int16Array(sampleRateHz);
  const signalStart = Math.round(sampleRateHz * 0.1);
  const signalEnd = Math.round(sampleRateHz * 0.9);
  for (let index = signalStart; index < signalEnd; index += 1) {
    samples[index] = Math.round(
      Math.sin((2 * Math.PI * 440 * index) / sampleRateHz) * 16_000,
    );
  }
  const bytes = Buffer.from(samples.buffer);
  const analysis = analysePcm16le(bytes, {
    sampleRateHz,
    silenceThresholdDbfs: -50,
  });

  assert.equal(analysis.durationMs, 1000);
  assert.ok(analysis.meanDbfs > -12 && analysis.meanDbfs < -9);
  assert.ok(analysis.peakDbfs > -6.4 && analysis.peakDbfs < -6.1);
  assert.ok(analysis.leadingSilenceMs >= 99 && analysis.leadingSilenceMs <= 101);
  assert.ok(analysis.trailingSilenceMs >= 99 && analysis.trailingSilenceMs <= 101);
});

test('Starter evidence binds every generated asset to the frozen inventory', () => {
  const evidence = validEvidence();
  const validated = validateStarterAudioEvidence(evidence, {
    catalogue: loadStarterSpellingCatalogue(),
  });

  assert.equal(validated.assetCount, 840);
  assert.equal(validated.assets.length, 840);
  assert.notStrictEqual(validated, evidence);
  assert.notStrictEqual(validated.assets, evidence.assets);
});

test('Starter evidence fails closed on one representative asset substitution', () => {
  const evidence = validEvidence();
  evidence.assets[0].audioKey = evidence.assets[1].audioKey;
  assert.throws(
    () => validateStarterAudioEvidence(evidence, {
      catalogue: loadStarterSpellingCatalogue(),
    }),
    /Starter audio evidence/u,
  );
});
