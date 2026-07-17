import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  canonicaliseB3ProofValue,
  createB3ProofObservation,
} from '../src/app/b3-live-proof-protocol.js';
import {
  buildB3PhysicalProofAuthority,
  deriveB3CaptureStep,
  deriveB3DeviceGatewaySmokeProjection,
  validateB3RetainedCaptureStep,
} from '../scripts/lib/b3-physical-observation-journal.mjs';
import {
  extractB3DeviceGatewaySmokeProjection,
} from '../scripts/lib/b3-live-capture-adapters.mjs';

const COMMIT = '1'.repeat(40);
const FINGERPRINT = '2'.repeat(64);
const CAPTURE_ID = '018f1d7b-97e8-4a52-8cf2-783e5089c001';
const INSTALLATION_ID = '018f1d7b-97e8-4a52-8cf2-783e5089c002';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function command(overrides = {}) {
  const unsigned = {
    schemaVersion: 1,
    captureId: CAPTURE_ID,
    platform: 'ios-physical',
    testedApplicationCommit: COMMIT,
    applicationFingerprint: FINGERPRINT,
    expectedScenarioIndex: 0,
    expectedSequence: 1,
    previousObservationSha256: '0'.repeat(64),
    installationMode: 'existing',
    actionCode: 'ARM_CAPTURE',
    ...overrides,
  };
  return {
    ...unsigned,
    challengeSha256: sha256(Buffer.from(
      `ks2-spelling:b3-host-command-challenge:v1\0${canonicaliseB3ProofValue(unsigned)}`,
      'utf8',
    )),
  };
}

function proofProjection(overrides = {}) {
  return {
    challengeSha256: command().challengeSha256,
    scenarioOutcome: 'in-progress',
    entitlementState: 'none',
    packState: 'absent',
    storeCompletionObserved: false,
    storeEvents: [],
    storeAuthority: {
      environment: 'sandbox', productId: 'uk.eugnel.ks2spelling.fullks2',
      localisedPriceObserved: false, completionState: 'not-observed',
    },
    gatewayCalls: [],
    syntheticLearners: {
      syntheticAuthorityMatched: true,
      positionalSnapshotSha256: ['a'.repeat(64), 'b'.repeat(64)],
    },
    transactionAuthority: {
      source: 'none', crossCheckedOnRefresh: false,
      domainSeparatedDigestSha256: null, rawProofCleared: false,
    },
    refreshHandleLifecycle: {
      present: false, positiveVersionObserved: false, rotated: false, deleted: false,
    },
    entitlementAuthority: {
      id: null, state: 'none', domainSeparatedDigestSha256: null,
      refreshHandlePresent: false,
    },
    packAuthority: {
      packId: null, manifestSha256: null, archiveSha256: null, installed: false,
    },
    gatewaySmokeAuthority: null,
    transportAuthority: {
      storeAdapter: 'concreteCapacitorStore', gatewayAdapter: 'concreteHttpGateway',
      serverUrl: null, nativeOriginAllowed: true, noRedirects: true,
    },
    ...overrides,
  };
}

function buildSource() {
  return Object.freeze({
    schemaVersion: 1,
    testedApplicationCommit: COMMIT,
    applicationFingerprint: FINGERPRINT,
    versionName: '0.3.0-b3',
    iosBuildNumber: '19',
    androidVersionCode: 19,
  });
}

test('D2 derives and revalidates one canonical record/checkpoint pair', async () => {
  const buildAuthority = buildB3PhysicalProofAuthority('ios', buildSource());
  const observation = await createB3ProofObservation({
    command: command(),
    buildAuthority,
    installationId: INSTALLATION_ID,
    sequence: 1,
    scenario: 'product-query',
    phase: 'ARMED',
    nextActionCode: 'QUERY_PRODUCT',
    completedTransitions: ['UNBOUND', 'ARMED'],
    proofProjection: proofProjection(),
    observedAt: '2026-07-17T10:00:00.000Z',
  });
  const step = await deriveB3CaptureStep({
    platform: 'ios',
    command: command(),
    buildSource: buildSource(),
    previousObservation: undefined,
    observationBytes: Buffer.from(canonicaliseB3ProofValue(observation), 'utf8'),
  });

  assert.equal(step.recordSha256, sha256(step.recordBytes));
  assert.equal(step.checkpointBlobSha256, sha256(step.checkpointBytes));
  assert.equal(step.observationSha256, observation.observationSha256);
  assert.equal(step.checkpoint.checkpointRevision, 0);
  assert.notEqual(step.checkpointBlobSha256, step.checkpoint.checkpointSha256);
  assert.equal(Object.isFrozen(step.record), true);
  assert.equal(Object.isFrozen(step.record.observation.proofProjection), true);

  const retained = await validateB3RetainedCaptureStep({
    platform: 'ios',
    command: command(),
    buildSource: buildSource(),
    previousObservation: undefined,
    recordBytes: step.recordBytes,
    checkpointBytes: step.checkpointBytes,
  });
  assert.deepEqual(retained.record, step.record);
  assert.deepEqual(retained.checkpoint, step.checkpoint);

  const callerBytes = step.recordBytes;
  callerBytes.fill(0);
  assert.equal(step.recordBytes.equals(callerBytes), false);
});

