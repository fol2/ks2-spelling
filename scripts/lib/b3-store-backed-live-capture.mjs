import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  canonicaliseB3ProofValue,
  validateB3ProofLaunchCommand,
  validateB3ProofObservationBytes,
} from '../../src/app/b3-live-proof-protocol.js';
import { openB3CaptureStore } from './b3-capture-store.mjs';
import { validateB3DistributionProjection } from './b3-evidence.mjs';
import {
  B3_PHYSICAL_DEVICE_PROCESS_TERMINATION_GRACE_MS,
} from './b3-physical-device-transport.mjs';

const PLATFORM = Object.freeze({
  ios: 'ios-physical',
  android: 'android-play-physical',
});
const MAXIMUM_SELECTED_ORDINARY_EDGES = 12;
const MAXIMUM_PULL_ATTEMPTS = 120;
const AMBIGUOUS_LAUNCH_STATES = new Set(['launching', 'reinstall-launching']);
const GENERIC_CONSUMPTION_STATES = new Set([
  'prepared',
  'stop-intent',
  'stop-executing',
  'host-stopped',
  'launching',
  'reinstall-authorised',
  'reinstall-launching',
  'launched',
]);
const ORDINARY_TRANSITIONS = new Set([
  'prepared:launching',
  'prepared:stop-intent',
  'stop-intent:stop-executing',
  'stop-executing:host-stopped',
  'host-stopped:launching',
  'launching:launched',
  'launching:reinstall-authorised',
  'launching:restart-required',
  'reinstall-authorised:reinstall-launching',
  'reinstall-launching:launched',
  'reinstall-launching:restart-required',
  'restart-required:launched',
]);
const RECOVERY_STATUSES = new Set([
  'not-applicable',
  'operator-required',
  'recovered',
  'already-recovered',
  'rejected',
]);
const ACKNOWLEDGED_RECOVERY_STATUSES = new Set(['recovered', 'already-recovered']);

function controllerError(message, code = 'b3_live_capture_invalid') {
  return Object.assign(new Error(message), { code });
}

function platformName(platform) {
  if (!Object.hasOwn(PLATFORM, platform)) {
    throw controllerError('B3 store-backed live-capture platform is invalid');
  }
  return platform;
}

function exactRecord(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    isDeepStrictEqual(Reflect.ownKeys(value).sort(), [...keys].sort());
}

function deriveChallenge(commandWithoutChallenge) {
  return createHash('sha256').update(Buffer.from(
    `ks2-spelling:b3-host-command-challenge:v1\0${canonicaliseB3ProofValue(commandWithoutChallenge)}`,
    'utf8',
  )).digest('hex');
}

function assertBuildAuthority(value, platform) {
  if (!value || typeof value !== 'object' || value.platform !== platform ||
      typeof value.testedApplicationCommit !== 'string' ||
      typeof value.applicationFingerprint !== 'string') {
    throw controllerError('B3 store-backed build authority is invalid');
  }
  return value;
}

function captureTail(capture, platform) {
  if (capture === null) return Object.freeze({ captureId: null, checkpoint: null, tail: null });
  if (!exactRecord(capture, [
    'schemaVersion', 'platform', 'captureId', 'records', 'checkpoint',
    'gatewaySmokeProjection',
  ]) || capture.schemaVersion !== 1 || capture.platform !== platform ||
      typeof capture.captureId !== 'string' || !Array.isArray(capture.records)) {
    throw controllerError('B3 committed capture projection is invalid');
  }
  const record = capture.records.at(-1) ?? null;
  const tail = record?.observation ?? null;
  if (record !== null && (!record.command || !tail ||
      tail.captureId !== capture.captureId ||
      record.command.captureId !== capture.captureId)) {
    throw controllerError('B3 committed capture tail is invalid');
  }
  return Object.freeze({
    captureId: capture.captureId,
    checkpoint: capture.checkpoint,
    tail,
  });
}

