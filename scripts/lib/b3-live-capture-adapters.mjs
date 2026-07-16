import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  parseB3StrictJsonBytes,
  readApprovedB3PlayCertificate,
} from '../check-b3-external-prerequisites.mjs';
import {
  canonicaliseB3ProofValue,
  validateB3GatewaySmokeAuthority,
  validateB3ProofLaunchCommand,
  validateB3ProofObservationBytes,
} from '../../src/app/b3-live-proof-protocol.js';
import {
  B3_ANDROID_SCENARIOS,
  B3_IOS_SCENARIOS,
  B3_SYNTHETIC_LEARNER_AUTHORITY_SHA256,
  B3_SYNTHETIC_LEARNER_DIGESTS,
} from './b3-evidence.mjs';
import {
  appendB3PhysicalObservation,
  deriveB3ProofObservationChain,
  deriveB3ScenarioTransition,
  readB3PhysicalObservationJournal,
} from './b3-physical-observation-journal.mjs';
import { createB3PhysicalDeviceTransport } from './b3-physical-device-transport.mjs';
import { captureB3IosScreenshotBytes } from './b3-ios-proof-screenshot.mjs';
import {
  captureB3PlayProtectSettingsScreenshot,
  inspectB3PlayProtectRootAttestation,
} from './b3-play-protect-attestation.mjs';
import { reconcileB3CaptureCheckpointFromJournal } from './b3-host-capture-state.mjs';
import {
  clearB3IssuedCommand,
  persistB3IssuedCommand,
  readB3IssuedCommand,
  transitionB3IssuedCommand,
} from './b3-issued-command.mjs';
import {
  archiveB3AbandonedCapture,
  readB3AbandonedCaptureArchive,
} from './b3-abandoned-capture.mjs';
import { createDefaultB3DistributionInspectors } from './b3-distribution-inspectors.mjs';
import {
  verifyB3InstalledDistributionWithInspectors,
} from '../verify-b3-installed-distribution.mjs';
import { validateB3PngBytes } from './b3-png.mjs';

export {
  assertB3CaptureResumeAuthority,
  createB3CaptureCheckpoint,
  readB3CaptureCheckpoint,
  writeB3CaptureCheckpoint,
} from './b3-device-observation.mjs';

export function extractB3DeviceGatewaySmokeProjection({ retained }) {
  if (!Array.isArray(retained) || retained.length === 0) {
    throw captureError('B3 device gateway smoke journal is empty');
  }
  const candidates = retained.filter(({ observation }) =>
    observation?.proofProjection?.gatewaySmokeAuthority !== null &&
    observation?.proofProjection?.gatewaySmokeAuthority !== undefined);
  if (candidates.length !== 1) {
    throw captureError('B3 device gateway smoke must occur exactly once');
  }
  const [{ observation }] = candidates;
  if (observation.scenario !== 'pack-install' || observation.phase !== 'SCENARIO_COMPLETE' ||
      !observation.proofProjection.gatewayCalls.some(({ operation, relation }) =>
        operation === 'authorise' && relation === 'download-capability-authorisation')) {
    throw captureError('B3 device gateway smoke is not bound to pack-install authorisation');
  }
  const authority = validateB3GatewaySmokeAuthority(
    observation.proofProjection.gatewaySmokeAuthority,
  );
  return Object.freeze({
    schemaVersion: authority.schemaVersion,
    deploymentVersionId: authority.deploymentVersionId,
    scriptAuthoritySha256: authority.scriptAuthoritySha256,
    signedEnvelopeSha256: authority.signedEnvelopeSha256,
    objects: Object.freeze(authority.objects.map((object) => Object.freeze({ ...object }))),
    capability: Object.freeze({ ...authority.accessBehaviour }),
    range: Object.freeze({ ...authority.byteServingBehaviour }),
  });
}

export async function persistB3DeviceGatewaySmokeProjection({ root, projection }) {
  if (!projection || typeof projection !== 'object' || Array.isArray(projection) ||
      Reflect.ownKeys(projection).length !== 7) {
    throw captureError('B3 device gateway smoke projection is not closed');
  }
  const authority = validateB3GatewaySmokeAuthority({
    schemaVersion: projection.schemaVersion,
    deploymentVersionId: projection.deploymentVersionId,
    scriptAuthoritySha256: projection.scriptAuthoritySha256,
    signedEnvelopeSha256: projection.signedEnvelopeSha256,
    objects: projection.objects,
    accessBehaviour: projection.capability,
    byteServingBehaviour: projection.range,
  });
  if (!isDeepStrictEqual(projection, {
    schemaVersion: authority.schemaVersion,
    deploymentVersionId: authority.deploymentVersionId,
    scriptAuthoritySha256: authority.scriptAuthoritySha256,
    signedEnvelopeSha256: authority.signedEnvelopeSha256,
    objects: authority.objects,
    capability: authority.accessBehaviour,
    range: authority.byteServingBehaviour,
  })) {
    throw captureError('B3 device gateway smoke projection differs from authority');
  }
  const canonicalRoot = await realpath(resolve(root));
  let directory = canonicalRoot;
  for (const component of ['.native-build', 'b3', 'evidence']) {
    directory = resolve(directory, component);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
        (metadata.mode & 0o077) !== 0) {
      throw captureError('B3 device gateway smoke directory policy is invalid');
    }
  }
  const path = resolve(directory, 'cloudflare-device-smoke.json');
  const bytes = Buffer.from(`${JSON.stringify(projection, null, 2)}\n`, 'utf8');
  if (/https?:\/\/|[?&](?:cap|token|handle)=|sealedRefreshHandle|capabilityUrl/iu.test(bytes.toString('utf8'))) {
    throw captureError('B3 device gateway smoke contains private authority');
  }
  const temporaryPath = resolve(
    directory,
    `.cloudflare-device-smoke.${process.pid}.${randomUUID()}.tmp`,
  );
  let created = false;
  try {
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporaryPath, path);
      created = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
  if (created) {
    const directoryHandle = await open(directory, fsConstants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  }
  const persisted = await open(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = await persisted.stat();
    const persistedBytes = await persisted.readFile();
    if (!metadata.isFile() || metadata.nlink !== 1 ||
        (metadata.mode & 0o777) !== 0o600 || !persistedBytes.equals(bytes)) {
      throw captureError('B3 device gateway smoke existing evidence conflicts');
    }
  } finally {
    await persisted.close();
  }
  return Object.freeze({ path: '.native-build/b3/evidence/cloudflare-device-smoke.json' });
}

const MAXIMUM_SCREENSHOT_BYTES = 64 * 1024 * 1024;
const MAXIMUM_DETERMINISTIC_REPORT_BYTES = 1024 * 1024;
const PLATFORM = Object.freeze({
  ios: Object.freeze({
    commandPlatform: 'ios-physical',
    signedEnvironment: 'B3_IOS_SIGNED_IPA_PATH',
    distribution: 'development',
  }),
  android: Object.freeze({
    commandPlatform: 'android-play-physical',
    signedEnvironment: 'B3_ANDROID_SIGNED_AAB_PATH',
    distribution: 'play-internal',
  }),
});

function captureError(message, code = 'b3_live_capture_invalid') {
  return Object.assign(new Error(message), { code });
}

