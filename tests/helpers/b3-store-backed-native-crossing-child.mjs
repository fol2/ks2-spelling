import { createHash } from 'node:crypto';
import { open, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
const {
  createB3StoreBackedLiveCapture,
  deriveB3NextStoreCommand,
} = await import('../../scripts/lib/b3-store-backed-live-capture.mjs');
const { buildB3PhysicalProofAuthority } = await import(
  '../../scripts/lib/b3-capture-proof-domain.mjs'
);
const {
  B3_TEST_COMMIT,
  B3_TEST_HASH,
  platformEvidence,
} = await import('./b3-evidence-fixtures.mjs');

const CAPTURE_ID = '018f1d7b-97e8-4a52-8cf2-783e5089c901';
const INSTALLATION_ID = '018f1d7b-97e8-4a52-8cf2-783e5089c902';
const RECEIPT_PATH = resolve('fake-native-launch-receipt.json');
const mode = process.argv[2];
const matrixPlatform = mode === 'finaliser-matrix' ? process.argv[3] : null;
const targetState = mode === 'finaliser-matrix' ? process.argv[4] : process.argv[3];

const MATRIX_TRANSITIONS = Object.freeze({
  prepared: Object.freeze([]),
  'stop-intent': Object.freeze(['stop-intent']),
  'stop-executing': Object.freeze(['stop-intent', 'stop-executing']),
  'host-stopped': Object.freeze(['stop-intent', 'stop-executing', 'host-stopped']),
  launching: Object.freeze(['launching']),
  'reinstall-authorised': Object.freeze(['launching', 'reinstall-authorised']),
  'reinstall-launching': Object.freeze([
    'launching', 'reinstall-authorised', 'reinstall-launching',
  ]),
  launched: Object.freeze(['launching', 'launched']),
  'restart-required': Object.freeze(['launching', 'restart-required']),
  'restart-executing': Object.freeze(['launching', 'restart-required']),
  'restart-complete': Object.freeze(['launching', 'restart-required']),
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function databasePath(platform = 'ios') {
  return resolve(
    '.native-build', 'b3', 'evidence', `${platform}-capture-state`, 'recovery.sqlite',
  );
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

async function observation(command) {
  return createB3ProofObservation({
    command,
    buildAuthority: buildAuthority(),
    installationId: INSTALLATION_ID,
    sequence: command.expectedSequence,
    scenario: 'product-query',
    phase: 'ARMED',
    nextActionCode: 'QUERY_PRODUCT',
    completedTransitions: ['UNBOUND', 'ARMED'],
    proofProjection: proofProjection(command),
    observedAt: '2026-07-17T11:00:00.000Z',
  });
}

function send(message) {
  if (typeof process.send !== 'function') {
    throw new Error('B3 store-backed native-crossing IPC channel is absent');
  }
  process.send(message);
}

function waitForGo() {
  return new Promise((resolveGo, rejectGo) => {
    process.once('message', (message) => {
      if (message?.type === 'go') resolveGo();
      else rejectGo(new Error('B3 store-backed native-crossing barrier is invalid'));
    });
  });
}

async function writeDurableLaunchReceipt(command) {
  const handle = await open(RECEIPT_PATH, 'wx', 0o600);
  try {
    await handle.writeFile(Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      commandSha256: sha256(Buffer.from(canonicaliseB3ProofValue(command), 'utf8')),
    })}\n`, 'utf8'));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function activeCommand() {
  const store = await openB3CaptureStore({ platform: 'ios' });
  try {
    return await store.readActiveCommand();
  } finally {
    await store.close();
  }
}

async function seed(initialState = 'prepared') {
  const store = await openB3CaptureStore({ platform: 'ios' });
  try {
    let active = await store.readActiveCommand();
    if (active.kind === 'none') {
      const command = deriveB3NextStoreCommand({
        platform: 'ios',
        buildAuthority: buildAuthority(),
        capture: null,
        uuidFactory: () => CAPTURE_ID,
      });
      await store.startCapture({ command });
      active = await store.readActiveCommand();
    }
    if (active.kind !== 'active') throw new Error('B3 seed did not retain an active command');
    if (initialState === 'stop-intent' && active.command.state === 'prepared') {
      const transitioned = await store.transitionCommand({
        source: active.command,
        nextState: 'stop-intent',
      });
      active = { kind: 'active', command: transitioned.command };
    }
    if (active.command.state !== initialState) {
      throw new Error('B3 seed retained an unexpected command state');
    }
    return active.command;
  } finally {
    await store.close();
  }
}

async function transitionActive(nextState) {
  const store = await openB3CaptureStore({ platform: 'ios' });
  try {
    const active = await store.readActiveCommand();
    if (active.kind !== 'active') throw new Error('B3 transition helper has no active command');
    return await store.transitionCommand({ source: active.command, nextState });
  } finally {
    await store.close();
  }
}

function inertTransport() {
  return Object.freeze({
    async launch() { throw new Error('unexpected native launch'); },
    async pullObservation() { throw new Error('unexpected observation pull'); },
    async forceStop() { throw new Error('unexpected native force-stop'); },
  });
}

async function crossing(stage) {
  let launchedCommand = null;
  const controller = createB3StoreBackedLiveCapture({
    platform: 'ios',
    buildAuthority: async () => buildAuthority(),
    uuidFactory: () => CAPTURE_ID,
    transport: {
      async launch(command) {
        launchedCommand = command;
        if (stage === 'before-native-launch') {
          send({ type: 'ready', stage });
          await waitForGo();
          return;
        }
        await writeDurableLaunchReceipt(command);
        if (stage === 'after-native-receipt') {
          send({ type: 'ready', stage });
          await waitForGo();
        }
      },
      async pullObservation() {
        if (stage === 'after-launched-commit') {
          send({ type: 'ready', stage });
          await waitForGo();
        }
        if (launchedCommand === null) throw new Error('B3 crossing launch command is absent');
        return Buffer.from(canonicaliseB3ProofValue(
          await observation(launchedCommand),
        ), 'utf8');
      },
      async forceStop() { throw new Error('unexpected native force-stop'); },
    },
  });
  await controller.advance();
  send({ type: 'unexpected-return' });
}

async function verifyCrossing() {
  const retainedBefore = await activeCommand();
  if (retainedBefore.kind !== 'active') {
    throw new Error('B3 crossing verification has no active command');
  }
  const databaseBefore = sha256(await readFile(databasePath()));
  let launches = 0;
  let pulls = 0;
  const controller = createB3StoreBackedLiveCapture({
    platform: 'ios',
    buildAuthority: async () => buildAuthority(),
    transport: {
      async launch() { launches += 1; },
      async pullObservation() {
        pulls += 1;
        return Buffer.from(canonicaliseB3ProofValue(
          await observation(retainedBefore.command.command),
        ), 'utf8');
      },
      async forceStop() { throw new Error('unexpected native force-stop'); },
    },
  });
  const invocation = await controller.pinInvocation();
  const finalisation = await controller.finaliseInvocation({
    invocation,
    distribution: platformEvidence().distribution,
  });
  const databaseAfterFinalisation = sha256(await readFile(databasePath()));
  let advancedObservationSha256 = null;
  if (['launching', 'reinstall-launching', 'launched']
    .includes(retainedBefore.command.state)) {
    advancedObservationSha256 = (await controller.advance()).observationSha256;
  }
  await controller.dispose();
  const retainedAfter = await activeCommand();
  send({
    type: 'result',
    stateBefore: retainedBefore.command.state,
    finalisation,
    databaseUnchangedByFinalisation: databaseBefore === databaseAfterFinalisation,
    launches,
    pulls,
    advancedObservationSha256,
    activeKindAfter: retainedAfter.kind,
    stateAfter: retainedAfter.kind === 'active' ? retainedAfter.command.state : null,
  });
}

async function stalePin(kind, nextState) {
  const initialState = nextState === 'stop-executing' ? 'stop-intent' : 'prepared';
  await seed(initialState);
  const controller = createB3StoreBackedLiveCapture({
    platform: 'ios',
    buildAuthority: async () => buildAuthority(),
    transport: inertTransport(),
  });
  const invocation = await controller.pinInvocation();
  if (kind === 'stale-pin-same') await transitionActive(nextState);
  else {
    send({ type: 'ready', state: initialState });
    await waitForGo();
  }
  const before = sha256(await readFile(databasePath()));
  const finalisation = await controller.finaliseInvocation({
    invocation,
    distribution: platformEvidence().distribution,
  });
  const after = sha256(await readFile(databasePath()));
  await controller.dispose();
  send({
    type: 'result',
    finalisation,
    databaseUnchangedByFinalisation: before === after,
    state: (await activeCommand()).command.state,
  });
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function snapshotScalar(value) {
  if (value instanceof Uint8Array) {
    return Object.freeze({ blobBase64: Buffer.from(value).toString('base64') });
  }
  if (typeof value === 'bigint') return Object.freeze({ integer: value.toString(10) });
  return value;
}

function relationalSnapshot(platform) {
  const database = new DatabaseSync(databasePath(platform), { readOnly: true });
  try {
    const tables = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map(({ name }) => name);
    return canonicaliseB3ProofValue(tables.map((table) => {
      const identifier = quoteIdentifier(table);
      const columns = database.prepare(`PRAGMA table_info(${identifier})`).all()
        .map(({ name }) => name);
      const order = columns.map(quoteIdentifier).join(', ');
      const rows = database.prepare(
        `SELECT * FROM ${identifier}${order.length > 0 ? ` ORDER BY ${order}` : ''}`,
      ).all().map((row) => Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key, snapshotScalar(value)]),
      ));
      return Object.freeze({ table, rows: Object.freeze(rows) });
    }));
  } finally {
    database.close();
  }
}

async function namespaceEntries(directory, relative = '') {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const snapshot = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const name = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      snapshot.push(Object.freeze({ name, kind: 'directory' }));
      snapshot.push(...await namespaceEntries(path, name));
    } else if (entry.isFile()) {
      const bytes = await readFile(path);
      snapshot.push(Object.freeze({
        name,
        kind: 'file',
        size: bytes.length,
        sha256: sha256(bytes),
      }));
    } else {
      snapshot.push(Object.freeze({ name, kind: 'non-regular' }));
    }
  }
  return snapshot;
}

async function legacyNamespaceSnapshot(platform) {
  const evidence = resolve('.native-build', 'b3', 'evidence');
  const entries = await namespaceEntries(evidence);
  const statePrefix = `${platform}-capture-state`;
  return canonicaliseB3ProofValue(entries.filter(({ name }) =>
    name !== statePrefix && !name.startsWith(`${statePrefix}/`)));
}

async function seedMatrixState(platform, state) {
  const store = await openB3CaptureStore({ platform });
  try {
    if (state === 'none') {
      const active = await store.readActiveCommand();
      if (active.kind !== 'none') throw new Error('B3 finaliser matrix expected no command');
      return null;
    }
    const command = deriveB3NextStoreCommand({
      platform,
      buildAuthority: buildAuthority(platform),
      capture: null,
      uuidFactory: () => CAPTURE_ID,
    });
    await store.startCapture({ command });
    let active = await store.readActiveCommand();
    if (active.kind !== 'active') {
      throw new Error('B3 finaliser matrix did not retain its prepared command');
    }
    const transitions = MATRIX_TRANSITIONS[state];
    if (!transitions) throw new Error('B3 finaliser matrix state is invalid');
    for (const nextState of transitions) {
      const transitioned = await store.transitionCommand({
        source: active.command,
        nextState,
      });
      active = Object.freeze({ kind: 'active', command: transitioned.command });
    }
    const expectedCommittedState = state.startsWith('restart-') &&
      state !== 'restart-required' ? 'restart-required' : state;
    if (active.command.state !== expectedCommittedState) {
      throw new Error('B3 finaliser matrix retained an unexpected committed state');
    }
    return active.command;
  } finally {
    await store.close();
  }
}

function projectRecoveryState(source, platform, state) {
  const record = createB3IssuedCommandStateAuthority({
    platform,
    command: source.command,
    state,
  });
  return Object.freeze({
    ...source,
    schemaVersion: record.schemaVersion,
    platform: record.platform,
    command: record.command,
    commandSha256: record.commandSha256,
    state: record.state,
    recordSha256: record.recordSha256,
  });
}

function recoveryProjectionFacade(store, projected) {
  return Object.freeze({
    startCapture: (...args) => store.startCapture(...args),
    readActiveCommand: async (...args) => {
      if (args.length !== 0) throw new Error('B3 recovery projection read is invalid');
      return Object.freeze({ kind: 'active', command: projected });
    },
    allocateNextCommand: (...args) => store.allocateNextCommand(...args),
    transitionCommand: (...args) => store.transitionCommand(...args),
    publishObservation: (...args) => store.publishObservation(...args),
    consumeCommand: (...args) => store.consumeCommand(...args),
    readCapture: (...args) => store.readCapture(...args),
    close: (...args) => store.close(...args),
  });
}

async function finaliserMatrix(platform, state) {
  if (!['ios', 'android'].includes(platform)) {
    throw new Error('B3 finaliser matrix platform is invalid');
  }
  const committed = await seedMatrixState(platform, state);
  const recoveryOnly = ['restart-executing', 'restart-complete'].includes(state);
  let authoritySource = 'repository-committed';
  let storeFactory;
  if (recoveryOnly) {
    // D4 owns relational recovery decisions. D3 deliberately keeps rejecting those
    // rows, so exercise the production finaliser through its public store seam while
    // retaining a real, validated restart-required SQLite repository underneath.
    const store = await openB3CaptureStore({ platform });
    const active = await store.readActiveCommand();
    if (active.kind !== 'active' || active.command.state !== 'restart-required' ||
        active.command.recordSha256 !== committed.recordSha256) {
      await store.close();
      throw new Error('B3 finaliser matrix recovery base differs');
    }
    const projected = projectRecoveryState(active.command, platform, state);
    const facade = recoveryProjectionFacade(store, projected);
    storeFactory = async () => facade;
    authoritySource = 'd4-recovery-projection-over-committed-restart-required';
  }
  const controller = createB3StoreBackedLiveCapture({
    platform,
    buildAuthority: async () => buildAuthority(platform),
    transport: inertTransport(),
    ...(storeFactory ? { storeFactory } : {}),
  });
  const beforeBytes = await readFile(databasePath(platform));
  const beforeRelational = relationalSnapshot(platform);
  const beforeLegacy = await legacyNamespaceSnapshot(platform);
  const invocation = await controller.pinInvocation();
  const finalisation = await controller.finaliseInvocation({
    invocation,
    distribution: platformEvidence(
      platform === 'ios' ? 'ios-physical' : 'android-play-physical',
    ).distribution,
  });
  await controller.dispose();
  const afterBytes = await readFile(databasePath(platform));
  const afterRelational = relationalSnapshot(platform);
  const afterLegacy = await legacyNamespaceSnapshot(platform);
  send({
    type: 'result',
    platform,
    state,
    authoritySource,
    finalisation,
    databaseBytesUnchanged: beforeBytes.equals(afterBytes),
    relationalSnapshotUnchanged: beforeRelational === afterRelational,
    legacyNamespaceUnchanged: beforeLegacy === afterLegacy,
  });
}

if (mode === 'crossing') await crossing(targetState);
else if (mode === 'verify-crossing') await verifyCrossing();
else if (mode === 'seed') {
  const state = await seed(targetState);
  send({ type: 'result', state: state.state });
} else if (mode === 'transition') {
  const result = await transitionActive(targetState);
  send({ type: 'result', state: result.command.state });
} else if (mode === 'stale-pin-same' || mode === 'stale-pin-wait') {
  await stalePin(mode, targetState);
} else if (mode === 'finaliser-matrix') {
  await finaliserMatrix(matrixPlatform, targetState);
} else throw new Error('B3 store-backed native-crossing helper mode is invalid');
