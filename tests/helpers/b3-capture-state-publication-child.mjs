import { createHash } from 'node:crypto';

import { installB3CaptureStateRootMock } from './b3-capture-state-install-root-mock.mjs';

installB3CaptureStateRootMock();

const {
  canonicaliseB3ProofValue,
  createB3ProofObservation,
} = await import('../../src/app/b3-live-proof-protocol.js');
const { buildB3PhysicalProofAuthority } = await import(
  '../../scripts/lib/b3-physical-observation-journal.mjs'
);
const { openB3CaptureStateRepository } = await import(
  '../../scripts/lib/b3-capture-state-repository.mjs'
);
const { openB3CaptureStore } = await import('../../scripts/lib/b3-capture-store.mjs');

const COMMIT = '1'.repeat(40);
const FINGERPRINT = '2'.repeat(64);
const CAPTURE_ID = '018f1d7b-97e8-4a52-8cf2-783e5089c001';
const INSTALLATION_ID = '018f1d7b-97e8-4a52-8cf2-783e5089c002';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function command(overrides = {}) {
  const unsigned = {
    schemaVersion: 1, captureId: CAPTURE_ID, platform: 'ios-physical',
    testedApplicationCommit: COMMIT, applicationFingerprint: FINGERPRINT,
    expectedScenarioIndex: 0, expectedSequence: 1,
    previousObservationSha256: '0'.repeat(64), installationMode: 'existing',
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

function projection(overrides = {}) {
  const value = {
    challengeSha256: command().challengeSha256, scenarioOutcome: 'in-progress',
    entitlementState: 'none', packState: 'absent', storeCompletionObserved: false,
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
  };
  Object.assign(value, overrides);
  if (value.storeEvents.some((event) =>
    event.operation === 'queryProducts' && event.outcome === 'products-visible')) {
    value.storeAuthority.localisedPriceObserved = true;
  }
  return value;
}

let store;
let repository;
try {
  store = await openB3CaptureStore({ platform: 'ios' });
  await store.startCapture({ command: command() });
  const empty = await store.readCapture();
  repository = await openB3CaptureStateRepository({ platform: 'ios' });
  const { command: source } = await repository.readActiveCommand();
  await repository.close();
  repository = null;
  const buildAuthority = buildB3PhysicalProofAuthority('ios', {
    schemaVersion: 1, testedApplicationCommit: COMMIT,
    applicationFingerprint: FINGERPRINT, versionName: '0.3.0-b3',
    iosBuildNumber: '19', androidVersionCode: 19,
  });
  const observation = await createB3ProofObservation({
    command: command(), buildAuthority, installationId: INSTALLATION_ID,
    sequence: 1, scenario: 'product-query', phase: 'ARMED',
    nextActionCode: 'QUERY_PRODUCT', completedTransitions: ['UNBOUND', 'ARMED'],
    proofProjection: projection(), observedAt: '2026-07-17T10:00:00.000Z',
  });
  const bytes = Buffer.from(canonicaliseB3ProofValue(observation), 'utf8');
  const mutableSource = structuredClone(source);
  const mutableBytes = Buffer.from(bytes);
  const firstPromise = store.publishObservation({
    source: mutableSource,
    observationBytes: mutableBytes,
  });
  mutableSource.state = 'mutated-after-invocation';
  mutableSource.command.captureId = 'mutated-after-invocation';
  mutableBytes.fill(0);
  const first = await firstPromise;
  const identical = await store.publishObservation({ source, observationBytes: bytes });
  const conflictingObservation = await createB3ProofObservation({
    command: command(), buildAuthority, installationId: INSTALLATION_ID,
    sequence: 1, scenario: 'product-query', phase: 'ARMED',
    nextActionCode: 'QUERY_PRODUCT', completedTransitions: ['UNBOUND', 'ARMED'],
    proofProjection: projection(), observedAt: '2026-07-17T10:00:01.000Z',
  });
  const conflictingBytes = Buffer.from(canonicaliseB3ProofValue(conflictingObservation), 'utf8');
  const conflict = await store.publishObservation({
    source,
    observationBytes: conflictingBytes,
  });
  repository = await openB3CaptureStateRepository({ platform: 'ios' });
  await repository.consumeCommand({ source });
  const secondCommand = command({
    expectedSequence: 2,
    previousObservationSha256: observation.observationSha256,
    actionCode: 'QUERY_PRODUCT',
  });
  const allocated = await repository.allocateNextCommand({ command: secondCommand });
  const secondSource = allocated.command;
  await repository.close();
  repository = null;
  const secondObservation = await createB3ProofObservation({
    command: secondCommand, buildAuthority, installationId: INSTALLATION_ID,
    sequence: 2, scenario: 'product-query', phase: 'SCENARIO_COMPLETE',
    nextActionCode: 'ARM_CAPTURE',
    completedTransitions: [
      'UNBOUND', 'ARMED', 'WAITING_OPERATOR', 'OBSERVING', 'SCENARIO_COMPLETE',
    ],
    proofProjection: projection({
      challengeSha256: secondCommand.challengeSha256,
      scenarioOutcome: 'products-visible',
      storeEvents: [{ operation: 'queryProducts', outcome: 'products-visible' }],
    }),
    observedAt: '2026-07-17T10:00:02.000Z',
  });
  const second = await store.publishObservation({
    source: secondSource,
    observationBytes: Buffer.from(canonicaliseB3ProofValue(secondObservation), 'utf8'),
  });
  const staleRetry = await store.publishObservation({ source, observationBytes: bytes });
  const capture = await store.readCapture();
  const freezeProof = {
    first: Object.isFrozen(first),
    firstRecord: Object.isFrozen(first.record),
    firstProjection: Object.isFrozen(first.record.observation.proofProjection),
    empty: Object.isFrozen(empty),
    emptyRecords: Object.isFrozen(empty.records),
    capture: Object.isFrozen(capture),
    captureRecords: Object.isFrozen(capture.records),
    checkpoint: Object.isFrozen(capture.checkpoint),
  };
  process.stdout.write(`${JSON.stringify({
    empty, first, identical, conflict, second, staleRetry, capture, freezeProof,
  })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    error: { code: error?.code ?? null, message: error?.message ?? String(error) },
  })}\n`);
} finally {
  await repository?.close();
  await store?.close();
}
