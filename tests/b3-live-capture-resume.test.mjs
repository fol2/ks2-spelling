import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createB3LiveProofSession } from '../src/app/b3-live-proof-composition.js';
import {
  canonicaliseB3ProofValue,
  createB3ProofObservation,
  validateB3ProofObservation,
} from '../src/app/b3-live-proof-protocol.js';
import { seedB2Learners } from '../src/platform/database/b2-seed.js';
import { configureAndMigrateDatabase } from '../src/platform/database/migrate-database.js';
import {
  assertB3CaptureResumeAuthority,
  createB3CaptureCheckpoint,
  readB3CaptureCheckpoint,
  writeB3CaptureCheckpoint,
} from '../scripts/lib/b3-device-observation.mjs';
import { createNodeSqliteConnection } from './helpers/node-sqlite-connection.mjs';
import {
  captureB3ValidatedDeviceObservation,
  resumeB3IssuedDeviceObservation,
  advanceB3HostCaptureOne,
  driveB3HostScenario,
  driveB3HostUntilPhase,
  createB3StoreActionResumeAuthority,
  buildAuthorityFor,
  resumeB3AmbiguousIssuedCommandAfterReinstall,
} from '../scripts/lib/b3-live-capture-adapters.mjs';
import {
  clearB3IssuedCommand,
  persistB3IssuedCommand,
  readB3IssuedCommand,
  transitionB3IssuedCommand,
} from '../scripts/lib/b3-issued-command.mjs';
import { reconcileB3CaptureCheckpointFromJournal } from '../scripts/lib/b3-host-capture-state.mjs';
import {
  appendB3PhysicalObservation,
  readB3PhysicalObservationJournal,
} from '../scripts/lib/b3-physical-observation-journal.mjs';

const COMMIT = 'a'.repeat(40);
const FINGERPRINT = 'b'.repeat(64);
const TAIL = 'c'.repeat(64);
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
  applicationFingerprint: FINGERPRINT,
  versionName: '0.3.0-b3',
  buildNumber: '19',
});

test('default Android build authority retains an integer version code', () => {
  const authority = buildAuthorityFor('android', {
    testedApplicationCommit: COMMIT,
    applicationFingerprint: FINGERPRINT,
    versionName: '0.3.0-b3',
    androidVersionCode: 19,
  });
  assert.equal(authority.buildNumber, 19);
  assert.equal(Number.isSafeInteger(authority.buildNumber), true);
});

function launchCommand(overrides = {}) {
  return {
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
    challengeSha256: 'd'.repeat(64),
    ...overrides,
  };
}

function checkpoint(overrides = {}) {
  return {
    schemaVersion: 2,
    platform: 'ios',
    captureId: CAPTURE_ID,
    testedApplicationCommit: COMMIT,
    applicationFingerprint: FINGERPRINT,
    installationId: INSTALLATION_ID,
    nextScenarioIndex: 0,
    nextObservationSequence: 1,
    state: 'UNBOUND',
    completedScenarios: [],
    previousObservationSha256: TAIL,
    checkpointRevision: 0,
    ...overrides,
  };
}

test('checkpoint construction is closed, canonical and self-hashed', () => {
  const value = createB3CaptureCheckpoint(checkpoint());
  assert.match(value.checkpointSha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(Object.keys(value).sort(), [
    'schemaVersion', 'platform', 'captureId', 'testedApplicationCommit',
    'applicationFingerprint', 'installationId', 'nextScenarioIndex',
    'nextObservationSequence', 'state', 'completedScenarios',
    'previousObservationSha256', 'checkpointRevision', 'checkpointSha256',
  ].sort());
  assert.throws(
    () => createB3CaptureCheckpoint({ ...checkpoint(), operatorResult: 'passed' }),
    /checkpoint|schema/i,
  );
  assert.throws(
    () => createB3CaptureCheckpoint(checkpoint({ completedScenarios: ['cancel', 'cancel'] })),
    /scenario|checkpoint/i,
  );
});

test('checkpoint writes are mode-0600 canonical CAS records and reject stale writers', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-capture-cas-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const initial = createB3CaptureCheckpoint(checkpoint());
  const firstPath = await writeB3CaptureCheckpoint({
    root,
    platform: 'ios',
    expectedRevision: null,
    value: initial,
  });
  assert.equal(firstPath, '.native-build/b3/evidence/ios-capture-checkpoint.json');
  const absolute = join(root, firstPath);
  assert.equal((await lstat(absolute)).mode & 0o777, 0o600);
  assert.equal((await readFile(absolute, 'utf8')).endsWith('\n'), false);
  assert.deepEqual(await readB3CaptureCheckpoint({ root, platform: 'ios' }), initial);
  await writeFile(`${absolute}.lock`, 'stale pre-revision writer debris', { mode: 0o600 });

  const updated = createB3CaptureCheckpoint(checkpoint({
    nextScenarioIndex: 1,
    nextObservationSequence: 2,
    state: 'SCENARIO_COMPLETE',
    completedScenarios: ['product-query'],
    checkpointRevision: 1,
  }));
  await writeB3CaptureCheckpoint({
    root,
    platform: 'ios',
    expectedRevision: 0,
    value: updated,
  });
  assert.equal((await readB3CaptureCheckpoint({ root, platform: 'ios' })).checkpointRevision, 1);
  assert.deepEqual(await readB3CaptureCheckpoint({ root, platform: 'ios' }), updated);

  await assert.rejects(
    writeB3CaptureCheckpoint({
      root,
      platform: 'ios',
      expectedRevision: 0,
      value: createB3CaptureCheckpoint(checkpoint({ checkpointRevision: 1 })),
    }),
    /stale|revision/i,
  );
  assert.deepEqual(await readB3CaptureCheckpoint({ root, platform: 'ios' }), updated);
});

test('resume authority binds commit, fingerprint, capture, platform and hash-chain tail', () => {
  const value = createB3CaptureCheckpoint(checkpoint());
  const expected = {
    testedApplicationCommit: COMMIT,
    applicationFingerprint: FINGERPRINT,
    captureId: CAPTURE_ID,
    platform: 'ios',
    previousObservationSha256: TAIL,
  };
  assert.equal(assertB3CaptureResumeAuthority(value, expected), value);
  for (const mutation of [
    { testedApplicationCommit: 'd'.repeat(40) },
    { applicationFingerprint: 'd'.repeat(64) },
    { captureId: '018f1d7b-97e8-4a52-8cf2-783e5089c009' },
    { platform: 'android' },
    { previousObservationSha256: 'd'.repeat(64) },
  ]) {
    assert.throws(
      () => assertB3CaptureResumeAuthority(value, { ...expected, ...mutation }),
      /resume|authority/i,
    );
  }
});

