import { installB3CaptureStateRootMock } from './b3-capture-state-install-root-mock.mjs';

installB3CaptureStateRootMock();

const {
  canonicaliseB3ProofValue,
  createB3ProofObservation,
} = await import('../../src/app/b3-live-proof-protocol.js');
const { openB3CaptureStore } = await import('../../scripts/lib/b3-capture-store.mjs');
const { createB3StoreBackedLiveCapture } = await import(
  '../../scripts/lib/b3-store-backed-live-capture.mjs'
);
const { buildB3PhysicalProofAuthority } = await import(
  '../../scripts/lib/b3-physical-observation-journal.mjs'
);

const COMMIT = '1'.repeat(40);
const FINGERPRINT = '2'.repeat(64);
const INSTALLATION_ID = '018f1d7b-97e8-4a52-8cf2-783e5089c002';

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

function barrier(phase, value = null) {
  process.send?.({ type: 'barrier', phase, value });
  return new Promise((resolve, reject) => {
    process.once('message', (message) => {
      if (message?.type !== 'go' || message.phase !== phase) {
        reject(new Error(`B3 controller race ${phase} barrier is invalid`));
        return;
      }
      resolve();
    });
  });
}

let controller;
try {
  const store = await openB3CaptureStore({ platform: 'ios' });
  let publicationCommitted = false;
  let publicationPaused = false;
  let consumptionPaused = false;
  let launchedCommand = null;
  const wrapped = Object.freeze({
    ...store,
    async readActiveCommand() {
      if (publicationCommitted && !consumptionPaused) {
        consumptionPaused = true;
        await barrier('consumption');
      }
      const retained = await store.readActiveCommand();
      if (retained.kind === 'active') launchedCommand = retained.command.command;
      return retained;
    },
    async transitionCommand(input) {
      if (input.source.state === 'launching' && input.nextState === 'launched') {
        await barrier('launch-completion', input.source);
      }
      return store.transitionCommand(input);
    },
    async publishObservation(input) {
      if (!publicationPaused) {
        publicationPaused = true;
        await barrier('publication', input.source);
      }
      const result = await store.publishObservation(input);
      publicationCommitted = true;
      return result;
    },
    async consumeCommand(input) {
      if (!consumptionPaused) {
        consumptionPaused = true;
        await barrier('consumption', input.source);
      }
      return store.consumeCommand(input);
    },
  });
  controller = createB3StoreBackedLiveCapture({
    platform: 'ios',
    buildAuthority: async () => buildAuthority(),
    storeFactory: async () => wrapped,
    transport: {
      async launch(command) {
        launchedCommand = command;
        throw Object.assign(new Error('native launch completion was not observed'), {
          code: 'b3_physical_device_command_failed',
        });
      },
      async pullObservation() {
        const observation = await createB3ProofObservation({
          command: launchedCommand,
          buildAuthority: buildAuthority(),
          installationId: INSTALLATION_ID,
          sequence: launchedCommand.expectedSequence,
          scenario: 'product-query',
          phase: 'ARMED',
          nextActionCode: 'QUERY_PRODUCT',
          completedTransitions: ['UNBOUND', 'ARMED'],
          proofProjection: projection(launchedCommand),
          observedAt: '2026-07-17T10:00:00.000Z',
        });
        return Buffer.from(canonicaliseB3ProofValue(observation), 'utf8');
      },
      async forceStop() {},
    },
  });
  const observation = await controller.advance({ maximumPullAttempts: 1 });
  process.send?.({ type: 'result', observation });
} catch (error) {
  process.send?.({
    type: 'result',
    observation: null,
    error: { code: error?.code ?? null, message: error?.message ?? String(error) },
  });
} finally {
  await controller?.dispose();
}
