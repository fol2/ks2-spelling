import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  canonicaliseB3ProofValue,
  createB3ProofObservation,
} from '../src/app/b3-live-proof-protocol.js';
import {
  createB3StoreBackedLiveCapture,
  deriveB3NextStoreCommand,
} from '../scripts/lib/b3-store-backed-live-capture.mjs';
import { createB3IssuedCommandStateAuthority } from
  '../scripts/lib/b3-issued-command-authority.mjs';
import { buildB3PhysicalProofAuthority } from
  '../scripts/lib/b3-capture-proof-domain.mjs';
import {
  B3_TEST_COMMIT,
  B3_TEST_HASH,
  platformEvidence,
} from './helpers/b3-evidence-fixtures.mjs';

const CAPTURE_ID = '018f1d7b-97e8-4a52-8cf2-783e5089c001';
const INSTALLATION_ID = '018f1d7b-97e8-4a52-8cf2-783e5089c002';
const NATIVE_CROSSING_HELPER = new URL(
  './helpers/b3-store-backed-native-crossing-child.mjs',
  import.meta.url,
);
const RECOVERY_SQL_DEATH_HELPER = new URL(
  './helpers/b3-store-backed-recovery-sql-death-child.mjs',
  import.meta.url,
);
const execFileAsync = promisify(execFile);

