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
  B3_IOS_SCENARIOS,
  validateB3PlatformEvidence,
  validateB3PendingPlatformEvidence,
} from './lib/b3-evidence.mjs';
import {
  assertB3RemoteMutationScope,
  validateB3CloudflareDeploymentDraft,
  validateB3DeviceGatewaySmokeProjection,
} from './lib/b3-cloudflare-evidence.mjs';
import { createDefaultB3IosCaptureAdapter } from './lib/b3-live-capture-adapters.mjs';
import { b3PlatformGatewayFromDeploymentDraft } from './prove-b3-cloudflare.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const B3_IOS_REMOTE_SCOPE = 'apple-sandbox-history-refund';
const B3_OPERATOR_INSTRUCTION_CODES = new Set([
  'START_CAPTURE', 'COMPLETE_STORE_ACTION', 'APPROVE_PENDING_PURCHASE',
  'DECLINE_PENDING_PURCHASE', 'REINSTALL_EXACT_BUILD',
]);

export function assertB3IosCaptureInput(value, { approvedScope, runToken, requireScope = false } = {}) {
  if (requireScope) assertB3RemoteMutationScope({ approvedScope, runToken, expectedScope: B3_IOS_REMOTE_SCOPE });
  const evidence = validateB3PlatformEvidence(value);
  if (evidence.platform !== 'ios-physical' || evidence.device.physical !== true || evidence.distribution.kind !== 'development') {
    throw new Error('B3 iOS proof requires a physical development-signed distribution');
  }
  return evidence;
}

export function finaliseB3IosEvidence({ platform, cloudflare }) {
  if (platform?.manualVisualInspection !== 'passed') throw new Error('B3 iOS manual visual inspection is not passed');
  const evidence = assertB3IosCaptureInput(platform);
  if (cloudflare?.testedApplicationCommit !== evidence.testedApplicationCommit ||
      cloudflare?.applicationFingerprint !== evidence.applicationFingerprint) {
    throw new Error('B3 iOS and Cloudflare application authority differ');
  }
  return assertB3GatewayEquality(evidence, cloudflare);
}

