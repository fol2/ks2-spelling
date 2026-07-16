import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  B3_SYNTHETIC_LEARNER_AUTHORITY_SHA256,
  createB3ObservationChainAuthoritySha256,
  validateB3CloudflareEvidence,
  validateB3PlatformEvidence,
} from '../scripts/lib/b3-evidence.mjs';
import {
  B3_TEST_HASH,
  cloudflareEvidence,
  platformEvidence,
} from './helpers/b3-evidence-fixtures.mjs';

const REAL_WORKER_VERSION_ID = 'a8f32f60-16b9-4ca6-9b4a-f771dd5302f7';
const REAL_MANIFEST_ETAG = 'c76b2858b8345814279a1c92ae64e365';
const REAL_ARCHIVE_ETAG = '913d2b2485ca6cd31d467bd7228d7e75';

test('public architecture states the exact local-first B3 claim boundary', async () => {
  const [readme, persistence, privacy] = await Promise.all([
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/architecture/b2-persistence-authority.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/compliance/sdk-privacy-register.md', import.meta.url), 'utf8'),
  ]);
  const publicWording = `${readme}\n${persistence}\n${privacy}`.replace(/\s+/gu, ' ');

  for (const claim of [
    /spelling practice, installed packs, learner progress and child-owned Monster progress remain local and work offline/i,
    /online access is used only for commerce verification, pack download or redownload, entitlement refresh, restore and revocation/i,
    /Monster is a motivational presentation around spelling, not an independently cloud-tracked Parent metric/i,
    /Visual \/ Theme \/ Asset Migration[^.]+after Gate B `GO`[^.]+before C3/i,
    /B3 proves sandbox\/test commerce and signed-download truth only; it does not prove production release readiness/i,
  ]) {
    assert.match(publicWording, claim);
  }
});

