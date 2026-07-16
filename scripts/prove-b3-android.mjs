import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  parseB3StrictJsonBytes,
  readValidatedB3OperatorJson,
  validateB3LocalMutationAuthority,
} from './check-b3-external-prerequisites.mjs';
import {
  assertB3GatewayEquality,
  assertB3SyntheticLearnerObservation,
  B3_ANDROID_SCENARIOS,
  b3PlatformGatewayFromCloudflare,
  validateB3PlatformEvidence,
  validateB3PendingPlatformEvidence,
} from './lib/b3-evidence.mjs';
import { assertB3RemoteMutationScope } from './lib/b3-cloudflare-evidence.mjs';
import { createDefaultB3AndroidCaptureAdapter } from './lib/b3-live-capture-adapters.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const B3_ANDROID_REMOTE_SCOPE = 'google-test-track-refund-revoke';
const B3_OPERATOR_INSTRUCTION_CODES = new Set([
  'START_CAPTURE', 'COMPLETE_STORE_ACTION', 'APPROVE_PENDING_PURCHASE',
  'DECLINE_PENDING_PURCHASE', 'REINSTALL_EXACT_BUILD',
  'SHOW_PLAY_PROTECT_SETTINGS', 'ATTEST_PLAY_PROTECT_SETTINGS',
]);
const POLL_INTERVAL_MS = 5_000;
const POLL_LIMIT = 120;

export function assertB3AndroidCaptureInput(value, { approvedScope, runToken, requireScope = false } = {}) {
  if (requireScope) assertB3RemoteMutationScope({ approvedScope, runToken, expectedScope: B3_ANDROID_REMOTE_SCOPE });
  const evidence = validateB3PlatformEvidence(value);
  if (evidence.platform !== 'android-play-physical' || evidence.device.physical !== true || evidence.device.playCertified !== true || evidence.distribution.kind !== 'play-internal') {
    throw new Error('B3 Android proof requires a Play-certified physical internal-test distribution');
  }
  return evidence;
}

export function finaliseB3AndroidEvidence({ platform, cloudflare }) {
  if (platform?.manualVisualInspection !== 'passed') throw new Error('B3 Android manual visual inspection is not passed');
  const evidence = assertB3AndroidCaptureInput(platform);
  if (cloudflare?.testedApplicationCommit !== evidence.testedApplicationCommit ||
      cloudflare?.applicationFingerprint !== evidence.applicationFingerprint) {
    throw new Error('B3 Android and Cloudflare application authority differ');
  }
  return assertB3GatewayEquality(evidence, cloudflare);
}

function requirePrimitive(primitives, name) {
  if (typeof primitives?.[name] !== 'function') throw new Error(`B3 Android physical primitive is missing: ${name}`);
  return primitives[name];
}