test('checkpoint reader rejects symlink, hard-link and non-canonical replacement records', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-capture-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const value = createB3CaptureCheckpoint(checkpoint());
  const relative = await writeB3CaptureCheckpoint({
    root,
    platform: 'ios',
    expectedRevision: null,
    value,
  });
  const path = join(root, relative);
  const alias = join(root, '.native-build/b3/evidence/alias.json');
  await link(path, alias);
  await assert.rejects(readB3CaptureCheckpoint({ root, platform: 'ios' }), /link|policy/i);
  await rm(alias);

  await rm(path);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(readB3CaptureCheckpoint({ root, platform: 'ios' }), /canonical|hash/i);

  const original = `${path}.original`;
  await rm(path);
  await symlink(original, path);
  await assert.rejects(readB3CaptureCheckpoint({ root, platform: 'ios' }), /link|policy/i);
});

test('host validation accepts consecutive observations emitted by the real live session', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-live-session-chain-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const connection = createNodeSqliteConnection(join(root, 'proof.sqlite'));
  await connection.open();
  t.after(() => connection.close());
  await configureAndMigrateDatabase(connection);
  await seedB2Learners(connection);
  const controller = Object.freeze({
    async start() {},
    async sync() {},
  });
  const observations = [];
  const firstCommand = launchCommand();
  const first = await createB3LiveProofSession({
    command: firstCommand,
    buildAuthority: BUILD_AUTHORITY,
    connection,
    observationPort: Object.freeze({
      async getLaunchCommand() { return firstCommand; },
      async publishObservation(value) { observations.push(value); },
    }),
    clock: () => Date.parse('2026-07-15T10:00:00.000Z'),
    uuidFactory: () => INSTALLATION_ID,
  });
  await first.run(controller);
  await validateB3ProofObservation(observations[0], {
    command: firstCommand,
    buildAuthority: BUILD_AUTHORITY,
  });

  const secondCommand = launchCommand({
    expectedSequence: 2,
    previousObservationSha256: observations[0].observationSha256,
    actionCode: observations[0].nextActionCode,
    challengeSha256: 'e'.repeat(64),
  });
  const second = await createB3LiveProofSession({
    command: secondCommand,
    buildAuthority: BUILD_AUTHORITY,
    connection,
    observationPort: Object.freeze({
      async getLaunchCommand() { return secondCommand; },
      async publishObservation(value) { observations.push(value); },
    }),
    clock: () => Date.parse('2026-07-15T10:00:01.000Z'),
  });
  second.observeStoreResult('queryProducts', {
    operation: 'queryProducts',
    outcome: 'products-visible',
  });
  await second.run(controller);

  assert.equal(observations.length, 2);
  await validateB3ProofObservation(observations[1], {
    command: secondCommand,
    buildAuthority: BUILD_AUTHORITY,
    previousObservation: observations[0],
  });
});

test('host capture polls past a stale fixed-path observation and retains only command-bound bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-stale-observation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const expectedCommand = launchCommand();
  const staleCommand = launchCommand({ challengeSha256: 'f'.repeat(64) });
  const proofProjection = (challengeSha256) => ({
    challengeSha256,
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
      source: 'none', crossCheckedOnRefresh: false, domainSeparatedDigestSha256: null,
      rawProofCleared: false,
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
  });
  const create = (command) => createB3ProofObservation({
    command,
    buildAuthority: BUILD_AUTHORITY,
    installationId: INSTALLATION_ID,
    sequence: 1,
    scenario: 'product-query',
    phase: 'ARMED',
    nextActionCode: 'QUERY_PRODUCT',
    completedTransitions: ['UNBOUND', 'ARMED'],
    proofProjection: proofProjection(command.challengeSha256),
    observedAt: '2026-07-15T10:00:00.000Z',
  });
  const [stale, expected] = await Promise.all([create(staleCommand), create(expectedCommand)]);
  const pulls = [stale, expected].map((value) =>
    Buffer.from(canonicaliseB3ProofValue(value), 'utf8'));
  let launches = 0;
  let waits = 0;
  const observation = await captureB3ValidatedDeviceObservation({
    root,
    platform: 'ios',
    command: expectedCommand,
    buildAuthority: BUILD_AUTHORITY,
    transport: {
      async launch(value) {
        launches += 1;
        assert.deepEqual(value, expectedCommand);
      },
      async pullObservation() { return pulls.shift(); },
    },
    wait: async () => { waits += 1; },
    maximumPullAttempts: 3,
  });
  assert.equal(observation.observationSha256, expected.observationSha256);
  assert.equal(launches, 1);
  assert.equal(waits, 1);
  const records = await import('../scripts/lib/b3-physical-observation-journal.mjs')
    .then(({ readB3PhysicalObservationJournal }) =>
      readB3PhysicalObservationJournal({ root, platform: 'ios', buildAuthority: BUILD_AUTHORITY }));
  assert.equal(records.length, 1);
  assert.equal(records[0].observation.observationSha256, expected.observationSha256);
});