function requirePrimitive(primitives, name) {
  if (typeof primitives?.[name] !== 'function') throw new Error(`B3 iOS physical primitive is missing: ${name}`);
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

export async function captureB3IosEvidenceWithPrimitives({
  root = ROOT,
  approvalFile,
  runToken,
  approvedScope,
  clock,
  gitRunner,
  authorityGate = validateB3LocalMutationAuthority,
  primitives,
  deploymentDraft,
  write = false,
} = {}) {
  assertB3RemoteMutationScope({ approvedScope, runToken, expectedScope: B3_IOS_REMOTE_SCOPE });
  await authorityGate({ approvalFile, runToken, requestedScope: B3_IOS_REMOTE_SCOPE, root, clock, gitRunner });
  const validatedDraft = validateB3CloudflareDeploymentDraft(deploymentDraft);
  const gateway = b3PlatformGatewayFromDeploymentDraft(validatedDraft);
  const recoverAmbiguousCapture = requirePrimitive(primitives, 'recoverAmbiguousCapture');
  const inspectDistribution = requirePrimitive(primitives, 'inspectDistribution');
  const inspectDeviceStore = requirePrimitive(primitives, 'inspectDeviceStore');
  const inspectSyntheticLearners = requirePrimitive(primitives, 'inspectSyntheticLearners');
  const runScenario = requirePrimitive(primitives, 'runScenario');
  const inspectGatewaySmoke = requirePrimitive(primitives, 'inspectGatewaySmoke');
  const inspectTerminalEvidence = requirePrimitive(primitives, 'inspectTerminalEvidence');
  const inspectProofObservationChain = requirePrimitive(primitives, 'inspectProofObservationChain');
  const inspectStoreKitTest = requirePrimitive(primitives, 'inspectStoreKitTest');
  const captureScreenshot = requirePrimitive(primitives, 'captureScreenshot');
  await recoverAmbiguousCapture();
  const distributionBeforeCapture = await inspectDistribution();
  if (validatedDraft.testedApplicationCommit !== distributionBeforeCapture.embeddedCommit ||
      validatedDraft.applicationFingerprint !== distributionBeforeCapture.embeddedFingerprint) {
    throw new Error('B3 iOS distribution and Cloudflare deployment draft authority differ');
  }
  const beforeInitial = assertB3SyntheticLearnerObservation(
    await inspectSyntheticLearners({ baseline: 'before-purchase', phase: 'initial' }),
    'before-purchase',
  );
  const transitions = [];
  let beforeFinal;
  let afterInitial;
  let afterFinal;
  for (const authority of B3_IOS_SCENARIOS) {
    transitions.push(await runScenario(structuredClone(authority)));
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
  validateB3DeviceGatewaySmokeProjection(await inspectGatewaySmoke(), validatedDraft);
  const deviceStore = await inspectDeviceStore();
  const terminal = await inspectTerminalEvidence();
  const proofObservationChain = await inspectProofObservationChain();
  const storeKitTest = await inspectStoreKitTest();
  const screenshot = await captureScreenshot();
  const distribution = await inspectDistribution({ fresh: true });
  if (!isDeepStrictEqual(distribution, distributionBeforeCapture)) {
    throw new Error('B3 iOS installed distribution changed during physical capture');
  }
  const pending = {
    schemaVersion: 1,
    testedApplicationCommit: distribution.embeddedCommit,
    applicationFingerprint: distribution.embeddedFingerprint,
    platform: 'ios-physical',
    device: deviceStore.device,
    store: deviceStore.store,
    transitions,
    storeCompletion: deviceStore.storeCompletion,
    proofObservationChain,
    storeKitTest,
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
  if (write) await writePendingAtomically(resolve(root, '.native-build/b3/evidence/ios-pending.json'), pending);
  return Object.freeze(pending);
}

function argument(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}

export function b3IosProofExitCode(error) {
  return error?.code === 'b3_operator_action_required' &&
    B3_OPERATOR_INSTRUCTION_CODES.has(error?.instructionCode) ? 7 : 6;
}

export function b3IosProofErrorRecord(error) {
  if (b3IosProofExitCode(error) === 7) {
    return Object.freeze({
      ok: false,
      code: 'b3_operator_action_required',
      instructionCode: error.instructionCode,
    });
  }
  return Object.freeze({
    ok: false,
    code: error?.code ?? 'b3_ios_proof_failed',
    message: error?.message,
  });
}

export async function runB3IosProofCli({
  env = process.env,
  root = ROOT,
  args = process.argv.slice(2),
  capturePrimitives,
  authorityGate = validateB3LocalMutationAuthority,
  operatorJsonReader = readValidatedB3OperatorJson,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    const attest = argument(args, '--attest');
    if (!attest) {
      const deploymentDraft = (await operatorJsonReader({
        path: resolve(root, '.native-build/b3/evidence/cloudflare-deployment-draft.json'),
        label: 'B3 Cloudflare deployment draft',
        root,
      })).value;
      await captureB3IosEvidenceWithPrimitives({
        root,
        approvalFile: env.B3_PREREQUISITES_FILE,
        runToken: env.B3_REMOTE_RUN_TOKEN,
        approvedScope: env.B3_REMOTE_MUTATION_SCOPE,
        authorityGate,
        primitives: capturePrimitives ?? createDefaultB3IosCaptureAdapter({
          root,
          env,
          resumeStoreAction: args.includes('--resume-store-action'),
          resumeReinstall: args.includes('--resume-reinstall'),
        }),
        deploymentDraft,
        write: true,
      });
      stdout.write(`${JSON.stringify({ ok: false, code: 'b3_ios_manual_attestation_required', evidencePath: '.native-build/b3/evidence/ios-pending.json' })}\n`);
      return 5;
    }
    await authorityGate({
      approvalFile: env.B3_PREREQUISITES_FILE,
      runToken: env.B3_REMOTE_RUN_TOKEN,
      requestedScope: B3_IOS_REMOTE_SCOPE,
      root,
    });
    const [pendingRecord, cloudflareBytes, attestationRecord] = await Promise.all([
      operatorJsonReader({ path: resolve(root, '.native-build/b3/evidence/ios-pending.json'), label: 'B3 iOS pending evidence', root }),
      readFile(resolve(root, 'reports/b3/cloudflare-sandbox-proof.json')),
      operatorJsonReader({ path: resolve(attest), label: 'B3 iOS manual attestation', root }),
    ]);
    const pending = pendingRecord.value;
    const cloudflare = parseB3StrictJsonBytes(cloudflareBytes, 'B3 Cloudflare report');
    const attestation = attestationRecord.value;
    if (attestation?.platform !== 'ios-physical' || attestation?.screenshotPath !== 'reports/b3/ios-sandbox-proof.png' ||
        attestation?.screenshotSha256 !== pending.screenshotSha256 || attestation?.manualVisualInspection !== 'passed' || Object.keys(attestation).length !== 4) {
      throw new Error('B3 iOS manual attestation is invalid');
    }
    pending.manualVisualInspection = attestation.manualVisualInspection;
    const report = finaliseB3IosEvidence({ platform: pending, cloudflare });
    await writeFile(resolve(root, 'reports/b3/ios-sandbox-proof.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    stdout.write(`${JSON.stringify({ ok: true, platform: report.platform })}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${JSON.stringify(b3IosProofErrorRecord(error))}\n`);
    return b3IosProofExitCode(error);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runB3IosProofCli();
}
