import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import {
  link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  recoverB3AmbiguousCaptureAfterReinstall,
} from '../scripts/lib/b3-live-capture-adapters.mjs';
import {
  clearB3IssuedCommand,
  persistB3IssuedCommand,
  readB3IssuedCommand,
  readB3IssuedCommandRecoverySuccessor,
  transitionB3IssuedCommand,
} from '../scripts/lib/b3-issued-command.mjs';
import { reconcileB3CaptureCheckpointFromJournal } from '../scripts/lib/b3-host-capture-state.mjs';
import {
  appendB3PhysicalObservation,
  readB3PhysicalObservationJournal,
} from '../scripts/lib/b3-physical-observation-journal.mjs';
import { runB3PhysicalDeviceProcess } from '../scripts/lib/b3-physical-device-transport.mjs';
import { b3IosProofExitCode } from '../scripts/prove-b3-ios.mjs';
import { b3AndroidProofExitCode } from '../scripts/prove-b3-android.mjs';

const COMMIT = 'a'.repeat(40);
const FINGERPRINT = 'b'.repeat(64);
const TAIL = 'c'.repeat(64);
const CAPTURE_ID = '018f1d7b-97e8-4a52-8cf2-783e5089c001';
const INSTALLATION_ID = '018f1d7b-97e8-4a52-8cf2-783e5089c002';
const CAPTURE_RACE_CHILD = fileURLToPath(
  new URL('./helpers/b3-live-capture-race-child.mjs', import.meta.url),
);
const ISSUED_COMMAND_RACE_CHILD = fileURLToPath(
  new URL('./helpers/b3-issued-command-race-child.mjs', import.meta.url),
);

function launchIpcRaceChild({ helper, environmentKey, input }) {
  const childLabel = input.label ?? input.operation ?? input.role ?? 'unlabelled';
  const child = spawn(process.execPath, [helper], {
    env: {
      ...process.env,
      [environmentKey]: Buffer.from(JSON.stringify(input)).toString('base64url'),
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-16 * 1_024);
  });
  const messages = [];
  const waiters = [];
  let exitAuthority = null;
  let lastProgress = null;
  child.on('message', (message) => {
    if (message?.type === 'progress') {
      lastProgress = message;
      return;
    }
    const index = waiters.findIndex(({ type }) => type === message?.type);
    if (index < 0) {
      messages.push(message);
      return;
    }
    const [{ resolve, timeout }] = waiters.splice(index, 1);
    clearTimeout(timeout);
    resolve(message);
  });
  child.once('exit', (code, signal) => {
    exitAuthority = { code, signal };
    for (const { type, reject, timeout } of waiters.splice(0)) {
      clearTimeout(timeout);
      reject(new Error(
        `B3 capture race child exited before ${type} (${code ?? signal}): ${stderr}`,
      ));
    }
  });
  const waitFor = (type) => {
    const index = messages.findIndex((message) => message?.type === type);
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
    if (exitAuthority !== null) {
      return Promise.reject(new Error(
        `B3 capture race child ${childLabel} (${input.operation ?? input.role ?? 'unknown'}) ` +
        `exited before ${type} ` +
        `(${exitAuthority.code ?? exitAuthority.signal}): ${stderr}`,
      ));
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const waiterIndex = waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
        reject(new Error(
          `B3 capture race child ${childLabel} (${input.operation ?? input.role ?? 'unknown'}) ` +
          `timed out waiting for ${type}; last progress ` +
          `${JSON.stringify(lastProgress)}: ${stderr}`,
        ));
      }, 30_000);
      waiters.push({ type, resolve, reject, timeout });
    });
  };
  return Object.freeze({
    child,
    waitFor,
    go: () => child.send({ type: 'go' }),
    continueRun: () => child.send({ type: 'continue' }),
    sendControl: (type) => child.send({ type }),
    terminate: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    },
  });
}

function launchCaptureRaceChild(input) {
  return launchIpcRaceChild({
    helper: CAPTURE_RACE_CHILD,
    environmentKey: 'B3_CAPTURE_RACE_CHILD_INPUT',
    input,
  });
}

function launchIssuedCommandRaceChild(input) {
  return launchIpcRaceChild({
    helper: ISSUED_COMMAND_RACE_CHILD,
    environmentKey: 'B3_ISSUED_COMMAND_RACE_CHILD_INPUT',
    input,
  });
}

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

