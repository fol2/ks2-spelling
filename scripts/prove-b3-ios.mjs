import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
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
  b3PlatformGatewayFromCloudflare,
  validateB3PlatformEvidence,
  validateB3PendingPlatformEvidence,
} from './lib/b3-evidence.mjs';
import { assertB3RemoteMutationScope } from './lib/b3-cloudflare-evidence.mjs';
import { createDefaultB3IosCaptureAdapter } from './lib/b3-live-capture-adapters.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const B3_IOS_REMOTE_SCOPE = 'apple-sandbox-history-refund';

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
  cloudflare,
  write = false,
} = {}) {
  assertB3RemoteMutationScope({ approvedScope, runToken, expectedScope: B3_IOS_REMOTE_SCOPE });
  await authorityGate({ approvalFile, runToken, requestedScope: B3_IOS_REMOTE_SCOPE, root, clock, gitRunner });
  const inspectDistribution = requirePrimitive(primitives, 'inspectDistribution');
  const inspectDeviceStore = requirePrimitive(primitives, 'inspectDeviceStore');
  const inspectSyntheticLearners = requirePrimitive(primitives, 'inspectSyntheticLearners');
  const runScenario = requirePrimitive(primitives, 'runScenario');
  const inspectTerminalEvidence = requirePrimitive(primitives, 'inspectTerminalEvidence');
  const inspectStoreKitTest = requirePrimitive(primitives, 'inspectStoreKitTest');
  const captureScreenshot = requirePrimitive(primitives, 'captureScreenshot');
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
  const [distribution, deviceStore, terminal, storeKitTest, screenshot] = await Promise.all([
    inspectDistribution(), inspectDeviceStore(), inspectTerminalEvidence(),
    inspectStoreKitTest(), captureScreenshot(),
  ]);
  const gateway = b3PlatformGatewayFromCloudflare(cloudflare);
  const pending = {
    schemaVersion: 1,
    testedApplicationCommit: distribution.embeddedCommit,
    applicationFingerprint: distribution.embeddedFingerprint,
    platform: 'ios-physical',
    device: deviceStore.device,
    store: deviceStore.store,
    transitions,
    storeCompletion: deviceStore.storeCompletion,
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
  assertB3GatewayEquality({ ...pending, manualVisualInspection: 'passed' }, cloudflare);
  if (write) await writePendingAtomically(resolve(root, '.native-build/b3/evidence/ios-pending.json'), pending);
  return Object.freeze(pending);
}

function argument(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}

export async function runB3IosProofCli({
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
      await captureB3IosEvidenceWithPrimitives({
        root,
        approvalFile: env.B3_PREREQUISITES_FILE,
        runToken: env.B3_REMOTE_RUN_TOKEN,
        approvedScope: env.B3_REMOTE_MUTATION_SCOPE,
        primitives: capturePrimitives ?? createDefaultB3IosCaptureAdapter({ root, env }),
        cloudflare,
        write: true,
      });
      stdout.write(`${JSON.stringify({ ok: false, code: 'b3_ios_manual_attestation_required', evidencePath: '.native-build/b3/evidence/ios-pending.json' })}\n`);
      return 5;
    }
    await validateB3LocalMutationAuthority({
      approvalFile: env.B3_PREREQUISITES_FILE,
      runToken: env.B3_REMOTE_RUN_TOKEN,
      requestedScope: B3_IOS_REMOTE_SCOPE,
      root,
    });
    const [pendingRecord, cloudflareBytes, attestationRecord] = await Promise.all([
      readValidatedB3OperatorJson({ path: resolve(root, '.native-build/b3/evidence/ios-pending.json'), label: 'B3 iOS pending evidence', root }),
      readFile(resolve(root, 'reports/b3/cloudflare-sandbox-proof.json')),
      readValidatedB3OperatorJson({ path: resolve(attest), label: 'B3 iOS manual attestation', root }),
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
    stderr.write(`${JSON.stringify({ ok: false, code: error.code ?? 'b3_ios_proof_failed', message: error.message })}\n`);
    return 6;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runB3IosProofCli();
}