test('crash after journal append but before checkpoint recovers from retained authority', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-journal-checkpoint-crash-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const expectedCommand = launchCommand();
  const value = await createB3ProofObservation({
    command: expectedCommand,
    buildAuthority: BUILD_AUTHORITY,
    installationId: INSTALLATION_ID,
    sequence: 1,
    scenario: 'product-query',
    phase: 'ARMED',
    nextActionCode: 'QUERY_PRODUCT',
    completedTransitions: ['UNBOUND', 'ARMED'],
    proofProjection: {
      challengeSha256: expectedCommand.challengeSha256,
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
        source: 'none', crossCheckedOnRefresh: false, domainSeparatedDigestSha256: null,
        rawProofCleared: false,
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
  await assert.rejects(
    captureB3ValidatedDeviceObservation({
      root,
      platform: 'ios',
      command: expectedCommand,
      buildAuthority: BUILD_AUTHORITY,
      transport: {
        async launch() {},
        async pullObservation() {
          return Buffer.from(canonicaliseB3ProofValue(value), 'utf8');
        },
      },
      maximumPullAttempts: 1,
      afterJournal: async () => { throw new Error('simulated host crash'); },
    }),
    /simulated host crash/i,
  );
  await assert.rejects(
    readB3CaptureCheckpoint({ root, platform: 'ios' }),
    /ENOENT|no such file/i,
  );

  const recovered = await reconcileB3CaptureCheckpointFromJournal({
    root,
    platform: 'ios',
    buildAuthority: BUILD_AUTHORITY,
  });
  assert.equal(recovered.nextObservationSequence, 2);
  assert.equal(recovered.previousObservationSha256, value.observationSha256);
  assert.equal(recovered.state, 'ARMED');
  assert.deepEqual(await readB3CaptureCheckpoint({ root, platform: 'ios' }), recovered);
  const resumed = await captureB3ValidatedDeviceObservation({
    root,
    platform: 'ios',
    command: expectedCommand,
    buildAuthority: BUILD_AUTHORITY,
    transport: {
      async launch() { assert.fail('reconciled journal must prevent relaunch'); },
      async pullObservation() { assert.fail('reconciled journal must prevent repull'); },
    },
    maximumPullAttempts: 1,
  });
  assert.equal(resumed.observationSha256, value.observationSha256);
});

test('reconciliation rejects self-hashed checkpoint progress not derived from its exact journal tail', async (t) => {
  const expectedCommand = launchCommand();
  const value = await createB3ProofObservation({
    command: expectedCommand,
    buildAuthority: BUILD_AUTHORITY,
    installationId: INSTALLATION_ID,
    sequence: 1,
    scenario: 'product-query',
    phase: 'ARMED',
    nextActionCode: 'QUERY_PRODUCT',
    completedTransitions: ['UNBOUND', 'ARMED'],
    proofProjection: {
      challengeSha256: expectedCommand.challengeSha256,
      scenarioOutcome: 'in-progress', entitlementState: 'none', packState: 'absent',
      storeCompletionObserved: false, storeEvents: [], gatewayCalls: [],
      storeAuthority: {
        environment: 'sandbox', productId: 'uk.eugnel.ks2spelling.fullks2',
        localisedPriceObserved: false, completionState: 'not-observed',
      },
      syntheticLearners: {
        syntheticAuthorityMatched: true,
        positionalSnapshotSha256: ['a'.repeat(64), 'b'.repeat(64)],
      },
      transactionAuthority: {
        source: 'none', crossCheckedOnRefresh: false, domainSeparatedDigestSha256: null,
        rawProofCleared: false,
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
  for (const mutation of [
    { installationId: '018f1d7b-97e8-4a52-8cf2-783e5089c099' },
    { state: 'WAITING_OPERATOR' },
    { nextScenarioIndex: 1, completedScenarios: ['product-query'] },
  ]) {
    const root = await mkdtemp(join(tmpdir(), 'b3-checkpoint-derived-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await appendB3PhysicalObservation({
      root,
      platform: 'ios',
      command: expectedCommand,
      buildAuthority: BUILD_AUTHORITY,
      observationBytes: Buffer.from(canonicaliseB3ProofValue(value), 'utf8'),
    });
    const malicious = createB3CaptureCheckpoint({
      ...checkpoint({
        previousObservationSha256: value.observationSha256,
        nextObservationSequence: 2,
        state: 'ARMED',
      }),
      ...mutation,
    });
    await writeB3CaptureCheckpoint({
      root,
      platform: 'ios',
      expectedRevision: null,
      value: malicious,
    });
    await assert.rejects(
      reconcileB3CaptureCheckpointFromJournal({
        root,
        platform: 'ios',
        buildAuthority: BUILD_AUTHORITY,
      }),
      /checkpoint|journal|derived|progress|state/i,
    );
  }
});

test('host death after device publish but before journal resumes pull before any relaunch', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-publish-before-journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const expectedCommand = launchCommand();
  const value = await createB3ProofObservation({
    command: expectedCommand,
    buildAuthority: BUILD_AUTHORITY,
    installationId: INSTALLATION_ID,
    sequence: 1,
    scenario: 'product-query', phase: 'ARMED', nextActionCode: 'QUERY_PRODUCT',
    completedTransitions: ['UNBOUND', 'ARMED'],
    proofProjection: {
      challengeSha256: expectedCommand.challengeSha256,
      scenarioOutcome: 'in-progress', entitlementState: 'none', packState: 'absent',
      storeCompletionObserved: false, storeEvents: [], gatewayCalls: [],
      storeAuthority: {
        environment: 'sandbox', productId: 'uk.eugnel.ks2spelling.fullks2',
        localisedPriceObserved: false, completionState: 'not-observed',
      },
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
  const bytes = Buffer.from(canonicaliseB3ProofValue(value), 'utf8');
  await assert.rejects(captureB3ValidatedDeviceObservation({
    root, platform: 'ios', command: expectedCommand, buildAuthority: BUILD_AUTHORITY,
    transport: { async launch() {}, async pullObservation() { return bytes; } },
    maximumPullAttempts: 1,
    beforeJournal: async () => { throw new Error('simulated host death'); },
  }), /simulated host death/i);
  assert.deepEqual((await readB3IssuedCommand({ root, platform: 'ios' })).command, expectedCommand);

  let launches = 0;
  const resumed = await resumeB3IssuedDeviceObservation({
    root, platform: 'ios', buildAuthority: BUILD_AUTHORITY,
    transport: {
      async launch() { launches += 1; },
      async pullObservation() { return bytes; },
    },
    maximumPullAttempts: 1,
  });
  assert.equal(launches, 0);
  assert.equal(resumed.observationSha256, value.observationSha256);
  await assert.rejects(readB3IssuedCommand({ root, platform: 'ios' }), /ENOENT|absent/i);
});

test('an invalid command-bound publication retains launched authority and never relaunches', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-invalid-publication-retry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const expectedCommand = launchCommand();
  const value = await createB3ProofObservation({
    command: expectedCommand,
    buildAuthority: BUILD_AUTHORITY,
    installationId: INSTALLATION_ID,
    sequence: 1,
    scenario: 'product-query', phase: 'ARMED', nextActionCode: 'QUERY_PRODUCT',
    completedTransitions: ['UNBOUND', 'ARMED'],
    proofProjection: {
      challengeSha256: expectedCommand.challengeSha256,
      scenarioOutcome: 'in-progress', entitlementState: 'none', packState: 'absent',
      storeCompletionObserved: false, storeEvents: [], gatewayCalls: [],
      storeAuthority: {
        environment: 'sandbox', productId: 'uk.eugnel.ks2spelling.fullks2',
        localisedPriceObserved: false, completionState: 'not-observed',
      },
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
  const invalid = structuredClone(value);
  invalid.phase = 'SCENARIO_COMPLETE';
  await assert.rejects(captureB3ValidatedDeviceObservation({
    root, platform: 'ios', command: expectedCommand, buildAuthority: BUILD_AUTHORITY,
    transport: {
      async launch() {},
      async pullObservation() {
        return Buffer.from(canonicaliseB3ProofValue(invalid), 'utf8');
      },
    },
    maximumPullAttempts: 1,
  }), /observation|phase|hash|transition/i);
  assert.equal((await readB3IssuedCommand({ root, platform: 'ios' })).state, 'launched');

  let retries = 0;
  const recovered = await captureB3ValidatedDeviceObservation({
    root, platform: 'ios', command: expectedCommand, buildAuthority: BUILD_AUTHORITY,
    transport: {
      async launch() { retries += 1; },
      async pullObservation() {
        return Buffer.from(canonicaliseB3ProofValue(value), 'utf8');
      },
    },
    maximumPullAttempts: 1,
  });
  assert.equal(retries, 0);
  assert.equal(recovered.observationSha256, value.observationSha256);
});

test('issued-command transitions are adjacent CAS records', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-issued-states-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const expectedCommand = launchCommand();
  assert.equal((await persistB3IssuedCommand({
    root, platform: 'ios', command: expectedCommand,
  })).state, 'prepared');
  await writeFile(
    join(root, '.native-build/b3/evidence/ios-issued-command.json.lock'),
    canonicaliseB3ProofValue({
      pid: 2_147_483_647,
      token: '018f1d7b-97e8-4a52-8cf2-783e5089c099',
    }),
    { mode: 0o600 },
  );
  await writeFile(
    join(root, '.native-build/b3/evidence/.issued-revision-stale-writer.tmp'),
    'crash debris',
    { mode: 0o600 },
  );
  assert.equal((await transitionB3IssuedCommand({
    root, platform: 'ios', command: expectedCommand,
    expectedState: 'prepared', nextState: 'launching',
  })).state, 'launching');
  assert.equal((await transitionB3IssuedCommand({
    root, platform: 'ios', command: expectedCommand,
    expectedState: 'prepared', nextState: 'launching',
  })).transitionClaimed, false);
  assert.equal((await transitionB3IssuedCommand({
    root, platform: 'ios', command: expectedCommand,
    expectedState: 'launching', nextState: 'launched',
  })).state, 'launched');
});

test('one source-state successor wins conflicting concurrent transitions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-issued-conflicting-edge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const expectedCommand = launchCommand();
  await persistB3IssuedCommand({ root, platform: 'ios', command: expectedCommand });
  const results = await Promise.allSettled([
    transitionB3IssuedCommand({
      root, platform: 'ios', command: expectedCommand,
      expectedState: 'prepared', nextState: 'launching',
    }),
    transitionB3IssuedCommand({
      root, platform: 'ios', command: expectedCommand,
      expectedState: 'prepared', nextState: 'stop-intent',
    }),
  ]);
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(results.filter(({ status }) => status === 'rejected').length, 1);
  assert.equal(results.find(({ status }) => status === 'fulfilled').value.transitionClaimed, true);
  assert.ok(['launching', 'stop-intent'].includes(
    (await readB3IssuedCommand({ root, platform: 'ios' })).state,
  ));
});

test('death before launch resumes exactly once from prepared authority', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-before-launch-death-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const expectedCommand = launchCommand();
  await assert.rejects(captureB3ValidatedDeviceObservation({
    root, platform: 'ios', command: expectedCommand, buildAuthority: BUILD_AUTHORITY,
    transport: {
      async launch() { assert.fail('death occurs before launch'); },
      async pullObservation() { assert.fail('death occurs before pull'); },
    },
    afterIssue: async () => { throw new Error('simulated death before launch'); },
    maximumPullAttempts: 1,
  }), /death before launch/i);
  assert.equal((await readB3IssuedCommand({ root, platform: 'ios' })).state, 'prepared');

  let launches = 0;
  await assert.rejects(resumeB3IssuedDeviceObservation({
    root, platform: 'ios', buildAuthority: BUILD_AUTHORITY,
    transport: {
      async launch() { launches += 1; },
      async pullObservation() { throw new Error('stop after proving launch count'); },
    },
    maximumPullAttempts: 1,
  }), /stop after proving launch count/i);
  assert.equal(launches, 1);
  assert.equal((await readB3IssuedCommand({ root, platform: 'ios' })).state, 'launched');
});

for (const [label, captureOptions] of [
  ['during launch', {
    transportLaunch: async () => { throw new Error('simulated death during launch'); },
  }],
  ['after launch before receipt', {
    transportLaunch: async () => {},
    afterLaunch: async () => { throw new Error('simulated death after launch'); },
  }],
]) {
  test(`${label} is fail-closed and cannot duplicate native side effects`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'b3-ambiguous-launch-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    let launches = 0;
    await assert.rejects(captureB3ValidatedDeviceObservation({
      root, platform: 'ios', command: launchCommand(), buildAuthority: BUILD_AUTHORITY,
      transport: {
        async launch(command) { launches += 1; await captureOptions.transportLaunch(command); },
        async pullObservation() { assert.fail('ambiguous launch cannot pull'); },
      },
      ...(captureOptions.afterLaunch ? { afterLaunch: captureOptions.afterLaunch } : {}),
      maximumPullAttempts: 1,
    }), /simulated death/i);
    assert.equal((await readB3IssuedCommand({ root, platform: 'ios' })).state, 'launching');
    await assert.rejects(resumeB3IssuedDeviceObservation({
      root, platform: 'ios', buildAuthority: BUILD_AUTHORITY,
      transport: {
        async launch() { launches += 1; },
        async pullObservation() {
          throw Object.assign(new Error('observation pull did not produce bytes'), {
            code: 'b3_physical_device_command_failed',
          });
        },
      },
      maximumPullAttempts: 1,
    }), (error) => error?.code === 'b3_physical_launch_outcome_ambiguous');
    assert.equal(launches, 1);
  });
}

test('launching resume consumes an exact published observation without a second launch', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-launching-published-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const expectedCommand = launchCommand();
  const value = await createB3ProofObservation({
    command: expectedCommand,
    buildAuthority: BUILD_AUTHORITY,
    installationId: INSTALLATION_ID,
    sequence: 1,
    scenario: 'product-query', phase: 'ARMED', nextActionCode: 'QUERY_PRODUCT',
    completedTransitions: ['UNBOUND', 'ARMED'],
    proofProjection: {
      challengeSha256: expectedCommand.challengeSha256,
      scenarioOutcome: 'in-progress', entitlementState: 'none', packState: 'absent',
      storeCompletionObserved: false, storeEvents: [], gatewayCalls: [],
      storeAuthority: {
        environment: 'sandbox', productId: 'uk.eugnel.ks2spelling.fullks2',
        localisedPriceObserved: false, completionState: 'not-observed',
      },
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
  let launches = 0;
  await assert.rejects(captureB3ValidatedDeviceObservation({
    root, platform: 'ios', command: expectedCommand, buildAuthority: BUILD_AUTHORITY,
    transport: {
      async launch() { launches += 1; },
      async pullObservation() { assert.fail('host dies before pull'); },
    },
    afterLaunch: async () => { throw new Error('host dies after native publication'); },
    maximumPullAttempts: 1,
  }), /dies after native publication/i);
  assert.equal((await readB3IssuedCommand({ root, platform: 'ios' })).state, 'launching');
  const recovered = await resumeB3IssuedDeviceObservation({
    root, platform: 'ios', buildAuthority: BUILD_AUTHORITY,
    transport: {
      async launch() { launches += 1; },
      async pullObservation() {
        return Buffer.from(canonicaliseB3ProofValue(value), 'utf8');
      },
    },
    maximumPullAttempts: 1,
  });
  assert.equal(launches, 1);
  assert.equal(recovered.observationSha256, value.observationSha256);
  await assert.rejects(readB3IssuedCommand({ root, platform: 'ios' }), /ENOENT|absent/i);
});

test('reinstall acknowledgement authorises only exact fresh REBIND ambiguity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-ambiguous-reinstall-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const expectedCommand = launchCommand({
    actionCode: 'REBIND_FRESH_INSTALL',
    installationMode: 'fresh-reinstall',
  });
  await persistB3IssuedCommand({ root, platform: 'ios', command: expectedCommand });
  await transitionB3IssuedCommand({
    root, platform: 'ios', command: expectedCommand,
    expectedState: 'prepared', nextState: 'launching',
  });
  assert.equal(await resumeB3AmbiguousIssuedCommandAfterReinstall({
    root,
    platform: 'ios',
    enabled: true,
    actionCode: expectedCommand.actionCode,
    observationSha256: expectedCommand.previousObservationSha256,
  }), true);
  assert.equal((await readB3IssuedCommand({ root, platform: 'ios' })).state, 'reinstall-authorised');
  let reinstallLaunches = 0;
  await assert.rejects(resumeB3IssuedDeviceObservation({
    root, platform: 'ios', buildAuthority: BUILD_AUTHORITY,
    transport: {
      async launch(command) {
        reinstallLaunches += 1;
        assert.equal(command.actionCode, 'REBIND_FRESH_INSTALL');
        assert.equal(command.installationMode, 'fresh-reinstall');
      },
      async pullObservation() {
        throw Object.assign(new Error('observation pull did not produce bytes'), {
          code: 'b3_physical_device_command_failed',
        });
      },
    },
    maximumPullAttempts: 1,
  }), /fixed deadline/i);
  assert.equal(reinstallLaunches, 1);
  assert.equal((await readB3IssuedCommand({ root, platform: 'ios' })).state, 'launched');

  for (const actionCode of ['CANCEL_PURCHASE', 'ARM_CAPTURE', 'RELAUNCH']) {
    const rejectedRoot = await mkdtemp(join(tmpdir(), 'b3-reinstall-reject-'));
    t.after(() => rm(rejectedRoot, { recursive: true, force: true }));
    const rejected = launchCommand({ actionCode });
    await persistB3IssuedCommand({ root: rejectedRoot, platform: 'ios', command: rejected });
    await transitionB3IssuedCommand({
      root: rejectedRoot, platform: 'ios', command: rejected,
      expectedState: 'prepared', nextState: 'launching',
    });
    assert.equal(await resumeB3AmbiguousIssuedCommandAfterReinstall({
      root: rejectedRoot,
      platform: 'ios',
      enabled: true,
      actionCode,
      observationSha256: rejected.previousObservationSha256,
    }), false);
    assert.equal((await readB3IssuedCommand({
      root: rejectedRoot, platform: 'ios',
    })).state, 'launching');
  }
});

test('host-stop intent receives a durable receipt before outer force-stop returns', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-host-stop-receipt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const relaunch = launchCommand({ actionCode: 'RELAUNCH' });
  await persistB3IssuedCommand({ root, platform: 'ios', command: relaunch });
  await transitionB3IssuedCommand({
    root, platform: 'ios', command: relaunch,
    expectedState: 'prepared', nextState: 'stop-intent',
  });
  await transitionB3IssuedCommand({
    root, platform: 'ios', command: relaunch,
    expectedState: 'stop-intent', nextState: 'stop-executing',
  });
  const forceStop = async ({ retainReceipt }) => {
    await retainReceipt();
    assert.equal((await readB3IssuedCommand({ root, platform: 'ios' })).state, 'host-stopped');
  };
  await forceStop({
    retainReceipt: () => transitionB3IssuedCommand({
      root, platform: 'ios', command: relaunch,
      expectedState: 'stop-executing', nextState: 'host-stopped',
    }),
  });
  // Immutable successor derivation has no mutable current-pointer promotion
  // window; an existing receipt can be reconciled idempotently after death.
  await transitionB3IssuedCommand({
    root, platform: 'ios', command: relaunch,
    expectedState: 'stop-executing', nextState: 'host-stopped',
    existingRevisionOnly: true,
  });
  await assert.rejects((async () => {
    assert.equal((await readB3IssuedCommand({ root, platform: 'ios' })).state, 'host-stopped');
    throw new Error('simulated outer crash after forceStop return');
  })(), /outer crash/i);
});

test('concurrent stop resumers grant force-stop execution to one claimant only', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-stop-execution-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const relaunch = launchCommand({ actionCode: 'RELAUNCH' });
  await persistB3IssuedCommand({ root, platform: 'ios', command: relaunch });
  await transitionB3IssuedCommand({
    root, platform: 'ios', command: relaunch,
    expectedState: 'prepared', nextState: 'stop-intent',
  });
  let forceStops = 0;
  const resumers = await Promise.all([
    transitionB3IssuedCommand({
      root, platform: 'ios', command: relaunch,
      expectedState: 'stop-intent', nextState: 'stop-executing',
    }),
    transitionB3IssuedCommand({
      root, platform: 'ios', command: relaunch,
      expectedState: 'stop-intent', nextState: 'stop-executing',
    }),
  ]);
  for (const result of resumers) {
    if (result.transitionClaimed) forceStops += 1;
  }
  assert.equal(forceStops, 1);
  assert.equal(resumers.filter(({ transitionClaimed }) => transitionClaimed).length, 1);
});

test('issued-command claim installation remains deterministic under repeated contention', async (t) => {
  const roots = [];
  t.after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));
  for (let iteration = 0; iteration < 40; iteration += 1) {
    const sameRoot = await mkdtemp(join(tmpdir(), 'b3-issued-same-edge-stress-'));
    roots.push(sameRoot);
    const relaunch = launchCommand({
      challengeSha256: iteration.toString(16).padStart(64, '0'),
    });
    await persistB3IssuedCommand({ root: sameRoot, platform: 'ios', command: relaunch });
    await transitionB3IssuedCommand({
      root: sameRoot, platform: 'ios', command: relaunch,
      expectedState: 'prepared', nextState: 'stop-intent',
    });
    const sameResults = await Promise.all([
      transitionB3IssuedCommand({
        root: sameRoot, platform: 'ios', command: relaunch,
        expectedState: 'stop-intent', nextState: 'stop-executing',
      }),
      transitionB3IssuedCommand({
        root: sameRoot, platform: 'ios', command: relaunch,
        expectedState: 'stop-intent', nextState: 'stop-executing',
      }),
    ]);
    assert.equal(sameResults.filter(({ transitionClaimed }) => transitionClaimed).length, 1);

    const conflictRoot = await mkdtemp(join(tmpdir(), 'b3-issued-conflict-stress-'));
    roots.push(conflictRoot);
    const command = launchCommand({
      challengeSha256: (iteration + 64).toString(16).padStart(64, '0'),
    });
    await persistB3IssuedCommand({ root: conflictRoot, platform: 'ios', command });
    const conflictResults = await Promise.allSettled([
      transitionB3IssuedCommand({
        root: conflictRoot, platform: 'ios', command,
        expectedState: 'prepared', nextState: 'launching',
      }),
      transitionB3IssuedCommand({
        root: conflictRoot, platform: 'ios', command,
        expectedState: 'prepared', nextState: 'stop-intent',
      }),
    ]);
    assert.equal(conflictResults.filter(({ status }) => status === 'fulfilled').length, 1);
    assert.equal(conflictResults.filter(({ status }) => status === 'rejected').length, 1);
  }
});

test('immutable claim reconciliation rejects a persistent private temp hard link', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-issued-hostile-temp-'));
  const authorityRoot = await mkdtemp(join(tmpdir(), 'b3-issued-authority-record-'));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(authorityRoot, { recursive: true, force: true }),
  ]));
  const command = launchCommand();
  await persistB3IssuedCommand({ root, platform: 'ios', command });
  await persistB3IssuedCommand({ root: authorityRoot, platform: 'ios', command });
  await transitionB3IssuedCommand({
    root: authorityRoot, platform: 'ios', command,
    expectedState: 'prepared', nextState: 'stop-intent',
  });
  const authorityLedger = join(
    authorityRoot, '.native-build/b3/evidence/ios-issued-command-ledger',
  );
  const stateName = (await readdir(authorityLedger))
    .find((name) => name.endsWith('.state-stop-intent.json'));
  const ledger = join(root, '.native-build/b3/evidence/ios-issued-command-ledger');
  const retainedState = join(ledger, stateName);
  await writeFile(retainedState, await readFile(join(authorityLedger, stateName)), { mode: 0o600 });
  const persistentAlias = join(
    root,
    '.native-build/b3/evidence/.issued-018f1d7b-97e8-4a52-8cf2-783e5089c099.tmp',
  );
  await link(retainedState, persistentAlias);
  await assert.rejects(transitionB3IssuedCommand({
    root, platform: 'ios', command,
    expectedState: 'prepared', nextState: 'stop-intent',
  }), /link|policy/i);
  await rm(persistentAlias);
  assert.equal((await transitionB3IssuedCommand({
    root, platform: 'ios', command,
    expectedState: 'prepared', nextState: 'stop-intent',
  })).state, 'stop-intent');
});

