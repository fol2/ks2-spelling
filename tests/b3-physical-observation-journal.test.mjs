import assert from 'node:assert/strict';
import { link, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  canonicaliseB3ProofValue,
  createB3ProofObservation,
} from '../src/app/b3-live-proof-protocol.js';
import {
  appendB3PhysicalObservation,
  deriveB3ProofObservationChain,
  deriveB3ScenarioTransition,
  readB3PhysicalObservationJournal,
} from '../scripts/lib/b3-physical-observation-journal.mjs';
import { reconcileB3CaptureCheckpointFromJournal } from '../scripts/lib/b3-host-capture-state.mjs';
import {
  createNextB3HostCommand,
  deriveB3DeviceStoreEvidence,
} from '../scripts/lib/b3-live-capture-adapters.mjs';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const COMMIT = 'c'.repeat(40);
const CAPTURE_ID = '018f1d7b-97e8-4a52-8cf2-783e5089c001';
const INSTALLATION_ID = '018f1d7b-97e8-4a52-8cf2-783e5089c002';

const BUILD_AUTHORITY = Object.freeze({
  mode: 'B3SandboxProof',
  proofKind: 'physical-live',
  platform: 'ios',
  distribution: 'development',
  publicSandboxOrigin: 'https://b3-gateway.eugnel.uk',
  workerName: 'ks2-spelling-b3-sandbox',
  bundleId: 'uk.eugnel.ks2spelling',
  testedApplicationCommit: COMMIT,
  applicationFingerprint: HASH_A,
  versionName: '0.3.0-b3',
  buildNumber: '19',
});

const ANDROID_BUILD_AUTHORITY = Object.freeze({
  ...BUILD_AUTHORITY,
  platform: 'android',
  distribution: 'play-internal',
  buildNumber: 19,
});

function command(overrides = {}) {
  return {
    schemaVersion: 1,
    captureId: CAPTURE_ID,
    platform: 'ios-physical',
    testedApplicationCommit: COMMIT,
    applicationFingerprint: HASH_A,
    expectedScenarioIndex: 0,
    expectedSequence: 1,
    previousObservationSha256: '0'.repeat(64),
    installationMode: 'existing',
    actionCode: 'ARM_CAPTURE',
    challengeSha256: HASH_B,
    ...overrides,
  };
}

function projection(overrides = {}) {
  const androidStoreAuthority = overrides.androidStoreAuthority === true;
  const projectionOverrides = { ...overrides };
  delete projectionOverrides.androidStoreAuthority;
  const value = {
    challengeSha256: HASH_B,
    scenarioOutcome: 'in-progress',
    entitlementState: 'none',
    packState: 'absent',
    storeCompletionObserved: false,
    storeEvents: [],
    storeAuthority: {
      environment: 'sandbox',
      productId: androidStoreAuthority ? 'full_ks2' : 'uk.eugnel.ks2spelling.fullks2',
      localisedPriceObserved: false,
      completionState: 'not-observed',
    },
    gatewayCalls: [],
    syntheticLearners: {
      syntheticAuthorityMatched: true,
      positionalSnapshotSha256: [HASH_A, HASH_B],
    },
    transactionAuthority: {
      source: 'none',
      crossCheckedOnRefresh: false,
      domainSeparatedDigestSha256: null,
      rawProofCleared: false,
    },
    refreshHandleLifecycle: {
      present: false,
      positiveVersionObserved: false,
      rotated: false,
      deleted: false,
    },
    entitlementAuthority: {
      id: null,
      state: 'none',
      domainSeparatedDigestSha256: null,
      refreshHandlePresent: false,
    },
    packAuthority: {
      packId: null,
      manifestSha256: null,
      archiveSha256: null,
      installed: false,
    },
    gatewaySmokeAuthority: null,
    transportAuthority: {
      storeAdapter: 'concreteCapacitorStore',
      gatewayAdapter: 'concreteHttpGateway',
      serverUrl: null,
      nativeOriginAllowed: true,
      noRedirects: true,
    },
    ...projectionOverrides,
  };
  if (!Object.hasOwn(projectionOverrides, 'storeAuthority')) {
    if (value.storeEvents.some((event) =>
      event.operation === 'queryProducts' && event.outcome === 'products-visible')) {
      value.storeAuthority.localisedPriceObserved = true;
    }
    if (value.storeCompletionObserved) {
      value.storeAuthority.completionState = androidStoreAuthority ? 'acknowledged' : 'finished';
    }
  }
  return value;
}

