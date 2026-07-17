import * as sqlite from 'node:sqlite';

import { installB3CaptureStateRootMock } from './b3-capture-state-install-root-mock.mjs';

installB3CaptureStateRootMock();

const mode = process.argv[2];
const targetTransaction = Number(process.argv[3] ?? 0);
const boundary = process.argv[4];
const acknowledgeReinstall = process.argv[5] === 'true';
const captureId = process.argv[6] ?? '018f1d7b-97e8-4a52-8cf2-783e5089c002';

const { createB3StoreBackedLiveCapture, deriveB3NextStoreCommand } = await import(
  '../../scripts/lib/b3-store-backed-live-capture.mjs'
);
const { openB3CaptureStore } = await import('../../scripts/lib/b3-capture-store.mjs');
const { buildB3PhysicalProofAuthority } = await import(
  '../../scripts/lib/b3-physical-observation-journal.mjs'
);
const {
  B3_TEST_COMMIT,
  B3_TEST_HASH,
  platformEvidence,
} = await import('./b3-evidence-fixtures.mjs');

function buildAuthority() {
  return buildB3PhysicalProofAuthority('ios', {
    schemaVersion: 1,
    testedApplicationCommit: B3_TEST_COMMIT,
    applicationFingerprint: B3_TEST_HASH,
    versionName: '0.3.0-b3',
    iosBuildNumber: '19',
    androidVersionCode: 19,
  });
}

function inertTransport() {
  return Object.freeze({
    async launch() { throw new Error('unexpected recovery native launch'); },
    async pullObservation() { throw new Error('unexpected recovery observation pull'); },
    async forceStop() { throw new Error('unexpected recovery native stop'); },
  });
}

async function seedRestartRequired() {
  const store = await openB3CaptureStore({ platform: 'ios' });
  try {
    const command = deriveB3NextStoreCommand({
      platform: 'ios',
      buildAuthority: buildAuthority(),
      capture: null,
      uuidFactory: () => '018f1d7b-97e8-4a52-8cf2-783e5089c001',
    });
    await store.startCapture({ command });
    let source = (await store.readActiveCommand()).command;
    source = (await store.transitionCommand({
      source,
      nextState: 'launching',
    })).command;
    source = (await store.transitionCommand({
      source,
      nextState: 'restart-required',
    })).command;
    return Object.freeze({ state: source.state });
  } finally {
    await store.close();
  }
}

function pauseAtCommit() {
  if (!Number.isSafeInteger(targetTransaction) || targetTransaction < 1 ||
      targetTransaction > 3 || !['before', 'after'].includes(boundary) ||
      typeof process.send !== 'function') {
    throw new Error('B3 recovery SQL death boundary is invalid');
  }
  const originalExec = sqlite.DatabaseSync.prototype.exec;
  let transaction = 0;
  const normalise = (sql) => String(sql).trim().replace(/\s+/gu, ' ');
  sqlite.DatabaseSync.prototype.exec = function tracedExec(sql) {
    const value = normalise(sql);
    if (value === 'BEGIN IMMEDIATE') transaction += 1;
    if (value === 'COMMIT' && transaction === targetTransaction && boundary === 'before') {
      process.send({ type: 'paused', transaction, boundary });
      process.kill(process.pid, 'SIGSTOP');
    }
    const result = Reflect.apply(originalExec, this, [sql]);
    if (value === 'COMMIT' && transaction === targetTransaction && boundary === 'after') {
      process.send({ type: 'paused', transaction, boundary });
      process.kill(process.pid, 'SIGSTOP');
    }
    return result;
  };
}

async function controllerFinalisation({ trace = false } = {}) {
  const controller = createB3StoreBackedLiveCapture({
    platform: 'ios',
    buildAuthority: async () => buildAuthority(),
    uuidFactory: () => captureId,
    transport: inertTransport(),
  });
  try {
    const readActive = async () => {
      const store = await openB3CaptureStore({ platform: 'ios' });
      try {
        return await store.readActiveCommand();
      } finally {
        await store.close();
      }
    };
    const activeBefore = await readActive();
    const invocation = await controller.pinInvocation({ acknowledgeReinstall });
    if (trace) pauseAtCommit();
    const outcome = await controller.finaliseInvocation({
      invocation,
      distribution: platformEvidence().distribution,
    });
    return Object.freeze({ activeBefore, outcome, activeAfter: await readActive() });
  } finally {
    await controller.dispose();
  }
}

if (mode === 'seed') {
  process.stdout.write(`${JSON.stringify({ ok: true, ...(await seedRestartRequired()) })}\n`);
} else if (mode === 'recover') {
  await controllerFinalisation({ trace: true });
  process.send?.({ type: 'unexpected-return' });
} else if (mode === 'resume') {
  const result = await controllerFinalisation();
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
} else {
  throw new Error('B3 recovery SQL death mode is invalid');
}
