import { createHash } from 'node:crypto';

import { installB3CaptureStateRootMock } from './b3-capture-state-install-root-mock.mjs';

installB3CaptureStateRootMock();

const {
  canonicaliseB3ProofValue,
  createB3ProofObservation,
} = await import('../../src/app/b3-live-proof-protocol.js');
const { openB3CaptureStore } = await import('../../scripts/lib/b3-capture-store.mjs');
const { createB3IssuedCommandStateAuthority } = await import(
  '../../scripts/lib/b3-issued-command-authority.mjs'
);
const { buildB3PhysicalProofAuthority } = await import(
  '../../scripts/lib/b3-capture-proof-domain.mjs'
);

const COMMIT = '1'.repeat(40);
const FINGERPRINT = '2'.repeat(64);
const INSTALLATION_ID = '018f1d7b-97e8-4a52-8cf2-783e5089c002';
const role = process.argv[2];
const observedAt = process.argv[3] ?? '2026-07-17T10:00:00.000Z';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function buildAuthority() {
  return buildB3PhysicalProofAuthority('ios', {
    schemaVersion: 1,
    testedApplicationCommit: COMMIT,
    applicationFingerprint: FINGERPRINT,
    versionName: '0.3.0-b3',
    iosBuildNumber: '19',
    androidVersionCode: 19,
  });
}

function projection(command) {
  return {
    challengeSha256: command.challengeSha256,
    scenarioOutcome: 'in-progress',
    entitlementState: 'none', packState: 'absent',
    storeCompletionObserved: false, storeEvents: [],
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
}

function sourceFor(command, state = 'prepared') {
  const retained = createB3IssuedCommandStateAuthority({
    platform: 'ios', command, state,
  });
  return Object.freeze({
    ...retained,
    allocationSequence: command.expectedSequence,
    captureId: command.captureId,
    predecessorCommandSha256: null,
  });
}

function nextCommand(capture) {
  const tail = capture.records.at(-1).observation;
  const commandWithoutChallenge = {
    schemaVersion: 1,
    captureId: capture.captureId,
    platform: 'ios-physical',
    testedApplicationCommit: COMMIT,
    applicationFingerprint: FINGERPRINT,
    expectedScenarioIndex: tail.scenarioIndex,
    expectedSequence: tail.sequence + 1,
    previousObservationSha256: tail.observationSha256,
    installationMode: 'existing',
    actionCode: tail.nextActionCode,
  };
  return Object.freeze({
    ...commandWithoutChallenge,
    challengeSha256: sha256(Buffer.from(
      `ks2-spelling:b3-host-command-challenge:v1\0${
        canonicaliseB3ProofValue(commandWithoutChallenge)}`,
      'utf8',
    )),
  });
}

async function observationBytes(command) {
  const observation = await createB3ProofObservation({
    command,
    buildAuthority: buildAuthority(),
    installationId: INSTALLATION_ID,
    sequence: command.expectedSequence,
    scenario: 'product-query',
    phase: 'ARMED',
    nextActionCode: 'QUERY_PRODUCT',
    completedTransitions: ['UNBOUND', 'ARMED'],
    proofProjection: projection(command),
    observedAt,
  });
  return Buffer.from(canonicaliseB3ProofValue(observation), 'utf8');
}

function waitForGo() {
  return new Promise((resolve) => {
    process.once('message', (message) => {
      if (message?.type === 'go') resolve();
    });
  });
}

let store;
try {
  store = await openB3CaptureStore({ platform: 'ios' });
  const active = await store.readActiveCommand();
  let capture = null;
  try {
    capture = await store.readCapture();
  } catch {
    // Empty and pending state have no committed capture projection.
  }
  const retainedCommand = active.kind === 'active'
    ? active.command.command
    : capture?.records.at(-1)?.command;
  const sourceState = ['publish-prepared', 'publish-adopt', 'consume-prepared'].includes(role)
    ? 'prepared'
    : active.kind === 'active' ? active.command.state : 'prepared';
  const source = active.kind === 'active' && active.command.state === sourceState
    ? active.command
    : retainedCommand ? sourceFor(retainedCommand, sourceState) : null;
  process.send?.({ type: 'ready', active, source });
  await waitForGo();

  let result;
  let initialError = null;
  if (['transition', 'transition-restart', 'transition-launched'].includes(role)) {
    const nextState = role === 'transition-restart'
      ? 'restart-required'
      : role === 'transition-launched' ? 'launched' : 'launching';
    result = await store.transitionCommand({ source, nextState });
  } else if (role === 'consume' || role === 'consume-prepared') {
    result = await store.consumeCommand({ source });
  } else if (role === 'allocate') {
    capture = await store.readCapture();
    result = await store.allocateNextCommand({ command: nextCommand(capture) });
  } else if (role === 'publish-prepared') {
    result = await store.publishObservation({
      source,
      observationBytes: await observationBytes(source.command),
    });
  } else if (role === 'publish-adopt') {
    const bytes = await observationBytes(source.command);
    try {
      result = await store.publishObservation({ source, observationBytes: bytes });
    } catch (error) {
      initialError = { code: error?.code ?? null, message: error?.message ?? String(error) };
      const winner = await store.readActiveCommand();
      if (winner.kind !== 'active' ||
          winner.command.commandSha256 !== source.commandSha256) throw error;
      result = await store.publishObservation({
        source: winner.command,
        observationBytes: bytes,
      });
    }
  } else {
    throw new Error('unknown B3 command/publication race role');
  }
  process.send?.({ type: 'result', result, initialError });
} catch (error) {
  process.send?.({
    type: 'result',
    result: null,
    initialError: null,
    error: { code: error?.code ?? null, message: error?.message ?? String(error) },
  });
} finally {
  await store?.close();
}
