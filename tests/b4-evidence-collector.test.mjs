import assert from 'node:assert/strict';
import test from 'node:test';

import audioManifest from '../config/b4-audio-manifest.json' with { type: 'json' };
import { createB4PlatformRiskReport } from '../src/app/b4-development-report.js';
import {
  B4_EVIDENCE_PATHS,
  createB4DevelopmentAggregate,
  createB4DomainRoundProof,
  createB4PlatformProof,
} from '../scripts/collect-b4-development-evidence.mjs';

const HASH = 'a'.repeat(64);
const checkpoint = Object.freeze({
  commit: '1'.repeat(40),
  tree: '2'.repeat(40),
});
const runner = Object.freeze({
  runnerImage: 'local-test',
  hostOS: 'test host',
  runtime: 'test runtime',
  deviceProfile: 'test device',
  buildConfiguration: 'B4Development test',
});

function capture(platform) {
  return {
    schemaVersion: 1,
    platform,
    runner,
    limitations: ['Virtual device only.'],
    offlineBoundary: { web: "connect-src 'none'", clientTts: 'none' },
    journeys: {
      default: {
        completed: true,
        softwareKeyboardObserved: true,
        enterSubmitted: true,
        backgroundAudioStoppedCount: 2,
        resumeProgressBefore: 'Card 2 of 5',
        resumeProgressAfter: 'Card 2 of 5',
      },
      scaled: { atLeast200Percent: true, completed: true },
    },
    rawSizes: { nativePayloadBytes: 1, localDatabaseBytes: 1 },
    layout: {
      phonePortrait: 'source-phone.png',
      phoneAt200Percent: 'source-phone-200-percent.png',
      tabletPortrait: 'source-tablet-portrait.png',
      tabletLandscape: 'source-tablet-landscape.png',
    },
    platformRiskReport: createB4PlatformRiskReport({
      platform,
      runner,
      raw: {
        coldLaunchMs: 1,
        answerFeedbackMs: Array(10).fill(1),
        audioStartMs: [1, 1],
        nativePayloadBytes: 1,
        localDatabaseBytes: 1,
      },
    }),
  };
}

test('the B4 domain proof binds the frozen round and audio authority without learner data', () => {
  const proof = createB4DomainRoundProof({
    applicationCheckpoint: checkpoint,
    planSha256: HASH,
    audioManifest,
  });
  assert.deepEqual(proof.applicationCheckpoint, checkpoint);
  assert.equal(proof.characterisation.randomSeed, 42);
  assert.equal(proof.characterisation.commandCount, 21);
  assert.equal(proof.characterisation.sentencePromptCount, 10);
  assert.equal(proof.audioAuthority.assetCount, 25);
  assert.equal(proof.outcomes.deterministicRound, 'pass');
  assert.doesNotMatch(JSON.stringify(proof), /learner-a|nickname|receipt|token/iu);
});

test('platform proofs retain raw observations and bind one committed large-text screenshot', () => {
  const ios = createB4PlatformProof({
    capture: capture('ios-simulator'),
    applicationCheckpoint: checkpoint,
    bundleInput: { kind: 'directory-sha256', sha256: HASH, fileCount: 2, byteSize: 3 },
    phoneFile: 'ios-phone.png',
  });
  assert.deepEqual(ios.applicationCheckpoint, checkpoint);
  assert.equal(ios.layout.phonePortrait, 'ios-phone.png');
  assert.equal(ios.layout.phoneAt200Percent, 'ios-phone.png');
  assert.equal(ios.platformRiskReport.technicalOutcome, 'pass');
});

test('the aggregate is shallow, exact-path and cannot encode the future Gate B decision', () => {
  const ios = createB4PlatformProof({
    capture: capture('ios-simulator'),
    applicationCheckpoint: checkpoint,
    bundleInput: { kind: 'directory-sha256', sha256: HASH, fileCount: 2, byteSize: 3 },
    phoneFile: 'ios-phone.png',
  });
  const androidCapture = capture('android-emulator');
  androidCapture.platformRiskReport.observations[0].rawValue = 2_001;
  androidCapture.platformRiskReport.observations[0].result = 'investigation-required';
  androidCapture.platformRiskReport.technicalOutcome = 'investigation-required';
  const android = createB4PlatformProof({
    capture: androidCapture,
    applicationCheckpoint: checkpoint,
    bundleInput: { kind: 'file-sha256', sha256: HASH, byteSize: 3 },
    phoneFile: 'android-phone.png',
  });
  const aggregate = createB4DevelopmentAggregate({
    applicationCheckpoint: checkpoint,
    bundleInputs: { ios: ios.bundleInput, android: android.bundleInput },
    platformProofs: { ios, android },
    evidenceSha256: Object.fromEntries(B4_EVIDENCE_PATHS.slice(0, -1).map((path) => [path, HASH])),
  });
  assert.deepEqual(Object.keys(aggregate), [
    'schemaVersion',
    'productIdentifier',
    'applicationCheckpoint',
    'bundleInputs',
    'evidenceSha256',
    'claims',
    'platformOutcomes',
    'technicalOutcome',
  ]);
  assert.equal(aggregate.technicalOutcome, 'investigation-required');
  assert.equal(B4_EVIDENCE_PATHS.length, 10);
  assert.doesNotMatch(JSON.stringify(aggregate), /Gate B|GO|NO_GO|App Store|Play Store/u);
});

test('the evidence contract rejects malformed checkpoints and private capture keys', () => {
  assert.throws(
    () => createB4DomainRoundProof({
      applicationCheckpoint: { commit: 'short', tree: '2'.repeat(40) },
      planSha256: HASH,
      audioManifest,
    }),
    (error) => error?.code === 'b4_evidence_invalid',
  );
  const privateCapture = capture('ios-simulator');
  privateCapture.deviceAccount = 'private';
  assert.throws(
    () => createB4PlatformProof({
      capture: privateCapture,
      applicationCheckpoint: checkpoint,
      bundleInput: { kind: 'directory-sha256', sha256: HASH, fileCount: 2, byteSize: 3 },
      phoneFile: 'ios-phone.png',
    }),
    (error) => error?.code === 'b4_evidence_private_data',
  );
});