export function deriveB3NextStoreCommand({
  platform: rawPlatform,
  buildAuthority: rawBuildAuthority,
  capture,
  uuidFactory,
} = {}) {
  const platform = platformName(rawPlatform);
  const buildAuthority = assertBuildAuthority(rawBuildAuthority, platform);
  if (typeof uuidFactory !== 'function') {
    throw controllerError('B3 store-backed command UUID factory is invalid');
  }
  const { captureId, checkpoint, tail } = captureTail(capture, platform);
  const requestedActionCode = tail?.nextActionCode ?? 'ARM_CAPTURE';
  const androidDecisionBridge = platform === 'android'
    ? Object.freeze({
        DECLINE_PENDING_PURCHASE: 'ARM_CAPTURE',
        APPROVE_PENDING_PURCHASE: 'ARM_GATEWAY_COMPLETION_HOLD',
      })[requestedActionCode]
    : undefined;
  const actionCode = androidDecisionBridge ?? requestedActionCode;
  let expectedScenarioIndex;
  if (!tail) expectedScenarioIndex = 0;
  else if (androidDecisionBridge) expectedScenarioIndex = tail.scenarioIndex + 1;
  else if (actionCode === 'ARM_CAPTURE') expectedScenarioIndex = checkpoint?.nextScenarioIndex;
  else if (actionCode === 'CAPTURE_TERMINAL' || actionCode === 'COMPLETE_CAPTURE') {
    expectedScenarioIndex = 8;
  } else if (actionCode === 'RELAUNCH' &&
      checkpoint?.nextScenarioIndex > tail.scenarioIndex) {
    expectedScenarioIndex = checkpoint.nextScenarioIndex;
  } else expectedScenarioIndex = tail.scenarioIndex;
  if (!Number.isSafeInteger(expectedScenarioIndex) || expectedScenarioIndex < 0 ||
      expectedScenarioIndex > 8) {
    throw controllerError('B3 next store-backed command scenario is outside its authority');
  }
  const commandWithoutChallenge = {
    schemaVersion: 1,
    captureId: captureId ?? uuidFactory(),
    platform: PLATFORM[platform],
    testedApplicationCommit: buildAuthority.testedApplicationCommit,
    applicationFingerprint: buildAuthority.applicationFingerprint,
    expectedScenarioIndex,
    expectedSequence: (tail?.sequence ?? 0) + 1,
    previousObservationSha256: tail?.observationSha256 ?? '0'.repeat(64),
    installationMode: actionCode === 'REBIND_FRESH_INSTALL'
      ? 'fresh-reinstall'
      : 'existing',
    actionCode,
  };
  return validateB3ProofLaunchCommand({
    ...commandWithoutChallenge,
    challengeSha256: deriveChallenge(commandWithoutChallenge),
  });
}

function sameCommand(left, right) {
  return left?.commandSha256 === right?.commandSha256 &&
    left?.captureId === right?.captureId && left?.platform === right?.platform &&
    left?.allocationSequence === right?.allocationSequence &&
    left?.predecessorCommandSha256 === right?.predecessorCommandSha256 &&
    isDeepStrictEqual(left?.command, right?.command);
}

function reachableOrdinaryState(sourceState, targetState) {
  if (sourceState === targetState) return true;
  const visited = new Set([sourceState]);
  const pending = [sourceState];
  while (pending.length > 0) {
    const source = pending.shift();
    for (const edge of ORDINARY_TRANSITIONS) {
      const [from, to] = edge.split(':');
      if (from !== source || visited.has(to)) continue;
      if (to === targetState) return true;
      visited.add(to);
      pending.push(to);
    }
  }
  return false;
}

function sameOrLegalSuccessor(left, right) {
  return sameCommand(left, right) &&
    reachableOrdinaryState(left.state, right.state);
}

function stalePublicationSource(error) {
  return error?.code === 'b3_capture_state_invalid' &&
    /(?:publication source is not retained|missing publication is not the active tail)/u
      .test(error.message ?? '');
}

function staleObservation(bytes, command) {
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return false;
  }
  return Number.isSafeInteger(value?.sequence) && value.sequence <= command.expectedSequence &&
    value?.proofProjection?.challengeSha256 !== command.challengeSha256;
}

function remainingCaptureDeadline(deadlineMs, monotonicClock) {
  if (deadlineMs === undefined) return null;
  const now = monotonicClock();
  if (!Number.isFinite(deadlineMs) || !Number.isFinite(now) || now < 0 || now >= deadlineMs) {
    throw controllerError(
      'B3 slow-card polling exceeded ten minutes',
      'b3_slow_card_poll_timeout',
    );
  }
  return deadlineMs - now;
}

function boundedOperationTimeout(deadlineMs, monotonicClock, maximumMs = 30_000) {
  const remaining = remainingCaptureDeadline(deadlineMs, monotonicClock);
  if (remaining === null) return undefined;
  const timeoutMs = Math.min(
    maximumMs,
    Math.floor(remaining - B3_PHYSICAL_DEVICE_PROCESS_TERMINATION_GRACE_MS),
  );
  if (timeoutMs < 1) {
    throw controllerError(
      'B3 slow-card polling exceeded ten minutes',
      'b3_slow_card_poll_timeout',
    );
  }
  return timeoutMs;
}