async function observation(observedAt = '2026-07-15T10:00:00.000Z') {
  const launch = command();
  return createB3ProofObservation({
    command: launch,
    buildAuthority: BUILD_AUTHORITY,
    installationId: INSTALLATION_ID,
    sequence: 1,
    scenario: 'product-query',
    phase: 'ARMED',
    nextActionCode: 'QUERY_PRODUCT',
    completedTransitions: ['UNBOUND', 'ARMED'],
    proofProjection: projection(),
    observedAt,
  });
}

async function terminalObservation() {
  const launch = command();
  return createB3ProofObservation({
    command: launch,
    buildAuthority: BUILD_AUTHORITY,
    installationId: INSTALLATION_ID,
    sequence: 1,
    scenario: 'product-query',
    phase: 'SCENARIO_COMPLETE',
    nextActionCode: 'ARM_CAPTURE',
    completedTransitions: ['UNBOUND', 'ARMED', 'OBSERVING', 'SCENARIO_COMPLETE'],
    proofProjection: projection({
      scenarioOutcome: 'products-visible',
      storeEvents: [{ operation: 'queryProducts', outcome: 'products-visible' }],
    }),
    observedAt: '2026-07-15T10:00:02.000Z',
  });
}

test('journal durably retains exact validated canonical records and is idempotent', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-observation-journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const value = await observation();
  const observationBytes = Buffer.from(canonicaliseB3ProofValue(value), 'utf8');

  const relative = await appendB3PhysicalObservation({
    root,
    platform: 'ios',
    command: command(),
    buildAuthority: BUILD_AUTHORITY,
    observationBytes,
  });
  assert.equal(
    relative,
    '.native-build/b3/evidence/ios-observations/00000001.json',
  );
  const path = join(root, relative);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.equal((await readFile(path, 'utf8')).endsWith('\n'), false);

  await appendB3PhysicalObservation({
    root,
    platform: 'ios',
    command: command(),
    buildAuthority: BUILD_AUTHORITY,
    observationBytes,
  });
  await writeFile(
    join(root, '.native-build/b3/evidence/ios-observation-crashed-writer.tmp'),
    'incomplete writer debris',
    { mode: 0o600 },
  );
  const records = await readB3PhysicalObservationJournal({
    root,
    platform: 'ios',
    buildAuthority: BUILD_AUTHORITY,
  });
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].command, command());
  assert.deepEqual(records[0].observation, value);
  assert.equal(canonicaliseB3ProofValue(records[0].observation), observationBytes.toString('utf8'));
});

test('journal rejects a conflicting sequence and validates retained authority afresh', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-observation-conflict-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await observation();
  await appendB3PhysicalObservation({
    root,
    platform: 'ios',
    command: command(),
    buildAuthority: BUILD_AUTHORITY,
    observationBytes: Buffer.from(canonicaliseB3ProofValue(first)),
  });

  const conflicting = await observation('2026-07-15T10:00:01.000Z');
  await assert.rejects(
    appendB3PhysicalObservation({
      root,
      platform: 'ios',
      command: command(),
      buildAuthority: BUILD_AUTHORITY,
      observationBytes: Buffer.from(canonicaliseB3ProofValue(conflicting)),
    }),
    /conflict|immutable|sequence/i,
  );
  await assert.rejects(
    readB3PhysicalObservationJournal({
      root,
      platform: 'ios',
      buildAuthority: { ...BUILD_AUTHORITY, buildNumber: '20' },
    }),
    /authority|observation|build/i,
  );
});