function platformName(platform) {
  if (!Object.hasOwn(PLATFORM, platform)) {
    throw captureError('B3 live-capture platform is invalid');
  }
  return platform;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export async function inspectB3DeterministicStoreKitReport({ root }) {
  const canonicalRoot = await realpath(resolve(root));
  const path = resolve(canonicalRoot, 'reports/b3/deterministic-proof.json');
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 ||
      metadata.size <= 0 || metadata.size > MAXIMUM_DETERMINISTIC_REPORT_BYTES ||
      await realpath(path) !== path) {
    throw captureError('B3 deterministic StoreKit report file authority is invalid');
  }
  const bytes = await readFile(path);
  const report = parseB3StrictJsonBytes(bytes, 'B3 deterministic proof report');
  const block = report?.nonLiveStoreKit;
  const expectedCases = [
    { name: 'delayed-approve', initialOutcome: 'pending', finalOutcome: 'purchased' },
    { name: 'delayed-decline', initialOutcome: 'pending', finalOutcome: 'cancelled' },
  ];
  if (report?.status !== 'pass' ||
      report?.evidenceBoundary?.liveStoreProof !== false ||
      report?.evidenceBoundary?.physicalDeviceProof !== false ||
      !exactKeys(block, ['evidenceKind', 'physicalSandbox', 'liveStore', 'cases']) ||
      block.evidenceKind !== 'xcode-storekit-test-non-live' ||
      block.physicalSandbox !== false || block.liveStore !== false ||
      !isDeepStrictEqual(block.cases, expectedCases)) {
    throw captureError('B3 deterministic StoreKit authority differs from the closed transcript');
  }
  return Object.freeze({
    reportSha256: sha256(bytes),
    scenarios: Object.freeze([
      'storekit-test-pending-approve',
      'storekit-test-pending-decline',
    ]),
    liveSandbox: false,
  });
}

function validateScreenshotBytes(rawBytes) {
  try {
    return validateB3PngBytes(rawBytes, { maximumBytes: MAXIMUM_SCREENSHOT_BYTES }).bytes;
  } catch {
    throw captureError('B3 screenshot is not a bounded original-resolution PNG');
  }
}

async function ensureScreenshotDirectory(root) {
  const canonicalRoot = await realpath(resolve(root));
  let current = canonicalRoot;
  for (const component of ['reports', 'b3']) {
    current = resolve(current, component);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw captureError('B3 screenshot directory policy is invalid');
    }
  }
  const directory = await realpath(current);
  if (!directory.startsWith(`${canonicalRoot}/`)) {
    throw captureError('B3 screenshot directory escaped the repository');
  }
  return directory;
}