function operatorRequired(instructionCode) {
  return Object.assign(
    new Error('Reinstall the exact approved B3 distribution, then resume capture.'),
    { code: 'b3_operator_action_required', instructionCode },
  );
}

export function createB3StoreBackedLiveCapture({
  platform: rawPlatform,
  buildAuthority,
  transport,
  wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
  uuidFactory = randomUUID,
  storeFactory = openB3CaptureStore,
  consumeReinstallAcknowledgement = () => {},
} = {}) {
  const platform = platformName(rawPlatform);
  if (typeof buildAuthority !== 'function' || typeof storeFactory !== 'function' ||
      typeof uuidFactory !== 'function' || typeof wait !== 'function' ||
      typeof consumeReinstallAcknowledgement !== 'function' ||
      typeof transport?.launch !== 'function' ||
      typeof transport?.pullObservation !== 'function' ||
      typeof transport?.forceStop !== 'function') {
    throw controllerError('B3 store-backed live-capture options are invalid');
  }
  let storePromise = null;
  let disposed = false;
  let disposalPromise = null;
  const pins = new WeakMap();

  function store() {
    if (disposed) throw controllerError('B3 store-backed live-capture is disposed');
    storePromise ??= Promise.resolve(storeFactory({ platform })).then((value) => {
      const methods = [
        'startCapture', 'readActiveCommand', 'allocateNextCommand', 'transitionCommand',
        'publishObservation', 'consumeCommand', 'readCapture',
        'pinRecoveryInvocation', 'finaliseRecoveryInvocation', 'close',
      ];
      if (!value || methods.some((name) => typeof value[name] !== 'function')) {
        throw controllerError('B3 capture-store facade is incomplete');
      }
      return value;
    });
    return storePromise;
  }

  async function readCaptureOrNull() {
    const handle = await store();
    try {
      return await handle.readCapture();
    } catch (error) {
      if (error?.code === 'b3_capture_state_invalid' &&
          error.message === 'B3 capture-state has no readable working capture') return null;
      throw error;
    }
  }

  async function currentCommand() {
    const handle = await store();
    let retained = await handle.readActiveCommand();
    if (retained.kind === 'active') return retained.command;
    if (retained.kind === 'start-reserved') {
      await handle.startCapture({ command: retained.intent.firstCommand });
      retained = await handle.readActiveCommand();
      if (retained.kind !== 'active') {
        throw controllerError('B3 reserved capture start did not retain an active command');
      }
      return retained.command;
    }
    if (retained.kind === 'recovery-pending') {
      throw controllerError('B3 capture recovery is pending finalisation');
    }
    if (retained.kind !== 'none') {
      throw controllerError('B3 active-command projection is invalid');
    }
    const capture = await readCaptureOrNull();
    const authority = assertBuildAuthority(await buildAuthority(), platform);
    const command = deriveB3NextStoreCommand({
      platform,
      buildAuthority: authority,
      capture,
      uuidFactory,
    });
    if (capture === null) await handle.startCapture({ command });
    else await handle.allocateNextCommand({ command });
    retained = await handle.readActiveCommand();
    if (retained.kind === 'start-reserved') {
      await handle.startCapture({ command: retained.intent.firstCommand });
      retained = await handle.readActiveCommand();
    }
    if (retained.kind !== 'active') {
      throw controllerError('B3 command allocation did not retain an active command');
    }
    return retained.command;
  }

  async function transition(source, nextState) {
    const outcome = await (await store()).transitionCommand({ source, nextState });
    if (['transitioned', 'already-transitioned', 'ordinary-conflict'].includes(outcome.kind)) {
      return Object.freeze({
        command: outcome.command,
        ownsSideEffect: outcome.kind === 'transitioned',
      });
    }
    throw controllerError('B3 store-backed command was consumed during transition');
  }

  async function consume(source) {
    let current = source;
    for (let edge = 0; edge <= MAXIMUM_SELECTED_ORDINARY_EDGES; edge += 1) {
      if (!GENERIC_CONSUMPTION_STATES.has(current.state)) {
        const retained = await (await store()).readActiveCommand();
        if (retained.kind !== 'active' ||
            !sameOrLegalSuccessor(current, retained.command) ||
            retained.command.state === current.state) {
          throw controllerError('B3 store-backed consumption source is not generically closable');
        }
        current = retained.command;
        continue;
      }
      const outcome = await (await store()).consumeCommand({ source: current });
      if (outcome.kind === 'consumed' || outcome.kind === 'already-consumed') return outcome;
      if (outcome.kind !== 'ordinary-selected' ||
          !sameOrLegalSuccessor(current, outcome.command)) {
        throw controllerError('B3 store-backed consumption winner is invalid');
      }
      current = outcome.command;
    }
    throw controllerError('B3 store-backed consumption exceeded its ordinary edge bound');
  }

  function retainedObservation(capture, source) {
    const record = capture?.records?.[source.command.expectedSequence - 1];
    if (!record) return null;
    if (!isDeepStrictEqual(record.command, source.command) ||
        record.observation?.sequence !== source.command.expectedSequence) {
      throw controllerError('B3 committed observation differs from its active command');
    }
    return record.observation;
  }

  async function publishWithSuccessorAdoption(source, bytes) {
    let current = source;
    for (let edge = 0; edge <= MAXIMUM_SELECTED_ORDINARY_EDGES; edge += 1) {
      try {
        const publication = await (await store()).publishObservation({
          source: current,
          observationBytes: bytes,
        });
        if (!['published', 'already-published'].includes(publication.kind)) {
          throw controllerError('B3 store-backed observation publication conflicts');
        }
        return Object.freeze({ source: current, publication });
      } catch (error) {
        if (!stalePublicationSource(error)) throw error;
        const retained = await (await store()).readActiveCommand();
        if (retained.kind !== 'active' ||
            !sameOrLegalSuccessor(current, retained.command)) throw error;
        current = retained.command;
      }
    }
    throw controllerError('B3 store-backed publication exceeded its ordinary edge bound');
  }

  async function advance({
    maximumPullAttempts = MAXIMUM_PULL_ATTEMPTS,
    deadlineMs,
    monotonicClock = () => performance.now(),
  } = {}) {
    if (!Number.isSafeInteger(maximumPullAttempts) || maximumPullAttempts < 1 ||
        maximumPullAttempts > MAXIMUM_PULL_ATTEMPTS || typeof monotonicClock !== 'function') {
      throw controllerError('B3 store-backed observation attempt authority is invalid');
    }
    let source = await currentCommand();
    let capture = await readCaptureOrNull();
    const existing = retainedObservation(capture, source);
    if (existing) {
      await consume(source);
      return existing;
    }
    let ownsLaunch = false;
    let launchingState = null;
    if (source.state === 'prepared' || source.state === 'host-stopped' ||
        source.state === 'reinstall-authorised') {
      launchingState = source.state === 'reinstall-authorised'
        ? 'reinstall-launching'
        : 'launching';
      const outcome = await transition(source, launchingState);
      source = outcome.command;
      ownsLaunch = outcome.ownsSideEffect;
    }
    if (ownsLaunch) {
      try {
        const timeoutMs = boundedOperationTimeout(deadlineMs, monotonicClock);
        await transport.launch(source.command, timeoutMs === undefined ? undefined : { timeoutMs });
        source = (await transition(source, 'launched')).command;
      } catch {
        const retained = await (await store()).readActiveCommand();
        if (retained.kind !== 'active' || !sameCommand(source, retained.command)) {
          throw controllerError('B3 launch authority changed after its native side effect');
        }
        source = retained.command;
      }
    }
    if (source.state !== 'launched' && !AMBIGUOUS_LAUNCH_STATES.has(source.state)) {
      throw controllerError('B3 store-backed command is not ready to pull');
    }
    capture = await readCaptureOrNull();
    const previousObservation = capture?.records?.[source.command.expectedSequence - 2]
      ?.observation;
    const authority = assertBuildAuthority(await buildAuthority(), platform);
    for (let attempt = 0; attempt < maximumPullAttempts; attempt += 1) {
      let bytes;
      try {
        const timeoutMs = boundedOperationTimeout(deadlineMs, monotonicClock);
        bytes = await transport.pullObservation(
          timeoutMs === undefined ? undefined : { timeoutMs },
        );
      } catch (error) {
        if (error?.code !== 'b3_physical_device_command_failed' &&
            !/observation pull did not produce/u.test(error?.message ?? '')) throw error;
        if (attempt === maximumPullAttempts - 1) break;
        await wait(Math.min(250, remainingCaptureDeadline(deadlineMs, monotonicClock) ?? 250));
        continue;
      }
      if (staleObservation(bytes, source.command)) {
        if (attempt === maximumPullAttempts - 1) break;
        await wait(Math.min(250, remainingCaptureDeadline(deadlineMs, monotonicClock) ?? 250));
        continue;
      }
      let observation;
      try {
        observation = await validateB3ProofObservationBytes(bytes, {
          command: source.command,
          buildAuthority: authority,
          ...(previousObservation ? { previousObservation } : {}),
        });
      } catch (error) {
        if (!AMBIGUOUS_LAUNCH_STATES.has(source.state)) throw error;
        if (attempt === maximumPullAttempts - 1) break;
        await wait(Math.min(250, remainingCaptureDeadline(deadlineMs, monotonicClock) ?? 250));
        continue;
      }
      if (AMBIGUOUS_LAUNCH_STATES.has(source.state)) {
        source = (await transition(source, 'launched')).command;
      }
      const committed = await publishWithSuccessorAdoption(source, Buffer.from(bytes));
      await consume(committed.source);
      return committed.publication.record.observation ?? observation;
    }
    if (AMBIGUOUS_LAUNCH_STATES.has(source.state)) {
      await transition(source, 'restart-required');
      throw operatorRequired('REINSTALL_EXACT_BUILD');
    }
    throw controllerError(
      'B3 physical device did not publish the command-bound observation before the fixed deadline',
      'b3_physical_observation_timeout',
    );
  }

  async function stopForRelaunch() {
    let source = await currentCommand();
    if (source.command.actionCode !== 'RELAUNCH') {
      throw controllerError('B3 force-stop command is not a relaunch authority');
    }
    if (source.state === 'prepared') source = (await transition(source, 'stop-intent')).command;
    let ownsStop = false;
    if (source.state === 'stop-intent') {
      const outcome = await transition(source, 'stop-executing');
      source = outcome.command;
      ownsStop = outcome.ownsSideEffect;
    }
    if (source.state === 'host-stopped') return source;
    if (source.state !== 'stop-executing' || !ownsStop) {
      throw controllerError('B3 force-stop crossing is ambiguous');
    }
    let retainedReceipt = false;
    const retainReceipt = async () => {
      if (retainedReceipt) return;
      source = (await transition(source, 'host-stopped')).command;
      retainedReceipt = true;
    };
    await transport.forceStop({ command: source.command, retainReceipt });
    await retainReceipt();
    return source;
  }

  async function readCapture() {
    return readCaptureOrNull();
  }

  async function pinInvocation({ acknowledgeReinstall } = {}) {
    if (acknowledgeReinstall !== undefined && typeof acknowledgeReinstall !== 'boolean') {
      throw controllerError('B3 capture recovery acknowledgement is invalid');
    }
    const acknowledged = acknowledgeReinstall === true;
    const storeInvocation = await (await store()).pinRecoveryInvocation({
      acknowledgeReinstall: acknowledged,
    });
    const invocation = Object.freeze(Object.create(null));
    pins.set(invocation, Object.freeze({ storeInvocation, finalised: false }));
    return invocation;
  }

  async function finaliseInvocation({ invocation, distribution } = {}) {
    const pin = pins.get(invocation);
    if (!pin || pin.finalised) {
      throw controllerError('B3 capture recovery invocation pin is invalid');
    }
    pins.set(invocation, Object.freeze({ ...pin, finalised: true }));
    const authority = assertBuildAuthority(await buildAuthority(), platform);
    let retainedDistribution;
    try {
      retainedDistribution = validateB3DistributionProjection({
        value: distribution,
        platform,
        buildAuthority: authority,
      });
    } catch {
      throw controllerError('B3 capture recovery distribution authority differs');
    }
    const freshCommand = deriveB3NextStoreCommand({
      platform,
      buildAuthority: authority,
      capture: null,
      uuidFactory,
    });
    const outcome = await (await store()).finaliseRecoveryInvocation({
      invocation: pin.storeInvocation,
      distribution: retainedDistribution,
      freshCommand,
    });
    if (!exactRecord(outcome, ['status', 'acknowledgementConsumed']) ||
        !RECOVERY_STATUSES.has(outcome.status) ||
        typeof outcome.acknowledgementConsumed !== 'boolean' ||
        (outcome.acknowledgementConsumed &&
          !ACKNOWLEDGED_RECOVERY_STATUSES.has(outcome.status))) {
      throw controllerError('B3 capture recovery outcome is invalid');
    }
    if (outcome.acknowledgementConsumed) {
      const consumed = consumeReinstallAcknowledgement();
      if (consumed !== undefined) {
        throw controllerError('B3 capture recovery acknowledgement callback is invalid');
      }
    }
    return Object.freeze({ status: outcome.status });
  }

  function dispose() {
    if (disposalPromise) return disposalPromise;
    disposed = true;
    disposalPromise = (async () => {
      if (storePromise === null) return;
      const handle = await storePromise;
      await handle.close();
    })();
    return disposalPromise;
  }

  return Object.freeze({
    readCapture,
    pinInvocation,
    finaliseInvocation,
    advance,
    stopForRelaunch,
    dispose,
  });
}