test('D2 build expansion is fixed and platform-specific', () => {
  assert.deepEqual(buildB3PhysicalProofAuthority('ios', buildSource()), {
    mode: 'B3SandboxProof', proofKind: 'physical-live', platform: 'ios',
    distribution: 'development', publicSandboxOrigin: 'https://b3-gateway.eugnel.uk',
    workerName: 'ks2-spelling-b3-sandbox', bundleId: 'uk.eugnel.ks2spelling',
    testedApplicationCommit: COMMIT, applicationFingerprint: FINGERPRINT,
    versionName: '0.3.0-b3', buildNumber: '19',
  });
  assert.equal(
    buildB3PhysicalProofAuthority('android', buildSource()).distribution,
    'play-internal',
  );
  assert.throws(
    () => buildB3PhysicalProofAuthority('ios', { ...buildSource(), extra: true }),
    /build|source|closed/i,
  );
});

test('D2 retained validation binds the record command to the persisted command', async () => {
  const buildAuthority = buildB3PhysicalProofAuthority('ios', buildSource());
  const differentCommand = command({
    captureId: '018f1d7b-97e8-4a52-8cf2-783e5089c099',
  });
  const observation = await createB3ProofObservation({
    command: differentCommand,
    buildAuthority,
    installationId: INSTALLATION_ID,
    sequence: 1,
    scenario: 'product-query',
    phase: 'ARMED',
    nextActionCode: 'QUERY_PRODUCT',
    completedTransitions: ['UNBOUND', 'ARMED'],
    proofProjection: {
      ...proofProjection(),
      challengeSha256: differentCommand.challengeSha256,
    },
    observedAt: '2026-07-17T10:00:03.000Z',
  });
  const foreign = await deriveB3CaptureStep({
    platform: 'ios',
    command: differentCommand,
    buildSource: buildSource(),
    previousObservation: undefined,
    observationBytes: Buffer.from(canonicaliseB3ProofValue(observation), 'utf8'),
  });
  await assert.rejects(
    validateB3RetainedCaptureStep({
      platform: 'ios',
      command: command(),
      buildSource: buildSource(),
      previousObservation: undefined,
      recordBytes: foreign.recordBytes,
      checkpointBytes: foreign.checkpointBytes,
    }),
    /command|authority|retained/i,
  );
});