export async function persistB3PlatformScreenshot({ root, platform, bytes: rawBytes }) {
  const name = platformName(platform);
  const bytes = validateScreenshotBytes(rawBytes);
  const directory = await ensureScreenshotDirectory(root);
  const path = resolve(directory, `${name}-sandbox-proof.png`);
  const temporary = `${path}.${process.pid}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  const directoryHandle = await open(directory, 'r');
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
  const persistedHandle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const metadata = await persistedHandle.stat();
    const persisted = await persistedHandle.readFile();
    if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0 ||
        !persisted.equals(bytes)) {
      throw captureError('B3 screenshot persistence changed its original bytes');
    }
  } finally {
    await persistedHandle.close();
  }
  return Object.freeze({
    path: `reports/b3/${name}-sandbox-proof.png`,
    sha256: sha256(bytes),
  });
}

function staleObservation(bytes, command) {
  let value;
  try {
    value = parseB3StrictJsonBytes(bytes, 'B3 pulled physical observation');
  } catch {
    return false;
  }
  return Number.isSafeInteger(value?.sequence) && value.sequence <= command.expectedSequence &&
    value?.proofProjection?.challengeSha256 !== command.challengeSha256;
}

const CONCURRENT_ALLOCATION_CONTEXT_KEYS = Object.freeze([
  'schemaVersion', 'platform', 'testedApplicationCommit', 'applicationFingerprint',
  'expectedScenarioIndex', 'expectedSequence', 'previousObservationSha256',
  'installationMode', 'actionCode',
]);

function hasMatchingConcurrentAllocationContext(retained, requested) {
  return CONCURRENT_ALLOCATION_CONTEXT_KEYS.every((key) => retained[key] === requested[key]);
}

function isIssuedCommandConflict(error) {
  return error?.code === 'b3_issued_command_invalid' &&
    error.message === 'B3 issued command conflicts with the pending command';
}

export async function captureB3ValidatedDeviceObservation({
  root,
  platform,
  command: rawCommand,
  buildAuthority,
  transport,
  wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
  maximumPullAttempts = 120,
  afterIssue = async () => {},
  afterLaunch = async () => {},
  afterJournal = async () => {},
  beforeJournal = async () => {},
} = {}) {
  const name = platformName(platform);
  let command = validateB3ProofLaunchCommand(rawCommand);
  if (command.platform !== PLATFORM[name].commandPlatform ||
      typeof transport?.launch !== 'function' ||
      typeof transport?.pullObservation !== 'function' || typeof wait !== 'function' ||
      !Number.isSafeInteger(maximumPullAttempts) || maximumPullAttempts < 1 ||
      maximumPullAttempts > 120 ||
      typeof afterIssue !== 'function' || typeof afterLaunch !== 'function' ||
      typeof afterJournal !== 'function' || typeof beforeJournal !== 'function') {
    throw captureError('B3 validated device-observation capture options are invalid');
  }
  const retainedBeforeLaunch = await readB3PhysicalObservationJournal({
    root,
    platform: name,
    buildAuthority,
  });
  if (retainedBeforeLaunch.length >= command.expectedSequence) {
    const retained = retainedBeforeLaunch[command.expectedSequence - 1];
    if (canonicaliseB3ProofValue(retained.command) !== canonicaliseB3ProofValue(command)) {
      throw captureError('B3 retained command differs at the requested observation sequence');
    }
    await reconcileB3CaptureCheckpointFromJournal({
      root,
      platform: name,
      buildAuthority,
    });
    try {
      const issued = await readB3IssuedCommand({ root, platform: name });
      if (canonicaliseB3ProofValue(issued.command) !== canonicaliseB3ProofValue(command)) {
        throw captureError('B3 pending issued command differs from retained observation authority');
      }
      await clearB3IssuedCommand({ root, platform: name, command });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return retained.observation;
  }
  await reconcileB3CaptureCheckpointFromJournal({
    root,
    platform: name,
    buildAuthority,
  });
  // The retained command state owns side-effect authority across process death.
  // A prepared command has
  // not crossed the launch boundary and is safe to issue. A launching command is
  // deliberately ambiguous and must never be issued again without an app-side
  // durable execution guard.
  let issued = await persistB3IssuedCommand({ root, platform: name, command });
  if (canonicaliseB3ProofValue(issued.command) !== canonicaliseB3ProofValue(command)) {
    if (retainedBeforeLaunch.length !== 0 ||
        !hasMatchingConcurrentAllocationContext(issued.command, command)) {
      throw captureError('B3 concurrent issued command differs from the requested authority');
    }
    // Concurrent empty-root runners may derive different capture identifiers.
    // The immutable platform-global allocation winner is the sole launch authority.
    command = issued.command;
  }
  let ownsLaunchTransition = false;
  let activeLaunchingState = 'launching';
  if (issued.state === 'prepared') {
    await afterIssue();
    issued = await transitionB3IssuedCommand({
      root, platform: name, command, expectedState: 'prepared', nextState: 'launching',
    });
    ownsLaunchTransition = issued.transitionClaimed;
  } else if (['host-stopped', 'reinstall-authorised'].includes(issued.state)) {
    const expectedState = issued.state;
    const nextState = expectedState === 'reinstall-authorised'
      ? 'reinstall-launching'
      : 'launching';
    issued = await transitionB3IssuedCommand({
      root, platform: name, command, expectedState, nextState,
    });
    activeLaunchingState = nextState;
    ownsLaunchTransition = issued.transitionClaimed;
  }
  if (['restart-executing', 'restart-complete'].includes(issued.state)) {
    throw captureError('B3 ambiguous capture restart must finish before device capture');
  }
  if (ownsLaunchTransition) {
    try {
      await transport.launch(command);
      await afterLaunch();
      issued = await transitionB3IssuedCommand({
        root, platform: name, command,
        expectedState: activeLaunchingState,
        nextState: 'launched',
      });
    } catch {
      // Crossing the native launch boundary is ambiguous even when the runner
      // reports an error. Keep this invocation alive and pull the fixed-path
      // publication before deciding that an explicit reinstall is required.
      issued = await readB3IssuedCommand({ root, platform: name });
    }
  }
  const launchOutcomeAmbiguous = [
    'launching', 'reinstall-launching', 'restart-required',
  ].includes(issued.state);
  if (!launchOutcomeAmbiguous && issued.state !== 'launched') {
    throw captureError('B3 issued command did not reach retained launched authority');
  }
  for (let attempt = 0; attempt < maximumPullAttempts; attempt += 1) {
    let bytes;
    try {
      bytes = await transport.pullObservation();
    } catch (error) {
      if (error?.code !== 'b3_physical_device_command_failed' &&
          !/observation pull did not produce/u.test(error?.message ?? '')) throw error;
      if (attempt === maximumPullAttempts - 1) break;
      await wait(250);
      continue;
    }
    if (staleObservation(bytes, command)) {
      if (attempt === maximumPullAttempts - 1) break;
      await wait(250);
      continue;
    }
    try {
      await validateB3ProofObservationBytes(bytes, {
        command,
        buildAuthority,
        ...(retainedBeforeLaunch.at(-1)
          ? { previousObservation: retainedBeforeLaunch.at(-1).observation }
          : {}),
      });
    } catch (error) {
      // Keep the exact launched command. A later pull may replace incomplete or
      // stale bytes, but the host must not repeat the native launch side effect.
      if (launchOutcomeAmbiguous) {
        if (attempt < maximumPullAttempts - 1) {
          await wait(250);
          continue;
        }
        break;
      }
      throw error;
    }
    if (launchOutcomeAmbiguous) {
      try {
        issued = await transitionB3IssuedCommand({
          root,
          platform: name,
          command,
          expectedState: issued.state,
          nextState: 'launched',
        });
      } catch (error) {
        const retained = await readB3IssuedCommand({ root, platform: name });
        if (retained.state !== 'restart-required') throw error;
        issued = await transitionB3IssuedCommand({
          root,
          platform: name,
          command,
          expectedState: 'restart-required',
          nextState: 'launched',
        });
      }
    }
    await beforeJournal();
    await appendB3PhysicalObservation({
      root,
      platform: name,
      command,
      buildAuthority,
      observationBytes: bytes,
    });
    await afterJournal();
    await reconcileB3CaptureCheckpointFromJournal({
      root,
      platform: name,
      buildAuthority,
    });
    await clearB3IssuedCommand({ root, platform: name, command });
    const records = await readB3PhysicalObservationJournal({
      root,
      platform: name,
      buildAuthority,
    });
    const retained = records[command.expectedSequence - 1];
    if (!retained || canonicaliseB3ProofValue(retained.command) !==
        canonicaliseB3ProofValue(command)) {
      throw captureError('B3 retained observation sequence differs after capture');
    }
    return retained.observation;
  }
  if (launchOutcomeAmbiguous) {
    if (issued.state !== 'restart-required') {
      try {
        issued = await transitionB3IssuedCommand({
          root,
          platform: name,
          command,
          expectedState: issued.state,
          nextState: 'restart-required',
        });
      } catch (error) {
        const retained = await readB3IssuedCommand({ root, platform: name });
        if (retained.state === 'launched') {
          throw captureError(
            'B3 physical device did not publish the command-bound observation before the fixed deadline',
            'b3_physical_observation_timeout',
          );
        }
        throw error;
      }
    }
    throw operatorRequired('REINSTALL_EXACT_BUILD');
  }
  throw captureError(
    'B3 physical device did not publish the command-bound observation before the fixed deadline',
    'b3_physical_observation_timeout',
  );
}

export async function resumeB3IssuedDeviceObservation(options = {}) {
  const { root, platform } = options;
  const issued = await readB3IssuedCommand({ root, platform });
  return captureB3ValidatedDeviceObservation({
    ...options,
    command: issued.command,
  });
}

export async function resumeB3AmbiguousIssuedCommandAfterReinstall({
  root,
  platform,
  enabled,
  actionCode,
  observationSha256,
}) {
  if (enabled !== true || actionCode !== 'REBIND_FRESH_INSTALL' ||
      !/^[0-9a-f]{64}$/u.test(observationSha256 ?? '')) return false;
  const issued = await readB3IssuedCommand({ root, platform });
  if (issued.state !== 'launching' || issued.command.actionCode !== actionCode ||
      issued.command.installationMode !== 'fresh-reinstall' ||
      issued.command.previousObservationSha256 !== observationSha256) return false;
  const authorised = await transitionB3IssuedCommand({
    root,
    platform,
    command: issued.command,
    expectedState: 'launching',
    nextState: 'reinstall-authorised',
  });
  return authorised.transitionClaimed;
}

export async function recoverB3AmbiguousCaptureAfterReinstall({
  root,
  platform,
  enabled,
  invocationCommandSha256,
  buildAuthority,
  afterArchive = async () => {},
  beforeClear = async () => {},
}) {
  if (typeof enabled !== 'boolean' || !/^[0-9a-f]{64}$/u.test(
    invocationCommandSha256 ?? '',
  ) || typeof afterArchive !== 'function' || typeof beforeClear !== 'function') {
    throw captureError('B3 ambiguous capture-restart authority is invalid');
  }
  let issued;
  try {
    issued = await readB3IssuedCommand({ root, platform });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    try {
      return await readB3AbandonedCaptureArchive({
        root,
        platform,
        commandSha256: invocationCommandSha256,
        buildAuthority,
      });
    } catch (archiveError) {
      if (archiveError?.code !== 'b3_abandoned_capture_archive_absent') throw archiveError;
      return false;
    }
  }
  if (issued.commandSha256 !== invocationCommandSha256) return false;
  if (issued.state === 'restart-required') {
    if (!enabled) return false;
    issued = await transitionB3IssuedCommand({
      root,
      platform,
      command: issued.command,
      expectedState: 'restart-required',
      nextState: 'restart-executing',
    });
  } else if (!['restart-executing', 'restart-complete'].includes(issued.state)) {
    return false;
  }
  const recovery = await archiveB3AbandonedCapture({
    root,
    platform,
    issued,
    buildAuthority,
  });
  await afterArchive();
  try {
    if (issued.state === 'restart-executing') {
      issued = await transitionB3IssuedCommand({
        root,
        platform,
        command: issued.command,
        expectedState: 'restart-executing',
        nextState: 'restart-complete',
      });
    }
    await beforeClear();
    await clearB3IssuedCommand({ root, platform, command: issued.command });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return recovery;
}

function deriveChallenge(commandWithoutChallenge) {
  return sha256(Buffer.from(
    `ks2-spelling:b3-host-command-challenge:v1\0${canonicaliseB3ProofValue(commandWithoutChallenge)}`,
    'utf8',
  ));
}

export async function createNextB3HostCommand({
  root,
  platform,
  buildAuthority,
  uuidFactory = randomUUID,
}) {
  const name = platformName(platform);
  if (typeof uuidFactory !== 'function') throw captureError('B3 command UUID factory is invalid');
  const retained = await readB3PhysicalObservationJournal({
    root, platform: name, buildAuthority,
  });
  const checkpoint = await reconcileB3CaptureCheckpointFromJournal({
    root, platform: name, buildAuthority,
  });
  const tail = retained.at(-1)?.observation;
  const requestedActionCode = tail?.nextActionCode ?? 'ARM_CAPTURE';
  const androidDecisionBridge = name === 'android'
    ? Object.freeze({
        DECLINE_PENDING_PURCHASE: 'ARM_CAPTURE',
        APPROVE_PENDING_PURCHASE: 'ARM_GATEWAY_COMPLETION_HOLD',
      })[requestedActionCode]
    : undefined;
  const actionCode = androidDecisionBridge ?? requestedActionCode;
  let expectedScenarioIndex;
  if (!tail) expectedScenarioIndex = 0;
  else if (androidDecisionBridge) expectedScenarioIndex = tail.scenarioIndex + 1;
  else if (actionCode === 'ARM_CAPTURE') expectedScenarioIndex = checkpoint.nextScenarioIndex;
  else if (actionCode === 'CAPTURE_TERMINAL' || actionCode === 'COMPLETE_CAPTURE') {
    expectedScenarioIndex = 8;
  } else if (actionCode === 'RELAUNCH' && checkpoint.nextScenarioIndex > tail.scenarioIndex) {
    expectedScenarioIndex = checkpoint.nextScenarioIndex;
  } else expectedScenarioIndex = tail.scenarioIndex;
  if (!Number.isSafeInteger(expectedScenarioIndex) || expectedScenarioIndex < 0 ||
      expectedScenarioIndex > 8) {
    throw captureError('B3 next host command scenario is outside its authority');
  }
  const commandWithoutChallenge = {
    schemaVersion: 1,
    captureId: tail?.captureId ?? uuidFactory(),
    platform: PLATFORM[name].commandPlatform,
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

export async function advanceB3HostCaptureOne({
  root,
  platform,
  buildAuthority,
  transport,
  wait,
  uuidFactory,
  maximumPullAttempts = 120,
}) {
  try {
    await readB3IssuedCommand({ root, platform });
    return await resumeB3IssuedDeviceObservation({
      root, platform, buildAuthority, transport, wait, maximumPullAttempts,
    });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const command = await createNextB3HostCommand({
    root, platform, buildAuthority, uuidFactory,
  });
  try {
    return await captureB3ValidatedDeviceObservation({
      root, platform, command, buildAuthority, transport, wait, maximumPullAttempts,
    });
  } catch (error) {
    if (!isIssuedCommandConflict(error)) throw error;
    const retained = await readB3PhysicalObservationJournal({
      root, platform, buildAuthority,
    });
    const issued = await readB3IssuedCommand({ root, platform });
    if (retained.length !== 0 ||
        !hasMatchingConcurrentAllocationContext(issued.command, command)) throw error;
    return captureB3ValidatedDeviceObservation({
      root, platform, command: issued.command, buildAuthority,
      transport, wait, maximumPullAttempts,
    });
  }
}

const HOST_OPERATOR_ACTIONS = Object.freeze(new Set([
  'APPROVE_PENDING_PURCHASE',
  'DECLINE_PENDING_PURCHASE',
]));

export function createB3StoreActionResumeAuthority(enabled, binding = null) {
  if (typeof enabled !== 'boolean') {
    throw captureError('B3 store-action resume authority is invalid');
  }
  if (enabled && (!binding || !HOST_OPERATOR_ACTIONS.has(binding.actionCode) ||
      !/^[0-9a-f]{64}$/u.test(binding.observationSha256 ?? ''))) {
    throw captureError('B3 store-action resume flag has no retained invocation-tail authority');
  }
  let consumed = false;
  return Object.freeze(({ actionCode, observationSha256 } = {}) => {
    if (!enabled || consumed || !HOST_OPERATOR_ACTIONS.has(actionCode) ||
        !/^[0-9a-f]{64}$/u.test(observationSha256 ?? '') ||
        actionCode !== binding.actionCode || observationSha256 !== binding.observationSha256) {
      return false;
    }
    consumed = true;
    return true;
  });
}

export async function driveB3HostScenario({
  authority,
  readRecords,
  advance,
  resumeStoreAction = false,
  resumeReinstall = false,
  maximumCommands = 16,
}) {
  if (typeof readRecords !== 'function' || typeof advance !== 'function' ||
      !['boolean', 'function'].includes(typeof resumeStoreAction) ||
      !['boolean', 'function'].includes(typeof resumeReinstall) ||
      !Number.isSafeInteger(maximumCommands) || maximumCommands < 1 || maximumCommands > 16) {
    throw captureError('B3 host scenario driver options are invalid');
  }
  let storeActionResumed = false;
  for (let count = 0; count <= maximumCommands; count += 1) {
    const retained = await readRecords();
    if (retained.length > 0) {
      const nextAction = retained.at(-1).observation.nextActionCode;
      let operatorGateResumed = false;
      if (HOST_OPERATOR_ACTIONS.has(nextAction)) {
        const resumeAllowed = typeof resumeStoreAction === 'function'
          ? resumeStoreAction(Object.freeze({
              actionCode: nextAction,
              observationSha256: retained.at(-1).observation.observationSha256,
            }))
          : resumeStoreAction;
        if (!resumeAllowed || storeActionResumed) {
          throw operatorRequired(nextAction);
        }
        storeActionResumed = true;
        operatorGateResumed = true;
      }
      if (nextAction === 'REBIND_FRESH_INSTALL') {
        const resumeAllowed = typeof resumeReinstall === 'function'
          ? resumeReinstall(Object.freeze({
              actionCode: nextAction,
              observationSha256: retained.at(-1).observation.observationSha256,
            }))
          : resumeReinstall;
        if (!resumeAllowed) throw operatorRequired('REINSTALL_EXACT_BUILD');
        operatorGateResumed = true;
      }
      if (!operatorGateResumed) {
        try {
          return deriveB3ScenarioTransition({ records: retained, authority });
        } catch (error) {
          if (!/absent|outcome/u.test(error?.message ?? '')) throw error;
        }
      }
    }
    if (count === maximumCommands) break;
    await advance();
  }
  throw captureError('B3 host scenario exceeded its closed command bound');
}

export async function driveB3HostUntilPhase({
  scenario,
  phase,
  readRecords,
  advance,
  maximumCommands = 16,
}) {
  if (typeof scenario !== 'string' || typeof phase !== 'string' ||
      typeof readRecords !== 'function' || typeof advance !== 'function' ||
      !Number.isSafeInteger(maximumCommands) || maximumCommands < 1 || maximumCommands > 16) {
    throw captureError('B3 host phase driver options are invalid');
  }
  for (let count = 0; count <= maximumCommands; count += 1) {
    const tail = (await readRecords()).at(-1)?.observation;
    if (tail?.scenario === scenario && tail.phase === phase) return tail;
    if (count === maximumCommands) break;
    await advance();
  }
  throw captureError('B3 host phase driver exceeded its closed command bound');
}

export function createB3AndroidSlowCardController({
  readRecords,
  consumeStoreActionResume,
  pollFreshProcess,
  deriveTransition = ({ records, authority }) =>
    deriveB3ScenarioTransition({ records, authority }),
} = {}) {
  if (typeof readRecords !== 'function' ||
      typeof consumeStoreActionResume !== 'function' ||
      typeof pollFreshProcess !== 'function' ||
      typeof deriveTransition !== 'function') {
    throw captureError('B3 Android slow-card controller options are invalid');
  }
  let activeScenario = null;
  let terminalState = null;

  function expectedTerminal(authority) {
    return authority?.scenario === 'slow-card-pending-decline' ? 'declined' : 'approved';
  }

  function deriveIfTerminal(records, authority) {
    try {
      const transition = deriveTransition({ records, authority });
      terminalState = expectedTerminal(authority);
      return transition;
    } catch (error) {
      if (!/absent|outcome/u.test(error?.message ?? '')) throw error;
      return null;
    }
  }

  async function begin(authority) {
    if (!['slow-card-pending-decline', 'slow-card-pending-approve']
      .includes(authority?.scenario)) {
      throw captureError('B3 Android slow-card scenario authority is invalid');
    }
    if (activeScenario !== authority.scenario) terminalState = null;
    activeScenario = authority.scenario;
    for (let count = 0; count <= 16; count += 1) {
      const retained = await readRecords();
      if (deriveIfTerminal(retained, authority)) return;
      const tail = retained.at(-1)?.observation;
      const expectedAction = authority.scenario.endsWith('decline')
        ? 'DECLINE_PENDING_PURCHASE'
        : 'APPROVE_PENDING_PURCHASE';
      if (tail?.scenario === authority.scenario && tail.phase === 'OBSERVING' &&
          tail.nextActionCode === expectedAction) {
        if (!consumeStoreActionResume({
          actionCode: expectedAction,
          observationSha256: tail.observationSha256,
        })) throw operatorRequired(expectedAction);
        return;
      }
      if (count === 16) break;
      await pollFreshProcess({ authority, phase: 'arm' });
    }
    throw captureError('B3 Android slow-card arming exceeded its closed command bound');
  }

  async function poll(authority) {
    if (authority?.scenario !== activeScenario) {
      throw captureError('B3 Android slow-card poll differs from the armed scenario');
    }
    if (terminalState) return terminalState;
    await pollFreshProcess({ authority, phase: 'poll' });
    const retained = await readRecords();
    deriveIfTerminal(retained, authority);
    return terminalState ?? 'pending';
  }

  async function finish(authority) {
    if (authority?.scenario !== activeScenario || !terminalState) {
      throw captureError('B3 Android slow-card finish has no terminal authority');
    }
    return deriveTransition({ records: await readRecords(), authority });
  }

  return Object.freeze({ begin, poll, finish });
}

function mapDistribution(platform, value) {
  return platform === 'ios'
    ? Object.freeze({
        embeddedCommit: value.embeddedCommit,
        embeddedFingerprint: value.embeddedFingerprint,
        versionName: value.versionName,
        kind: 'development',
        iosBuildNumber: value.build,
        signedIpaSha256: value.signedIpaSha256,
        ipaEmbeddedAuthoritySha256: value.ipaEmbeddedAuthoritySha256,
        codeSigningCertificateSha256: value.codeSigningCertificateSha256,
        installedBundleId: value.installedBundleId,
        installedVersion: value.installedVersion,
        installedBuild: value.installedBuild,
        installedEmbeddedAuthoritySha256: value.installedEmbeddedAuthoritySha256,
        developmentIdentityVerified: value.developmentIdentityVerified,
        sandboxReceiptVerified: value.sandboxReceiptVerified,
      })
    : Object.freeze({
        embeddedCommit: value.embeddedCommit,
        embeddedFingerprint: value.embeddedFingerprint,
        versionName: value.versionName,
        kind: 'play-internal',
        androidVersionCode: value.versionCode,
        signedAabSha256: value.signedAabSha256,
        aabEmbeddedAuthoritySha256: value.aabEmbeddedAuthoritySha256,
        playAppSigningCertificateSha256: value.playAppSigningCertificateSha256,
        installer: value.installer,
        installedEmbeddedAuthoritySha256: value.installedEmbeddedAuthoritySha256,
        pmPathOrderVerified: value.pmPathOrderVerified,
        installedApks: value.installedApks,
      });
}

async function readBuildExpected(root) {
  return parseB3StrictJsonBytes(
    await readFile(resolve(root, '.native-build/b3/distribution/build-authority.json')),
    'B3 distribution build authority',
  );
}

export function buildAuthorityFor(platform, expected) {
  return Object.freeze({
    mode: 'B3SandboxProof',
    proofKind: 'physical-live',
    platform,
    distribution: PLATFORM[platform].distribution,
    publicSandboxOrigin: 'https://b3-gateway.eugnel.uk',
    workerName: 'ks2-spelling-b3-sandbox',
    bundleId: 'uk.eugnel.ks2spelling',
    testedApplicationCommit: expected.testedApplicationCommit,
    applicationFingerprint: expected.applicationFingerprint,
    versionName: expected.versionName,
    buildNumber: platform === 'ios'
      ? expected.iosBuildNumber
      : expected.androidVersionCode,
  });
}

function operatorRequired(instructionCode) {
  const messages = Object.freeze({
    START_CAPTURE: 'Start or resume the closed physical-device B3 capture journey.',
    COMPLETE_STORE_ACTION: 'Complete the displayed sandbox store action on the physical device.',
    APPROVE_PENDING_PURCHASE: 'Approve the displayed pending sandbox purchase on the device.',
    DECLINE_PENDING_PURCHASE: 'Decline the displayed pending sandbox purchase on the device.',
    REINSTALL_EXACT_BUILD: 'Reinstall the exact approved B3 distribution, then resume capture.',
    SHOW_PLAY_PROTECT_SETTINGS: 'Open the Play Protect certification settings on the approved device.',
    ATTEST_PLAY_PROTECT_SETTINGS: 'Inspect and attest the retained Play Protect settings screenshot.',
  });
  if (!Object.hasOwn(messages, instructionCode)) {
    throw captureError('B3 operator instruction code is invalid');
  }
  const error = new Error(messages[instructionCode]);
  error.code = 'b3_operator_action_required';
  error.instructionCode = instructionCode;
  return error;
}

export function deriveB3DeviceStoreEvidence({
  platform,
  retained,
  device,
  playProtect,
}) {
  if (!Object.hasOwn(PLATFORM, platform) || !Array.isArray(retained) ||
      !exactKeys(device, ['model', 'osVersion', 'physical']) ||
      typeof device.model !== 'string' || typeof device.osVersion !== 'string' ||
      device.physical !== true) {
    throw captureError('B3 physical device/store retained authority is incomplete');
  }
  deriveB3ScenarioTransition({
    records: retained,
    authority: { scenario: 'product-query', outcome: 'products-visible', traces: [] },
  });
  const completionScenario = platform === 'ios'
    ? 'unfinished-relaunch'
    : 'unacknowledged-relaunch';
  const scenarioAuthorities = platform === 'ios' ? B3_IOS_SCENARIOS : B3_ANDROID_SCENARIOS;
  deriveB3ScenarioTransition({
    records: retained,
    authority: scenarioAuthorities.find(({ scenario }) => scenario === completionScenario),
  });
  const expectedProductId = platform === 'ios'
    ? 'uk.eugnel.ks2spelling.fullks2'
    : 'full_ks2';
  const expectedCompletionState = platform === 'ios' ? 'finished' : 'acknowledged';
  const productVisible = retained.some(({ observation }) =>
      observation.scenario === 'product-query' &&
      observation.proofProjection.storeAuthority.environment === 'sandbox' &&
      observation.proofProjection.storeAuthority.productId === expectedProductId &&
      observation.proofProjection.storeAuthority.localisedPriceObserved === true &&
      observation.proofProjection.storeEvents.some((event) =>
        event.operation === 'queryProducts' && event.outcome === 'products-visible'));
  const completed = retained.some(({ observation }) =>
      observation.scenario === completionScenario &&
      observation.phase === 'SCENARIO_COMPLETE' &&
      observation.proofProjection.storeCompletionObserved === true &&
      observation.proofProjection.storeAuthority.environment === 'sandbox' &&
      observation.proofProjection.storeAuthority.productId === expectedProductId &&
      observation.proofProjection.storeAuthority.completionState === expectedCompletionState &&
      observation.proofProjection.transactionAuthority.rawProofCleared === true &&
      observation.proofProjection.storeEvents.some((event) =>
        ['queryTransactions', 'transaction-update'].includes(event.operation) &&
        event.outcome === 'purchased') &&
      observation.proofProjection.storeEvents.some((event) =>
        event.operation === 'finishTransaction' && event.outcome === 'finished') &&
      observation.proofProjection.gatewayCalls.some((call) =>
        call.operation === 'complete' && call.relation === 'completion-of-prior-verify'));
  if (!productVisible || !completed) {
    throw captureError('B3 product price or store completion authority is absent');
  }
  const store = Object.freeze({
    environment: platform === 'ios' ? 'sandbox' : 'play-test',
    productId: expectedProductId,
    localisedPriceObserved: true,
  });
  if (platform === 'ios') {
    return Object.freeze({
      device: Object.freeze({ ...device }),
      store,
      storeCompletion: Object.freeze({ finished: true }),
    });
  }
  if (!exactKeys(playProtect, [
    'playCertified',
    'playProtectSettingsScreenshotSha256',
    'playProtectRootAttestationSha256',
    'attestationPath',
  ]) || playProtect.playCertified !== true ||
      !/^[0-9a-f]{64}$/u.test(playProtect.playProtectSettingsScreenshotSha256) ||
      !/^[0-9a-f]{64}$/u.test(playProtect.playProtectRootAttestationSha256)) {
    throw captureError('B3 Play Protect retained authority is incomplete');
  }
  return Object.freeze({
    device: Object.freeze({
      ...device,
      playCertified: true,
      playProtectSettingsScreenshotSha256:
        playProtect.playProtectSettingsScreenshotSha256,
      playProtectRootAttestationSha256:
        playProtect.playProtectRootAttestationSha256,
    }),
    store,
    storeCompletion: Object.freeze({ acknowledged: true }),
  });
}

export function deriveB3TerminalEvidenceProjection({
  terminal,
  restoreRecord,
  preReinstallRecord,
  redownloadRecord,
  positiveVersionObserved,
  redownloadTransitionValidated,
}) {
  const projection = terminal?.proofProjection;
  const entitlement = projection?.entitlementAuthority;
  const pack = projection?.packAuthority;
  const restoreProjection = restoreRecord?.proofProjection;
  const restoreDigests = restoreProjection?.syntheticLearners?.positionalSnapshotSha256;
  const hash = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
  if (terminal?.phase !== 'TERMINAL_CAPTURE' || redownloadTransitionValidated !== true ||
      positiveVersionObserved !== true || entitlement?.id !== 'full-ks2' ||
      entitlement.state !== 'revoked' ||
      !hash(entitlement.domainSeparatedDigestSha256) ||
      entitlement.refreshHandlePresent !== false || pack?.packId !== 'b3-sandbox-proof' ||
      pack.installed !== true || !hash(pack.manifestSha256) ||
      !hash(pack.archiveSha256) ||
      restoreRecord?.installationId === preReinstallRecord?.installationId ||
      restoreProjection?.entitlementAuthority?.state !== 'active' ||
      restoreProjection?.entitlementAuthority?.refreshHandlePresent !== true ||
      restoreProjection?.refreshHandleLifecycle?.present !== true ||
      restoreProjection?.refreshHandleLifecycle?.positiveVersionObserved !== true ||
      restoreProjection?.packAuthority?.installed !== true ||
      redownloadRecord?.proofProjection?.packAuthority?.installed !== true ||
      projection.transactionAuthority.rawProofCleared !== true ||
      restoreDigests?.[0] !==
        B3_SYNTHETIC_LEARNER_DIGESTS['after-fresh-install-reseed'].learnerA ||
      restoreDigests?.[1] !==
        B3_SYNTHETIC_LEARNER_DIGESTS['after-fresh-install-reseed'].learnerB) {
    throw captureError('B3 terminal retained authority is incomplete or inconsistent');
  }
  const transportAuthority = projection.transportAuthority;
  return Object.freeze({
    transport: Object.freeze({
      concreteCapacitorStore: transportAuthority.storeAdapter === 'concreteCapacitorStore',
      concreteHttpGateway: transportAuthority.gatewayAdapter === 'concreteHttpGateway',
      serverUrl: transportAuthority.serverUrl,
      nativeOriginAllowed: transportAuthority.nativeOriginAllowed,
      noRedirects: transportAuthority.noRedirects,
    }),
    storeTransactionAuthority: Object.freeze({
      source: projection.transactionAuthority.source,
      crossCheckedOnRefresh: projection.transactionAuthority.crossCheckedOnRefresh,
      // This is a report/privacy claim: no raw store value enters committed evidence.
      rawValueCommitted: false,
    }),
    refreshHandleLifecycle: Object.freeze({
      positiveVersionObserved,
      rawProofCleared: projection.transactionAuthority.rawProofCleared,
      restoredFreshHandle: restoreProjection.refreshHandleLifecycle.present,
      revokedHandleDeleted: projection.refreshHandleLifecycle.deleted,
      // This is a report/privacy claim: no raw sealed handle enters committed evidence.
      rawHandleCommitted: false,
    }),
    entitlement: Object.freeze({
      id: entitlement.id,
      finalState: entitlement.state,
      digest: entitlement.domainSeparatedDigestSha256,
      refreshHandlePresent: entitlement.refreshHandlePresent,
    }),
    pack: Object.freeze({
      packId: pack.packId,
      manifestSha256: pack.manifestSha256,
      archiveSha256: pack.archiveSha256,
      installed: pack.installed,
      redownloaded: true,
    }),
    syntheticLearnerAuthoritySha256: B3_SYNTHETIC_LEARNER_AUTHORITY_SHA256,
    restore: Object.freeze({
      freshInstall: true,
      entitlementRebuilt: true,
      packRedownloaded: true,
      learnerBackupRestoreClaimed: false,
      baselineCreatedAfterFreshInstall: true,
    }),
  });
}

function createDefaultAdapter({
  root,
  env,
  platform,
  runner,
  binaryRunner,
  wait,
  resumeStoreAction = false,
  resumeReinstall = false,
  capturePlayProtectSettings = false,
}) {
  if (typeof resumeStoreAction !== 'boolean' || typeof resumeReinstall !== 'boolean' ||
      typeof capturePlayProtectSettings !== 'boolean') {
    throw captureError('B3 store-action resume authority is invalid');
  }
  const hostWait = wait ?? ((milliseconds) =>
    new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)));
  const inspectors = createDefaultB3DistributionInspectors({
    root,
    env,
    ...(runner ? { commandRunner: runner } : {}),
  });
  const transport = createB3PhysicalDeviceTransport({
    root,
    platform,
    env,
    ...(runner ? { runner } : {}),
    ...(binaryRunner ? { binaryRunner } : {}),
  });
  const signedPath = env[PLATFORM[platform].signedEnvironment];
  let distributionPromise;
  let buildAuthorityPromise;
  let invocationTailCaptured = false;
  let invocationTail = null;
  let invocationIssuedCommandSha256 = null;
  let reinstallAcknowledgementConsumed = false;
  let storeActionResumeAuthority = null;

  async function inspectDistributionFresh() {
    if (typeof signedPath !== 'string' || signedPath.length === 0) {
      throw captureError(`B3 ${platform} signed distribution path is required`);
    }
    const expected = await readBuildExpected(root);
    const approvedPlayCertificateSha256 = platform === 'android'
      ? await readApprovedB3PlayCertificate({
          approvalFile: env.B3_PREREQUISITES_FILE,
          root,
        })
      : undefined;
    return mapDistribution(platform, await verifyB3InstalledDistributionWithInspectors({
      expected,
      platform,
      signedPath,
      artifactInspector: inspectors.artifactInspector,
      deviceInspector: inspectors.deviceInspector,
      approvedPlayCertificateSha256,
    }));
  }

  function inspectDistribution({ fresh = false } = {}) {
    if (fresh) return inspectDistributionFresh();
    distributionPromise ??= inspectDistributionFresh();
    return distributionPromise;
  }

  async function buildAuthority() {
    buildAuthorityPromise ??= readBuildExpected(root).then((expected) =>
      buildAuthorityFor(platform, expected));
    return buildAuthorityPromise;
  }

  async function recoverAmbiguousCapture() {
    let retained;
    try {
      retained = await readB3IssuedCommand({ root, platform });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      return false;
    }
    const recovery = await recoverB3AmbiguousCaptureAfterReinstall({
      root,
      platform,
      enabled: resumeReinstall && !reinstallAcknowledgementConsumed,
      invocationCommandSha256: retained.commandSha256,
      buildAuthority: await buildAuthority(),
    });
    if (recovery) reinstallAcknowledgementConsumed = true;
    return recovery;
  }

  async function records() {
    await inspectDistribution();
    const retained = await readB3PhysicalObservationJournal({
      root,
      platform,
      buildAuthority: await buildAuthority(),
    });
    if (!invocationTailCaptured) {
      invocationTail = retained.at(-1)?.observation ?? null;
      try {
        invocationIssuedCommandSha256 = (await readB3IssuedCommand({ root, platform }))
          .commandSha256;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      invocationTailCaptured = true;
    }
    return retained;
  }

  async function inspectSyntheticLearners({ baseline } = {}) {
    const authority = B3_SYNTHETIC_LEARNER_DIGESTS[baseline];
    if (!authority) throw captureError('B3 synthetic learner baseline is invalid');
    let retained = await records();
    if (retained.length === 0) {
      await advanceB3HostCaptureOne({
        root,
        platform,
        buildAuthority: await buildAuthority(),
        transport,
        wait,
      });
      retained = await records();
    }
    const digests = retained.at(-1).observation.proofProjection.syntheticLearners
      .positionalSnapshotSha256;
    if (digests[0] !== authority.learnerA || digests[1] !== authority.learnerB) {
      throw captureError('B3 retained synthetic learner digest authority differs');
    }
    return Object.freeze([
      Object.freeze({ learnerId: 'learner-a', nickname: 'Ada', digest: digests[0] }),
      Object.freeze({ learnerId: 'learner-b', nickname: 'Ben', digest: digests[1] }),
    ]);
  }

  async function runScenario(authority) {
    let retained = await records();
    let tail = retained.at(-1)?.observation;
    if (invocationIssuedCommandSha256) {
      const recovery = await recoverB3AmbiguousCaptureAfterReinstall({
        root,
        platform,
        enabled: resumeReinstall && !reinstallAcknowledgementConsumed,
        invocationCommandSha256: invocationIssuedCommandSha256,
        buildAuthority: await buildAuthority(),
      });
      if (recovery) {
        reinstallAcknowledgementConsumed = true;
        retained = await records();
        tail = retained.at(-1)?.observation;
      }
    }
    if (platform === 'ios' && authority?.scenario === 'unfinished-relaunch' &&
        tail?.scenario === 'normal-purchase' && tail.phase === 'HOLD_REACHED') {
      let issuedRelaunch;
      try {
        issuedRelaunch = await readB3IssuedCommand({ root, platform });
        if (issuedRelaunch.command.actionCode !== 'RELAUNCH') {
          throw captureError('B3 iOS hold retained a different issued command');
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      let ownsStopExecution = false;
      if (!issuedRelaunch) {
        const relaunchCommand = await createNextB3HostCommand({
          root,
          platform,
          buildAuthority: await buildAuthority(),
        });
        if (relaunchCommand.actionCode !== 'RELAUNCH') {
          throw captureError('B3 host force-stop did not retain exact relaunch authority');
        }
        await persistB3IssuedCommand({ root, platform, command: relaunchCommand });
        issuedRelaunch = await transitionB3IssuedCommand({
          root,
          platform,
          command: relaunchCommand,
          expectedState: 'prepared',
          nextState: 'stop-intent',
        });
        if (!issuedRelaunch.transitionClaimed) {
          throw captureError('B3 host-stop intent is already owned by another invocation');
        }
      }
      if (issuedRelaunch.state === 'stop-intent') {
        issuedRelaunch = await transitionB3IssuedCommand({
          root,
          platform,
          command: issuedRelaunch.command,
          expectedState: 'stop-intent',
          nextState: 'stop-executing',
        });
        ownsStopExecution = issuedRelaunch.transitionClaimed;
      }
      if (issuedRelaunch.state === 'stop-executing' && !ownsStopExecution) {
        try {
          issuedRelaunch = await transitionB3IssuedCommand({
            root,
            platform,
            command: issuedRelaunch.command,
            expectedState: 'stop-executing',
            nextState: 'host-stopped',
            existingRevisionOnly: true,
          });
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
      if (issuedRelaunch.state === 'stop-executing' && ownsStopExecution) {
        await hostWait(5_000);
        await transport.forceStop({
          command: issuedRelaunch.command,
          retainReceipt: async () => {
            await transitionB3IssuedCommand({
              root,
              platform,
              command: issuedRelaunch.command,
              expectedState: 'stop-executing',
              nextState: 'host-stopped',
            });
          },
        });
      } else if (!['host-stopped', 'launching', 'launched'].includes(issuedRelaunch.state)) {
        throw captureError('B3 iOS host-stop authority is incomplete');
      }
    }
    const invocationBinding = invocationTail && {
      actionCode: invocationTail.nextActionCode,
      observationSha256: invocationTail.observationSha256,
    };
    storeActionResumeAuthority ??= createB3StoreActionResumeAuthority(
      resumeStoreAction, invocationBinding,
    );
    const transition = await driveB3HostScenario({
      authority,
      resumeStoreAction: storeActionResumeAuthority,
      resumeReinstall: ({ actionCode, observationSha256 }) => {
        if (!resumeReinstall || reinstallAcknowledgementConsumed ||
            actionCode !== 'REBIND_FRESH_INSTALL' ||
            invocationBinding?.actionCode !== actionCode ||
            invocationBinding?.observationSha256 !== observationSha256) return false;
        reinstallAcknowledgementConsumed = true;
        return true;
      },
      readRecords: records,
      advance: async () => advanceB3HostCaptureOne({
        root,
        platform,
        buildAuthority: await buildAuthority(),
        transport,
        wait: hostWait,
      }),
    });
    if (authority?.scenario === 'refund-revoke') {
      await driveB3HostUntilPhase({
        scenario: authority.scenario,
        phase: 'TERMINAL_CAPTURE',
        readRecords: records,
        advance: async () => advanceB3HostCaptureOne({
          root,
          platform,
          buildAuthority: await buildAuthority(),
          transport,
          wait: hostWait,
        }),
      });
    }
    return transition;
  }

  async function inspectProofObservationChain() {
    const retained = await records();
    const scenarios = platform === 'ios' ? B3_IOS_SCENARIOS : B3_ANDROID_SCENARIOS;
    const transitions = scenarios.map((authority) =>
      deriveB3ScenarioTransition({ records: retained, authority }));
    return deriveB3ProofObservationChain({ records: retained, transitions });
  }

  async function captureScreenshot() {
    const before = await inspectDistribution();
    if (platform === 'android') {
      await transport.foregroundApplication();
      await hostWait(500);
    }
    const bytes = platform === 'ios'
      ? await captureB3IosScreenshotBytes({
          root,
          deviceId: env.B3_IOS_PHYSICAL_DEVICE_ID,
          ...(runner ? { runner } : {}),
        })
      : await transport.captureScreenshot();
    const persisted = await persistB3PlatformScreenshot({ root, platform, bytes });
    const after = await inspectDistributionFresh();
    if (!isDeepStrictEqual(after, before)) {
      throw captureError('B3 installed distribution changed during screenshot capture');
    }
    return persisted;
  }

  async function inspectGatewaySmoke() {
    const retained = await records();
    const projection = extractB3DeviceGatewaySmokeProjection({ retained });
    await persistB3DeviceGatewaySmokeProjection({ root, projection });
    return projection;
  }

  async function inspectTerminalEvidence() {
    const retained = await records();
    const terminal = retained.at(-1)?.observation;
    if (terminal?.phase !== 'TERMINAL_CAPTURE') {
      throw captureError('B3 terminal observation authority is absent');
    }
    const restoreRecord = retained.filter(({ observation }) =>
      observation.scenario === 'restore-after-reinstall').at(-1)?.observation;
    const preReinstallRecord = retained.filter(({ observation }) =>
      observation.scenario === 'pack-install').at(-1)?.observation;
    const redownloadRecord = retained.filter(({ observation }) =>
      observation.scenario === 'redownload').at(-1)?.observation;
    const scenarioAuthorities = platform === 'ios' ? B3_IOS_SCENARIOS : B3_ANDROID_SCENARIOS;
    const redownloadAuthority = scenarioAuthorities.find(({ scenario }) => scenario === 'redownload');
    deriveB3ScenarioTransition({ records: retained, authority: redownloadAuthority });
    const positiveVersionObserved = retained.some(({ observation }) => {
      const projection = observation.proofProjection;
      return projection.entitlementAuthority.state === 'active' &&
        projection.entitlementAuthority.refreshHandlePresent === true &&
        projection.refreshHandleLifecycle.present === true &&
        projection.refreshHandleLifecycle.positiveVersionObserved === true &&
        typeof projection.transactionAuthority.domainSeparatedDigestSha256 === 'string';
    });
    return deriveB3TerminalEvidenceProjection({
      terminal,
      restoreRecord,
      preReinstallRecord,
      redownloadRecord,
      positiveVersionObserved,
      redownloadTransitionValidated: true,
    });
  }

  async function inspectDeviceStore() {
    await inspectDistribution();
    const device = await transport.inspectDevice();
    const retained = await records();
    if (retained.at(-1)?.observation.phase !== 'TERMINAL_CAPTURE') {
      throw captureError('B3 terminal device/store authority is absent');
    }
    let playProtect;
    if (platform === 'android') {
      if (capturePlayProtectSettings) {
        await captureB3PlayProtectSettingsScreenshot({
          root,
          bytes: await transport.captureScreenshot(),
        });
        throw operatorRequired('ATTEST_PLAY_PROTECT_SETTINGS');
      }
      try {
        playProtect = await inspectB3PlayProtectRootAttestation({ root });
      } catch (error) {
        if (error?.code !== 'b3_play_protect_attestation_absent') throw error;
        throw operatorRequired('SHOW_PLAY_PROTECT_SETTINGS');
      }
    }
    return deriveB3DeviceStoreEvidence({
      platform, retained, device, playProtect,
    });
  }

  async function inspectStoreKitTest() {
    if (platform !== 'ios') {
      throw captureError('StoreKit Test evidence is iOS-only');
    }
    return inspectB3DeterministicStoreKitReport({ root });
  }

  const base = {
    recoverAmbiguousCapture,
    inspectDistribution,
    inspectDeviceStore,
    inspectSyntheticLearners,
    runScenario,
    inspectGatewaySmoke,
    inspectTerminalEvidence,
    inspectProofObservationChain,
    captureScreenshot,
    inspectStoreKitTest,
  };
  return {
    base,
    transport,
    wait: hostWait,
    records,
    buildAuthority,
    consumeStoreActionResume(binding) {
      const invocationBinding = invocationTail && {
        actionCode: invocationTail.nextActionCode,
        observationSha256: invocationTail.observationSha256,
      };
      storeActionResumeAuthority ??= createB3StoreActionResumeAuthority(
        resumeStoreAction, invocationBinding,
      );
      return storeActionResumeAuthority(binding);
    },
  };
}

export function createDefaultB3IosCaptureAdapter({
  root,
  env = process.env,
  runner,
  wait,
  resumeStoreAction = false,
  resumeReinstall = false,
  capturePlayProtectSettings = false,
} = {}) {
  const { base } = createDefaultAdapter({
    root, env, platform: 'ios', runner, wait, resumeStoreAction, resumeReinstall,
    capturePlayProtectSettings,
  });
  return Object.freeze(base);
}

export function createDefaultB3AndroidCaptureAdapter({
  root,
  env = process.env,
  runner,
  binaryRunner,
  wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
  resumeStoreAction = false,
  resumeReinstall = false,
  capturePlayProtectSettings = false,
} = {}) {
  const {
    base, transport, records, buildAuthority, consumeStoreActionResume,
  } = createDefaultAdapter({
    root,
    env,
    platform: 'android',
    runner,
    binaryRunner,
    wait,
    resumeStoreAction,
    resumeReinstall,
    capturePlayProtectSettings,
  });
  const slowCard = createB3AndroidSlowCardController({
    readRecords: records,
    consumeStoreActionResume,
    pollFreshProcess: async () => advanceB3HostCaptureOne({
      root,
      platform: 'android',
      buildAuthority: await buildAuthority(),
      transport,
      wait,
    }),
  });
  return Object.freeze({
    ...base,
    beginSlowCardScenario: slowCard.begin,
    pollSlowCardScenario: slowCard.poll,
    finishSlowCardScenario: slowCard.finish,
    beginUnacknowledgedScenario: async (authority) => {
      return driveB3HostUntilPhase({
        scenario: authority?.scenario,
        phase: 'HOLD_REACHED',
        readRecords: records,
        advance: async () => advanceB3HostCaptureOne({
          root,
          platform: 'android',
          buildAuthority: await buildAuthority(),
          transport,
          wait,
        }),
      });
    },
    forceStopUnacknowledgedScenario: async () => {
      try {
        const issued = await readB3IssuedCommand({ root, platform: 'android' });
        if (issued.command.actionCode === 'RELAUNCH') return;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      await transport.forceStop();
    },
    finishUnacknowledgedScenario: base.runScenario,
    wait,
  });
}

export { B3_SYNTHETIC_LEARNER_AUTHORITY_SHA256 };