test('evidence accepts only UUID v4 Worker version IDs and lowercase 32-hex R2 ETags', () => {
  assert.equal(
    validateB3CloudflareEvidence(cloudflareEvidence())
      .worker.deploymentVersionId,
    REAL_WORKER_VERSION_ID,
  );
  assert.equal(
    validateB3PlatformEvidence(platformEvidence())
      .gateway.archiveObject.etag,
    REAL_ARCHIVE_ETAG,
  );

  for (const invalidWorkerVersionId of [
    'version-1',
    REAL_MANIFEST_ETAG,
    'a8f32f60-16b9-1ca6-9b4a-f771dd5302f7',
    REAL_WORKER_VERSION_ID.toUpperCase(),
    'https://example.invalid/?token=raw',
    '-----BEGIN PRIVATE KEY-----',
  ]) {
    const cloudflare = cloudflareEvidence();
    cloudflare.worker.deploymentVersionId = invalidWorkerVersionId;
    assert.throws(() => validateB3CloudflareEvidence(cloudflare), /worker|authority/i);

    const platform = platformEvidence();
    platform.gateway.deploymentVersionId = invalidWorkerVersionId;
    assert.throws(() => validateB3PlatformEvidence(platform), /gateway|authority/i);
  }

  for (const invalidEtag of [
    'safe-etag',
    REAL_WORKER_VERSION_ID,
    B3_TEST_HASH,
    REAL_MANIFEST_ETAG.toUpperCase(),
    'https://example.invalid/?cap=raw',
    'sealedRefreshHandle-secret',
  ]) {
    const cloudflare = cloudflareEvidence();
    cloudflare.objects[0].etag = invalidEtag;
    assert.throws(() => validateB3CloudflareEvidence(cloudflare), /object|authority/i);

    const platform = platformEvidence();
    platform.gateway.manifestObject.etag = invalidEtag;
    assert.throws(() => validateB3PlatformEvidence(platform), /object|authority/i);
  }
});

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
  const misleadingDevelopmentIdentity = platformEvidence();
  misleadingDevelopmentIdentity.distribution.developmentIdentityVerified = true;
  assert.throws(() => validateB3PlatformEvidence(misleadingDevelopmentIdentity), /closed schema|developer app/i);
  const nonDeveloperInstall = platformEvidence();
  nonDeveloperInstall.distribution.installedBuiltByDeveloper = false;
  assert.throws(() => validateB3PlatformEvidence(nonDeveloperInstall), /developer app|installed distribution/i);
  const duplicateTrace = platformEvidence();
  duplicateTrace.transitions[6].gatewayTraces[0].traceId = duplicateTrace.transitions[3].gatewayTraces[0].traceId;
  assert.throws(() => validateB3PlatformEvidence(duplicateTrace), /trace/i);
  for (const mutate of [
    (evidence) => {
      evidence.transitions.find(({ gatewayTraces }) => gatewayTraces.length > 1)
        .gatewayTraces.pop();
    },
    (evidence) => {
      const traces = evidence.transitions.find(({ gatewayTraces }) => gatewayTraces.length > 1)
        .gatewayTraces;
      traces.push({ ...traces.at(-1), traceId: '018f1d7b-97e8-4a52-8cf2-783e5089c099' });
    },
    (evidence) => {
      evidence.transitions.find(({ gatewayTraces }) => gatewayTraces.length > 1)
        .gatewayTraces.reverse();
    },
    (evidence) => {
      evidence.transitions.find(({ gatewayTraces }) => gatewayTraces.length > 1)
        .gatewayTraces[0].relation = 'operator-relabelled-call';
    },
  ]) {
    const changed = platformEvidence();
    mutate(changed);
    assert.throws(() => validateB3PlatformEvidence(changed), /trace|transition/i);
  }
  const brokenObservationChain = platformEvidence();
  brokenObservationChain.proofObservationChain.observations[3]
    .previousObservationSha256 = B3_TEST_HASH;
  assert.throws(
    () => validateB3PlatformEvidence(brokenObservationChain),
    /observation hash chain/i,
  );
  const authoritativeObservationChain = platformEvidence();
  assert.equal(
    authoritativeObservationChain.proofObservationChain.chainAuthoritySha256,
    createB3ObservationChainAuthoritySha256({
      chain: authoritativeObservationChain.proofObservationChain,
      transitions: authoritativeObservationChain.transitions,
    }),
  );
  const relinkedObservationChain = platformEvidence();
  const relinked = relinkedObservationChain.proofObservationChain.observations;
  relinked[3].observationSha256 = 'e'.repeat(64);
  relinked[4].previousObservationSha256 = relinked[3].observationSha256;
  assert.throws(
    () => validateB3PlatformEvidence(relinkedObservationChain),
    /chain authority/i,
  );
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
  for (const field of [
    'playProtectSettingsScreenshotSha256',
    'playProtectRootAttestationSha256',
  ]) {
    const invalidPlayProtect = platformEvidence('android-play-physical');
    invalidPlayProtect.device[field] = 'operator-approved-without-sha';
    assert.throws(
      () => validateB3PlatformEvidence(invalidPlayProtect),
      /device|store authority/i,
    );
  }
});

test('public evidence rejects operator paths, extra native files and widened cloud claims', () => {
  for (const mutate of [
    (evidence) => { evidence.operatorObservationPath = '/operator/observation.json'; },
    (evidence) => { evidence.screenshotPath = '/operator/screenshot.png'; },
    (evidence) => {
      evidence.nativeObservationFiles = ['reports/b3/ios-observation.json'];
    },
    (evidence) => {
      evidence.cloudRuntimeClaims = {
        installedSpellingRequiresCloudflare: true,
        learnerProgressRequiresCloudflare: true,
        monsterProgressRequiresCloudflare: true,
      };
    },
    (evidence) => {
      evidence.proofObservationChain.checkpointSha256 = B3_TEST_HASH;
    },
  ]) {
    const evidence = platformEvidence();
    mutate(evidence);
    assert.throws(() => validateB3PlatformEvidence(evidence), /closed schema/i);
  }

  const selfClaimedPlayCertification = platformEvidence('android-play-physical');
  selfClaimedPlayCertification.device.playProtectSettingsScreenshotSha256 =
    selfClaimedPlayCertification.screenshotSha256;
  selfClaimedPlayCertification.device.playProtectRootAttestationSha256 =
    selfClaimedPlayCertification.screenshotSha256;
  assert.throws(
    () => validateB3PlatformEvidence(selfClaimedPlayCertification),
    /Play certification|device|store authority/i,
  );
});