test('slow-card physical launch and pull settle within the absolute deadline', async (t) => {
  const deadlineBudgetMs = 600;
  const maximumElapsedMs = deadlineBudgetMs + 125;

  for (const delayedOperation of ['launch', 'pull']) {
    const root = await mkdtemp(join(tmpdir(), `b3-slow-card-${delayedOperation}-deadline-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    let completedStubbornSettlements = 0;
    let processTimedOut = false;
    const stubbornProcess = async (options) => {
      const result = await runB3PhysicalDeviceProcess(process.execPath, [
        '-e',
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
      ], {
        timeoutMs: options.timeoutMs,
        stdoutLimit: 1024,
        stderrLimit: 1024,
      });
      processTimedOut = result.timedOut;
      throw Object.assign(new Error('observation pull did not produce bytes'), {
        code: 'b3_physical_device_command_failed',
      });
    };
    const startedAt = performance.now();
    await assert.rejects(captureB3ValidatedDeviceObservation({
      root,
      platform: 'ios',
      command: launchCommand({ captureId: delayedOperation === 'launch'
        ? '018f1d7b-97e8-4a52-8cf2-783e5089c011'
        : '018f1d7b-97e8-4a52-8cf2-783e5089c012' }),
      buildAuthority: BUILD_AUTHORITY,
      transport: {
        launch: delayedOperation === 'launch'
          ? async (_command, options) => {
            try {
              await stubbornProcess(options);
            } finally {
              completedStubbornSettlements += 1;
            }
          }
          : async () => {},
        pullObservation: delayedOperation === 'pull'
          ? async (options) => {
            try {
              await stubbornProcess(options);
            } finally {
              completedStubbornSettlements += 1;
            }
          }
          : async () => assert.fail('pull started after the launch consumed its deadline'),
      },
      maximumPullAttempts: 1,
      deadlineMs: startedAt + deadlineBudgetMs,
      monotonicClock: () => performance.now(),
    }));
    assert.equal(completedStubbornSettlements, 1);
    assert.equal(processTimedOut, true);
    const elapsedMs = performance.now() - startedAt;
    assert.ok(
      elapsedMs <= maximumElapsedMs,
      `${delayedOperation} settled after the absolute deadline (${elapsedMs}ms)`,
    );
  }
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

function emptyProofProjection(command) {
  return {
    challengeSha256: command.challengeSha256,
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
  const operationTimeouts = [];
  const observation = await captureB3ValidatedDeviceObservation({
    root,
    platform: 'ios',
    command: expectedCommand,
    buildAuthority: BUILD_AUTHORITY,
    transport: {
      async launch(value, options) {
        launches += 1;
        operationTimeouts.push(options.timeoutMs);
        assert.deepEqual(value, expectedCommand);
      },
      async pullObservation(options) {
        operationTimeouts.push(options.timeoutMs);
        return pulls.shift();
      },
    },
    wait: async () => { waits += 1; },
    maximumPullAttempts: 3,
    deadlineMs: 600_000,
    monotonicClock: () => 580_000,
  });
  assert.equal(observation.observationSha256, expected.observationSha256);
  assert.equal(launches, 1);
  assert.equal(waits, 1);
  assert.deepEqual(operationTimeouts, [19_750, 19_750, 19_750]);
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

for (const [platform, commandPlatform, exitCode] of [
  ['ios', 'ios-physical', b3IosProofExitCode],
  ['android', 'android-play-physical', b3AndroidProofExitCode],
]) {
  for (const [label, captureOptions] of [
    ['during launch', {
      transportLaunch: async () => { throw new Error('simulated death during launch'); },
    }],
    ['after launch before receipt', {
      transportLaunch: async () => {},
      afterLaunch: async () => { throw new Error('simulated death after launch'); },
    }],
  ]) test(`${platform} ${label} pulls before reaching the closed reinstall gate`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'b3-ambiguous-launch-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const expectedCommand = launchCommand({ platform: commandPlatform });
    let launches = 0;
    let pulls = 0;
    await assert.rejects(captureB3ValidatedDeviceObservation({
      root, platform, command: expectedCommand, buildAuthority: BUILD_AUTHORITY,
      transport: {
        async launch(command) { launches += 1; await captureOptions.transportLaunch(command); },
        async pullObservation() {
          pulls += 1;
          throw Object.assign(new Error('observation pull did not produce bytes'), {
            code: 'b3_physical_device_command_failed',
          });
        },
      },
      ...(captureOptions.afterLaunch ? { afterLaunch: captureOptions.afterLaunch } : {}),
      maximumPullAttempts: 1,
    }), (error) => error?.code === 'b3_operator_action_required' &&
      error.instructionCode === 'REINSTALL_EXACT_BUILD' && exitCode(error) === 7);
    assert.equal(launches, 1);
    assert.equal(pulls, 1);
    assert.equal((await readB3IssuedCommand({ root, platform })).state, 'restart-required');
  });
}

test('an ambiguous launch reconciles a same-invocation publication without relaunch', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-ambiguous-launch-published-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = launchCommand();
  const observation = await createB3ProofObservation({
    command,
    buildAuthority: BUILD_AUTHORITY,
    installationId: INSTALLATION_ID,
    sequence: 1,
    scenario: 'product-query',
    phase: 'ARMED',
    nextActionCode: 'QUERY_PRODUCT',
    completedTransitions: ['UNBOUND', 'ARMED'],
    proofProjection: emptyProofProjection(command),
    observedAt: '2026-07-15T10:00:00.000Z',
  });
  let launches = 0;
  let pulls = 0;

  const recovered = await captureB3ValidatedDeviceObservation({
    root,
    platform: 'ios',
    command,
    buildAuthority: BUILD_AUTHORITY,
    transport: {
      async launch() {
        launches += 1;
        throw new Error('ambiguous launch return');
      },
      async pullObservation() {
        pulls += 1;
        return Buffer.from(canonicaliseB3ProofValue(observation), 'utf8');
      },
    },
    maximumPullAttempts: 1,
  });

  assert.equal(recovered.observationSha256, observation.observationSha256);
  assert.equal(launches, 1);
  assert.equal(pulls, 1);
  await assert.rejects(readB3IssuedCommand({ root, platform: 'ios' }), /ENOENT|absent/i);
});

async function retainAmbiguousRestartGate({ root, command = launchCommand() }) {
  await assert.rejects(captureB3ValidatedDeviceObservation({
    root,
    platform: 'ios',
    command,
    buildAuthority: BUILD_AUTHORITY,
    transport: {
      async launch() { throw new Error('ambiguous physical launch'); },
      async pullObservation() {
        throw Object.assign(new Error('observation pull did not produce bytes'), {
          code: 'b3_physical_device_command_failed',
        });
      },
    },
    maximumPullAttempts: 1,
  }), (error) => error?.instructionCode === 'REINSTALL_EXACT_BUILD');
  return readB3IssuedCommand({ root, platform: 'ios' });
}

async function retainAmbiguousRestartGateWithJournal({ root }) {
  const firstCommand = launchCommand();
  const firstObservation = await createB3ProofObservation({
    command: firstCommand,
    buildAuthority: BUILD_AUTHORITY,
    installationId: INSTALLATION_ID,
    sequence: 1,
    scenario: 'product-query',
    phase: 'ARMED',
    nextActionCode: 'QUERY_PRODUCT',
    completedTransitions: ['UNBOUND', 'ARMED'],
    proofProjection: emptyProofProjection(firstCommand),
    observedAt: '2026-07-15T10:00:00.000Z',
  });
  await appendB3PhysicalObservation({
    root,
    platform: 'ios',
    command: firstCommand,
    buildAuthority: BUILD_AUTHORITY,
    observationBytes: Buffer.from(canonicaliseB3ProofValue(firstObservation), 'utf8'),
  });
  const retained = await retainAmbiguousRestartGate({
    root,
    command: launchCommand({
      expectedSequence: 2,
      previousObservationSha256: firstObservation.observationSha256,
    }),
  });
  return { retained, firstObservation };
}

test('ordinary ambiguity archives its exact capture and restarts from sequence one', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-ordinary-ambiguity-restart-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const abandoned = await retainAmbiguousRestartGate({ root });

  assert.equal(await recoverB3AmbiguousCaptureAfterReinstall({
    root,
    platform: 'ios',
    enabled: true,
    invocationCommandSha256: 'f'.repeat(64),
    buildAuthority: BUILD_AUTHORITY,
  }), false);
  assert.equal((await readB3IssuedCommand({ root, platform: 'ios' })).state,
    'restart-required');
  const evidence = join(root, '.native-build/b3/evidence');
  await writeFile(join(evidence, 'ios-pending.json'), '{"stale":true}', { mode: 0o600 });
  await writeFile(join(evidence, 'cloudflare-device-smoke.json'), '{"stale":true}', {
    mode: 0o600,
  });

  const recovery = await recoverB3AmbiguousCaptureAfterReinstall({
    root,
    platform: 'ios',
    enabled: true,
    invocationCommandSha256: abandoned.commandSha256,
    buildAuthority: BUILD_AUTHORITY,
  });
  assert.equal(recovery.restarted, true);
  assert.equal(recovery.abandonedCaptureId, abandoned.command.captureId);
  await assert.rejects(readB3IssuedCommand({ root, platform: 'ios' }), /ENOENT|absent/i);

  const archiveRoot = join(root, '.native-build/b3/evidence/ios-abandoned-captures');
  const archives = await readdir(archiveRoot);
  assert.deepEqual(archives, [abandoned.commandSha256]);
  const archiveAuthority = JSON.parse(await readFile(
    join(archiveRoot, abandoned.commandSha256, 'authority.json'),
    'utf8',
  ));
  assert.equal(archiveAuthority.schemaVersion, 2);
  assert.equal(archiveAuthority.captureId, abandoned.command.captureId);
  assert.equal(archiveAuthority.commandSha256, abandoned.commandSha256);
  assert.match(archiveAuthority.observationJournalSnapshotSha256, /^[0-9a-f]{64}$/u);
  assert.equal(await readFile(join(
    archiveRoot, abandoned.commandSha256, 'derived', 'ios-pending.json',
  ), 'utf8'), '{"stale":true}');
  assert.equal(await readFile(join(
    archiveRoot, abandoned.commandSha256, 'derived', 'cloudflare-device-smoke.json',
  ), 'utf8'), '{"stale":true}');
  await assert.rejects(readFile(join(evidence, 'ios-pending.json')), /ENOENT/u);
  await assert.rejects(readFile(join(evidence, 'cloudflare-device-smoke.json')), /ENOENT/u);

  let freshCommand;
  const next = await advanceB3HostCaptureOne({
    root,
    platform: 'ios',
    buildAuthority: BUILD_AUTHORITY,
    uuidFactory: () => '00000000-0000-4000-8000-000000000999',
    maximumPullAttempts: 1,
    transport: {
      async launch(command) { freshCommand = command; },
      async pullObservation() {
        const observation = await createB3ProofObservation({
          command: freshCommand,
          buildAuthority: BUILD_AUTHORITY,
          installationId: '00000000-0000-4000-8000-000000000998',
          sequence: 1,
          scenario: 'product-query',
          phase: 'ARMED',
          nextActionCode: 'QUERY_PRODUCT',
          completedTransitions: ['UNBOUND', 'ARMED'],
          proofProjection: emptyProofProjection(freshCommand),
          observedAt: '2026-07-15T10:00:01.000Z',
        });
        return Buffer.from(canonicaliseB3ProofValue(observation), 'utf8');
      },
    },
  });
  assert.equal(freshCommand.captureId, '00000000-0000-4000-8000-000000000999');
  assert.equal(freshCommand.expectedSequence, 1);
  assert.equal(freshCommand.actionCode, 'ARM_CAPTURE');
  assert.equal(next.sequence, 1);
});

test('repeated fresh-REBIND ambiguity uses the disjoint capture-restart path', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-rebind-ambiguity-restart-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = launchCommand({
    actionCode: 'REBIND_FRESH_INSTALL',
    installationMode: 'fresh-reinstall',
  });
  await persistB3IssuedCommand({ root, platform: 'ios', command });
  await transitionB3IssuedCommand({
    root, platform: 'ios', command,
    expectedState: 'prepared', nextState: 'launching',
  });
  await transitionB3IssuedCommand({
    root, platform: 'ios', command,
    expectedState: 'launching', nextState: 'reinstall-authorised',
  });

  await assert.rejects(resumeB3IssuedDeviceObservation({
    root,
    platform: 'ios',
    buildAuthority: BUILD_AUTHORITY,
    transport: {
      async launch() { throw new Error('second ambiguous reinstall launch'); },
      async pullObservation() {
        throw Object.assign(new Error('observation pull did not produce bytes'), {
          code: 'b3_physical_device_command_failed',
        });
      },
    },
    maximumPullAttempts: 1,
  }), (error) => error?.instructionCode === 'REINSTALL_EXACT_BUILD');
  const retained = await readB3IssuedCommand({ root, platform: 'ios' });
  assert.equal(retained.state, 'restart-required');

  const recovery = await recoverB3AmbiguousCaptureAfterReinstall({
    root,
    platform: 'ios',
    enabled: true,
    invocationCommandSha256: retained.commandSha256,
    buildAuthority: BUILD_AUTHORITY,
  });
  assert.equal(recovery.restarted, true);
  await assert.rejects(readB3IssuedCommand({ root, platform: 'ios' }), /ENOENT|absent/i);
});

test('ambiguous capture restart is concurrent and crash-resumable without a second flag', async (t) => {
  const concurrentRoot = await mkdtemp(join(tmpdir(), 'b3-concurrent-ambiguity-restart-'));
  const crashRoot = await mkdtemp(join(tmpdir(), 'b3-crash-ambiguity-restart-'));
  t.after(() => Promise.all([
    rm(concurrentRoot, { recursive: true, force: true }),
    rm(crashRoot, { recursive: true, force: true }),
  ]));
  const concurrent = await retainAmbiguousRestartGate({ root: concurrentRoot });
  const outcomes = await Promise.all([
    recoverB3AmbiguousCaptureAfterReinstall({
      root: concurrentRoot, platform: 'ios', enabled: true,
      invocationCommandSha256: concurrent.commandSha256, buildAuthority: BUILD_AUTHORITY,
    }),
    recoverB3AmbiguousCaptureAfterReinstall({
      root: concurrentRoot, platform: 'ios', enabled: true,
      invocationCommandSha256: concurrent.commandSha256, buildAuthority: BUILD_AUTHORITY,
    }),
  ]);
  assert.equal(outcomes.every(({ restarted }) => restarted), true);
  assert.deepEqual(await readdir(join(
    concurrentRoot, '.native-build/b3/evidence/ios-abandoned-captures',
  )), [concurrent.commandSha256]);

  const crashing = await retainAmbiguousRestartGate({ root: crashRoot });
  await assert.rejects(recoverB3AmbiguousCaptureAfterReinstall({
    root: crashRoot, platform: 'ios', enabled: true,
    invocationCommandSha256: crashing.commandSha256, buildAuthority: BUILD_AUTHORITY,
    afterArchive: async () => { throw new Error('simulated restart crash'); },
  }), /simulated restart crash/i);
  assert.equal((await readB3IssuedCommand({ root: crashRoot, platform: 'ios' })).state,
    'restart-executing');
  const resumed = await recoverB3AmbiguousCaptureAfterReinstall({
    root: crashRoot, platform: 'ios', enabled: false,
    invocationCommandSha256: crashing.commandSha256, buildAuthority: BUILD_AUTHORITY,
  });
  assert.equal(resumed.restarted, true);
  await assert.rejects(readB3IssuedCommand({ root: crashRoot, platform: 'ios' }), /ENOENT|absent/i);
});

test('capture restart rejects a journal replaced after archive before consuming its command', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-post-archive-journal-replacement-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { retained } = await retainAmbiguousRestartGateWithJournal({ root });
  const record = join(
    root,
    '.native-build/b3/evidence/ios-abandoned-captures',
    retained.commandSha256,
    'observations/00000001.json',
  );

  await assert.rejects(recoverB3AmbiguousCaptureAfterReinstall({
    root,
    platform: 'ios',
    enabled: true,
    invocationCommandSha256: retained.commandSha256,
    buildAuthority: BUILD_AUTHORITY,
    afterArchive: async () => {
      const replacement = `${record}.replacement`;
      await writeFile(replacement, await readFile(record), { mode: 0o600 });
      await rename(replacement, record);
    },
  }), /archive|journal|observation|snapshot|changed|differ/i);

  assert.equal((await readB3IssuedCommand({ root, platform: 'ios' })).state,
    'restart-executing');
  assert.equal((await readdir(join(record, '..'))).includes('00000001.json'), true);
});

test('capture restart revalidates its archive after the final pre-consume seam', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-pre-consume-archive-replacement-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { retained } = await retainAmbiguousRestartGateWithJournal({ root });
  const record = join(
    root,
    '.native-build/b3/evidence/ios-abandoned-captures',
    retained.commandSha256,
    'observations/00000001.json',
  );

  await assert.rejects(recoverB3AmbiguousCaptureAfterReinstall({
    root,
    platform: 'ios',
    enabled: true,
    invocationCommandSha256: retained.commandSha256,
    invocationRecordSha256: retained.recordSha256,
    invocationState: retained.state,
    buildAuthority: BUILD_AUTHORITY,
    beforeClear: async () => {
      const replacement = `${record}.replacement`;
      await writeFile(replacement, await readFile(record), { mode: 0o600 });
      await rename(replacement, record);
    },
  }), /archive|journal|observation|snapshot|changed|differ/i);

  assert.equal((await readB3IssuedCommand({ root, platform: 'ios' })).state,
    'restart-complete');
});

test('capture restart rejects an archive invalidated by an exact helper before clear reads command',
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'b3-before-clear-read-race-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const { retained } = await retainAmbiguousRestartGateWithJournal({ root });
    const pinned = await readB3IssuedCommand({ root, platform: 'ios' });
    let releaseClearRead;
    let signalClearRead;
    const clearReadReleased = new Promise((resolveRelease) => {
      releaseClearRead = resolveRelease;
    });
    const clearReadReached = new Promise((resolveReached) => { signalClearRead = resolveReached; });
    const racingRecovery = recoverB3AmbiguousCaptureAfterReinstall({
      root,
      platform: 'ios',
      enabled: true,
      invocationCommandSha256: pinned.commandSha256,
      invocationRecordSha256: pinned.recordSha256,
      invocationState: pinned.state,
      buildAuthority: BUILD_AUTHORITY,
      beforeClearCommandRead: async () => {
        signalClearRead();
        await clearReadReleased;
      },
    });

    try {
      const reachedBeforeCompletion = await Promise.race([
        clearReadReached.then(() => true),
        racingRecovery.then(() => false, () => false),
      ]);
      assert.equal(reachedBeforeCompletion, true);
      const completingRecovery = await recoverB3AmbiguousCaptureAfterReinstall({
        root,
        platform: 'ios',
        enabled: true,
        invocationCommandSha256: pinned.commandSha256,
        invocationRecordSha256: pinned.recordSha256,
        invocationState: pinned.state,
        buildAuthority: BUILD_AUTHORITY,
      });
      assert.equal(completingRecovery.restarted, true);
      const record = join(
        root,
        '.native-build/b3/evidence/ios-abandoned-captures',
        retained.commandSha256,
        'observations/00000001.json',
      );
      const replacement = `${record}.replacement`;
      await writeFile(replacement, await readFile(record), { mode: 0o600 });
      await rename(replacement, record);
      releaseClearRead();
      await assert.rejects(racingRecovery,
        /archive|journal|observation|snapshot|changed|differ/i);
    } finally {
      releaseClearRead();
      await racingRecovery.catch(() => {});
    }
  });

test('capture restart converges when an exact helper consumes between beforeClear and clear read',
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'b3-valid-before-clear-read-race-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await retainAmbiguousRestartGate({ root });
    const pinned = await readB3IssuedCommand({ root, platform: 'ios' });
    let releaseClearRead;
    let signalClearRead;
    const clearReadReleased = new Promise((resolveRelease) => {
      releaseClearRead = resolveRelease;
    });
    const clearReadReached = new Promise((resolveReached) => { signalClearRead = resolveReached; });
    const racingRecovery = recoverB3AmbiguousCaptureAfterReinstall({
      root,
      platform: 'ios',
      enabled: true,
      invocationCommandSha256: pinned.commandSha256,
      invocationRecordSha256: pinned.recordSha256,
      invocationState: pinned.state,
      buildAuthority: BUILD_AUTHORITY,
      beforeClearCommandRead: async () => {
        signalClearRead();
        await clearReadReleased;
      },
    });
    await clearReadReached;
    const completingRecovery = await recoverB3AmbiguousCaptureAfterReinstall({
      root,
      platform: 'ios',
      enabled: true,
      invocationCommandSha256: pinned.commandSha256,
      invocationRecordSha256: pinned.recordSha256,
      invocationState: pinned.state,
      buildAuthority: BUILD_AUTHORITY,
    });
    releaseClearRead();
    const convergedRecovery = await racingRecovery;

    assert.equal(completingRecovery.restarted, true);
    assert.equal(convergedRecovery.restarted, true);
    assert.equal(convergedRecovery.commandSha256, pinned.commandSha256);
    await assert.rejects(readB3IssuedCommand({ root, platform: 'ios' }), /ENOENT|absent/i);
  });

test('archive lookup rejects extra, symbolic-link and external-hard-link observation records',
  async (t) => {
    const outside = await mkdtemp(join(tmpdir(), 'b3-hostile-archived-record-target-'));
    const roots = [];
    t.after(() => Promise.all([...roots, outside].map((path) =>
      rm(path, { recursive: true, force: true }))));
    const external = join(outside, 'external.json');
    await writeFile(external, '{}', { mode: 0o600 });
    const cases = [
      ['extra', async (journal) => writeFile(join(journal, 'hostile.json'), '{}', {
        mode: 0o600,
      })],
      ['symbolic-link', async (journal) => symlink(external, join(journal, '00000001.json'))],
      ['external-hard-link', async (journal) => link(external, join(journal, '00000001.json'))],
    ];

    for (const [label, poison] of cases) {
      const root = await mkdtemp(join(tmpdir(), `b3-hostile-archive-lookup-${label}-`));
      roots.push(root);
      const retained = await retainAmbiguousRestartGate({ root });
      await recoverB3AmbiguousCaptureAfterReinstall({
        root,
        platform: 'ios',
        enabled: true,
        invocationCommandSha256: retained.commandSha256,
        buildAuthority: BUILD_AUTHORITY,
      });
      const journal = join(
        root,
        '.native-build/b3/evidence/ios-abandoned-captures',
        retained.commandSha256,
        'observations',
      );
      await poison(journal);

      await assert.rejects(recoverB3AmbiguousCaptureAfterReinstall({
        root,
        platform: 'ios',
        enabled: false,
        invocationCommandSha256: retained.commandSha256,
        buildAuthority: BUILD_AUTHORITY,
      }), /archive|journal|observation|entry|link|policy|snapshot/i);
      await assert.rejects(readB3IssuedCommand({ root, platform: 'ios' }), /ENOENT|absent/i);
    }
  });

test('archive lookup rejects a semantically identical replaced observation record', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-replaced-archive-lookup-record-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { retained } = await retainAmbiguousRestartGateWithJournal({ root });
  await recoverB3AmbiguousCaptureAfterReinstall({
    root,
    platform: 'ios',
    enabled: true,
    invocationCommandSha256: retained.commandSha256,
    buildAuthority: BUILD_AUTHORITY,
  });
  const record = join(
    root,
    '.native-build/b3/evidence/ios-abandoned-captures',
    retained.commandSha256,
    'observations/00000001.json',
  );
  const replacement = `${record}.replacement`;
  await writeFile(replacement, await readFile(record), { mode: 0o600 });
  await rename(replacement, record);

  await assert.rejects(recoverB3AmbiguousCaptureAfterReinstall({
    root,
    platform: 'ios',
    enabled: false,
    invocationCommandSha256: retained.commandSha256,
    buildAuthority: BUILD_AUTHORITY,
  }), /archive|journal|observation|snapshot|changed|differ/i);
});

test('archive lookup revalidates the complete abandoned-generation root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-invalid-archive-generation-root-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const retained = await retainAmbiguousRestartGate({ root });
  await recoverB3AmbiguousCaptureAfterReinstall({
    root,
    platform: 'ios',
    enabled: true,
    invocationCommandSha256: retained.commandSha256,
    buildAuthority: BUILD_AUTHORITY,
  });
  await mkdir(join(
    root,
    '.native-build/b3/evidence/ios-abandoned-captures/hostile-generation',
  ), { mode: 0o700 });

  await assert.rejects(recoverB3AmbiguousCaptureAfterReinstall({
    root,
    platform: 'ios',
    enabled: false,
    invocationCommandSha256: retained.commandSha256,
    buildAuthority: BUILD_AUTHORITY,
  }), /archive|generation|entry|policy|layout/i);
});

test('a recovery helper adopts the same pinned command advanced by another helper', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-pinned-recovery-successor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await retainAmbiguousRestartGate({ root });
  const helperAPin = await readB3IssuedCommand({ root, platform: 'ios' });
  const helperBPin = await readB3IssuedCommand({ root, platform: 'ios' });
  assert.equal(helperAPin.state, 'restart-required');
  assert.equal(helperBPin.recordSha256, helperAPin.recordSha256);

  let releaseHelperA;
  let signalArchived;
  const helperAReleased = new Promise((resolveRelease) => { releaseHelperA = resolveRelease; });
  const helperAArchived = new Promise((resolveArchived) => { signalArchived = resolveArchived; });
  const helperA = recoverB3AmbiguousCaptureAfterReinstall({
    root,
    platform: 'ios',
    enabled: true,
    invocationCommandSha256: helperAPin.commandSha256,
    invocationRecordSha256: helperAPin.recordSha256,
    invocationState: helperAPin.state,
    buildAuthority: BUILD_AUTHORITY,
    afterArchive: async () => {
      signalArchived();
      await helperAReleased;
    },
  });
  await helperAArchived;
  assert.equal((await readB3IssuedCommand({ root, platform: 'ios' })).state,
    'restart-executing');

  let helperB;
  try {
    helperB = await recoverB3AmbiguousCaptureAfterReinstall({
      root,
      platform: 'ios',
      enabled: true,
      invocationCommandSha256: helperBPin.commandSha256,
      invocationRecordSha256: helperBPin.recordSha256,
      invocationState: helperBPin.state,
      buildAuthority: BUILD_AUTHORITY,
    });
  } finally {
    releaseHelperA();
    await helperA;
  }
  assert.equal(helperB.restarted, true);
  assert.equal(helperB.commandSha256, helperBPin.commandSha256);
  await assert.rejects(readB3IssuedCommand({ root, platform: 'ios' }), /ENOENT|absent/i);
});

test('recovery successor adoption accepts legal progress during immutable chain validation',
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'b3-recovery-successor-adoption-race-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const retained = await retainAmbiguousRestartGate({ root });
    const pinned = await readB3IssuedCommand({ root, platform: 'ios' });
    await transitionB3IssuedCommand({
      root,
      platform: 'ios',
      command: retained.command,
      expectedState: 'restart-required',
      nextState: 'restart-executing',
    });

    const adopted = await readB3IssuedCommandRecoverySuccessor({
      root,
      platform: 'ios',
      commandSha256: pinned.commandSha256,
      recordSha256: pinned.recordSha256,
      state: pinned.state,
      afterCurrentRead: async (current) => {
        assert.equal(current.state, 'restart-executing');
        await transitionB3IssuedCommand({
          root,
          platform: 'ios',
          command: current.command,
          expectedState: 'restart-executing',
          nextState: 'restart-complete',
        });
      },
    });

    assert.equal(adopted.commandSha256, pinned.commandSha256);
    assert.equal(adopted.state, 'restart-complete');
  });

test('recovery successor adoption converges after the exact helper consumes its terminal command',
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'b3-recovery-successor-terminal-consume-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await retainAmbiguousRestartGate({ root });
    const pinned = await readB3IssuedCommand({ root, platform: 'ios' });

    let releaseCompletingHelper;
    let signalArchiveReady;
    const completingHelperReleased = new Promise((resolveRelease) => {
      releaseCompletingHelper = resolveRelease;
    });
    const archiveReady = new Promise((resolveReady) => { signalArchiveReady = resolveReady; });
    const completingHelper = recoverB3AmbiguousCaptureAfterReinstall({
      root,
      platform: 'ios',
      enabled: true,
      invocationCommandSha256: pinned.commandSha256,
      invocationRecordSha256: pinned.recordSha256,
      invocationState: pinned.state,
      buildAuthority: BUILD_AUTHORITY,
      afterArchive: async () => {
        signalArchiveReady();
        await completingHelperReleased;
      },
    });
    await archiveReady;
    assert.equal((await readB3IssuedCommand({ root, platform: 'ios' })).state,
      'restart-executing');

    let successorHookCalled = false;
    const adopted = await recoverB3AmbiguousCaptureAfterReinstall({
      root,
      platform: 'ios',
      enabled: true,
      invocationCommandSha256: pinned.commandSha256,
      invocationRecordSha256: pinned.recordSha256,
      invocationState: pinned.state,
      buildAuthority: BUILD_AUTHORITY,
      afterSuccessorCurrentRead: async (current) => {
        successorHookCalled = true;
        assert.equal(current.state, 'restart-executing');
        releaseCompletingHelper();
        await completingHelper;
      },
    });

    assert.equal(successorHookCalled, true);
    assert.equal(adopted.restarted, true);
    assert.equal(adopted.commandSha256, pinned.commandSha256);
    await assert.rejects(readB3IssuedCommand({ root, platform: 'ios' }), /ENOENT|absent/i);
  });

test('exact recovery rejects an archived command consumed before its terminal successor',
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'b3-recovery-nonterminal-consume-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await retainAmbiguousRestartGate({ root });
    const pinned = await readB3IssuedCommand({ root, platform: 'ios' });

    await assert.rejects(recoverB3AmbiguousCaptureAfterReinstall({
      root,
      platform: 'ios',
      enabled: true,
      invocationCommandSha256: pinned.commandSha256,
      invocationRecordSha256: pinned.recordSha256,
      invocationState: pinned.state,
      buildAuthority: BUILD_AUTHORITY,
      afterArchive: async () => { throw new Error('retain exact archive'); },
    }), /retain exact archive/i);
    const nonTerminal = await readB3IssuedCommand({ root, platform: 'ios' });
    assert.equal(nonTerminal.state, 'restart-executing');
    await clearB3IssuedCommand({ root, platform: 'ios', command: nonTerminal.command });

    await assert.rejects(recoverB3AmbiguousCaptureAfterReinstall({
      root,
      platform: 'ios',
      enabled: false,
      invocationCommandSha256: pinned.commandSha256,
      invocationRecordSha256: pinned.recordSha256,
      invocationState: pinned.state,
      buildAuthority: BUILD_AUTHORITY,
    }), /issued command|terminal|tombstone|changed|successor/i);
  });

test('capture restart removes an authentic unpublished checkpoint revision temporary', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-restart-revision-temporary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { retained, firstObservation } = await retainAmbiguousRestartGateWithJournal({ root });
  assert.equal(firstObservation.observationSha256, retained.command.previousObservationSha256);
  const checkpointPath = join(
    root, '.native-build/b3/evidence/ios-capture-checkpoint.json',
  );
  const bytes = await readFile(checkpointPath);
  await rm(checkpointPath);
  await rm(`${checkpointPath}.revision-00000000.json`);
  const temporary = `${checkpointPath}.00000000-0000-4000-8000-000000000771.revision.tmp`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  assert.equal((await lstat(temporary)).nlink, 1);
  await transitionB3IssuedCommand({
    root,
    platform: 'ios',
    command: retained.command,
    expectedState: 'restart-required',
    nextState: 'restart-executing',
  });
  assert.equal((await readB3IssuedCommand({ root, platform: 'ios' })).state,
    'restart-executing');

  const recovered = await recoverB3AmbiguousCaptureAfterReinstall({
    root,
    platform: 'ios',
    enabled: false,
    invocationCommandSha256: retained.commandSha256,
    buildAuthority: BUILD_AUTHORITY,
  });

  assert.equal(recovered.restarted, true);
  await assert.rejects(lstat(temporary), /ENOENT/u);
  await assert.rejects(readB3IssuedCommand({ root, platform: 'ios' }), /ENOENT|absent/i);
});

test('capture restart removes an authentic unpublished checkpoint current temporary', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-restart-current-temporary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { retained, firstObservation } = await retainAmbiguousRestartGateWithJournal({ root });
  assert.equal(firstObservation.observationSha256, retained.command.previousObservationSha256);
  const checkpointPath = join(
    root, '.native-build/b3/evidence/ios-capture-checkpoint.json',
  );
  const bytes = await readFile(checkpointPath);
  await rm(checkpointPath);
  const temporary = `${checkpointPath}.00000000-0000-4000-8000-000000000772.current.tmp`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  assert.equal((await lstat(temporary)).nlink, 1);

  const recovered = await recoverB3AmbiguousCaptureAfterReinstall({
    root,
    platform: 'ios',
    enabled: true,
    invocationCommandSha256: retained.commandSha256,
    buildAuthority: BUILD_AUTHORITY,
  });

  assert.equal(recovered.restarted, true);
  await assert.rejects(lstat(temporary), /ENOENT/u);
  assert.equal(await readFile(join(
    root,
    '.native-build/b3/evidence/ios-abandoned-captures',
    retained.commandSha256,
    'checkpoint/ios-capture-checkpoint.json.revision-00000000.json',
  ), 'utf8'), bytes.toString('utf8'));
  await assert.rejects(readB3IssuedCommand({ root, platform: 'ios' }), /ENOENT|absent/i);
});

test('capture restart verifies and removes a published checkpoint revision alias', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-restart-revision-alias-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { retained, firstObservation } = await retainAmbiguousRestartGateWithJournal({ root });
  assert.equal(firstObservation.observationSha256, retained.command.previousObservationSha256);
  const checkpointPath = join(
    root, '.native-build/b3/evidence/ios-capture-checkpoint.json',
  );
  const revisionPath = `${checkpointPath}.revision-00000000.json`;
  const temporary = `${checkpointPath}.00000000-0000-4000-8000-000000000773.revision.tmp`;
  await link(revisionPath, temporary);
  const revisionBytes = await readFile(revisionPath, 'utf8');
  // The writer publishes the immutable revision link before it creates the
  // current temporary, so an initial-write crash here has no current alias.
  await rm(checkpointPath);
  assert.equal((await lstat(revisionPath)).nlink, 2);
  assert.equal((await lstat(temporary)).nlink, 2);

  const recovered = await recoverB3AmbiguousCaptureAfterReinstall({
    root,
    platform: 'ios',
    enabled: true,
    invocationCommandSha256: retained.commandSha256,
    buildAuthority: BUILD_AUTHORITY,
  });

  assert.equal(recovered.restarted, true);
  await assert.rejects(lstat(temporary), /ENOENT/u);
  const archivedRevision = join(
    root,
    '.native-build/b3/evidence/ios-abandoned-captures',
    retained.commandSha256,
    'checkpoint/ios-capture-checkpoint.json.revision-00000000.json',
  );
  assert.equal((await lstat(archivedRevision)).nlink, 1);
  assert.equal(await readFile(archivedRevision, 'utf8'), revisionBytes);
});

test('capture restart verifies and removes a published checkpoint current alias', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-restart-current-alias-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { retained, firstObservation } = await retainAmbiguousRestartGateWithJournal({ root });
  assert.equal(firstObservation.observationSha256, retained.command.previousObservationSha256);
  const checkpointPath = join(
    root, '.native-build/b3/evidence/ios-capture-checkpoint.json',
  );
  const temporary = `${checkpointPath}.00000000-0000-4000-8000-000000000774.current.tmp`;
  await link(checkpointPath, temporary);
  assert.equal((await lstat(checkpointPath)).nlink, 2);
  assert.equal((await lstat(temporary)).nlink, 2);

  const recovered = await recoverB3AmbiguousCaptureAfterReinstall({
    root,
    platform: 'ios',
    enabled: true,
    invocationCommandSha256: retained.commandSha256,
    buildAuthority: BUILD_AUTHORITY,
  });

  assert.equal(recovered.restarted, true);
  await assert.rejects(lstat(temporary), /ENOENT/u);
  const archivedCurrent = join(
    root,
    '.native-build/b3/evidence/ios-abandoned-captures',
    retained.commandSha256,
    'checkpoint/ios-capture-checkpoint.json',
  );
  assert.equal((await lstat(archivedCurrent)).nlink, 1);
  assert.equal(await readFile(archivedCurrent, 'utf8'), await readFile(join(
    root,
    '.native-build/b3/evidence/ios-abandoned-captures',
    retained.commandSha256,
    'checkpoint/ios-capture-checkpoint.json.revision-00000000.json',
  ), 'utf8'));
});

test('capture restart retains hostile checkpoint temporary files and external links', async (t) => {
  const outside = await mkdtemp(join(tmpdir(), 'b3-hostile-checkpoint-temporary-target-'));
  const roots = [];
  t.after(() => Promise.all([...roots, outside].map((path) =>
    rm(path, { recursive: true, force: true }))));

  for (const [index, kind] of ['invalid-file', 'external-hard-link'].entries()) {
    const root = await mkdtemp(join(tmpdir(), `b3-hostile-checkpoint-${kind}-`));
    roots.push(root);
    const retained = await retainAmbiguousRestartGate({
      root,
      command: launchCommand({ expectedSequence: 2, previousObservationSha256: TAIL }),
    });
    const checkpointValue = createB3CaptureCheckpoint(checkpoint({
      nextObservationSequence: 2,
      state: 'ARMED',
      previousObservationSha256: TAIL,
    }));
    const checkpointPath = join(
      root, '.native-build/b3/evidence/ios-capture-checkpoint.json',
    );
    await writeB3CaptureCheckpoint({
      root,
      platform: 'ios',
      expectedRevision: null,
      value: checkpointValue,
    });
    const bytes = await readFile(checkpointPath);
    await rm(checkpointPath);
    await rm(`${checkpointPath}.revision-00000000.json`);
    const temporary = `${checkpointPath}.00000000-0000-4000-8000-00000000078${index}` +
      '.revision.tmp';
    if (kind === 'invalid-file') {
      await writeFile(temporary, '{}', { mode: 0o600 });
    } else {
      const external = join(outside, `checkpoint-${index}.json`);
      await writeFile(external, bytes, { mode: 0o600 });
      await link(external, temporary);
    }

    await assert.rejects(recoverB3AmbiguousCaptureAfterReinstall({
      root,
      platform: 'ios',
      enabled: true,
      invocationCommandSha256: retained.commandSha256,
      buildAuthority: BUILD_AUTHORITY,
    }), /checkpoint|temporary|external|link|policy|schema/i);
    await lstat(temporary);
    assert.equal((await readB3IssuedCommand({ root, platform: 'ios' })).state,
      'restart-executing');
  }
});

test('capture restart resumes after normal journal access recreates an empty active directory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-recreated-journal-restart-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const retained = await retainAmbiguousRestartGate({ root });

  await assert.rejects(recoverB3AmbiguousCaptureAfterReinstall({
    root,
    platform: 'ios',
    enabled: true,
    invocationCommandSha256: retained.commandSha256,
    buildAuthority: BUILD_AUTHORITY,
    afterArchive: async () => { throw new Error('simulated crash after archive'); },
  }), /simulated crash after archive/i);
  assert.equal((await readB3IssuedCommand({ root, platform: 'ios' })).state,
    'restart-executing');

  // This is the first operation performed by the normal adapter on the next
  // invocation. The reader recreates the now-active journal path after the old
  // directory has been moved into the abandoned-capture archive.
  assert.deepEqual(await readB3PhysicalObservationJournal({
    root,
    platform: 'ios',
    buildAuthority: BUILD_AUTHORITY,
  }), []);

  const recovered = await recoverB3AmbiguousCaptureAfterReinstall({
    root,
    platform: 'ios',
    enabled: false,
    invocationCommandSha256: retained.commandSha256,
    buildAuthority: BUILD_AUTHORITY,
  });
  assert.equal(recovered.restarted, true);
  await assert.rejects(readB3IssuedCommand({ root, platform: 'ios' }), /ENOENT|absent/i);
});

test('capture restart rejects hostile recreated active observation directories', async (t) => {
  const outside = await mkdtemp(join(tmpdir(), 'b3-hostile-recreated-journal-target-'));
  const cases = [
    ['non-empty', async (path) => {
      await mkdir(path, { mode: 0o700 });
      await writeFile(join(path, 'hostile.json'), '{}', { mode: 0o600 });
    }],
    ['private-wrong-mode', async (path) => mkdir(path, { mode: 0o600 })],
    ['wrong-mode', async (path) => mkdir(path, { mode: 0o755 })],
    ['symbolic-link', async (path) => symlink(outside, path)],
  ];
  const roots = [];
  t.after(() => Promise.all([...roots, outside].map((path) =>
    rm(path, { recursive: true, force: true }))));

  for (const [label, recreate] of cases) {
    const root = await mkdtemp(join(tmpdir(), `b3-hostile-recreated-journal-${label}-`));
    roots.push(root);
    const retained = await retainAmbiguousRestartGate({ root });
    await assert.rejects(recoverB3AmbiguousCaptureAfterReinstall({
      root,
      platform: 'ios',
      enabled: true,
      invocationCommandSha256: retained.commandSha256,
      buildAuthority: BUILD_AUTHORITY,
      afterArchive: async () => { throw new Error('simulated crash after archive'); },
    }), /simulated crash after archive/i);
    await recreate(join(root, '.native-build/b3/evidence/ios-observations'));

    await assert.rejects(recoverB3AmbiguousCaptureAfterReinstall({
      root,
      platform: 'ios',
      enabled: false,
      invocationCommandSha256: retained.commandSha256,
      buildAuthority: BUILD_AUTHORITY,
    }), /observation|archive|directory|conflict|policy/i);
    assert.equal((await readB3IssuedCommand({ root, platform: 'ios' })).state,
      'restart-executing');
  }
});

test('capture restart clears an exact restart-complete command after a crash', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-complete-ambiguity-restart-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const retained = await retainAmbiguousRestartGate({ root });

  await assert.rejects(recoverB3AmbiguousCaptureAfterReinstall({
    root,
    platform: 'ios',
    enabled: true,
    invocationCommandSha256: retained.commandSha256,
    buildAuthority: BUILD_AUTHORITY,
    beforeClear: async () => { throw new Error('simulated crash before restart clear'); },
  }), /simulated crash before restart clear/i);
  assert.equal((await readB3IssuedCommand({ root, platform: 'ios' })).state,
    'restart-complete');

  const recovered = await recoverB3AmbiguousCaptureAfterReinstall({
    root,
    platform: 'ios',
    enabled: false,
    invocationCommandSha256: retained.commandSha256,
    buildAuthority: BUILD_AUTHORITY,
  });
  assert.equal(recovered.restarted, true);
  assert.equal(recovered.commandSha256, retained.commandSha256);
  await assert.rejects(readB3IssuedCommand({ root, platform: 'ios' }), /ENOENT|absent/i);
});

test('ambiguous capture restart rejects hostile archive links before consuming authority', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-hostile-ambiguity-restart-'));
  const outside = await mkdtemp(join(tmpdir(), 'b3-hostile-ambiguity-outside-'));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  const retained = await retainAmbiguousRestartGate({ root });
  const evidence = join(root, '.native-build/b3/evidence');
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  await symlink(outside, join(evidence, 'ios-abandoned-captures'));

  await assert.rejects(recoverB3AmbiguousCaptureAfterReinstall({
    root,
    platform: 'ios',
    enabled: true,
    invocationCommandSha256: retained.commandSha256,
    buildAuthority: BUILD_AUTHORITY,
  }), /archive|directory|link|policy/i);
  assert.equal((await readB3IssuedCommand({ root, platform: 'ios' })).state,
    'restart-executing');
});

test('capture restart rejects hostile pre-created destinations and checkpoint hard links', async (t) => {
  const destinationRoot = await mkdtemp(join(tmpdir(), 'b3-hostile-restart-destination-'));
  const hardLinkRoot = await mkdtemp(join(tmpdir(), 'b3-hostile-restart-checkpoint-'));
  const outside = await mkdtemp(join(tmpdir(), 'b3-hostile-restart-target-'));
  t.after(() => Promise.all([destinationRoot, hardLinkRoot, outside].map((root) =>
    rm(root, { recursive: true, force: true }))));

  const destination = await retainAmbiguousRestartGate({ root: destinationRoot });
  const destinationArchive = join(
    destinationRoot,
    '.native-build/b3/evidence/ios-abandoned-captures',
    destination.commandSha256,
  );
  await mkdir(destinationArchive, { recursive: true, mode: 0o700 });
  await symlink(outside, join(destinationArchive, 'observations'));
  await assert.rejects(recoverB3AmbiguousCaptureAfterReinstall({
    root: destinationRoot, platform: 'ios', enabled: true,
    invocationCommandSha256: destination.commandSha256, buildAuthority: BUILD_AUTHORITY,
  }), /destination|observation|archive|link|policy/i);

  const hardLinked = await retainAmbiguousRestartGate({ root: hardLinkRoot });
  const checkpointPath = join(
    hardLinkRoot, '.native-build/b3/evidence/ios-capture-checkpoint.json',
  );
  await writeFile(checkpointPath, '{"checkpoint":"stale"}', { mode: 0o600 });
  await link(checkpointPath, join(outside, 'linked-checkpoint.json'));
  await assert.rejects(recoverB3AmbiguousCaptureAfterReinstall({
    root: hardLinkRoot, platform: 'ios', enabled: true,
    invocationCommandSha256: hardLinked.commandSha256, buildAuthority: BUILD_AUTHORITY,
  }), /checkpoint|link|policy/i);
});

test('capture restart validates every observation entry before moving its journal', async (t) => {
  const outside = await mkdtemp(join(tmpdir(), 'b3-hostile-restart-journal-target-'));
  const roots = [];
  t.after(() => Promise.all([...roots, outside].map((path) =>
    rm(path, { recursive: true, force: true }))));
  const external = join(outside, 'external.json');
  await writeFile(external, '{}', { mode: 0o600 });

  const cases = [
    ['symbolic-link', async (journal) => symlink(external, join(journal, '00000001.json'))],
    ['external-hard-link', async (journal) => link(external, join(journal, '00000001.json'))],
    ['non-record', async (journal) => writeFile(join(journal, 'hostile.json'), '{}', {
      mode: 0o600,
    })],
    ['invalid-record', async (journal) => writeFile(join(journal, '00000001.json'), '{}', {
      mode: 0o600,
    })],
  ];

  for (const [label, poison] of cases) {
    const root = await mkdtemp(join(tmpdir(), `b3-hostile-restart-journal-${label}-`));
    roots.push(root);
    const retained = await retainAmbiguousRestartGate({ root });
    const journal = join(root, '.native-build/b3/evidence/ios-observations');
    await poison(journal);

    await assert.rejects(recoverB3AmbiguousCaptureAfterReinstall({
      root,
      platform: 'ios',
      enabled: true,
      invocationCommandSha256: retained.commandSha256,
      buildAuthority: BUILD_AUTHORITY,
    }), /observation|journal|entry|record|link|policy|canonical/i);
    await lstat(journal);
    assert.equal((await readB3IssuedCommand({ root, platform: 'ios' })).state,
      'restart-executing');
    await assert.rejects(lstat(join(
      root,
      '.native-build/b3/evidence/ios-abandoned-captures',
      retained.commandSha256,
      'observations',
    )), /ENOENT/u);
  }
});

test('capture restart rejects a canonical journal bound to another capture', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-wrong-capture-restart-journal-'));
  const donorRoot = await mkdtemp(join(tmpdir(), 'b3-wrong-capture-restart-donor-'));
  t.after(() => Promise.all([root, donorRoot].map((path) =>
    rm(path, { recursive: true, force: true }))));
  const donorCommand = launchCommand({
    captureId: '018f1d7b-97e8-4a52-8cf2-783e5089c088',
  });
  const donorObservation = await createB3ProofObservation({
    command: donorCommand,
    buildAuthority: BUILD_AUTHORITY,
    installationId: INSTALLATION_ID,
    sequence: 1,
    scenario: 'product-query',
    phase: 'ARMED',
    nextActionCode: 'QUERY_PRODUCT',
    completedTransitions: ['UNBOUND', 'ARMED'],
    proofProjection: emptyProofProjection(donorCommand),
    observedAt: '2026-07-15T10:00:00.000Z',
  });
  const donorRelative = await appendB3PhysicalObservation({
    root: donorRoot,
    platform: 'ios',
    command: donorCommand,
    buildAuthority: BUILD_AUTHORITY,
    observationBytes: Buffer.from(canonicaliseB3ProofValue(donorObservation), 'utf8'),
  });
  const retained = await retainAmbiguousRestartGate({
    root,
    command: launchCommand({
      expectedSequence: 2,
      previousObservationSha256: donorObservation.observationSha256,
    }),
  });
  const journal = join(root, '.native-build/b3/evidence/ios-observations');
  await writeFile(
    join(journal, '00000001.json'),
    await readFile(join(donorRoot, donorRelative)),
    { mode: 0o600 },
  );

  await assert.rejects(recoverB3AmbiguousCaptureAfterReinstall({
    root,
    platform: 'ios',
    enabled: true,
    invocationCommandSha256: retained.commandSha256,
    buildAuthority: BUILD_AUTHORITY,
  }), /observation|journal|capture|authority|chain/i);
  await lstat(journal);
  assert.equal((await readB3IssuedCommand({ root, platform: 'ios' })).state,
    'restart-executing');
});

test('capture restart rejects an observation journal entry flood before moving it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-restart-journal-entry-flood-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const retained = await retainAmbiguousRestartGate({ root });
  const journal = join(root, '.native-build/b3/evidence/ios-observations');
  await Promise.all(Array.from({ length: 513 }, (_, index) => writeFile(
    join(journal, `${String(index + 1).padStart(8, '0')}.json`),
    '{}',
    { mode: 0o600 },
  )));

  await assert.rejects(recoverB3AmbiguousCaptureAfterReinstall({
    root,
    platform: 'ios',
    enabled: true,
    invocationCommandSha256: retained.commandSha256,
    buildAuthority: BUILD_AUTHORITY,
  }), /observation|journal|entry|bound/i);
  assert.equal((await readdir(journal)).length, 513);
  assert.equal((await readB3IssuedCommand({ root, platform: 'ios' })).state,
    'restart-executing');
});

test('capture restart restores the active journal when a record changes across its move', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-restart-journal-move-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstCommand = launchCommand();
  const firstObservation = await createB3ProofObservation({
    command: firstCommand,
    buildAuthority: BUILD_AUTHORITY,
    installationId: INSTALLATION_ID,
    sequence: 1,
    scenario: 'product-query',
    phase: 'ARMED',
    nextActionCode: 'QUERY_PRODUCT',
    completedTransitions: ['UNBOUND', 'ARMED'],
    proofProjection: emptyProofProjection(firstCommand),
    observedAt: '2026-07-15T10:00:00.000Z',
  });
  const relative = await appendB3PhysicalObservation({
    root,
    platform: 'ios',
    command: firstCommand,
    buildAuthority: BUILD_AUTHORITY,
    observationBytes: Buffer.from(canonicaliseB3ProofValue(firstObservation), 'utf8'),
  });
  const retained = await retainAmbiguousRestartGate({
    root,
    command: launchCommand({
      expectedSequence: 2,
      previousObservationSha256: firstObservation.observationSha256,
    }),
  });
  const journal = join(root, '.native-build/b3/evidence/ios-observations');
  const record = join(root, relative);
  let changed = false;
  const racingBuildAuthority = new Proxy(BUILD_AUTHORITY, {
    getOwnPropertyDescriptor(target, property) {
      if (property === 'mode' && !changed) {
        changed = true;
        writeFileSync(record, '{}', { mode: 0o600 });
      }
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });

  await assert.rejects(recoverB3AmbiguousCaptureAfterReinstall({
    root,
    platform: 'ios',
    enabled: true,
    invocationCommandSha256: retained.commandSha256,
    buildAuthority: racingBuildAuthority,
  }), /observation|journal|record|canonical|changed/i);
  assert.equal(changed, true);
  await lstat(journal);
  assert.equal(await readFile(record, 'utf8'), '{}');
  await assert.rejects(lstat(join(
    root,
    '.native-build/b3/evidence/ios-abandoned-captures',
    retained.commandSha256,
    'observations',
  )), /ENOENT/u);
  assert.equal((await readB3IssuedCommand({ root, platform: 'ios' })).state,
    'restart-executing');
});

test('capture restart repairs its exact authority writer alias after a crash gap', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-restart-authority-alias-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const retained = await retainAmbiguousRestartGate({ root });
  await recoverB3AmbiguousCaptureAfterReinstall({
    root, platform: 'ios', enabled: true,
    invocationCommandSha256: retained.commandSha256, buildAuthority: BUILD_AUTHORITY,
  });
  const evidence = join(root, '.native-build/b3/evidence');
  const authority = join(
    evidence, 'ios-abandoned-captures', retained.commandSha256, 'authority.json',
  );
  const alias = join(
    evidence,
    `.abandoned-capture-${retained.commandSha256}-00000000-0000-4000-8000-000000000777.tmp`,
  );
  await link(authority, alias);
  assert.equal((await lstat(authority)).nlink, 2);

  const recovered = await recoverB3AmbiguousCaptureAfterReinstall({
    root, platform: 'ios', enabled: false,
    invocationCommandSha256: retained.commandSha256, buildAuthority: BUILD_AUTHORITY,
  });
  assert.equal(recovered.restarted, true);
  assert.equal((await lstat(authority)).nlink, 1);
  await assert.rejects(lstat(alias), /ENOENT/u);
});

test('capture restart fails closed when its retained archive authority is corrupt', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-corrupt-restart-authority-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const retained = await retainAmbiguousRestartGate({ root });
  await recoverB3AmbiguousCaptureAfterReinstall({
    root, platform: 'ios', enabled: true,
    invocationCommandSha256: retained.commandSha256, buildAuthority: BUILD_AUTHORITY,
  });
  const authority = join(
    root,
    '.native-build/b3/evidence/ios-abandoned-captures',
    retained.commandSha256,
    'authority.json',
  );
  await writeFile(authority, '{"corrupt":true}', { mode: 0o600 });

  await assert.rejects(recoverB3AmbiguousCaptureAfterReinstall({
    root, platform: 'ios', enabled: false,
    invocationCommandSha256: retained.commandSha256, buildAuthority: BUILD_AUTHORITY,
  }), /archive|authority|differ|invalid/i);
});

test('capture restart bounds abandoned generations and rejects an absent journal', async (t) => {
  const absentRoot = await mkdtemp(join(tmpdir(), 'b3-restart-absent-journal-'));
  const boundedRoot = await mkdtemp(join(tmpdir(), 'b3-restart-bounded-archive-'));
  t.after(() => Promise.all([absentRoot, boundedRoot].map((root) =>
    rm(root, { recursive: true, force: true }))));

  const absent = await retainAmbiguousRestartGate({ root: absentRoot });
  await rm(join(absentRoot, '.native-build/b3/evidence/ios-observations'), {
    recursive: true,
  });
  await assert.rejects(recoverB3AmbiguousCaptureAfterReinstall({
    root: absentRoot, platform: 'ios', enabled: true,
    invocationCommandSha256: absent.commandSha256, buildAuthority: BUILD_AUTHORITY,
  }), /observation|journal|archive|absent|missing/i);
  assert.equal((await readB3IssuedCommand({ root: absentRoot, platform: 'ios' })).state,
    'restart-executing');

  const bounded = await retainAmbiguousRestartGate({ root: boundedRoot });
  const archiveRoot = join(
    boundedRoot, '.native-build/b3/evidence/ios-abandoned-captures',
  );
  await mkdir(archiveRoot, { recursive: true, mode: 0o700 });
  for (let index = 0; index < 4; index += 1) {
    await mkdir(join(archiveRoot, String(index + 1).padStart(64, '0')), { mode: 0o700 });
  }
  await assert.rejects(recoverB3AmbiguousCaptureAfterReinstall({
    root: boundedRoot, platform: 'ios', enabled: true,
    invocationCommandSha256: bounded.commandSha256, buildAuthority: BUILD_AUTHORITY,
  }), /bound|archive/i);
});

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
  await persistB3IssuedCommand({ root, platform: 'ios', command: expectedCommand });
  await transitionB3IssuedCommand({
    root, platform: 'ios', command: expectedCommand,
    expectedState: 'prepared', nextState: 'launching',
  });
  assert.equal((await readB3IssuedCommand({ root, platform: 'ios' })).state, 'launching');
  let pulls = 0;
  const recovered = await resumeB3IssuedDeviceObservation({
    root, platform: 'ios', buildAuthority: BUILD_AUTHORITY,
    transport: {
      async launch() { launches += 1; },
      async pullObservation() {
        pulls += 1;
        if (pulls === 1) return Buffer.from('{"incomplete":true}', 'utf8');
        return Buffer.from(canonicaliseB3ProofValue(value), 'utf8');
      },
    },
    wait: async () => {},
    maximumPullAttempts: 2,
  });
  assert.equal(launches, 0);
  assert.equal(pulls, 2);
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

test('a repeated fresh-reinstall ambiguity becomes a durable capture-restart gate', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-reinstall-launch-ambiguous-'));
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

  let launches = 0;
  let pulls = 0;
  await assert.rejects(resumeB3IssuedDeviceObservation({
    root, platform: 'ios', buildAuthority: BUILD_AUTHORITY,
    transport: {
      async launch() { launches += 1; },
      async pullObservation() {
        pulls += 1;
        throw Object.assign(new Error('observation pull did not produce bytes'), {
          code: 'b3_physical_device_command_failed',
        });
      },
    },
    afterLaunch: async () => { throw new Error('simulated repeated reinstall ambiguity'); },
    maximumPullAttempts: 1,
  }), (error) => error?.instructionCode === 'REINSTALL_EXACT_BUILD' &&
    b3IosProofExitCode(error) === 7);
  assert.equal((await readB3IssuedCommand({ root, platform: 'ios' })).state,
    'restart-required');
  assert.equal(launches, 1);
  assert.equal(pulls, 1);
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

test('different first commands reconcile to one platform-global allocation under contention', async (t) => {
  const roots = [];
  t.after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

  for (let iteration = 0; iteration < 100; iteration += 1) {
    const root = await mkdtemp(join(tmpdir(), 'b3-issued-first-command-stress-'));
    roots.push(root);
    const first = launchCommand({
      captureId: `00000000-0000-4000-8000-${String((iteration * 2) + 1).padStart(12, '0')}`,
      challengeSha256: ((iteration * 2) + 1).toString(16).padStart(64, '0'),
    });
    const second = launchCommand({
      captureId: `00000000-0000-4000-8000-${String((iteration * 2) + 2).padStart(12, '0')}`,
      challengeSha256: ((iteration * 2) + 2).toString(16).padStart(64, '0'),
    });

    const contenders = await Promise.all([
      persistB3IssuedCommand({ root, platform: 'ios', command: first }),
      persistB3IssuedCommand({ root, platform: 'ios', command: second }),
    ]);
    const retained = await readB3IssuedCommand({ root, platform: 'ios' });
    assert.ok([first.captureId, second.captureId].includes(retained.command.captureId));
    assert.deepEqual(contenders.map(({ command }) => command), [retained.command, retained.command]);

    const ledger = join(root, '.native-build/b3/evidence/ios-issued-command-ledger');
    assert.equal((await readdir(ledger)).filter((name) => name.endsWith('.base.json')).length, 1);
  }
});

test('barriered child processes share one first public launch authority without ledger errors', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-issued-first-process-barrier-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const children = Array.from({ length: 12 }, (_, index) => launchIssuedCommandRaceChild({
    operation: 'advance-first',
    root,
    buildAuthority: BUILD_AUTHORITY,
    captureId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  }));
  t.after(() => children.forEach(({ terminate }) => terminate()));
  await Promise.all(children.map(({ waitFor }) => waitFor('ready')));
  children.forEach(({ go }) => go());
  const results = await Promise.all(children.map(({ waitFor }) => waitFor('result')));

  assert.equal(results.reduce((total, value) => total + value.launches, 0), 1);
  assert.equal(results.every(({ error }) => error !== null), true);
  assert.equal(results.some(({ error }) => /file policy|ledger|orphan|conflict/i.test(
    error.message,
  )), false, JSON.stringify(results));
  const launchedCaptureId = results.find(({ launches }) => launches === 1).launchedCaptureId;
  assert.equal((await readB3IssuedCommand({ root, platform: 'ios' })).command.captureId,
    launchedCaptureId);
});

test('barriered readers reconcile consume-next allocation and transition writers', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-issued-next-process-barrier-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const commands = Array.from({ length: 8 }, (_, index) => launchCommand({
    challengeSha256: String(index + 1).padStart(64, '0'),
  }));
  await persistB3IssuedCommand({ root, platform: 'ios', command: commands[0] });
  const writer = launchIssuedCommandRaceChild({
    operation: 'consume-chain',
    label: 'writer',
    root,
    commands,
  });
  const readers = Array.from({ length: 4 }, (_, index) => launchIssuedCommandRaceChild({
    operation: 'read-loop',
    label: `reader-${index}`,
    root,
    iterations: 16,
    finalChallengeSha256: commands.at(-1).challengeSha256,
  }));
  const children = [writer, ...readers];
  t.after(() => children.forEach(({ terminate }) => terminate()));
  await Promise.all(children.map(({ waitFor }) => waitFor('ready')));
  readers.forEach(({ go }) => go());
  await Promise.all(readers.map(({ waitFor }) => waitFor('active')));
  writer.go();
  await writer.waitFor('active');
  readers.forEach(({ continueRun }) => continueRun());
  const successorReads = await Promise.all(
    readers.map(({ waitFor }) => waitFor('successor-seen')),
  );
  assert.equal(successorReads.every(({ challengeSha256, state }) =>
    challengeSha256 === commands[1].challengeSha256 && state === 'prepared'), true);
  writer.continueRun();
  readers.forEach(({ sendControl }) => sendControl('race'));
  const [writerResult] = await Promise.all([
    writer.waitFor('result'),
    ...readers.map(({ waitFor }) => waitFor('race-complete')),
  ]);
  readers.forEach(({ sendControl }) => sendControl('final-check'));
  const readerResults = await Promise.all(readers.map(({ waitFor }) => waitFor('result')));

  assert.equal(writerResult.error, null);
  assert.deepEqual(readerResults.flatMap(({ errors }) => errors), []);
  assert.equal(readerResults.every(({ finalObserved }) => finalObserved), true);
  assert.equal(readerResults.every(({ observedChallenges }) =>
    observedChallenges.includes(commands[0].challengeSha256) &&
    observedChallenges.includes(commands.at(-1).challengeSha256)), true);
  const retained = await readB3IssuedCommand({ root, platform: 'ios' });
  assert.equal(retained.state, 'launching');
  assert.deepEqual(retained.command, commands.at(-1));
});

test('a lagging empty-root child process adopts the platform-global capture winner', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-issued-child-process-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const winnerCommand = launchCommand({
    captureId: '00000000-0000-4000-8000-000000000801',
  });
  const laggerCommand = launchCommand({
    captureId: '00000000-0000-4000-8000-000000000802',
  });
  const barrierPath = join(root, 'release-lagging-child');
  const winner = launchCaptureRaceChild({
    role: 'winner', root, captureId: winnerCommand.captureId,
    buildAuthority: BUILD_AUTHORITY, barrierPath,
  });
  const lagger = launchCaptureRaceChild({
    role: 'lagger', root, captureId: laggerCommand.captureId,
    buildAuthority: BUILD_AUTHORITY, barrierPath,
  });
  t.after(() => { winner.terminate(); lagger.terminate(); });

  await Promise.all([winner.waitFor('ready'), lagger.waitFor('empty')]);
  winner.go();
  const winnerResult = await winner.waitFor('result');
  await writeFile(barrierPath, 'go', { mode: 0o600 });
  const laggerResult = await lagger.waitFor('result');

  assert.match(winnerResult.outcome.message, /fixed deadline/i);
  assert.match(laggerResult.outcome.message, /fixed deadline/i);
  assert.doesNotMatch(laggerResult.outcome.message, /conflicts with the pending command/i);
  assert.equal(winnerResult.launches, 1);
  assert.equal(laggerResult.launches, 0);
  assert.equal(winnerResult.launchedCaptureId, winnerCommand.captureId);
  assert.equal(winnerResult.retainedCaptureId, winnerCommand.captureId);
  assert.equal(laggerResult.retainedCaptureId, winnerCommand.captureId);
});

test('a lagging empty-root child rejects a winner from a different allocation context', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-issued-child-context-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const winnerCaptureId = '00000000-0000-4000-8000-000000000821';
  const laggerCaptureId = '00000000-0000-4000-8000-000000000822';
  const barrierPath = join(root, 'release-context-lagging-child');
  const winner = launchCaptureRaceChild({
    role: 'winner', root, captureId: winnerCaptureId,
    buildAuthority: BUILD_AUTHORITY, barrierPath,
  });
  const lagger = launchCaptureRaceChild({
    role: 'lagger', root, captureId: laggerCaptureId,
    buildAuthority: { ...BUILD_AUTHORITY, applicationFingerprint: 'c'.repeat(64) },
    barrierPath,
  });
  t.after(() => { winner.terminate(); lagger.terminate(); });

  await Promise.all([winner.waitFor('ready'), lagger.waitFor('empty')]);
  winner.go();
  const winnerResult = await winner.waitFor('result');
  await writeFile(barrierPath, 'go', { mode: 0o600 });
  const laggerResult = await lagger.waitFor('result');

  assert.match(winnerResult.outcome.message, /fixed deadline/i);
  assert.match(laggerResult.outcome.message, /conflicts with the pending command/i);
  assert.equal(winnerResult.launches, 1);
  assert.equal(laggerResult.launches, 0);
  assert.equal(winnerResult.retainedCaptureId, winnerCaptureId);
  assert.equal(laggerResult.retainedCaptureId, winnerCaptureId);
});

test('a stale empty-root child cannot relaunch sequence one after the winner journals it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-issued-child-journal-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const winnerCaptureId = '00000000-0000-4000-8000-000000000831';
  const laggerCaptureId = '00000000-0000-4000-8000-000000000832';
  const barrierPath = join(root, 'release-journal-lagging-child');
  const winner = launchCaptureRaceChild({
    role: 'winner', root, captureId: winnerCaptureId,
    buildAuthority: BUILD_AUTHORITY, barrierPath, completeObservation: true,
  });
  const lagger = launchCaptureRaceChild({
    role: 'lagger', root, captureId: laggerCaptureId,
    buildAuthority: BUILD_AUTHORITY, barrierPath,
  });
  t.after(() => { winner.terminate(); lagger.terminate(); });

  await Promise.all([winner.waitFor('ready'), lagger.waitFor('empty')]);
  winner.go();
  const winnerResult = await winner.waitFor('result');
  assert.equal(winnerResult.outcome.status, 'fulfilled');
  assert.equal(winnerResult.launches, 1);
  assert.equal(winnerResult.retainedCaptureId, null);
  assert.equal(winnerResult.journalLength, 1);
  assert.equal(winnerResult.journalCaptureId, winnerCaptureId);

  await writeFile(barrierPath, 'go', { mode: 0o600 });
  const laggerResult = await lagger.waitFor('result');
  assert.match(laggerResult.outcome.message, /retained command differs/i);
  assert.equal(laggerResult.launches, 0);
  assert.equal(laggerResult.retainedCaptureId, null);
  assert.equal(laggerResult.journalLength, 1);
  assert.equal(laggerResult.journalCaptureId, winnerCaptureId);
});

test('a sequential direct capture still rejects a different pending command', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-issued-sequential-mismatch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const winnerCommand = launchCommand({
    captureId: '00000000-0000-4000-8000-000000000811',
    challengeSha256: '1'.repeat(64),
  });
  const differentCommand = launchCommand({
    captureId: '00000000-0000-4000-8000-000000000812',
    challengeSha256: '2'.repeat(64),
  });
  await persistB3IssuedCommand({ root, platform: 'ios', command: winnerCommand });
  let launches = 0;

  await assert.rejects(captureB3ValidatedDeviceObservation({
    root,
    platform: 'ios',
    command: differentCommand,
    buildAuthority: BUILD_AUTHORITY,
    transport: {
      async launch() { launches += 1; },
      async pullObservation() { throw new Error('pull must not be reached'); },
    },
    maximumPullAttempts: 1,
  }), /conflicts with the pending command/i);
  assert.equal(launches, 0);
  assert.deepEqual(
    (await readB3IssuedCommand({ root, platform: 'ios' })).command,
    winnerCommand,
  );
});

test('different first host advances retain one healthy launch authority across 100 races', async (t) => {
  const roots = [];
  t.after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

  for (let iteration = 0; iteration < 100; iteration += 1) {
    const root = await mkdtemp(join(tmpdir(), 'b3-first-advance-stress-'));
    roots.push(root);
    await assert.rejects(readB3IssuedCommand({ root, platform: 'ios' }), /ENOENT|absent/i);
    let launches = 0;
    let uuidCalls = 0;
    let launchedCommand = null;
    const transport = {
      async launch(command) {
        launches += 1;
        launchedCommand = command;
      },
      async pullObservation() {
        throw Object.assign(new Error('observation pull did not produce bytes'), {
          code: 'b3_physical_device_command_failed',
        });
      },
    };
    const captureIds = [
      `00000000-0000-4000-8000-${String((iteration * 2) + 1_001).padStart(12, '0')}`,
      `00000000-0000-4000-8000-${String((iteration * 2) + 1_002).padStart(12, '0')}`,
    ];
    const attempts = await Promise.allSettled(captureIds.map((captureId) =>
      advanceB3HostCaptureOne({
        root,
        platform: 'ios',
        buildAuthority: BUILD_AUTHORITY,
        transport,
        uuidFactory: () => {
          uuidCalls += 1;
          return captureId;
        },
        maximumPullAttempts: 1,
      })));
    assert.equal(uuidCalls, 2);
    assert.equal(attempts.filter(({ status }) => status === 'rejected').length, 2);
    for (const { reason } of attempts) {
      assert.doesNotMatch(reason.message, /multiple active|pending command|stale|differs/i);
    }
    assert.equal(launches, 1);
    assert.deepEqual((await readB3IssuedCommand({ root, platform: 'ios' })).command,
      launchedCommand);
    const ledger = join(root, '.native-build/b3/evidence/ios-issued-command-ledger');
    assert.equal((await readdir(ledger)).filter((name) => name.endsWith('.base.json')).length, 1);
  }
});

test('concurrent first host advances keep one launch authority and resume its observation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-first-advance-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(readB3IssuedCommand({ root, platform: 'ios' }), /ENOENT|absent/i);

  let launches = 0;
  let uuidCalls = 0;
  let launchedCommand = null;
  let publishedBytes = null;
  const transport = {
    async launch(command) {
      launches += 1;
      launchedCommand = command;
    },
    async pullObservation() {
      if (publishedBytes !== null) return publishedBytes;
      throw Object.assign(new Error('observation pull did not produce bytes'), {
        code: 'b3_physical_device_command_failed',
      });
    },
  };
  const advance = (captureId) => advanceB3HostCaptureOne({
    root,
    platform: 'ios',
    buildAuthority: BUILD_AUTHORITY,
    transport,
    uuidFactory: () => {
      uuidCalls += 1;
      return captureId;
    },
    maximumPullAttempts: 1,
  });
  const attempts = await Promise.allSettled([
    advance('00000000-0000-4000-8000-000000000901'),
    advance('00000000-0000-4000-8000-000000000902'),
  ]);
  assert.equal(uuidCalls, 2);
  assert.equal(attempts.filter(({ status }) => status === 'rejected').length, 2);
  for (const { reason } of attempts) {
    assert.doesNotMatch(reason.message, /multiple active|pending command|stale|differs/i);
  }
  assert.equal(launches, 1);

  const issued = await readB3IssuedCommand({ root, platform: 'ios' });
  assert.deepEqual(issued.command, launchedCommand);
  const observation = await createB3ProofObservation({
    command: issued.command,
    buildAuthority: BUILD_AUTHORITY,
    installationId: INSTALLATION_ID,
    sequence: 1,
    scenario: 'product-query',
    phase: 'ARMED',
    nextActionCode: 'QUERY_PRODUCT',
    completedTransitions: ['UNBOUND', 'ARMED'],
    proofProjection: {
      challengeSha256: issued.command.challengeSha256,
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
    },
    observedAt: '2026-07-15T10:00:00.000Z',
  });
  publishedBytes = Buffer.from(canonicaliseB3ProofValue(observation), 'utf8');
  const resumed = await resumeB3IssuedDeviceObservation({
    root,
    platform: 'ios',
    buildAuthority: BUILD_AUTHORITY,
    transport,
    maximumPullAttempts: 1,
  });
  assert.equal(resumed.observationSha256, observation.observationSha256);
  assert.equal(launches, 1);
  assert.equal((await readB3PhysicalObservationJournal({
    root, platform: 'ios', buildAuthority: BUILD_AUTHORITY,
  })).length, 1);
  await assert.rejects(readB3IssuedCommand({ root, platform: 'ios' }), /ENOENT|absent/i);
});

test('an immutable allocation claim repairs its exact base after a crash gap', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-issued-allocation-repair-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = join(root, '.native-build/b3/evidence/ios-issued-command-ledger');

  const first = await persistB3IssuedCommand({
    root, platform: 'ios', command: launchCommand(),
  });
  const firstBase = join(ledger, `${first.commandSha256}.base.json`);
  await rm(firstBase);
  assert.equal((await readB3IssuedCommand({ root, platform: 'ios' })).commandSha256,
    first.commandSha256);
  assert.equal((await lstat(firstBase)).mode & 0o777, 0o600);

  await clearB3IssuedCommand({ root, platform: 'ios', command: first.command });
  const second = await persistB3IssuedCommand({
    root,
    platform: 'ios',
    command: launchCommand({ challengeSha256: 'e'.repeat(64) }),
  });
  const secondBase = join(ledger, `${second.commandSha256}.base.json`);
  await rm(secondBase);
  assert.equal((await readB3IssuedCommand({ root, platform: 'ios' })).commandSha256,
    second.commandSha256);
  assert.equal((await lstat(secondBase)).mode & 0o777, 0o600);
});

test('global allocation scanning rejects an unanchored next-command claim', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-issued-orphan-allocation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const retained = await persistB3IssuedCommand({
    root, platform: 'ios', command: launchCommand(),
  });
  const ledger = join(root, '.native-build/b3/evidence/ios-issued-command-ledger');
  await writeFile(
    join(ledger, `${'f'.repeat(64)}.next-command.json`),
    await readFile(join(ledger, `${retained.commandSha256}.base.json`)),
    { mode: 0o600 },
  );
  await assert.rejects(
    readB3IssuedCommand({ root, platform: 'ios' }),
    /allocation|orphan|anchored/i,
  );
});

test('immutable claim reconciliation repairs a crashed writer alias but rejects arbitrary links', async (t) => {
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
  assert.equal((await transitionB3IssuedCommand({
    root, platform: 'ios', command,
    expectedState: 'prepared', nextState: 'stop-intent',
  })).state, 'stop-intent');
  await assert.rejects(lstat(persistentAlias), { code: 'ENOENT' });

  const arbitraryAlias = join(
    root,
    '.native-build/b3/evidence/hostile-private.tmp',
  );
  await link(retainedState, arbitraryAlias);
  await assert.rejects(
    readB3IssuedCommand({ root, platform: 'ios' }),
    /link|policy/i,
  );
  await rm(arbitraryAlias);
});

test('restart repairs crashed writer aliases for every issued-command authority record', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-issued-crashed-writer-records-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, '.native-build/b3/evidence');
  const ledger = join(evidence, 'ios-issued-command-ledger');
  let aliasIndex = 100;
  const crashAfterLink = async (target) => {
    const alias = join(
      evidence,
      `.issued-018f1d7b-97e8-4a52-8cf2-${String(aliasIndex).padStart(12, '0')}.tmp`,
    );
    aliasIndex += 1;
    await link(target, alias);
    return alias;
  };
  const expectRepaired = async (alias) => {
    await assert.rejects(lstat(alias), { code: 'ENOENT' });
  };

  const first = await persistB3IssuedCommand({
    root, platform: 'ios', command: launchCommand(),
  });
  let alias = await crashAfterLink(join(ledger, 'command-chain-root.json'));
  assert.equal((await readB3IssuedCommand({ root, platform: 'ios' })).state, 'prepared');
  await expectRepaired(alias);

  alias = await crashAfterLink(join(ledger, `${first.commandSha256}.base.json`));
  assert.equal((await readB3IssuedCommand({ root, platform: 'ios' })).state, 'prepared');
  await expectRepaired(alias);

  await transitionB3IssuedCommand({
    root, platform: 'ios', command: first.command,
    expectedState: 'prepared', nextState: 'launching',
  });
  for (const name of [
    `${first.commandSha256}.successor-prepared.json`,
    `${first.commandSha256}.state-launching.json`,
  ]) {
    alias = await crashAfterLink(join(ledger, name));
    assert.equal((await readB3IssuedCommand({ root, platform: 'ios' })).state, 'launching');
    await expectRepaired(alias);
  }

  await clearB3IssuedCommand({ root, platform: 'ios', command: first.command });
  alias = await crashAfterLink(join(ledger, `${first.commandSha256}.consumed.json`));
  await assert.rejects(readB3IssuedCommand({ root, platform: 'ios' }), /ENOENT|absent/i);
  await expectRepaired(alias);

  const second = await persistB3IssuedCommand({
    root,
    platform: 'ios',
    command: launchCommand({ challengeSha256: 'e'.repeat(64) }),
  });
  alias = await crashAfterLink(join(ledger, `${first.commandSha256}.next-command.json`));
  assert.equal((await readB3IssuedCommand({ root, platform: 'ios' })).commandSha256,
    second.commandSha256);
  await expectRepaired(alias);
});

test('failed pre-cleanup allocation sync preserves its writer alias for restart repair', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-issued-allocation-sync-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = launchCommand();
  let injected = 0;
  await assert.rejects(
    persistB3IssuedCommand({
      root,
      platform: 'ios',
      command,
      beforeAllocationSync: async () => {
        injected += 1;
        throw new Error('injected pre-cleanup allocation sync failure');
      },
    }),
    /injected pre-cleanup allocation sync failure/i,
  );
  assert.equal(injected, 1);

  const evidence = join(root, '.native-build/b3/evidence');
  const ledger = join(evidence, 'ios-issued-command-ledger');
  const aliases = (await readdir(evidence)).filter((name) =>
    /^\.issued-.*\.tmp$/u.test(name));
  assert.equal(aliases.length, 1);
  assert.equal((await lstat(join(evidence, aliases[0]))).nlink, 2);
  assert.equal((await lstat(join(ledger, 'command-chain-root.json'))).nlink, 2);

  const recovered = await persistB3IssuedCommand({ root, platform: 'ios', command });
  assert.deepEqual(recovered.command, command);
  await assert.rejects(lstat(join(evidence, aliases[0])), { code: 'ENOENT' });
  assert.equal((await lstat(join(ledger, 'command-chain-root.json'))).nlink, 1);
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
  await Promise.all(Array.from({ length: 768 }, (_, index) => writeFile(
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
  await Promise.all(Array.from({ length: 96 }, (_, index) => writeFile(
    join(baseLedger, `${(index + 1).toString(16).padStart(64, '0')}.base.json`),
    'bounded-debris',
    { mode: 0o600 },
  )));
  await assert.rejects(
    readB3IssuedCommand({ root: baseRoot, platform: 'ios' }),
    /base count|bound/i,
  );
});

test('issued ledger capacity covers four abandoned Android journeys and one final journey', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-ledger-capture-generation-capacity-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  // Android is the larger closed journey at eighteen host commands. Four
  // retained abandoned generations plus one final generation therefore need
  // ninety immutable command allocations without operator ledger deletion.
  for (let index = 1; index <= 90; index += 1) {
    const command = launchCommand({
      captureId: `018f1d7b-97e8-4a52-8cf2-${String(index).padStart(12, '0')}`,
      challengeSha256: index.toString(16).padStart(64, '0'),
    });
    await persistB3IssuedCommand({ root, platform: 'ios', command });
    await clearB3IssuedCommand({ root, platform: 'ios', command });
  }

  await assert.rejects(readB3IssuedCommand({ root, platform: 'ios' }), /ENOENT|absent/i);
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
  const crashedPrivateAlias = join(
    root,
    '.native-build/b3/evidence/.issued-018f1d7b-97e8-4a52-8cf2-783e5089c099.tmp',
  );
  await link(path, crashedPrivateAlias);
  assert.equal((await readB3IssuedCommand({ root, platform: 'ios' })).state, 'prepared');
  await assert.rejects(lstat(crashedPrivateAlias), { code: 'ENOENT' });
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