async function writePendingAtomically(path, value) {
  await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try {
    await link(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function captureB3AndroidEvidenceWithPrimitives({
  root = ROOT,
  approvalFile,
  runToken,
  approvedScope,
  clock,
  gitRunner,
  authorityGate = validateB3LocalMutationAuthority,
  primitives,
  cloudflare,
  write = false,
} = {}) {
  assertB3RemoteMutationScope({ approvedScope, runToken, expectedScope: B3_ANDROID_REMOTE_SCOPE });
  await authorityGate({ approvalFile, runToken, requestedScope: B3_ANDROID_REMOTE_SCOPE, root, clock, gitRunner });
  const gateway = b3PlatformGatewayFromCloudflare(cloudflare);
  const recoverAmbiguousCapture = requirePrimitive(primitives, 'recoverAmbiguousCapture');
  const inspectDistribution = requirePrimitive(primitives, 'inspectDistribution');
  const inspectDeviceStore = requirePrimitive(primitives, 'inspectDeviceStore');
  const inspectSyntheticLearners = requirePrimitive(primitives, 'inspectSyntheticLearners');
  const runScenario = requirePrimitive(primitives, 'runScenario');
  const inspectTerminalEvidence = requirePrimitive(primitives, 'inspectTerminalEvidence');
  const inspectProofObservationChain = requirePrimitive(primitives, 'inspectProofObservationChain');
  const captureScreenshot = requirePrimitive(primitives, 'captureScreenshot');
  const distributionBeforeCapture = await inspectDistribution();
  await recoverAmbiguousCapture();
  const beforeInitial = assertB3SyntheticLearnerObservation(
    await inspectSyntheticLearners({ baseline: 'before-purchase', phase: 'initial' }),
    'before-purchase',
  );
  const transitions = [];
  let beforeFinal;
  let afterInitial;
  let afterFinal;
  for (const authority of B3_ANDROID_SCENARIOS) {
    let transition;
    if (authority.scenario.startsWith('slow-card-')) {
      const begin = requirePrimitive(primitives, 'beginSlowCardScenario');
      const poll = requirePrimitive(primitives, 'pollSlowCardScenario');
      const finish = requirePrimitive(primitives, 'finishSlowCardScenario');
      const wait = requirePrimitive(primitives, 'wait');
      await begin(structuredClone(authority));
      const terminalState = await pollSlowCard({ poll: () => poll(structuredClone(authority)), wait });
      const expected = authority.scenario.endsWith('decline') ? 'declined' : 'approved';
      if (terminalState !== expected) throw new Error('slow-card terminal state differs from scenario authority');
      transition = await finish(structuredClone(authority));
    } else if (authority.scenario === 'unacknowledged-relaunch') {
      const begin = requirePrimitive(primitives, 'beginUnacknowledgedScenario');
      const forceStop = requirePrimitive(primitives, 'forceStopUnacknowledgedScenario');
      const finish = requirePrimitive(primitives, 'finishUnacknowledgedScenario');
      const wait = requirePrimitive(primitives, 'wait');
      await begin(structuredClone(authority));
      await holdUnacknowledgedPurchase({ wait, release: () => forceStop(structuredClone(authority)) });
      transition = await finish(structuredClone(authority));
    } else {
      transition = await runScenario(structuredClone(authority));
    }
    transitions.push(transition);
    if (authority.scenario === 'pack-install') {
      beforeFinal = assertB3SyntheticLearnerObservation(
        await inspectSyntheticLearners({ baseline: 'before-purchase', phase: 'final' }),
        'before-purchase',
      );
    }
    if (authority.scenario === 'redownload') {
      afterInitial = assertB3SyntheticLearnerObservation(
        await inspectSyntheticLearners({ baseline: 'after-fresh-install-reseed', phase: 'initial' }),
        'after-fresh-install-reseed',
      );
    }
    if (authority.scenario === 'refund-revoke') {
      afterFinal = assertB3SyntheticLearnerObservation(
        await inspectSyntheticLearners({ baseline: 'after-fresh-install-reseed', phase: 'final' }),
        'after-fresh-install-reseed',
      );
    }
  }
  const distributionBeforeScreenshot = distributionBeforeCapture;
  const deviceStore = await inspectDeviceStore();
  const terminal = await inspectTerminalEvidence();
  const proofObservationChain = await inspectProofObservationChain();
  const screenshot = await captureScreenshot();
  const distribution = await inspectDistribution({ fresh: true });
  if (!isDeepStrictEqual(distribution, distributionBeforeScreenshot)) {
    throw new Error('B3 Android installed distribution changed during screenshot capture');
  }
  const pending = {
    schemaVersion: 1,
    testedApplicationCommit: distribution.embeddedCommit,
    applicationFingerprint: distribution.embeddedFingerprint,
    platform: 'android-play-physical',
    device: deviceStore.device,
    store: deviceStore.store,
    transitions,
    storeCompletion: deviceStore.storeCompletion,
    proofObservationChain,
    distribution,
    gateway,
    transport: terminal.transport,
    storeTransactionAuthority: terminal.storeTransactionAuthority,
    refreshHandleLifecycle: terminal.refreshHandleLifecycle,
    entitlement: terminal.entitlement,
    pack: terminal.pack,
    syntheticLearnerAuthoritySha256: terminal.syntheticLearnerAuthoritySha256,
    learnerPreservation: [
      { scenario: 'purchase-install', baseline: 'before-purchase', learnerAInitialSha256: beforeInitial.learnerA, learnerAFinalSha256: beforeFinal.learnerA, learnerBInitialSha256: beforeInitial.learnerB, learnerBFinalSha256: beforeFinal.learnerB },
      { scenario: 'refund-revoke-after-fresh-install-reseed', baseline: 'after-fresh-install-reseed', learnerAInitialSha256: afterInitial.learnerA, learnerAFinalSha256: afterFinal.learnerA, learnerBInitialSha256: afterInitial.learnerB, learnerBFinalSha256: afterFinal.learnerB },
    ],
    restore: terminal.restore,
    screenshotSha256: screenshot.sha256,
    manualVisualInspection: 'pending',
  };
  validateB3PendingPlatformEvidence(pending);
  assertB3GatewayEquality({ ...pending, manualVisualInspection: 'passed' }, cloudflare);
  if (write) await writePendingAtomically(resolve(root, '.native-build/b3/evidence/android-pending.json'), pending);
  return Object.freeze(pending);
}

export async function pollSlowCard({ poll, wait, maximumPolls = POLL_LIMIT }) {
  if (typeof poll !== 'function' || typeof wait !== 'function' || maximumPolls !== POLL_LIMIT) {
    throw new Error('slow-card polling authority is invalid');
  }
  for (let count = 0; count < maximumPolls; count += 1) {
    const state = await poll();
    if (state !== 'pending') return state;
    if (count === maximumPolls - 1) break;
    await wait(POLL_INTERVAL_MS);
  }
  throw new Error('slow-card polling exceeded ten minutes');
}

export async function holdUnacknowledgedPurchase({ wait, release }) {
  if (typeof wait !== 'function' || typeof release !== 'function') throw new Error('unacknowledged hold authority is invalid');
  try {
    await wait(5_000);
  } finally {
    await release();
  }
}

function argument(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}

export function b3AndroidProofExitCode(error) {
  return error?.code === 'b3_operator_action_required' &&
    B3_OPERATOR_INSTRUCTION_CODES.has(error?.instructionCode) ? 7 : 6;
}

export function b3AndroidProofErrorRecord(error) {
  if (b3AndroidProofExitCode(error) === 7) {
    return Object.freeze({
      ok: false,
      code: 'b3_operator_action_required',
      instructionCode: error.instructionCode,
    });
  }
  return Object.freeze({
    ok: false,
    code: error?.code ?? 'b3_android_proof_failed',
    message: error?.message,
  });
}

export async function runB3AndroidProofCli({
  env = process.env,
  root = ROOT,
  args = process.argv.slice(2),
  capturePrimitives,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    const attest = argument(args, '--attest');
    if (!attest) {
      const cloudflare = parseB3StrictJsonBytes(
        await readFile(resolve(root, 'reports/b3/cloudflare-sandbox-proof.json')),
        'B3 Cloudflare report',
      );
      await captureB3AndroidEvidenceWithPrimitives({
        root,
        approvalFile: env.B3_PREREQUISITES_FILE,
        runToken: env.B3_REMOTE_RUN_TOKEN,
        approvedScope: env.B3_REMOTE_MUTATION_SCOPE,
        primitives: capturePrimitives ?? createDefaultB3AndroidCaptureAdapter({
          root,
          env,
          resumeStoreAction: args.includes('--resume-store-action'),
          resumeReinstall: args.includes('--resume-reinstall'),
          capturePlayProtectSettings: args.includes('--capture-play-protect'),
        }),
        cloudflare,
        write: true,
      });
      stdout.write(`${JSON.stringify({ ok: false, code: 'b3_android_manual_attestation_required', evidencePath: '.native-build/b3/evidence/android-pending.json' })}\n`);
      return 5;
    }
    await validateB3LocalMutationAuthority({
      approvalFile: env.B3_PREREQUISITES_FILE,
      runToken: env.B3_REMOTE_RUN_TOKEN,
      requestedScope: B3_ANDROID_REMOTE_SCOPE,
      root,
    });
    const [pendingRecord, cloudflareBytes, attestationRecord] = await Promise.all([
      readValidatedB3OperatorJson({ path: resolve(root, '.native-build/b3/evidence/android-pending.json'), label: 'B3 Android pending evidence', root }),
      readFile(resolve(root, 'reports/b3/cloudflare-sandbox-proof.json')),
      readValidatedB3OperatorJson({ path: resolve(attest), label: 'B3 Android manual attestation', root }),
    ]);
    const pending = pendingRecord.value;
    const cloudflare = parseB3StrictJsonBytes(cloudflareBytes, 'B3 Cloudflare report');
    const attestation = attestationRecord.value;
    if (attestation?.platform !== 'android-play-physical' || attestation?.screenshotPath !== 'reports/b3/android-sandbox-proof.png' ||
        attestation?.screenshotSha256 !== pending.screenshotSha256 || attestation?.manualVisualInspection !== 'passed' || Object.keys(attestation).length !== 4) {
      throw new Error('B3 Android manual attestation is invalid');
    }
    pending.manualVisualInspection = attestation.manualVisualInspection;
    const report = finaliseB3AndroidEvidence({ platform: pending, cloudflare });
    await writeFile(resolve(root, 'reports/b3/android-sandbox-proof.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    stdout.write(`${JSON.stringify({ ok: true, platform: report.platform })}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${JSON.stringify(b3AndroidProofErrorRecord(error))}\n`);
    return b3AndroidProofExitCode(error);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runB3AndroidProofCli();
}