test('stale clear of command A cannot consume concurrently persisted command B', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-clear-persist-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const commandA = launchCommand();
  const commandB = launchCommand({ challengeSha256: 'e'.repeat(64) });
  await persistB3IssuedCommand({ root, platform: 'ios', command: commandA });
  let releaseStaleClear;
  let staleClearReached;
  const reached = new Promise((resolveReached) => { staleClearReached = resolveReached; });
  const release = new Promise((resolveRelease) => { releaseStaleClear = resolveRelease; });
  const staleClear = clearB3IssuedCommand({
    root,
    platform: 'ios',
    command: commandA,
    beforeConsume: async () => {
      staleClearReached();
      await release;
    },
  });
  await reached;
  await clearB3IssuedCommand({ root, platform: 'ios', command: commandA });
  await persistB3IssuedCommand({ root, platform: 'ios', command: commandB });
  releaseStaleClear();
  await staleClear;
  assert.deepEqual((await readB3IssuedCommand({ root, platform: 'ios' })).command, commandB);
});

test('tombstone binds the actually derived terminal record', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-tombstone-terminal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const expectedCommand = launchCommand();
  await persistB3IssuedCommand({ root, platform: 'ios', command: expectedCommand });
  await clearB3IssuedCommand({ root, platform: 'ios', command: expectedCommand });
  const ledger = join(root, '.native-build/b3/evidence/ios-issued-command-ledger');
  const consumedName = (await readdir(ledger)).find((name) => name.endsWith('.consumed.json'));
  const consumedPath = join(ledger, consumedName);
  const consumed = JSON.parse(await readFile(consumedPath, 'utf8'));
  consumed.finalRecordSha256 = 'f'.repeat(64);
  const unsigned = Object.fromEntries(
    Object.entries(consumed).filter(([key]) => key !== 'tombstoneSha256'),
  );
  consumed.tombstoneSha256 = createHash('sha256')
    .update(Buffer.from(canonicaliseB3ProofValue(unsigned), 'utf8'))
    .digest('hex');
  await writeFile(consumedPath, canonicaliseB3ProofValue(consumed), { mode: 0o600 });
  await assert.rejects(readB3IssuedCommand({ root, platform: 'ios' }), /terminal state/i);
});

