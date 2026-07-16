import { existsSync } from 'node:fs';

import { readB3IssuedCommand } from '../../scripts/lib/b3-issued-command.mjs';
import { advanceB3HostCaptureOne } from '../../scripts/lib/b3-live-capture-adapters.mjs';
import { readB3PhysicalObservationJournal } from '../../scripts/lib/b3-physical-observation-journal.mjs';
import {
  canonicaliseB3ProofValue,
  createB3ProofObservation,
} from '../../src/app/b3-live-proof-protocol.js';

function decodeInput() {
  const encoded = process.env.B3_CAPTURE_RACE_CHILD_INPUT;
  if (typeof encoded !== 'string' || encoded.length === 0 || typeof process.send !== 'function') {
    throw new Error('B3 capture race child input or IPC channel is absent');
  }
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
}

function waitForGo() {
  return new Promise((resolve) => {
    process.once('message', (message) => {
      if (message?.type !== 'go') throw new Error('B3 capture race child barrier is invalid');
      resolve();
    });
  });
}

const input = decodeInput();
if (input.role === 'winner') {
  process.send({ type: 'ready' });
  await waitForGo();
}

let launches = 0;
let launchedCaptureId = null;
let retainedCaptureId = null;
let outcome = null;
const transport = {
  async launch(command) {
    launches += 1;
    launchedCaptureId = command.captureId;
  },
  async pullObservation() {
    if (input.completeObservation === true && launchedCaptureId !== null) {
      const command = (await readB3IssuedCommand({
        root: input.root,
        platform: 'ios',
      })).command;
      const observation = await createB3ProofObservation({
        command,
        buildAuthority: input.buildAuthority,
        installationId: '00000000-0000-4000-8000-000000000899',
        sequence: command.expectedSequence,
        scenario: 'product-query',
        phase: 'ARMED',
        nextActionCode: 'QUERY_PRODUCT',
        completedTransitions: ['UNBOUND', 'ARMED'],
        proofProjection: {
          challengeSha256: command.challengeSha256,
          scenarioOutcome: 'in-progress',
          entitlementState: 'none',
          packState: 'absent',
          storeCompletionObserved: false,
          storeEvents: [],
          storeAuthority: {
            environment: 'sandbox',
            productId: 'uk.eugnel.ks2spelling.fullks2',
            localisedPriceObserved: false,
            completionState: 'not-observed',
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
        },
        observedAt: '2026-07-15T10:00:00.000Z',
      });
      return Buffer.from(canonicaliseB3ProofValue(observation), 'utf8');
    }
    throw Object.assign(new Error('observation pull did not produce bytes'), {
      code: 'b3_physical_device_command_failed',
    });
  },
};
try {
  await advanceB3HostCaptureOne({
    root: input.root,
    platform: 'ios',
    buildAuthority: input.buildAuthority,
    transport,
    maximumPullAttempts: 1,
    uuidFactory: () => {
      if (input.role === 'lagger') {
        process.send({ type: 'empty' });
        const deadline = Date.now() + 10_000;
        const barrierWait = new Int32Array(new SharedArrayBuffer(4));
        while (!existsSync(input.barrierPath)) {
          if (Date.now() >= deadline) throw new Error('B3 capture race barrier timed out');
          Atomics.wait(barrierWait, 0, 0, 10);
        }
      }
      return input.captureId;
    },
  });
  outcome = { status: 'fulfilled' };
} catch (error) {
  outcome = { status: 'rejected', code: error?.code ?? null, message: error?.message ?? '' };
}
try {
  retainedCaptureId = (await readB3IssuedCommand({
    root: input.root,
    platform: 'ios',
  })).command.captureId;
} catch {}
let journalCaptureId = null;
let journalLength = null;
try {
  const journal = await readB3PhysicalObservationJournal({
    root: input.root,
    platform: 'ios',
    buildAuthority: input.buildAuthority,
  });
  journalLength = journal.length;
  journalCaptureId = journal.at(-1)?.command.captureId ?? null;
} catch {}
process.send({
  type: 'result',
  outcome,
  launches,
  launchedCaptureId,
  retainedCaptureId,
  journalCaptureId,
  journalLength,
});