test('D2 optional gateway smoke projection is validated, zero-or-one and iOS-only', async () => {
  const authority = {
    schemaVersion: 1,
    deploymentVersionId: 'a8f32f60-16b9-4ca6-9b4a-f771dd5302f7',
    scriptAuthoritySha256: 'a'.repeat(64),
    signedEnvelopeSha256: 'b'.repeat(64),
    objects: [
      {
        role: 'signed-manifest',
        key: 'packs/b3-sandbox-proof/1.0.0-b3.1/signed-manifest.json',
        sha256: 'b'.repeat(64), size: 1_135,
        etag: 'c76b2858b8345814279a1c92ae64e365',
      },
      {
        role: 'archive',
        key: 'packs/b3-sandbox-proof/1.0.0-b3.1/b3-sandbox-proof.zip',
        sha256: 'a'.repeat(64), size: 1_324,
        etag: '913d2b2485ca6cd31d467bd7228d7e75',
      },
    ],
    accessBehaviour: {
      ttlSeconds: 600, valid: true, tamperedRejected: true,
      expiredRejected: true, canonicalEncodingRequired: true,
    },
    byteServingBehaviour: {
      full200: true, partial206: true, conditional304: true, unsatisfied416: true,
      noRedirects: true, cacheControl: 'private, no-store',
    },
  };
  const buildAuthority = buildB3PhysicalProofAuthority('ios', buildSource());
  const noneCommand = command();
  const noneObservation = await createB3ProofObservation({
    command: noneCommand, buildAuthority, installationId: INSTALLATION_ID,
    sequence: 1, scenario: 'product-query', phase: 'ARMED',
    nextActionCode: 'QUERY_PRODUCT', completedTransitions: ['UNBOUND', 'ARMED'],
    proofProjection: proofProjection(), observedAt: '2026-07-17T10:04:00.000Z',
  });
  const none = (await deriveB3CaptureStep({
    platform: 'ios', command: noneCommand, buildSource: buildSource(),
    previousObservation: undefined,
    observationBytes: Buffer.from(canonicaliseB3ProofValue(noneObservation), 'utf8'),
  })).record;
  const smokeCommand = command({ expectedScenarioIndex: 5 });
  const smokeObservation = await createB3ProofObservation({
    command: smokeCommand, buildAuthority, installationId: INSTALLATION_ID,
    sequence: 1, scenario: 'pack-install', phase: 'SCENARIO_COMPLETE',
    nextActionCode: 'REBIND_FRESH_INSTALL',
    completedTransitions: ['UNBOUND', 'ARMED', 'OBSERVING', 'SCENARIO_COMPLETE'],
    proofProjection: proofProjection({
      challengeSha256: smokeCommand.challengeSha256,
      scenarioOutcome: 'installed', gatewaySmokeAuthority: authority,
      transactionAuthority: {
        source: 'none', crossCheckedOnRefresh: false,
        domainSeparatedDigestSha256: null, rawProofCleared: true,
      },
      gatewayCalls: [{
        operation: 'authorise', relation: 'download-capability-authorisation',
        traceId: '018f1d7b-97e8-4a52-8cf2-783e50890001',
      }],
    }),
    observedAt: '2026-07-17T10:04:01.000Z',
  });
  const smoke = (await deriveB3CaptureStep({
    platform: 'ios', command: smokeCommand, buildSource: buildSource(),
    previousObservation: undefined,
    observationBytes: Buffer.from(canonicaliseB3ProofValue(smokeObservation), 'utf8'),
  })).record;
  assert.equal(deriveB3DeviceGatewaySmokeProjection([none]), null);
  const projection = deriveB3DeviceGatewaySmokeProjection([none, smoke]);
  assert.deepEqual(projection.capability, authority.accessBehaviour);
  assert.equal(Object.isFrozen(projection.objects[0]), true);
  assert.deepEqual(
    extractB3DeviceGatewaySmokeProjection({ retained: [smoke] }),
    projection,
  );
  assert.throws(
    () => deriveB3DeviceGatewaySmokeProjection([smoke, smoke]),
    /exactly once/i,
  );
  assert.deepEqual(
    deriveB3DeviceGatewaySmokeProjection([structuredClone(smoke)]),
    projection,
  );
  const androidCommand = command({
    platform: 'android-play-physical', expectedScenarioIndex: 5,
  });
  const androidBuildAuthority = buildB3PhysicalProofAuthority('android', buildSource());
  const androidObservation = await createB3ProofObservation({
    command: androidCommand, buildAuthority: androidBuildAuthority,
    installationId: INSTALLATION_ID, sequence: 1, scenario: 'pack-install',
    phase: 'SCENARIO_COMPLETE', nextActionCode: 'REBIND_FRESH_INSTALL',
    completedTransitions: ['UNBOUND', 'ARMED', 'OBSERVING', 'SCENARIO_COMPLETE'],
    proofProjection: proofProjection({
      challengeSha256: androidCommand.challengeSha256,
      scenarioOutcome: 'installed', gatewaySmokeAuthority: authority,
      transactionAuthority: {
        source: 'none', crossCheckedOnRefresh: false,
        domainSeparatedDigestSha256: null, rawProofCleared: true,
      },
      storeAuthority: {
        environment: 'sandbox', productId: 'full_ks2',
        localisedPriceObserved: false, completionState: 'not-observed',
      },
      gatewayCalls: [{
        operation: 'authorise', relation: 'download-capability-authorisation',
        traceId: '018f1d7b-97e8-4a52-8cf2-783e50890002',
      }],
    }),
    observedAt: '2026-07-17T10:04:02.000Z',
  });
  const android = (await deriveB3CaptureStep({
    platform: 'android', command: androidCommand, buildSource: buildSource(),
    previousObservation: undefined,
    observationBytes: Buffer.from(canonicaliseB3ProofValue(androidObservation), 'utf8'),
  })).record;
  assert.throws(
    () => deriveB3DeviceGatewaySmokeProjection([android]),
    /iOS|pack-install/i,
  );
});