test('iOS and Android issued ledgers coexist with consumed and active histories', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-cross-platform-ledger-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const iosConsumed = launchCommand();
  const iosActive = launchCommand({ challengeSha256: 'e'.repeat(64) });
  const androidActive = launchCommand({
    platform: 'android-play-physical',
    challengeSha256: 'f'.repeat(64),
  });
  await persistB3IssuedCommand({ root, platform: 'ios', command: iosConsumed });
  await clearB3IssuedCommand({ root, platform: 'ios', command: iosConsumed });
  await Promise.all([
    persistB3IssuedCommand({ root, platform: 'ios', command: iosActive }),
    persistB3IssuedCommand({ root, platform: 'android', command: androidActive }),
  ]);
  assert.deepEqual((await readB3IssuedCommand({ root, platform: 'ios' })).command, iosActive);
  assert.deepEqual((await readB3IssuedCommand({ root, platform: 'android' })).command, androidActive);
});

test('issued ledger entry and base scans are independently bounded', async (t) => {
  const entryRoot = await mkdtemp(join(tmpdir(), 'b3-ledger-entry-bound-'));
  const baseRoot = await mkdtemp(join(tmpdir(), 'b3-ledger-base-bound-'));
  t.after(() => Promise.all([
    rm(entryRoot, { recursive: true, force: true }),
    rm(baseRoot, { recursive: true, force: true }),
  ]));
  await persistB3IssuedCommand({ root: entryRoot, platform: 'ios', command: launchCommand() });
  const entryLedger = join(
    entryRoot, '.native-build/b3/evidence/ios-issued-command-ledger',
  );
  await Promise.all(Array.from({ length: 256 }, (_, index) => writeFile(
    join(entryLedger, `${index.toString(16).padStart(64, '0')}.state-launched.json`),
    'bounded-debris',
    { mode: 0o600 },
  )));
  await assert.rejects(
    readB3IssuedCommand({ root: entryRoot, platform: 'ios' }),
    /entry policy|bound/i,
  );

  const consumed = launchCommand();
  await persistB3IssuedCommand({ root: baseRoot, platform: 'ios', command: consumed });
  await clearB3IssuedCommand({ root: baseRoot, platform: 'ios', command: consumed });
  const baseLedger = join(baseRoot, '.native-build/b3/evidence/ios-issued-command-ledger');
  await Promise.all(Array.from({ length: 64 }, (_, index) => writeFile(
    join(baseLedger, `${(index + 1).toString(16).padStart(64, '0')}.base.json`),
    'bounded-debris',
    { mode: 0o600 },
  )));
  await assert.rejects(
    readB3IssuedCommand({ root: baseRoot, platform: 'ios' }),
    /base count|bound/i,
  );
});