test('journal reader rejects hard links, symlinks and non-canonical replacement bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-observation-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const value = await observation();
  const relative = await appendB3PhysicalObservation({
    root,
    platform: 'ios',
    command: command(),
    buildAuthority: BUILD_AUTHORITY,
    observationBytes: Buffer.from(canonicaliseB3ProofValue(value)),
  });
  const path = join(root, relative);
  const alias = `${path}.alias`;
  await link(path, alias);
  await assert.rejects(
    readB3PhysicalObservationJournal({ root, platform: 'ios', buildAuthority: BUILD_AUTHORITY }),
    /link|policy/i,
  );
  await rm(alias);

  const bytes = await readFile(path);
  await rm(path);
  await writeFile(path, `${JSON.stringify(JSON.parse(bytes), null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(
    readB3PhysicalObservationJournal({ root, platform: 'ios', buildAuthority: BUILD_AUTHORITY }),
    /canonical|journal/i,
  );

  await rm(path);
  await symlink(`${path}.missing`, path);
  await assert.rejects(
    readB3PhysicalObservationJournal({ root, platform: 'ios', buildAuthority: BUILD_AUTHORITY }),
    /link|policy|journal/i,
  );
});

test('evidence chain is derived only from independently revalidated retained records', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-observation-chain-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const value = await terminalObservation();
  await appendB3PhysicalObservation({
    root,
    platform: 'ios',
    command: command(),
    buildAuthority: BUILD_AUTHORITY,
    observationBytes: Buffer.from(canonicaliseB3ProofValue(value)),
  });
  const records = await readB3PhysicalObservationJournal({
    root,
    platform: 'ios',
    buildAuthority: BUILD_AUTHORITY,
  });
  const transitions = [{
    scenario: 'product-query',
    startedAt: '2026-07-15T10:00:02.000Z',
    completedAt: '2026-07-15T10:00:02.000Z',
    outcome: 'products-visible',
    gatewayTraces: [],
  }];
  const chain = deriveB3ProofObservationChain({ records, transitions });
  assert.equal(chain.captureId, CAPTURE_ID);
  assert.equal(chain.terminalObservationSha256, value.observationSha256);
  assert.deepEqual(chain.observations, [{
    sequence: 1,
    scenarioIndex: 0,
    previousObservationSha256: '0'.repeat(64),
    observationSha256: value.observationSha256,
    proofProjectionSha256: chain.observations[0].proofProjectionSha256,
  }]);
  assert.match(chain.chainAuthoritySha256, /^[0-9a-f]{64}$/u);
  assert.match(chain.transitionGatewayProjectionSha256, /^[0-9a-f]{64}$/u);
  assert.equal(Object.hasOwn(chain, 'proofProjection'), false);

  assert.throws(
    () => { records[0].observation.proofProjection.packState = 'installed'; },
    /read only|assign|frozen/i,
  );
  assert.throws(
    () => deriveB3ProofObservationChain({
      records: structuredClone(records),
      transitions,
    }),
    /validated retained records/i,
  );
  assert.deepEqual(
    deriveB3ProofObservationChain({ records, transitions }),
    chain,
  );
  for (const mutation of [
    { outcome: 'cancelled' },
    { startedAt: '2026-07-15T09:59:59.000Z' },
    { gatewayTraces: [{
      operation: 'verify',
      relation: 'transaction-verification',
      traceId: '018f1d7b-97e8-4a52-8cf2-783e50890009',
    }] },
  ]) {
    assert.throws(
      () => deriveB3ProofObservationChain({
        records,
        transitions: [{ ...transitions[0], ...mutation }],
      }),
      /transition|retained|outcome|trace|time/i,
    );
  }
});

test('scenario transition outcome and traces come only from validated retained observations', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-observation-outcome-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const value = await terminalObservation();
  await appendB3PhysicalObservation({
    root,
    platform: 'ios',
    command: command(),
    buildAuthority: BUILD_AUTHORITY,
    observationBytes: Buffer.from(canonicaliseB3ProofValue(value)),
  });
  const records = await readB3PhysicalObservationJournal({
    root,
    platform: 'ios',
    buildAuthority: BUILD_AUTHORITY,
  });
  assert.deepEqual(deriveB3ScenarioTransition({
    records,
    authority: { scenario: 'product-query', outcome: 'products-visible', traces: [] },
  }), {
    scenario: 'product-query',
    startedAt: '2026-07-15T10:00:02.000Z',
    completedAt: '2026-07-15T10:00:02.000Z',
    outcome: 'products-visible',
    gatewayTraces: [],
  });
  assert.throws(
    () => deriveB3ScenarioTransition({
      records,
      authority: { scenario: 'product-query', outcome: 'cancelled', traces: [] },
    }),
    /outcome|retained|authority/i,
  );
});

test('Android decline is derived only from the next fresh scenario query authority', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-android-decline-bridge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const commands = [];
  const values = [];
  const add = async ({ scenarioIndex, actionCode, scenario, phase, nextActionCode,
    completedTransitions, storeEvents, observedAt }) => {
    const previous = values.at(-1);
    const launch = command({
      platform: 'android-play-physical',
      expectedScenarioIndex: scenarioIndex,
      expectedSequence: values.length + 1,
      previousObservationSha256: previous?.observationSha256 ?? '0'.repeat(64),
      actionCode,
      challengeSha256: String(values.length + 1).repeat(64),
    });
    const value = await createB3ProofObservation({
      command: launch,
      buildAuthority: ANDROID_BUILD_AUTHORITY,
      installationId: INSTALLATION_ID,
      sequence: launch.expectedSequence,
      scenario,
      phase,
      nextActionCode,
      completedTransitions,
      proofProjection: projection({
        androidStoreAuthority: true,
        challengeSha256: launch.challengeSha256,
        storeEvents,
      }),
      observedAt,
    });
    commands.push(launch);
    values.push(value);
    await appendB3PhysicalObservation({
      root,
      platform: 'android',
      command: launch,
      buildAuthority: ANDROID_BUILD_AUTHORITY,
      observationBytes: Buffer.from(canonicaliseB3ProofValue(value)),
    });
    await reconcileB3CaptureCheckpointFromJournal({
      root, platform: 'android', buildAuthority: ANDROID_BUILD_AUTHORITY,
    });
  };

  await add({
    scenarioIndex: 2, actionCode: 'ARM_CAPTURE',
    scenario: 'slow-card-pending-decline', phase: 'ARMED',
    nextActionCode: 'INITIATE_PURCHASE',
    completedTransitions: ['UNBOUND', 'ARMED'], storeEvents: [],
    observedAt: '2026-07-15T10:00:00.000Z',
  });
  await add({
    scenarioIndex: 2, actionCode: 'INITIATE_PURCHASE',
    scenario: 'slow-card-pending-decline', phase: 'OBSERVING',
    nextActionCode: 'DECLINE_PENDING_PURCHASE',
    completedTransitions: ['UNBOUND', 'ARMED', 'WAITING_OPERATOR', 'OBSERVING'],
    storeEvents: [{ operation: 'purchase', outcome: 'pending' }],
    observedAt: '2026-07-15T10:00:01.000Z',
  });
  const declineBridgeCommand = await createNextB3HostCommand({
    root,
    platform: 'android',
    buildAuthority: ANDROID_BUILD_AUTHORITY,
  });
  assert.equal(declineBridgeCommand.actionCode, 'ARM_CAPTURE');
  assert.equal(declineBridgeCommand.expectedScenarioIndex, 3);
  assert.equal(declineBridgeCommand.expectedSequence, 3);
  await add({
    scenarioIndex: 3, actionCode: 'ARM_CAPTURE',
    scenario: 'slow-card-pending-approve', phase: 'ARMED',
    nextActionCode: 'INITIATE_PURCHASE', completedTransitions: ['ARMED'],
    storeEvents: [{ operation: 'queryTransactions', outcome: 'none' }],
    observedAt: '2026-07-15T10:00:02.000Z',
  });

  const records = await readB3PhysicalObservationJournal({
    root, platform: 'android', buildAuthority: ANDROID_BUILD_AUTHORITY,
  });
  const transition = deriveB3ScenarioTransition({
    records,
    authority: {
      scenario: 'slow-card-pending-decline', outcome: 'declined-no-access', traces: [],
    },
  });
  assert.deepEqual(transition, {
    scenario: 'slow-card-pending-decline',
    startedAt: '2026-07-15T10:00:00.000Z',
    completedAt: '2026-07-15T10:00:02.000Z',
    outcome: 'declined-no-access',
    gatewayTraces: [],
  });
});

test('Android approval is derived from the next scenario hold before completion', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-android-approve-bridge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const values = [];
  const add = async ({ scenarioIndex, actionCode, scenario, phase, nextActionCode,
    completedTransitions, proofOverrides, observedAt }) => {
    const previous = values.at(-1);
    const launch = command({
      platform: 'android-play-physical',
      expectedScenarioIndex: scenarioIndex,
      expectedSequence: values.length + 1,
      previousObservationSha256: previous?.observationSha256 ?? '0'.repeat(64),
      actionCode,
      challengeSha256: String(values.length + 4).repeat(64),
    });
    const value = await createB3ProofObservation({
      command: launch,
      buildAuthority: ANDROID_BUILD_AUTHORITY,
      installationId: INSTALLATION_ID,
      sequence: launch.expectedSequence,
      scenario,
      phase,
      nextActionCode,
      completedTransitions,
      proofProjection: projection({
        androidStoreAuthority: true,
        challengeSha256: launch.challengeSha256,
        ...proofOverrides,
      }),
      observedAt,
    });
    values.push(value);
    await appendB3PhysicalObservation({
      root,
      platform: 'android',
      command: launch,
      buildAuthority: ANDROID_BUILD_AUTHORITY,
      observationBytes: Buffer.from(canonicaliseB3ProofValue(value)),
    });
    await reconcileB3CaptureCheckpointFromJournal({
      root, platform: 'android', buildAuthority: ANDROID_BUILD_AUTHORITY,
    });
  };

  await add({
    scenarioIndex: 3, actionCode: 'ARM_CAPTURE',
    scenario: 'slow-card-pending-approve', phase: 'ARMED',
    nextActionCode: 'INITIATE_PURCHASE', completedTransitions: ['UNBOUND', 'ARMED'],
    proofOverrides: { storeEvents: [] },
    observedAt: '2026-07-15T10:01:00.000Z',
  });
  await add({
    scenarioIndex: 3, actionCode: 'INITIATE_PURCHASE',
    scenario: 'slow-card-pending-approve', phase: 'OBSERVING',
    nextActionCode: 'APPROVE_PENDING_PURCHASE',
    completedTransitions: ['UNBOUND', 'ARMED', 'WAITING_OPERATOR', 'OBSERVING'],
    proofOverrides: { storeEvents: [{ operation: 'purchase', outcome: 'pending' }] },
    observedAt: '2026-07-15T10:01:01.000Z',
  });
  const approveBridgeCommand = await createNextB3HostCommand({
    root,
    platform: 'android',
    buildAuthority: ANDROID_BUILD_AUTHORITY,
  });
  assert.equal(approveBridgeCommand.actionCode, 'ARM_GATEWAY_COMPLETION_HOLD');
  assert.equal(approveBridgeCommand.expectedScenarioIndex, 4);
  assert.equal(approveBridgeCommand.expectedSequence, 3);
  await add({
    scenarioIndex: 4, actionCode: 'ARM_GATEWAY_COMPLETION_HOLD',
    scenario: 'unacknowledged-relaunch', phase: 'HOLD_REACHED',
    nextActionCode: 'RELAUNCH',
    completedTransitions: ['ARMED', 'WAITING_OPERATOR', 'OBSERVING', 'HOLD_REACHED'],
    proofOverrides: {
      entitlementState: 'active',
      storeCompletionObserved: false,
      storeEvents: [{ operation: 'queryTransactions', outcome: 'purchased' }],
      gatewayCalls: [{
        operation: 'verify', relation: 'transaction-verification',
        traceId: '018f1d7b-97e8-4a52-8cf2-000000000001',
      }],
      transactionAuthority: {
        source: 'google-order-id', crossCheckedOnRefresh: false,
        domainSeparatedDigestSha256: 'f'.repeat(64), rawProofCleared: false,
      },
      entitlementAuthority: {
        id: 'full-ks2', state: 'active',
        domainSeparatedDigestSha256: 'e'.repeat(64), refreshHandlePresent: true,
      },
      refreshHandleLifecycle: {
        present: true, positiveVersionObserved: true, rotated: false, deleted: false,
      },
    },
    observedAt: '2026-07-15T10:01:02.000Z',
  });

  const records = await readB3PhysicalObservationJournal({
    root, platform: 'android', buildAuthority: ANDROID_BUILD_AUTHORITY,
  });
  assert.deepEqual(deriveB3ScenarioTransition({
    records,
    authority: {
      scenario: 'slow-card-pending-approve',
      outcome: 'pending-approved-no-access',
      traces: [],
    },
  }), {
    scenario: 'slow-card-pending-approve',
    startedAt: '2026-07-15T10:01:00.000Z',
    completedAt: '2026-07-15T10:01:02.000Z',
    outcome: 'pending-approved-no-access',
    gatewayTraces: [],
  });
  assert.equal(values.at(-1).proofProjection.transactionAuthority.rawProofCleared, false);
});

test('device/store evidence rejects completion fabricated in a product-query observation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-device-store-chain-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const launch = command();
  const value = await createB3ProofObservation({
    command: launch,
    buildAuthority: BUILD_AUTHORITY,
    installationId: INSTALLATION_ID,
    sequence: 1,
    scenario: 'product-query',
    phase: 'SCENARIO_COMPLETE',
    nextActionCode: 'ARM_CAPTURE',
    completedTransitions: ['UNBOUND', 'ARMED', 'WAITING_OPERATOR', 'OBSERVING', 'SCENARIO_COMPLETE'],
    proofProjection: projection({
      scenarioOutcome: 'products-visible',
      storeCompletionObserved: true,
      storeEvents: [
        { operation: 'queryProducts', outcome: 'products-visible' },
        { operation: 'finishTransaction', outcome: 'finished' },
      ],
      transactionAuthority: {
        source: 'apple-transaction-id', crossCheckedOnRefresh: true,
        domainSeparatedDigestSha256: 'f'.repeat(64), rawProofCleared: true,
      },
    }),
    observedAt: '2026-07-15T10:02:00.000Z',
  });
  await appendB3PhysicalObservation({
    root,
    platform: 'ios',
    command: launch,
    buildAuthority: BUILD_AUTHORITY,
    observationBytes: Buffer.from(canonicaliseB3ProofValue(value)),
  });
  const records = await readB3PhysicalObservationJournal({
    root, platform: 'ios', buildAuthority: BUILD_AUTHORITY,
  });
  assert.throws(() => deriveB3DeviceStoreEvidence({
    platform: 'ios',
    retained: records,
    device: { model: 'iPhone 17', osVersion: '26.0', physical: true },
  }), /scenario|completion|absent/i);

  for (const mutate of [
    (copy) => { copy[0].observation.proofProjection.storeEvents.pop(); },
    (copy) => { copy[0].observation.proofProjection.transactionAuthority.rawProofCleared = false; },
  ]) {
    const copy = structuredClone(records);
    mutate(copy);
    assert.throws(() => deriveB3DeviceStoreEvidence({
      platform: 'ios', retained: copy,
      device: { model: 'iPhone 17', osVersion: '26.0', physical: true },
    }), /validated retained|store|completion|authority/i);
  }
});
