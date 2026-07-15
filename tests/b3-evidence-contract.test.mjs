import assert from 'node:assert/strict';
import test from 'node:test';
import {
  B3_SYNTHETIC_LEARNER_AUTHORITY_SHA256,
  validateB3CloudflareEvidence,
  validateB3PlatformEvidence,
} from '../scripts/lib/b3-evidence.mjs';
import {
  B3_TEST_HASH,
  cloudflareEvidence,
  platformEvidence,
} from './helpers/b3-evidence-fixtures.mjs';

test('Cloudflare evidence accepts only the exact redacted closed shape and object order', () => {
  assert.deepEqual(validateB3CloudflareEvidence(cloudflareEvidence()), cloudflareEvidence());
  const wrongOrder = cloudflareEvidence();
  wrongOrder.objects.reverse();
  assert.throws(() => validateB3CloudflareEvidence(wrongOrder), /closed schema|object order/i);
  const leaked = cloudflareEvidence();
  leaked.rawCapability = 'secret';
  assert.throws(() => validateB3CloudflareEvidence(leaked), /closed schema/i);
  const smuggled = cloudflareEvidence();
  smuggled.worker.deploymentVersionId = 'https://example.invalid/?token=raw';
  assert.throws(() => validateB3CloudflareEvidence(smuggled), /authority/i);
});

test('platform evidence enforces physical scenarios, tracked learners and privacy', () => {
  assert.equal(validateB3PlatformEvidence(platformEvidence()).platform, 'ios-physical');
  assert.equal(validateB3PlatformEvidence(platformEvidence('android-play-physical')).platform, 'android-play-physical');
  assert.match(B3_SYNTHETIC_LEARNER_AUTHORITY_SHA256, /^[0-9a-f]{64}$/u);
  for (const field of ['signingCertificateSha256', 'playAppSigningCertificateSha256']) {
    const invalid = platformEvidence();
    invalid.distribution[field] = B3_TEST_HASH;
    assert.throws(() => validateB3PlatformEvidence(invalid), /closed schema|certificate/i);
  }
  const duplicateTrace = platformEvidence();
  duplicateTrace.transitions[6].gatewayTraces[0].traceId = duplicateTrace.transitions[3].gatewayTraces[0].traceId;
  assert.throws(() => validateB3PlatformEvidence(duplicateTrace), /trace/i);
  for (const privateValue of ['Ada', 'learner-a', 'child@example.test', 'opaque-base64-token-value']) {
    const smuggled = platformEvidence();
    smuggled.device.model = privateValue;
    assert.throws(() => validateB3PlatformEvidence(smuggled), /device|privacy|authority/i);
  }
  const learnerDrift = platformEvidence();
  learnerDrift.learnerPreservation[0].learnerAInitialSha256 = B3_TEST_HASH;
  learnerDrift.learnerPreservation[0].learnerAFinalSha256 = B3_TEST_HASH;
  assert.throws(() => validateB3PlatformEvidence(learnerDrift), /learner preservation/i);
  const packDrift = platformEvidence();
  packDrift.pack.archiveSha256 = 'c'.repeat(64);
  assert.throws(() => validateB3PlatformEvidence(packDrift), /pack evidence/i);
  const duplicateSplit = platformEvidence('android-play-physical');
  duplicateSplit.distribution.installedApks.push({ order: 2, kind: 'split', splitName: 'config.en', sha256: B3_TEST_HASH });
  assert.throws(() => validateB3PlatformEvidence(duplicateSplit), /pm path order/i);
});