test('empty host root issues ARM_CAPTURE and makes durable progress on first invocation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-empty-root-progress-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let issuedCommand;
  const transport = {
    async launch(command) { issuedCommand = command; },
    async pullObservation() {
      const value = await createB3ProofObservation({
        command: issuedCommand,
        buildAuthority: BUILD_AUTHORITY,
        installationId: INSTALLATION_ID,
        sequence: 1,
        scenario: 'product-query', phase: 'ARMED', nextActionCode: 'QUERY_PRODUCT',
        completedTransitions: ['UNBOUND', 'ARMED'],
        proofProjection: {
          challengeSha256: issuedCommand.challengeSha256,
          scenarioOutcome: 'in-progress', entitlementState: 'none', packState: 'absent',
          storeCompletionObserved: false, storeEvents: [], gatewayCalls: [],
          storeAuthority: {
            environment: 'sandbox', productId: 'uk.eugnel.ks2spelling.fullks2',
            localisedPriceObserved: false, completionState: 'not-observed',
          },
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
      return Buffer.from(canonicaliseB3ProofValue(value), 'utf8');
    },
  };
  const observation = await advanceB3HostCaptureOne({
    root, platform: 'ios', buildAuthority: BUILD_AUTHORITY, transport,
    uuidFactory: () => CAPTURE_ID,
    maximumPullAttempts: 1,
  });
  assert.equal(issuedCommand.actionCode, 'ARM_CAPTURE');
  assert.equal(observation.phase, 'ARMED');
  const checkpointValue = await readB3CaptureCheckpoint({ root, platform: 'ios' });
  assert.equal(checkpointValue.nextObservationSequence, 2);
  assert.equal(checkpointValue.state, 'ARMED');
});

test('next host invocation advances an armed scenario to retained completion', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-multi-invocation-progress-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const launches = [];
  let issuedCommand;
  const projection = (command, terminal) => ({
    challengeSha256: command.challengeSha256,
    scenarioOutcome: terminal ? 'products-visible' : 'in-progress',
    entitlementState: 'none', packState: 'absent',
    storeCompletionObserved: false,
    storeEvents: terminal
      ? [{ operation: 'queryProducts', outcome: 'products-visible' }]
      : [],
    storeAuthority: {
      environment: 'sandbox', productId: 'uk.eugnel.ks2spelling.fullks2',
      localisedPriceObserved: terminal, completionState: 'not-observed',
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
  });
  const transport = {
    async launch(command) {
      launches.push(command.actionCode);
      issuedCommand = command;
    },
    async pullObservation() {
      const terminal = issuedCommand.actionCode === 'QUERY_PRODUCT';
      const value = await createB3ProofObservation({
        command: issuedCommand,
        buildAuthority: BUILD_AUTHORITY,
        installationId: INSTALLATION_ID,
        sequence: issuedCommand.expectedSequence,
        scenario: 'product-query',
        phase: terminal ? 'SCENARIO_COMPLETE' : 'ARMED',
        nextActionCode: terminal ? 'ARM_CAPTURE' : 'QUERY_PRODUCT',
        completedTransitions: terminal
          ? ['UNBOUND', 'ARMED', 'WAITING_OPERATOR', 'OBSERVING', 'SCENARIO_COMPLETE']
          : ['UNBOUND', 'ARMED'],
        proofProjection: projection(issuedCommand, terminal),
        observedAt: terminal
          ? '2026-07-15T10:00:01.000Z'
          : '2026-07-15T10:00:00.000Z',
      });
      return Buffer.from(canonicaliseB3ProofValue(value), 'utf8');
    },
  };
  const advance = () => advanceB3HostCaptureOne({
    root, platform: 'ios', buildAuthority: BUILD_AUTHORITY, transport,
    uuidFactory: () => CAPTURE_ID,
    maximumPullAttempts: 1,
  });

  await advance();
  const transition = await driveB3HostScenario({
    authority: { scenario: 'product-query', outcome: 'products-visible', traces: [] },
    readRecords: () => readB3PhysicalObservationJournal({
      root, platform: 'ios', buildAuthority: BUILD_AUTHORITY,
    }),
    advance,
  });

  assert.deepEqual(launches, ['ARM_CAPTURE', 'QUERY_PRODUCT']);
  assert.equal(transition.scenario, 'product-query');
  assert.equal(transition.outcome, 'products-visible');
  assert.equal((await readB3CaptureCheckpoint({ root, platform: 'ios' })).nextScenarioIndex, 1);
});

test('issued command is canonical, immutable and rejects symlink or hard-link authority', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-issued-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = launchCommand();
  await persistB3IssuedCommand({ root, platform: 'ios', command });
  const ledger = join(root, '.native-build/b3/evidence/ios-issued-command-ledger');
  const baseName = (await readdir(ledger)).find((name) => name.endsWith('.base.json'));
  const path = join(ledger, baseName);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.equal((await readFile(path, 'utf8')).endsWith('\n'), false);
  await assert.rejects(
    persistB3IssuedCommand({
      root,
      platform: 'ios',
      command: launchCommand({ challengeSha256: 'e'.repeat(64) }),
    }),
    /conflict|pending/i,
  );

  const alias = `${path}.alias`;
  await link(path, alias);
  await assert.rejects(readB3IssuedCommand({ root, platform: 'ios' }), /link|policy/i);
  await rm(alias);
  const hostilePrivateAlias = join(
    root,
    '.native-build/b3/evidence/.issued-018f1d7b-97e8-4a52-8cf2-783e5089c099.tmp',
  );
  await link(path, hostilePrivateAlias);
  await assert.rejects(readB3IssuedCommand({ root, platform: 'ios' }), /link|policy/i);
  await rm(hostilePrivateAlias);
  const bytes = await readFile(path);
  await rm(path);
  await writeFile(path, `${JSON.stringify(JSON.parse(bytes), null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(readB3IssuedCommand({ root, platform: 'ios' }), /canonical/i);
  await rm(path);
  await symlink(`${path}.missing`, path);
  await assert.rejects(readB3IssuedCommand({ root, platform: 'ios' }), /link|policy/i);
});

test('one resume flag acknowledges exactly one retained store-action tail', () => {
  const binding = {
    actionCode: 'DECLINE_PENDING_PURCHASE',
    observationSha256: 'a'.repeat(64),
  };
  const resume = createB3StoreActionResumeAuthority(true, binding);
  assert.equal(resume({
    actionCode: 'DECLINE_PENDING_PURCHASE',
    observationSha256: 'a'.repeat(64),
  }), true);
  assert.equal(resume({
    actionCode: 'APPROVE_PENDING_PURCHASE',
    observationSha256: 'b'.repeat(64),
  }), false);
  assert.throws(() => createB3StoreActionResumeAuthority(true), /invocation-tail/i);
});

test('host phase driver stops at validated HOLD before any relaunch command', async () => {
  const retained = [{ observation: {
    scenario: 'unacknowledged-relaunch', phase: 'ARMED',
  } }];
  let advances = 0;
  const held = await driveB3HostUntilPhase({
    scenario: 'unacknowledged-relaunch',
    phase: 'HOLD_REACHED',
    readRecords: async () => retained,
    advance: async () => {
      advances += 1;
      retained.push({ observation: {
        scenario: 'unacknowledged-relaunch',
        phase: advances === 1 ? 'HOLD_REACHED' : 'SCENARIO_COMPLETE',
      } });
    },
  });
  assert.equal(held.phase, 'HOLD_REACHED');
  assert.equal(advances, 1);
});

test('reinstall resume is bound to the retained gate and advances exactly once', async () => {
  const observationSha256 = 'a'.repeat(64);
  const readRecords = async () => [{ observation: {
    nextActionCode: 'REBIND_FRESH_INSTALL', observationSha256,
  } }];
  await assert.rejects(driveB3HostScenario({
    authority: { scenario: 'restore-after-reinstall', outcome: 'restored-active', traces: [] },
    readRecords,
    advance: async () => assert.fail('unacknowledged reinstall must not advance'),
  }), (error) => error?.instructionCode === 'REINSTALL_EXACT_BUILD');

  let advances = 0;
  await assert.rejects(driveB3HostScenario({
    authority: { scenario: 'restore-after-reinstall', outcome: 'restored-active', traces: [] },
    readRecords,
    resumeReinstall: ({ actionCode, observationSha256: retainedHash }) =>
      actionCode === 'REBIND_FRESH_INSTALL' && retainedHash === observationSha256,
    advance: async () => {
      advances += 1;
      throw new Error('stopped after exact reinstall resume');
    },
  }), /stopped after exact reinstall resume/i);
  assert.equal(advances, 1);
});

test('terminal driver advances refund completion only to app-owned terminal capture', async () => {
  const retained = [{ observation: {
    scenario: 'refund-revoke', phase: 'SCENARIO_COMPLETE',
  } }];
  let advances = 0;
  const terminal = await driveB3HostUntilPhase({
    scenario: 'refund-revoke',
    phase: 'TERMINAL_CAPTURE',
    readRecords: async () => retained,
    advance: async () => {
      advances += 1;
      retained.push({ observation: {
        scenario: 'refund-revoke', phase: 'TERMINAL_CAPTURE',
      } });
    },
  });
  assert.equal(terminal.phase, 'TERMINAL_CAPTURE');
  assert.equal(advances, 1);
  assert.equal(retained.some(({ observation }) => observation.phase === 'COMPLETE'), false);
});
