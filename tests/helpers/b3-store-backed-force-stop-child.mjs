import { installB3CaptureStateRootMock } from './b3-capture-state-install-root-mock.mjs';

installB3CaptureStateRootMock();

const { createB3StoreBackedLiveCapture, deriveB3NextStoreCommand } = await import(
  '../../scripts/lib/b3-store-backed-live-capture.mjs'
);
const { openB3CaptureStore } = await import('../../scripts/lib/b3-capture-store.mjs');
const { buildB3PhysicalProofAuthority } = await import(
  '../../scripts/lib/b3-capture-proof-domain.mjs'
);
const { createB3PhysicalDeviceTransport } = await import(
  '../../scripts/lib/b3-physical-device-transport.mjs'
);
const {
  B3_TEST_COMMIT,
  B3_TEST_HASH,
  platformEvidence,
} = await import('./b3-evidence-fixtures.mjs');

const mode = process.argv[2];
const stage = process.argv[3];
const INITIAL_CAPTURE_ID = '018f1d7b-97e8-4a52-8cf2-783e5089ca01';
const RECOVERY_CAPTURE_ID = '018f1d7b-97e8-4a52-8cf2-783e5089ca02';

function send(message) {
  if (typeof process.send !== 'function') {
    throw new Error('B3 force-stop boundary IPC channel is absent');
  }
  process.send(message);
}

function waitForGo() {
  return new Promise((resolveGo, rejectGo) => {
    process.once('message', (message) => {
      if (message?.type === 'go') resolveGo();
      else rejectGo(new Error('B3 force-stop boundary barrier is invalid'));
    });
  });
}

function buildAuthority() {
  return buildB3PhysicalProofAuthority('android', {
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

async function seedStopExecuting() {
  const store = await openB3CaptureStore({ platform: 'android' });
  try {
    let active = await store.readActiveCommand();
    if (active.kind === 'none') {
      const command = deriveB3NextStoreCommand({
        platform: 'android',
        buildAuthority: buildAuthority(),
        capture: null,
        uuidFactory: () => INITIAL_CAPTURE_ID,
      });
      await store.startCapture({ command });
      active = await store.readActiveCommand();
    }
    if (active.kind !== 'active') {
      throw new Error('B3 force-stop boundary seed has no active command');
    }
    let source = active.command;
    if (source.state === 'prepared') {
      source = (await store.transitionCommand({
        source,
        nextState: 'stop-intent',
      })).command;
    }
    if (source.state === 'stop-intent') {
      source = (await store.transitionCommand({
        source,
        nextState: 'stop-executing',
      })).command;
    }
    if (source.state !== 'stop-executing') {
      throw new Error('B3 force-stop boundary seed retained an unexpected state');
    }
    return Object.freeze({ store, source });
  } catch (error) {
    await store.close();
    throw error;
  }
}

async function crossing(targetStage) {
  if (!['before-receipt', 'after-receipt'].includes(targetStage)) {
    throw new Error('B3 force-stop boundary stage is invalid');
  }
  const { store, source } = await seedStopExecuting();
  const transport = createB3PhysicalDeviceTransport({
    root: process.cwd(),
    platform: 'android',
    env: { B3_ANDROID_PHYSICAL_DEVICE_ID: 'R5CT1234ABC' },
    runner: async (executable, args) => {
      if (executable !== 'adb' || args.join(' ') !==
          '-s R5CT1234ABC shell am force-stop uk.eugnel.ks2spelling') {
        throw new Error('B3 force-stop boundary used an unexpected native command');
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });
  await transport.forceStop({
    command: source.command,
    retainReceipt: async (receipt) => {
      if (receipt.deviceIdentifier !== 'R5CT1234ABC' ||
          receipt.bundleIdentifier !== 'uk.eugnel.ks2spelling') {
        throw new Error('B3 force-stop boundary receipt differs');
      }
      if (targetStage === 'before-receipt') {
        send({ type: 'ready', stage: targetStage });
        await waitForGo();
      }
      const active = await store.readActiveCommand();
      if (active.kind !== 'active' || active.command.state !== 'stop-executing' ||
          active.command.recordSha256 !== source.recordSha256) {
        throw new Error('B3 force-stop boundary receipt source differs');
      }
      const retained = await store.transitionCommand({
        source: active.command,
        nextState: 'host-stopped',
      });
      if (retained.command.state !== 'host-stopped') {
        throw new Error('B3 force-stop boundary receipt did not persist');
      }
      if (targetStage === 'after-receipt') {
        send({ type: 'ready', stage: targetStage });
        await waitForGo();
      }
    },
  });
  await store.close();
  send({ type: 'unexpected-return' });
}

async function inspect() {
  const store = await openB3CaptureStore({ platform: 'android' });
  try {
    const active = await store.readActiveCommand();
    send({
      type: 'result',
      activeKind: active.kind,
      state: active.kind === 'active' ? active.command.state : null,
    });
  } finally {
    await store.close();
  }
}

async function recoverStopExecuting() {
  const store = await openB3CaptureStore({ platform: 'android' });
  try {
    const active = await store.readActiveCommand();
    if (active.kind !== 'active' || active.command.state !== 'stop-executing') {
      throw new Error('B3 force-stop recovery requires the retained stop-executing source');
    }
    const gated = await store.transitionCommand({
      source: active.command,
      nextState: 'restart-required',
    });
    if (gated.command.state !== 'restart-required') {
      throw new Error('B3 force-stop recovery did not retain the restart gate');
    }
  } finally {
    await store.close();
  }

  const controller = createB3StoreBackedLiveCapture({
    platform: 'android',
    buildAuthority: async () => buildAuthority(),
    uuidFactory: () => RECOVERY_CAPTURE_ID,
    transport: inertTransport(),
  });
  try {
    const requiredInvocation = await controller.pinInvocation();
    const required = await controller.finaliseInvocation({
      invocation: requiredInvocation,
      distribution: platformEvidence('android-play-physical').distribution,
    });
    const acknowledgedInvocation = await controller.pinInvocation({
      acknowledgeReinstall: true,
    });
    const recovered = await controller.finaliseInvocation({
      invocation: acknowledgedInvocation,
      distribution: platformEvidence('android-play-physical').distribution,
    });
    const retained = await openB3CaptureStore({ platform: 'android' });
    try {
      const active = await retained.readActiveCommand();
      send({
        type: 'result',
        required,
        recovered,
        activeKind: active.kind,
        state: active.kind === 'active' ? active.command.state : null,
        captureId: active.kind === 'active' ? active.command.captureId : null,
      });
    } finally {
      await retained.close();
    }
  } finally {
    await controller.dispose();
  }
}

if (mode === 'crossing') await crossing(stage);
else if (mode === 'inspect') await inspect();
else if (mode === 'recover') await recoverStopExecuting();
else throw new Error('B3 force-stop boundary mode is invalid');
