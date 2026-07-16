import {
  clearB3IssuedCommand,
  persistB3IssuedCommand,
  readB3IssuedCommand,
  transitionB3IssuedCommand,
} from '../../scripts/lib/b3-issued-command.mjs';
import { advanceB3HostCaptureOne } from '../../scripts/lib/b3-live-capture-adapters.mjs';

function decodeInput() {
  const encoded = process.env.B3_ISSUED_COMMAND_RACE_CHILD_INPUT;
  if (typeof encoded !== 'string' || encoded.length === 0 || typeof process.send !== 'function') {
    throw new Error('B3 issued-command race child input or IPC channel is absent');
  }
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
}

function waitForControl(type) {
  return new Promise((resolve) => {
    process.once('message', (message) => {
      if (message?.type !== type) throw new Error('B3 issued-command race barrier is invalid');
      resolve();
    });
  });
}

function result(error = null, extra = {}) {
  process.send({
    type: 'result',
    error: error === null ? null : {
      code: error?.code ?? null,
      message: error?.message ?? '',
    },
    ...extra,
  });
}

const input = decodeInput();
process.send({ type: 'ready' });
await waitForControl('go');

if (input.operation === 'advance-first') {
  let launches = 0;
  let launchedCaptureId = null;
  try {
    await advanceB3HostCaptureOne({
      root: input.root,
      platform: 'ios',
      buildAuthority: input.buildAuthority,
      maximumPullAttempts: 1,
      uuidFactory: () => input.captureId,
      transport: {
        async launch(command) {
          launches += 1;
          launchedCaptureId = command.captureId;
        },
        async pullObservation() {
          throw Object.assign(new Error('observation pull did not produce bytes'), {
            code: 'b3_physical_device_command_failed',
          });
        },
      },
    });
    result(null, { launches, launchedCaptureId });
  } catch (error) {
    result(error, { launches, launchedCaptureId });
  }
} else if (input.operation === 'read-loop') {
  const errors = [];
  const observedChallenges = new Set();
  let finalObserved = false;
  let reads = 0;
  const readCurrent = async () => {
    reads += 1;
    try {
      const retained = await readB3IssuedCommand({ root: input.root, platform: 'ios' });
      observedChallenges.add(retained.command.challengeSha256);
      if (retained.command.challengeSha256 === input.finalChallengeSha256 &&
          retained.state === 'launching') {
        finalObserved = true;
      }
      return retained;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        errors.push({ code: error?.code ?? null, message: error?.message ?? '' });
      }
      return null;
    }
  };
  await readCurrent();
  process.send({ type: 'active' });
  await waitForControl('continue');
  const successor = await readCurrent();
  process.send({
    type: 'successor-seen',
    challengeSha256: successor?.command.challengeSha256 ?? null,
    state: successor?.state ?? null,
  });
  await waitForControl('race');
  for (let iteration = 0; iteration < input.iterations; iteration += 1) {
    if (iteration % 16 === 0) {
      process.send({ type: 'progress', iteration, stage: 'before-read' });
    }
    await readCurrent();
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
  }
  process.send({ type: 'race-complete' });
  await waitForControl('final-check');
  await readCurrent();
  process.send({ type: 'progress', iteration: reads, stage: 'complete' });
  result(null, {
    errors,
    finalObserved,
    observedChallenges: [...observedChallenges],
    reads,
  });
} else if (input.operation === 'consume-chain') {
  try {
    let current = input.commands[0];
    for (const [index, next] of input.commands.slice(1).entries()) {
      process.send({ type: 'progress', index, stage: 'before-clear' });
      await clearB3IssuedCommand({ root: input.root, platform: 'ios', command: current });
      process.send({ type: 'progress', index, stage: 'before-persist' });
      const issued = await persistB3IssuedCommand({
        root: input.root,
        platform: 'ios',
        command: next,
      });
      if (index === 0) {
        process.send({ type: 'active' });
        await waitForControl('continue');
      }
      process.send({ type: 'progress', index, stage: 'before-transition' });
      await transitionB3IssuedCommand({
        root: input.root,
        platform: 'ios',
        command: issued.command,
        expectedState: 'prepared',
        nextState: 'launching',
      });
      current = issued.command;
      process.send({ type: 'progress', index, stage: 'complete' });
    }
    result(null, { finalCommand: current });
  } catch (error) {
    result(error);
  }
} else {
  result(new Error('B3 issued-command race operation is invalid'));
}