async function nativeCrossingFixture(t, label) {
  const root = await mkdtemp(join(tmpdir(), `b3-store-backed-${label}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nativeBuild = join(root, '.native-build');
  const b3 = join(nativeBuild, 'b3');
  const distribution = join(b3, 'distribution');
  await mkdir(distribution, { recursive: true, mode: 0o700 });
  for (const directory of [nativeBuild, b3, distribution]) await chmod(directory, 0o700);
  await writeFile(join(distribution, 'build-authority.json'), JSON.stringify({
    schemaVersion: 1,
    testedApplicationCommit: B3_TEST_COMMIT,
    applicationFingerprint: B3_TEST_HASH,
    versionName: '0.3.0-b3',
    iosBuildNumber: '19',
    androidVersionCode: 19,
  }), { mode: 0o600 });
  return root;
}

function spawnNativeCrossingHelper(t, root, ...args) {
  const child = fork(NATIVE_CROSSING_HELPER.pathname, args, {
    cwd: root,
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
    execArgv: ['--experimental-test-module-mocks'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  let readyResolve;
  let readyReject;
  let resultResolve;
  let resultReject;
  const ready = new Promise((resolveReady, rejectReady) => {
    readyResolve = resolveReady;
    readyReject = rejectReady;
  });
  const result = new Promise((resolveResult, rejectResult) => {
    resultResolve = resolveResult;
    resultReject = rejectResult;
  });
  let hasResult = false;
  child.on('message', (message) => {
    if (message?.type === 'ready') readyResolve(message);
    if (message?.type === 'result') {
      hasResult = true;
      resultResolve(message);
    }
    if (message?.type === 'unexpected-return') {
      resultReject(new Error('B3 native-crossing child unexpectedly returned'));
    }
  });
  child.on('error', (error) => {
    readyReject(error);
    resultReject(error);
  });
  const exited = new Promise((resolveExit) => {
    child.on('exit', (code, signal) => {
      const exit = { code, signal, stderr };
      if (code !== 0 && signal === null) {
        const error = new Error(`B3 native-crossing child exited ${code}: ${stderr}`);
        readyReject(error);
        if (!hasResult) resultReject(error);
      }
      resolveExit(exit);
    });
  });
  return Object.freeze({ child, ready, result, exited });
}

async function runNativeCrossingHelper(t, root, ...args) {
  const helper = spawnNativeCrossingHelper(t, root, ...args);
  const result = await helper.result;
  assert.deepEqual(await helper.exited, { code: 0, signal: null, stderr: '' });
  return result;
}

async function runRecoverySqlDeathHelper(root, ...args) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    '--experimental-test-module-mocks',
    RECOVERY_SQL_DEATH_HELPER.pathname,
    ...args,
  ], { cwd: root, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  assert.equal(stderr, '');
  return JSON.parse(stdout);
}

function spawnRecoverySqlDeathHelper(t, root, ...args) {
  const child = fork(RECOVERY_SQL_DEATH_HELPER.pathname, args, {
    cwd: root,
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
    execArgv: ['--experimental-test-module-mocks'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  const paused = new Promise((resolvePaused, rejectPaused) => {
    child.on('message', (message) => {
      if (message?.type === 'paused') resolvePaused(message);
      if (message?.type === 'unexpected-return') {
        rejectPaused(new Error('B3 recovery SQL death helper unexpectedly returned'));
      }
    });
    child.on('error', rejectPaused);
  });
  const exited = new Promise((resolveExit) => {
    child.on('exit', (code, signal) => resolveExit({ code, signal, stderr }));
  });
  return Object.freeze({ child, paused, exited });
}

function buildAuthority(platform = 'ios') {
  return buildB3PhysicalProofAuthority(platform, {
    schemaVersion: 1,
    testedApplicationCommit: B3_TEST_COMMIT,
    applicationFingerprint: B3_TEST_HASH,
    versionName: '0.3.0-b3',
    iosBuildNumber: '19',
    androidVersionCode: 19,
  });
}

function commandSource(platform, command, state = 'prepared', allocationSequence = 1) {
  const retained = createB3IssuedCommandStateAuthority({ platform, command, state });
  return Object.freeze({
    ...retained,
    allocationSequence,
    captureId: command.captureId,
    predecessorCommandSha256: null,
  });
}

function proofProjection(command) {
  return {
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
  };
}

async function observationFor(command, authority = buildAuthority()) {
  return createB3ProofObservation({
    command,
    buildAuthority: authority,
    installationId: INSTALLATION_ID,
    sequence: command.expectedSequence,
    scenario: 'product-query',
    phase: 'ARMED',
    nextActionCode: 'QUERY_PRODUCT',
    completedTransitions: ['UNBOUND', 'ARMED'],
    proofProjection: proofProjection(command),
    observedAt: '2026-07-17T10:00:00.000Z',
  });
}

function fakeStore({
  platform = 'ios',
  active = null,
  capture = null,
  activeProjection,
  recoveryOutcome = Object.freeze({
    status: 'not-applicable',
    acknowledgementConsumed: false,
  }),
} = {}) {
  const events = [];
  let current = active;
  let projection = capture;
  let selectedRecoveryOutcome = recoveryOutcome;
  const recoveryPins = new WeakSet();
  const nextSource = (command, state, allocationSequence = 1) =>
    commandSource(platform, command, state, allocationSequence);
  const store = {
    async readActiveCommand() {
      events.push('read-active');
      if (activeProjection !== undefined) return activeProjection;
      return current === null
        ? Object.freeze({ kind: 'none' })
        : Object.freeze({ kind: 'active', command: current });
    },
    async startCapture({ command }) {
      events.push('start');
      current = nextSource(command, 'prepared');
      projection = Object.freeze({
        schemaVersion: 1,
        platform,
        captureId: command.captureId,
        records: Object.freeze([]),
        checkpoint: null,
        gatewaySmokeProjection: null,
      });
      return Object.freeze({ kind: 'started', capture: Object.freeze({
        firstCommand: command,
      }) });
    },
    async allocateNextCommand({ command }) {
      events.push('allocate');
      current = nextSource(command, 'prepared', command.expectedSequence);
      return Object.freeze({ kind: 'allocated', command: current });
    },
    async transitionCommand({ source, nextState }) {
      events.push(`transition:${source.state}:${nextState}`);
      current = nextSource(source.command, nextState, source.allocationSequence);
      return Object.freeze({ kind: 'transitioned', command: current });
    },
    async publishObservation({ source, observationBytes }) {
      events.push(`publish:${source.state}`);
      const observation = JSON.parse(Buffer.from(observationBytes).toString('utf8'));
      const record = Object.freeze({ command: source.command, observation });
      projection = Object.freeze({
        schemaVersion: 1,
        platform,
        captureId: source.captureId,
        records: Object.freeze([...(projection?.records ?? []), record]),
        checkpoint: Object.freeze({
          schemaVersion: 1,
          captureId: source.captureId,
          nextSequence: source.command.expectedSequence + 1,
        }),
        gatewaySmokeProjection: null,
      });
      return Object.freeze({ kind: 'published', record, checkpoint: projection.checkpoint });
    },
    async consumeCommand({ source }) {
      events.push(`consume:${source.state}`);
      current = null;
      return Object.freeze({
        kind: 'consumed', commandSha256: source.commandSha256,
        sourceState: source.state, claimSha256: 'c'.repeat(64),
      });
    },
    async readCapture() {
      events.push('read-capture');
      if (projection === null) {
        throw Object.assign(new Error('B3 capture-state has no readable working capture'), {
          code: 'b3_capture_state_invalid',
        });
      }
      return projection;
    },
    async pinRecoveryInvocation({ acknowledgeReinstall }) {
      events.push(`pin-recovery:${acknowledgeReinstall}`);
      const invocation = Object.freeze(Object.create(null));
      recoveryPins.add(invocation);
      return invocation;
    },
    async finaliseRecoveryInvocation({ invocation, distribution, freshCommand }) {
      events.push('finalise-recovery');
      assert.equal(recoveryPins.has(invocation), true);
      assert.notEqual(distribution, platformEvidence(
        platform === 'ios' ? 'ios-physical' : 'android-play-physical',
      ).distribution);
      assert.equal(freshCommand.actionCode, 'ARM_CAPTURE');
      assert.equal(freshCommand.expectedScenarioIndex, 0);
      assert.equal(freshCommand.expectedSequence, 1);
      return selectedRecoveryOutcome;
    },
    async close() { events.push('close'); },
  };
  return {
    store: Object.freeze(store),
    events,
    active: () => current,
    setActive: (value) => { current = value; },
    setRecoveryOutcome: (value) => { selectedRecoveryOutcome = value; },
    capture: () => projection,
  };
}

test('pure next-command derivation uses the committed capture tail and Android action bridge', () => {
  let uuidCalls = 0;
  const first = deriveB3NextStoreCommand({
    platform: 'ios',
    buildAuthority: buildAuthority(),
    capture: null,
    uuidFactory: () => {
      uuidCalls += 1;
      return CAPTURE_ID;
    },
  });
  assert.equal(first.actionCode, 'ARM_CAPTURE');
  assert.equal(first.expectedSequence, 1);
  assert.equal(first.previousObservationSha256, '0'.repeat(64));
  assert.equal(uuidCalls, 1);

  const observationSha256 = 'd'.repeat(64);
  const capture = Object.freeze({
    schemaVersion: 1,
    platform: 'android',
    captureId: CAPTURE_ID,
    records: Object.freeze([Object.freeze({
      command: first,
      observation: Object.freeze({
        captureId: CAPTURE_ID,
        sequence: 1,
        scenarioIndex: 2,
        nextActionCode: 'APPROVE_PENDING_PURCHASE',
        observationSha256,
      }),
    })]),
    checkpoint: Object.freeze({ nextScenarioIndex: 2 }),
    gatewaySmokeProjection: null,
  });
  const second = deriveB3NextStoreCommand({
    platform: 'android',
    buildAuthority: buildAuthority('android'),
    capture,
    uuidFactory: () => {
      uuidCalls += 1;
      return 'must-not-be-used';
    },
  });
  assert.equal(second.actionCode, 'ARM_GATEWAY_COMPLETION_HOLD');
  assert.equal(second.expectedScenarioIndex, 3);
  assert.equal(second.expectedSequence, 2);
  assert.equal(second.previousObservationSha256, observationSha256);
  assert.equal(second.captureId, CAPTURE_ID);
  assert.equal(uuidCalls, 1);
});

test('controller lazily starts, owns one launch, publishes, consumes and closes once', async () => {
  const authority = buildAuthority();
  const fake = fakeStore();
  let opened = 0;
  let launched = 0;
  let pulled = 0;
  let launchedCommand;
  const controller = createB3StoreBackedLiveCapture({
    platform: 'ios',
    buildAuthority: async () => authority,
    uuidFactory: () => CAPTURE_ID,
    storeFactory: async () => {
      opened += 1;
      return fake.store;
    },
    transport: {
      async launch(command) {
        launched += 1;
        launchedCommand = command;
      },
      async pullObservation() {
        pulled += 1;
        const observation = await observationFor(launchedCommand, authority);
        return Buffer.from(canonicaliseB3ProofValue(observation), 'utf8');
      },
      async forceStop() {},
    },
    wait: async () => {},
  });

  assert.equal(opened, 0);
  const observation = await controller.advance();
  assert.equal(observation.sequence, 1);
  assert.equal(launched, 1);
  assert.equal(pulled, 1);
  assert.equal(opened, 1);
  assert.equal(fake.capture().records.length, 1);
  assert.equal(fake.active(), null);
  await controller.dispose();
  await controller.dispose();
  assert.equal(fake.events.filter((entry) => entry === 'close').length, 1);
  assert.deepEqual(fake.events.filter((entry) => /^(start|transition|publish|consume)/u.test(entry)), [
    'start',
    'transition:prepared:launching',
    'transition:launching:launched',
    'publish:launched',
    'consume:launched',
  ]);
});

test('retained launched command is pull-only and an existing committed step is consume-only', async () => {
  const authority = buildAuthority();
  const command = deriveB3NextStoreCommand({
    platform: 'ios',
    buildAuthority: authority,
    capture: null,
    uuidFactory: () => CAPTURE_ID,
  });
  const launched = commandSource('ios', command, 'launched');
  let launches = 0;
  let pulls = 0;
  const first = fakeStore({
    active: launched,
    capture: Object.freeze({
      schemaVersion: 1, platform: 'ios', captureId: CAPTURE_ID,
      records: Object.freeze([]), checkpoint: null, gatewaySmokeProjection: null,
    }),
  });
  const controller = createB3StoreBackedLiveCapture({
    platform: 'ios',
    buildAuthority: async () => authority,
    storeFactory: async () => first.store,
    transport: {
      async launch() { launches += 1; },
      async pullObservation() {
        pulls += 1;
        return Buffer.from(canonicaliseB3ProofValue(
          await observationFor(command, authority),
        ));
      },
      async forceStop() {},
    },
  });
  await controller.advance();
  assert.deepEqual({ launches, pulls }, { launches: 0, pulls: 1 });
  await controller.dispose();

  const observation = await observationFor(command, authority);
  const record = Object.freeze({ command, observation });
  const second = fakeStore({
    active: launched,
    capture: Object.freeze({
      schemaVersion: 1, platform: 'ios', captureId: CAPTURE_ID,
      records: Object.freeze([record]), checkpoint: Object.freeze({}),
      gatewaySmokeProjection: null,
    }),
  });
  const consumeOnly = createB3StoreBackedLiveCapture({
    platform: 'ios',
    buildAuthority: async () => authority,
    storeFactory: async () => second.store,
    transport: {
      async launch() { launches += 1; },
      async pullObservation() { pulls += 1; return Buffer.alloc(0); },
      async forceStop() {},
    },
  });
  assert.equal((await consumeOnly.advance()).observationSha256, observation.observationSha256);
  assert.deepEqual({ launches, pulls }, { launches: 0, pulls: 1 });
  assert.equal(second.events.some((entry) => entry.startsWith('publish:')), false);
  assert.equal(second.events.some((entry) => entry === 'consume:launched'), true);
  await consumeOnly.dispose();
});

test('publication adopts a concurrently selected ordinary successor before consuming', async () => {
  const authority = buildAuthority();
  const fake = fakeStore();
  let launchCompletionConflicted = false;
  let firstPublication = true;
  const store = Object.freeze({
    ...fake.store,
    async transitionCommand(input) {
      if (!launchCompletionConflicted && input.source.state === 'launching' &&
          input.nextState === 'launched') {
        launchCompletionConflicted = true;
        const selected = await fake.store.transitionCommand({
          source: input.source,
          nextState: 'restart-required',
        });
        return Object.freeze({ kind: 'ordinary-conflict', command: selected.command });
      }
      return fake.store.transitionCommand(input);
    },
    async publishObservation(input) {
      if (firstPublication) {
        firstPublication = false;
        await fake.store.transitionCommand({
          source: input.source,
          nextState: 'launched',
        });
        throw Object.assign(
          new Error('B3 capture-state missing publication is not the active tail'),
          { code: 'b3_capture_state_invalid' },
        );
      }
      return fake.store.publishObservation(input);
    },
  });
  let launchedCommand;
  const controller = createB3StoreBackedLiveCapture({
    platform: 'ios',
    buildAuthority: async () => authority,
    uuidFactory: () => CAPTURE_ID,
    storeFactory: async () => store,
    transport: {
      async launch(command) {
        launchedCommand = command;
        throw Object.assign(new Error('native launch completion was not observed'), {
          code: 'b3_physical_device_command_failed',
        });
      },
      async pullObservation() {
        return Buffer.from(canonicaliseB3ProofValue(
          await observationFor(launchedCommand, authority),
        ));
      },
      async forceStop() {},
    },
  });

  assert.equal((await controller.advance()).sequence, 1);
  assert.deepEqual(fake.events.filter((entry) =>
    /^(publish|consume|transition:(?:launching:restart-required|restart-required:launched))/u
      .test(entry)), [
    'transition:launching:restart-required',
    'transition:restart-required:launched',
    'publish:launched',
    'consume:launched',
  ]);
  await controller.dispose();
});

test('controller maps every closed recovery outcome to one public key on both platforms',
  async (t) => {
    const outcomes = [
      ['not-applicable', false],
      ['operator-required', false],
      ['recovered', true],
      ['already-recovered', true],
      ['rejected', false],
    ];
    for (const platform of ['ios', 'android']) {
      for (const [status, acknowledgementConsumed] of outcomes) {
        await t.test(`${platform}:${status}`, async () => {
          const events = [];
          const fake = fakeStore({
            platform,
            recoveryOutcome: Object.freeze({ status, acknowledgementConsumed }),
          });
          const controller = createB3StoreBackedLiveCapture({
            platform,
            buildAuthority: async () => buildAuthority(platform),
            uuidFactory: () => CAPTURE_ID,
            storeFactory: async () => fake.store,
            consumeReinstallAcknowledgement() {
              assert.equal(fake.events.at(-1), 'finalise-recovery');
              events.push('acknowledgement-consumed');
            },
            transport: {
              async launch() {}, async pullObservation() { return Buffer.alloc(0); },
              async forceStop() {},
            },
          });
          const invocation = await controller.pinInvocation({
            acknowledgeReinstall: true,
          });
          const result = await controller.finaliseInvocation({
            invocation,
            distribution: platformEvidence(
              platform === 'ios' ? 'ios-physical' : 'android-play-physical',
            ).distribution,
          });
          assert.deepEqual(result, { status });
          assert.deepEqual(Reflect.ownKeys(result), ['status']);
          assert.equal(Object.isFrozen(result), true);
          assert.deepEqual(fake.events.filter((entry) =>
            entry.startsWith('pin-recovery') || entry === 'finalise-recovery'), [
            'pin-recovery:true',
            'finalise-recovery',
          ]);
          assert.deepEqual(events, acknowledgementConsumed
            ? ['acknowledgement-consumed']
            : []);
          await controller.dispose();
        });
      }
    }
  });

test('controller rejects distribution before UUID or store finalisation and consumes its pin',
  async () => {
    const fake = fakeStore();
    let uuidCalls = 0;
    const controller = createB3StoreBackedLiveCapture({
      platform: 'ios',
      buildAuthority: async () => buildAuthority(),
      uuidFactory: () => {
        uuidCalls += 1;
        return CAPTURE_ID;
      },
      storeFactory: async () => fake.store,
      transport: {
        async launch() {}, async pullObservation() { return Buffer.alloc(0); },
        async forceStop() {},
      },
    });
    const invocation = await controller.pinInvocation({ acknowledgeReinstall: true });
    const invalidDistribution = {
      ...platformEvidence().distribution,
      installedBuild: '999',
    };
    await assert.rejects(controller.finaliseInvocation({
      invocation,
      distribution: invalidDistribution,
    }), /recovery.*distribution.*differs/i);
    assert.equal(uuidCalls, 0);
    assert.equal(fake.events.includes('finalise-recovery'), false);
    await assert.rejects(controller.finaliseInvocation({
      invocation,
      distribution: platformEvidence().distribution,
    }), /recovery.*invocation.*invalid/i);
    assert.equal(uuidCalls, 0);
    assert.equal(fake.events.includes('finalise-recovery'), false);
    await controller.dispose();
  });

test('controller rejects recovery-pending ordinary work without build, UUID or transport',
  async () => {
    let buildReads = 0;
    let uuidCalls = 0;
    let transportCalls = 0;
    const fake = fakeStore({
      activeProjection: Object.freeze({ kind: 'recovery-pending' }),
    });
    const controller = createB3StoreBackedLiveCapture({
      platform: 'ios',
      buildAuthority: async () => {
        buildReads += 1;
        return buildAuthority();
      },
      uuidFactory: () => {
        uuidCalls += 1;
        return CAPTURE_ID;
      },
      storeFactory: async () => fake.store,
      transport: {
        async launch() { transportCalls += 1; },
        async pullObservation() { transportCalls += 1; return Buffer.alloc(0); },
        async forceStop() { transportCalls += 1; },
      },
    });
    await assert.rejects(controller.advance(), /recovery.*pending/i);
    assert.deepEqual({ buildReads, uuidCalls, transportCalls }, {
      buildReads: 0,
      uuidCalls: 0,
      transportCalls: 0,
    });
    assert.equal(fake.events.some((entry) =>
      ['start', 'allocate', 'finalise-recovery'].includes(entry)), false);
    await controller.dispose();
  });

test('controller validates the internal recovery outcome before consuming acknowledgement',
  async () => {
    let callbackCalls = 0;
    const fake = fakeStore({
      recoveryOutcome: Object.freeze({
        status: 'not-applicable',
        acknowledgementConsumed: true,
      }),
    });
    const controller = createB3StoreBackedLiveCapture({
      platform: 'ios',
      buildAuthority: async () => buildAuthority(),
      uuidFactory: () => CAPTURE_ID,
      storeFactory: async () => fake.store,
      consumeReinstallAcknowledgement() { callbackCalls += 1; },
      transport: {
        async launch() {}, async pullObservation() { return Buffer.alloc(0); },
        async forceStop() {},
      },
    });
    const invocation = await controller.pinInvocation({ acknowledgeReinstall: true });
    await assert.rejects(controller.finaliseInvocation({
      invocation,
      distribution: platformEvidence().distribution,
    }), /recovery.*outcome.*invalid/i);
    assert.equal(callbackCalls, 0);
    await controller.dispose();
    await controller.dispose();
    assert.equal(fake.events.filter((entry) => entry === 'close').length, 1);
  });

test('real child death at native launch crossings reopens without replay or finaliser mutation',
  async (t) => {
    const cases = [
      {
        stage: 'before-native-launch',
        state: 'launching',
        status: 'rejected',
        receipt: false,
        pulls: 0,
        activeKindAfter: 'active',
      },
      {
        stage: 'after-native-receipt',
        state: 'launching',
        status: 'rejected',
        receipt: true,
        pulls: 0,
        activeKindAfter: 'active',
      },
      {
        stage: 'after-launched-commit',
        state: 'launched',
        status: 'not-applicable',
        receipt: true,
        pulls: 1,
        activeKindAfter: 'none',
      },
    ];
    for (const expected of cases) {
      await t.test(expected.stage, async (t) => {
        const root = await nativeCrossingFixture(t, expected.stage);
        const crossing = spawnNativeCrossingHelper(t, root, 'crossing', expected.stage);
        assert.deepEqual(await crossing.ready, { type: 'ready', stage: expected.stage });
        assert.equal(crossing.child.kill('SIGKILL'), true);
        assert.deepEqual(await crossing.exited, {
          code: null,
          signal: 'SIGKILL',
          stderr: '',
        });

        const receiptPath = join(root, 'fake-native-launch-receipt.json');
        if (expected.receipt) {
          const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
          assert.equal(receipt.schemaVersion, 1);
          assert.match(receipt.commandSha256, /^[0-9a-f]{64}$/u);
        } else {
          await assert.rejects(readFile(receiptPath), /ENOENT/u);
        }

        const verified = await runNativeCrossingHelper(t, root, 'verify-crossing');
        assert.equal(verified.stateBefore, expected.state);
        assert.deepEqual(verified.finalisation, { status: expected.status });
        assert.equal(verified.databaseUnchangedByFinalisation, true);
        assert.equal(verified.launches, 0);
        assert.equal(verified.pulls, expected.pulls);
        assert.equal(verified.activeKindAfter, expected.activeKindAfter);
        if (expected.state === 'launched') {
          assert.match(verified.advancedObservationSha256, /^[0-9a-f]{64}$/u);
          assert.equal(verified.stateAfter, null);
        } else {
          assert.equal(verified.advancedObservationSha256, null);
          assert.equal(verified.stateAfter, 'launching');
        }
        assert.deepEqual(
          await readdir(join(root, '.native-build', 'b3', 'evidence')),
          ['ios-capture-state'],
        );
      });
    }
  });

test('real process death before and after each recovery commit reopens through the controller',
  async (t) => {
    const cases = [
      { transaction: 1, boundary: 'before', before: 'active', status: 'recovered',
        acknowledge: true, retainedCapture: '018f1d7b-97e8-4a52-8cf2-783e5089c003' },
      { transaction: 1, boundary: 'after', before: 'recovery-pending', status: 'recovered',
        acknowledge: false, retainedCapture: '018f1d7b-97e8-4a52-8cf2-783e5089c003' },
      { transaction: 2, boundary: 'before', before: 'recovery-pending', status: 'recovered',
        acknowledge: false, retainedCapture: '018f1d7b-97e8-4a52-8cf2-783e5089c003' },
      { transaction: 2, boundary: 'after', before: 'recovery-pending',
        status: 'already-recovered', acknowledge: false,
        retainedCapture: '018f1d7b-97e8-4a52-8cf2-783e5089c002' },
      { transaction: 3, boundary: 'before', before: 'recovery-pending',
        status: 'already-recovered', acknowledge: false,
        retainedCapture: '018f1d7b-97e8-4a52-8cf2-783e5089c002' },
      { transaction: 3, boundary: 'after', before: 'active',
        status: 'already-recovered', acknowledge: false,
        retainedCapture: '018f1d7b-97e8-4a52-8cf2-783e5089c002' },
    ];
    for (const expected of cases) {
      await t.test(`${expected.boundary}-transaction-${expected.transaction}`, async (t) => {
        const root = await nativeCrossingFixture(
          t,
          `recovery-${expected.boundary}-${expected.transaction}`,
        );
        assert.deepEqual(await runRecoverySqlDeathHelper(root, 'seed'), {
          ok: true,
          state: 'restart-required',
        });
        const crossing = spawnRecoverySqlDeathHelper(
          t,
          root,
          'recover',
          String(expected.transaction),
          expected.boundary,
          'true',
          '018f1d7b-97e8-4a52-8cf2-783e5089c002',
        );
        assert.deepEqual(await crossing.paused, {
          type: 'paused',
          transaction: expected.transaction,
          boundary: expected.boundary,
        });
        assert.equal(crossing.child.kill('SIGKILL'), true);
        assert.deepEqual(await crossing.exited, {
          code: null,
          signal: 'SIGKILL',
          stderr: '',
        });
        const resumed = await runRecoverySqlDeathHelper(
          root,
          'resume',
          '0',
          'none',
          String(expected.acknowledge),
          '018f1d7b-97e8-4a52-8cf2-783e5089c003',
        );
        assert.equal(resumed.ok, true);
        assert.equal(resumed.activeBefore.kind, expected.before);
        if (expected.transaction === 1 && expected.boundary === 'before') {
          assert.equal(resumed.activeBefore.command.state, 'restart-required');
        }
        assert.deepEqual(resumed.outcome, { status: expected.status });
        assert.deepEqual(Reflect.ownKeys(resumed.outcome), ['status']);
        assert.equal(resumed.activeAfter.kind, 'active');
        assert.equal(resumed.activeAfter.command.state, 'prepared');
        assert.equal(resumed.activeAfter.command.captureId, expected.retainedCapture);
        assert.equal(resumed.activeAfter.command.allocationSequence, 2);
      });
    }
  });

test('real same-process and second-helper stale pins classify fresh ambiguous states read-only',
  async (t) => {
    for (const target of ['launching', 'stop-executing']) {
      await t.test(`${target}:same-process`, async (t) => {
        const root = await nativeCrossingFixture(t, `${target}-same`);
        const result = await runNativeCrossingHelper(t, root, 'stale-pin-same', target);
        assert.deepEqual(result.finalisation, { status: 'rejected' });
        assert.equal(result.databaseUnchangedByFinalisation, true);
        assert.equal(result.state, target);
      });

      await t.test(`${target}:second-helper`, async (t) => {
        const root = await nativeCrossingFixture(t, `${target}-second`);
        const stale = spawnNativeCrossingHelper(t, root, 'stale-pin-wait', target);
        assert.equal((await stale.ready).state,
          target === 'stop-executing' ? 'stop-intent' : 'prepared');
        const transition = await runNativeCrossingHelper(t, root, 'transition', target);
        assert.equal(transition.state, target);
        stale.child.send({ type: 'go' });
        const result = await stale.result;
        assert.deepEqual(await stale.exited, { code: 0, signal: null, stderr: '' });
        assert.deepEqual(result.finalisation, { status: 'rejected' });
        assert.equal(result.databaseUnchangedByFinalisation, true);
        assert.equal(result.state, target);
      });
    }
  });

test('real SQLite finaliser matrix is read-only for ordinary repository states',
  async (t) => {
    const expectedStatuses = Object.freeze({
      none: 'not-applicable',
      prepared: 'not-applicable',
      'stop-intent': 'not-applicable',
      'stop-executing': 'rejected',
      'host-stopped': 'not-applicable',
      launching: 'rejected',
      'reinstall-authorised': 'not-applicable',
      'reinstall-launching': 'rejected',
      launched: 'not-applicable',
      'restart-required': 'operator-required',
    });

    for (const platform of ['ios', 'android']) {
      for (const [state, status] of Object.entries(expectedStatuses)) {
        await t.test(`${platform}:${state}`, async (t) => {
          const root = await nativeCrossingFixture(t, `finaliser-${platform}-${state}`);
          const result = await runNativeCrossingHelper(
            t, root, 'finaliser-matrix', platform, state,
          );
          assert.equal(result.platform, platform);
          assert.equal(result.state, state);
          assert.equal(result.authoritySource, 'repository-committed');
          assert.deepEqual(result.finalisation, { status });
          assert.equal(result.databaseBytesUnchanged, true);
          assert.equal(result.relationalSnapshotUnchanged, true);
          assert.equal(result.legacyNamespaceUnchanged, true);
        });
      }
    }
  });

test('controller source has no legacy working-state dependency', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) => readFile(
    new URL('../scripts/lib/b3-store-backed-live-capture.mjs', import.meta.url),
    'utf8',
  ));
  assert.doesNotMatch(source, /b3-(?:issued-command|host-capture-state|abandoned-capture)|appendB3PhysicalObservation|readB3CaptureCheckpoint/u);
  assert.equal(createHash('sha256').update(source).digest('hex').length, 64);
});
