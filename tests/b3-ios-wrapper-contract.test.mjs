import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createB3TestPng,
  createB3TestPngDimensionBomb,
} from './helpers/b3-test-png.mjs';
import {
  assertB3IosCaptureInput,
  b3IosProofExitCode,
  b3IosProofErrorRecord,
  captureB3IosEvidenceWithPrimitives,
  finaliseB3IosEvidence,
  runB3IosProofCli,
} from '../scripts/prove-b3-ios.mjs';
import {
  B3_TEST_COMMIT,
  B3_TEST_HASH,
  B3_TEST_WORKER_VERSION_ID,
  cloudflareEvidence,
  platformEvidence,
} from './helpers/b3-evidence-fixtures.mjs';

function cloudflareDeploymentDraft() {
  const live = cloudflareEvidence();
  return {
    schemaVersion: 1,
    testedApplicationCommit: B3_TEST_COMMIT,
    applicationFingerprint: B3_TEST_HASH,
    worker: structuredClone(live.worker),
    bucket: structuredClone(live.bucket),
    signedEnvelopeSha256: live.signedEnvelopeSha256,
    objects: structuredClone(live.objects),
    deploymentReadback: {
      deploymentVersionId: B3_TEST_WORKER_VERSION_ID,
      deployedSourceSha256: B3_TEST_HASH,
      versionApiMatched: true,
      contentBytesMatched: true,
      objects: live.objects.map(({ role, key, sha256, size, etag }) => ({
        role, key, sha256, size, etag, headMatched: true, getMatched: true,
      })),
    },
  };
}

function deviceGatewaySmoke(draft = cloudflareDeploymentDraft()) {
  return {
    schemaVersion: 1,
    deploymentVersionId: draft.worker.deploymentVersionId,
    scriptAuthoritySha256: draft.worker.scriptAuthoritySha256,
    signedEnvelopeSha256: draft.signedEnvelopeSha256,
    objects: draft.objects.map(({ role, key, sha256, size, etag }) => ({
      role, key, sha256, size, etag,
    })),
    capability: {
      ttlSeconds: 600,
      valid: true,
      tamperedRejected: true,
      expiredRejected: true,
      canonicalEncodingRequired: true,
    },
    range: {
      full200: true,
      partial206: true,
      conditional304: true,
      unsatisfied416: true,
      noRedirects: true,
      cacheControl: 'private, no-store',
    },
  };
}

function cliCapturePrimitives(platform, deploymentDraft, dispose = async () => {}) {
  const learners = (baseline) => {
    const row = platform.learnerPreservation.find((entry) => entry.baseline === baseline);
    return [
      { learnerId: 'learner-a', nickname: 'Ada', digest: row.learnerAInitialSha256 },
      { learnerId: 'learner-b', nickname: 'Ben', digest: row.learnerBInitialSha256 },
    ];
  };
  return {
    pinInvocation: async () => Object.freeze({ invocation: 'ios-cli' }),
    finaliseInvocation: async () => Object.freeze({ status: 'not-applicable' }),
    inspectDistribution: async () => platform.distribution,
    inspectDeviceStore: async () => ({
      device: platform.device,
      store: platform.store,
      storeCompletion: platform.storeCompletion,
    }),
    inspectSyntheticLearners: async ({ baseline }) => learners(baseline),
    runScenario: async ({ scenario }) =>
      platform.transitions.find((entry) => entry.scenario === scenario),
    inspectGatewaySmoke: async () => deviceGatewaySmoke(deploymentDraft),
    inspectTerminalEvidence: async () => ({
      transport: platform.transport,
      storeTransactionAuthority: platform.storeTransactionAuthority,
      refreshHandleLifecycle: platform.refreshHandleLifecycle,
      entitlement: platform.entitlement,
      pack: platform.pack,
      syntheticLearnerAuthoritySha256: platform.syntheticLearnerAuthoritySha256,
      restore: platform.restore,
    }),
    inspectProofObservationChain: async () => platform.proofObservationChain,
    inspectStoreKitTest: async () => platform.storeKitTest,
    captureScreenshot: async () => ({ sha256: platform.screenshotSha256 }),
    dispose,
  };
}

test('iOS wrapper requires physical development distribution and screenshot SHA attestation', () => {
  const platform = platformEvidence();
  assert.equal(assertB3IosCaptureInput(platform).distribution.kind, 'development');
  const simulator = structuredClone(platform);
  simulator.device.physical = false;
  assert.throws(() => assertB3IosCaptureInput(simulator), /physical/i);
  const wrongCertificate = structuredClone(platform);
  wrongCertificate.distribution.signingCertificateSha256 = 'a'.repeat(64);
  assert.throws(() => assertB3IosCaptureInput(wrongCertificate), /closed schema|certificate/i);
  assert.equal(
    finaliseB3IosEvidence({ platform, cloudflare: cloudflareEvidence() })
      .gateway.deploymentVersionId,
    B3_TEST_WORKER_VERSION_ID,
  );
  assert.throws(() => finaliseB3IosEvidence({
    platform,
    cloudflare: { ...cloudflareEvidence(), testedApplicationCommit: 'c'.repeat(40) },
  }), /application authority/i);
  assert.throws(() => finaliseB3IosEvidence({ platform: { ...platform, manualVisualInspection: 'pending' }, cloudflare: cloudflareEvidence() }), /pending|manual/i);
});

test('iOS capture owns exact scenario order, learner redaction and scope-before-primitives', async () => {
  const platform = platformEvidence();
  const deploymentDraft = cloudflareDeploymentDraft();
  const calls = [];
  const physicalOrder = [];
  const learnerCalls = [];
  const learners = (baseline) => {
    const row = platform.learnerPreservation.find((entry) => entry.baseline === baseline);
    return [
      { learnerId: 'learner-a', nickname: 'Ada', digest: row.learnerAInitialSha256 },
      { learnerId: 'learner-b', nickname: 'Ben', digest: row.learnerBInitialSha256 },
    ];
  };
  const primitives = {
    pinInvocation: async () => {
      physicalOrder.push('invocation-pinned');
      return Object.freeze({ invocation: 'ios-test' });
    },
    finaliseInvocation: async ({ invocation, distribution }) => {
      assert.deepEqual(invocation, { invocation: 'ios-test' });
      assert.equal(distribution, platform.distribution);
      physicalOrder.push('invocation-finalised');
      return Object.freeze({ status: 'not-applicable' });
    },
    inspectDistribution: async ({ fresh = false } = {}) => {
      physicalOrder.push(fresh ? 'distribution-after' : 'distribution-before');
      return platform.distribution;
    },
    inspectDeviceStore: async () => {
      physicalOrder.push('device-store');
      return { device: platform.device, store: platform.store, storeCompletion: platform.storeCompletion };
    },
    inspectSyntheticLearners: async ({ baseline, phase }) => {
      learnerCalls.push(`${baseline}:${phase}`);
      return learners(baseline);
    },
    runScenario: async ({ scenario }) => platform.transitions.find((entry) => entry.scenario === scenario),
    inspectGatewaySmoke: async () => {
      physicalOrder.push('gateway-smoke');
      return deviceGatewaySmoke(deploymentDraft);
    },
    inspectTerminalEvidence: async () => {
      physicalOrder.push('terminal');
      return {
        transport: platform.transport, storeTransactionAuthority: platform.storeTransactionAuthority,
        refreshHandleLifecycle: platform.refreshHandleLifecycle, entitlement: platform.entitlement,
        pack: platform.pack, syntheticLearnerAuthoritySha256: platform.syntheticLearnerAuthoritySha256,
        restore: platform.restore,
      };
    },
    inspectProofObservationChain: async () => {
      physicalOrder.push('chain');
      return platform.proofObservationChain;
    },
    inspectStoreKitTest: async () => {
      physicalOrder.push('storekit');
      return platform.storeKitTest;
    },
    captureScreenshot: async () => {
      physicalOrder.push('screenshot');
      return { sha256: platform.screenshotSha256 };
    },
  };
  const pending = await captureB3IosEvidenceWithPrimitives({
    approvalFile: '/operator/approval.json', runToken: 'a'.repeat(64), approvedScope: 'apple-sandbox-history-refund', deploymentDraft, primitives,
    authorityGate: async ({ requestedScope }) => calls.push(requestedScope),
  });
  assert.equal(pending.manualVisualInspection, 'pending');
  assert.deepEqual(pending.transitions.map(({ scenario }) => scenario), platform.transitions.map(({ scenario }) => scenario));
  assert.equal(JSON.stringify(pending).includes('Ada'), false);
  assert.deepEqual(calls, ['apple-sandbox-history-refund']);
  assert.deepEqual(learnerCalls, [
    'before-purchase:initial', 'before-purchase:final',
    'after-fresh-install-reseed:initial', 'after-fresh-install-reseed:final',
  ]);
  assert.deepEqual(physicalOrder, [
    'invocation-pinned',
    'distribution-before',
    'invocation-finalised',
    'gateway-smoke',
    'device-store', 'terminal', 'chain', 'storekit',
    'screenshot', 'distribution-after',
  ]);
  let distributionReads = 0;
  await assert.rejects(captureB3IosEvidenceWithPrimitives({
    approvalFile: '/operator/approval.json', runToken: 'a'.repeat(64),
    approvedScope: 'apple-sandbox-history-refund', deploymentDraft,
    primitives: {
      ...primitives,
      inspectDistribution: async () => (++distributionReads === 1
        ? platform.distribution
        : { ...platform.distribution, installedBuild: '999' }),
    },
    authorityGate: async () => {},
  }), /distribution changed/i);
  await assert.rejects(captureB3IosEvidenceWithPrimitives({
    approvalFile: '/operator/approval.json', runToken: 'a'.repeat(64), approvedScope: 'google-test-track-refund-revoke',
    deploymentDraft, primitives, authorityGate: async () => {},
  }), /scope/i);
  let primitiveCalls = 0;
  const counted = new Proxy({}, { get: () => async () => { primitiveCalls += 1; } });
  await assert.rejects(captureB3IosEvidenceWithPrimitives({
    runToken: 'c'.repeat(64), approvedScope: 'apple-sandbox-history-refund', deploymentDraft, primitives: counted,
    authorityGate: async () => { throw new Error('run token rejected'); },
  }), /run token rejected/);
  assert.equal(primitiveCalls, 0);

  const crossAuthorityDraft = cloudflareDeploymentDraft();
  crossAuthorityDraft.testedApplicationCommit = 'c'.repeat(40);
  let crossAuthorityFinaliseCalls = 0;
  let crossAuthorityLaterCalls = 0;
  await assert.rejects(captureB3IosEvidenceWithPrimitives({
    approvalFile: '/operator/approval.json', runToken: 'a'.repeat(64),
    approvedScope: 'apple-sandbox-history-refund', deploymentDraft: crossAuthorityDraft,
    primitives: {
      ...primitives,
      inspectDistribution: async () => platform.distribution,
      finaliseInvocation: async () => {
        crossAuthorityFinaliseCalls += 1;
        return Object.freeze({ status: 'not-applicable' });
      },
      inspectSyntheticLearners: async () => { crossAuthorityLaterCalls += 1; },
    },
    authorityGate: async () => {},
  }), /distribution.*Cloudflare.*authority/i);
  assert.equal(crossAuthorityFinaliseCalls, 0);
  assert.equal(crossAuthorityLaterCalls, 0);

  const invalidDraft = structuredClone(deploymentDraft);
  invalidDraft.worker.deploymentVersionId = invalidDraft.worker.deploymentVersionId.toUpperCase();
  await assert.rejects(captureB3IosEvidenceWithPrimitives({
    runToken: 'c'.repeat(64), approvedScope: 'apple-sandbox-history-refund',
    deploymentDraft: invalidDraft, primitives: counted, authorityGate: async () => {},
  }), /deployment draft|readback authority|Cloudflare/i);
  assert.equal(primitiveCalls, 0);

  const wrongSmoke = deviceGatewaySmoke(deploymentDraft);
  wrongSmoke.deploymentVersionId = 'b8f32f60-16b9-4ca6-9b4a-f771dd5302f7';
  await assert.rejects(captureB3IosEvidenceWithPrimitives({
    approvalFile: '/operator/approval.json', runToken: 'a'.repeat(64),
    approvedScope: 'apple-sandbox-history-refund', deploymentDraft,
    primitives: { ...primitives, inspectGatewaySmoke: async () => wrongSmoke },
    authorityGate: async () => {},
  }), /smoke|deployment|authority/i);
});

test('iOS wrapper rejects an invocation tail created during distribution inspection before device work', async () => {
  const platform = platformEvidence();
  const deploymentDraft = cloudflareDeploymentDraft();
  const primitives = cliCapturePrimitives(platform, deploymentDraft);
  let tail = 'absent';
  let laterDeviceCalls = 0;
  await assert.rejects(captureB3IosEvidenceWithPrimitives({
    approvalFile: '/operator/approval.json',
    runToken: 'a'.repeat(64),
    approvedScope: 'apple-sandbox-history-refund',
    deploymentDraft,
    authorityGate: async () => {},
    primitives: {
      ...primitives,
      pinInvocation: async () => Object.freeze({ tail }),
      inspectDistribution: async () => {
        tail = 'planned-rebind';
        return platform.distribution;
      },
      finaliseInvocation: async ({ invocation }) => Object.freeze({
        status: invocation.tail === tail ? 'not-applicable' : 'rejected',
      }),
      inspectSyntheticLearners: async () => {
        laterDeviceCalls += 1;
        throw new Error('unexpected device work');
      },
    },
  }), /recovery.*rejected|pinned invocation/i);
  assert.equal(laterDeviceCalls, 0);
});

test('iOS wrapper accepts only closed successful recovery finalisation results', async () => {
  const platform = platformEvidence();
  const deploymentDraft = cloudflareDeploymentDraft();
  const base = cliCapturePrimitives(platform, deploymentDraft);
  for (const status of ['recovered', 'already-recovered']) {
    const pending = await captureB3IosEvidenceWithPrimitives({
      approvalFile: '/operator/approval.json', runToken: 'a'.repeat(64),
      approvedScope: 'apple-sandbox-history-refund', deploymentDraft,
      authorityGate: async () => {},
      primitives: {
        ...base,
        finaliseInvocation: async () => Object.freeze({ status }),
      },
    });
    assert.equal(pending.platform, 'ios-physical');
  }
  for (const [label, result, expected] of [
    ['operator', Object.freeze({ status: 'operator-required' }), (error) =>
      b3IosProofExitCode(error) === 7 && error.instructionCode === 'REINSTALL_EXACT_BUILD'],
    ['rejected', Object.freeze({ status: 'rejected' }), /recovery.*rejected/i],
    ['malformed', Object.freeze({ status: 'recovered', extra: true }), /finalisation.*invalid|recovery.*invalid/i],
    ['unknown', Object.freeze({ status: 'later-status' }), /finalisation.*invalid|recovery.*invalid/i],
    ['absent', undefined, /finalisation.*invalid|recovery.*invalid/i],
  ]) {
    let laterDeviceCalls = 0;
    await assert.rejects(captureB3IosEvidenceWithPrimitives({
      approvalFile: '/operator/approval.json', runToken: 'a'.repeat(64),
      approvedScope: 'apple-sandbox-history-refund', deploymentDraft,
      authorityGate: async () => {},
      primitives: {
        ...base,
        finaliseInvocation: async () => result,
        inspectSyntheticLearners: async () => {
          laterDeviceCalls += 1;
          throw new Error(`unexpected ${label} device work`);
        },
      },
    }), expected);
    assert.equal(laterDeviceCalls, 0);
  }
});

test('iOS Task22 exposes real host utilities and fails closed before device work without authority', async () => {
  const adapter = await import('../scripts/lib/b3-live-capture-adapters.mjs').catch(() => ({}));
  assert.equal(typeof adapter.createDefaultB3IosCaptureAdapter, 'function');
  assert.equal(typeof adapter.persistB3PlatformScreenshot, 'function');
  assert.equal(typeof adapter.readB3CaptureCheckpoint, 'function');
  await assert.rejects(
    adapter.createDefaultB3IosCaptureAdapter({ root: '/tmp', env: {} })
      .inspectSyntheticLearners({ baseline: 'before-purchase', phase: 'initial' }),
    /signed distribution path|required/i,
  );
  const hostile = {
    code: 'b3_operator_action_required',
    instructionCode: 'COMPLETE_STORE_ACTION',
    message: 'secret free text must never leave the host',
  };
  assert.equal(b3IosProofExitCode(hostile), 7);
  assert.deepEqual(b3IosProofErrorRecord(hostile), {
    ok: false,
    code: 'b3_operator_action_required',
    instructionCode: 'COMPLETE_STORE_ACTION',
  });
  assert.equal(JSON.stringify(b3IosProofErrorRecord(hostile)).includes('secret'), false);
  assert.equal(b3IosProofExitCode({ ...hostile, instructionCode: 'FREE_TEXT' }), 6);
  assert.equal(b3IosProofExitCode(new Error('ordinary failure')), 6);
});

test('iOS CLI captures from the ignored deployment draft, then binds final attestation to the later Cloudflare report', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-ios-order-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidenceDirectory = join(root, '.native-build/b3/evidence');
  const reportsDirectory = join(root, 'reports/b3');
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  const deploymentDraft = cloudflareDeploymentDraft();
  await writeFile(
    join(evidenceDirectory, 'cloudflare-deployment-draft.json'),
    `${JSON.stringify(deploymentDraft, null, 2)}\n`,
    { mode: 0o600 },
  );
  const platform = platformEvidence();
  const env = {
    B3_PREREQUISITES_FILE: '/operator/approval.json',
    B3_REMOTE_RUN_TOKEN: 'a'.repeat(64),
    B3_REMOTE_MUTATION_SCOPE: 'apple-sandbox-history-refund',
  };
  const stdout = [];
  const stderr = [];
  let successfulDisposals = 0;
  let failedDisposals = 0;
  const stream = (target) => ({ write: (value) => target.push(value) });
  const operatorJsonReader = async ({ path }) => ({
    value: JSON.parse(await readFile(path, 'utf8')),
  });
  const failedPrimitives = cliCapturePrimitives(
    platform,
    deploymentDraft,
    async () => { failedDisposals += 1; },
  );
  failedPrimitives.pinInvocation = async () => {
    throw new Error('injected capture failure');
  };
  assert.equal(await runB3IosProofCli({
    root,
    env,
    args: [],
    capturePrimitives: failedPrimitives,
    authorityGate: async () => {},
    operatorJsonReader,
    stdout: stream(stdout),
    stderr: stream(stderr),
  }), 6);
  assert.equal(failedDisposals, 1);
  assert.equal(await runB3IosProofCli({
    root,
    env,
    args: [],
    capturePrimitives: cliCapturePrimitives(
      platform,
      deploymentDraft,
      async () => { successfulDisposals += 1; },
    ),
    authorityGate: async () => {},
    operatorJsonReader,
    stdout: stream(stdout),
    stderr: stream(stderr),
  }), 5);
  assert.equal(successfulDisposals, 1);
  assert.deepEqual(JSON.parse(stdout.pop()), {
    ok: false,
    code: 'b3_ios_manual_attestation_required',
    evidencePath: '.native-build/b3/evidence/ios-pending.json',
  });
  await assert.rejects(
    readFile(join(reportsDirectory, 'cloudflare-sandbox-proof.json')),
    /ENOENT/u,
  );
  const pending = JSON.parse(await readFile(join(evidenceDirectory, 'ios-pending.json'), 'utf8'));
  assert.deepEqual(pending.gateway, platform.gateway);

  const attestationPath = join(root, '.native-build/b3/ios-attestation.json');
  await writeFile(attestationPath, `${JSON.stringify({
    platform: 'ios-physical',
    screenshotPath: 'reports/b3/ios-sandbox-proof.png',
    screenshotSha256: platform.screenshotSha256,
    manualVisualInspection: 'passed',
  })}\n`, { mode: 0o600 });
  assert.equal(await runB3IosProofCli({
    root,
    env,
    args: ['--attest', attestationPath],
    authorityGate: async () => {},
    operatorJsonReader,
    stdout: stream(stdout),
    stderr: stream(stderr),
  }), 6);
  await assert.rejects(
    readFile(join(reportsDirectory, 'ios-sandbox-proof.json')),
    /ENOENT/u,
  );

  await mkdir(reportsDirectory, { recursive: true });
  await writeFile(
    join(reportsDirectory, 'cloudflare-sandbox-proof.json'),
    `${JSON.stringify(cloudflareEvidence(), null, 2)}\n`,
  );
  assert.equal(await runB3IosProofCli({
    root,
    env,
    args: ['--attest', attestationPath],
    authorityGate: async () => {},
    operatorJsonReader,
    stdout: stream(stdout),
    stderr: stream(stderr),
  }), 0);
  assert.equal(
    JSON.parse(await readFile(join(reportsDirectory, 'ios-sandbox-proof.json'), 'utf8'))
      .gateway.deploymentVersionId,
    B3_TEST_WORKER_VERSION_ID,
  );
});

test('iOS B3 proof transport is fixed-path, launch-argument only and absent outside the proof build', async () => {
  const root = new URL('../', import.meta.url);
  const [plugin, delegate, project, normalScheme, proofScheme, info] = await Promise.all([
    readFile(new URL('ios/App/App/B3ProofObservationPlugin.swift', root), 'utf8'),
    readFile(new URL('ios/App/App/AppDelegate.swift', root), 'utf8'),
    readFile(new URL('ios/App/App.xcodeproj/project.pbxproj', root), 'utf8'),
    readFile(new URL('ios/App/App.xcodeproj/xcshareddata/xcschemes/KS2Spelling.xcscheme', root), 'utf8'),
    readFile(new URL('ios/App/App.xcodeproj/xcshareddata/xcschemes/B3SandboxProof.xcscheme', root), 'utf8'),
    readFile(new URL('ios/App/App/Info.plist', root), 'utf8'),
  ]);

  assert.match(plugin, /#if B3_SANDBOX_PROOF/u);
  assert.match(plugin, /CAPBridgedPlugin/u);
  assert.match(plugin, /getLaunchCommand/u);
  assert.match(plugin, /publishObservation/u);
  assert.match(plugin, /--b3-proof-command-v1/u);
  assert.match(plugin, /b3-proof-observation-v1\.json/u);
  assert.match(plugin, /applicationSupportDirectory/u);
  assert.match(plugin, /\.atomic/u);
  assert.match(plugin, /completeFileProtection/u);
  assert.match(plugin, /isExcludedFromBackup/u);
  assert.match(plugin, /isSymbolicLink/u);
  assert.match(plugin, /isRegularFile/u);
  assert.match(delegate, /#if B3_SANDBOX_PROOF[\s\S]*registerPluginInstance\(B3ProofObservationPlugin\(\)\)[\s\S]*#endif/u);
  assert.match(project, /B3ProofObservationPlugin\.swift in Sources/u);
  assert.doesNotMatch(normalScheme, /buildConfiguration = "B3SandboxProof"/u);
  assert.match(proofScheme, /buildConfiguration = "B3SandboxProof"/u);
  assert.doesNotMatch(info, /CFBundleURLTypes|b3-proof-observation/u);
});

test('screenshot persistence keeps owned exact PNG bytes and rejects operator paths', async (t) => {
  const adapter = await import('../scripts/lib/b3-live-capture-adapters.mjs');
  const root = await mkdtemp(join(tmpdir(), 'b3-png-root-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const png = createB3TestPng({ width: 1179, height: 2556 });
  const result = await adapter.persistB3PlatformScreenshot({ root, platform: 'ios', bytes: png });
  const destination = join(root, result.path);
  assert.deepEqual(await readFile(destination), png);
  assert.equal((await lstat(destination)).mode & 0o777, 0o600);
  await assert.rejects(
    adapter.persistB3PlatformScreenshot({ root, platform: 'ios', bytes: png }),
    /exist|EEXIST/i,
  );
  await assert.rejects(
    adapter.persistB3PlatformScreenshot({ root, platform: 'android', sourcePath: '/tmp/operator.png' }),
    /PNG|screenshot/i,
  );
  await assert.rejects(
    adapter.persistB3PlatformScreenshot({
      root,
      platform: 'android',
      bytes: createB3TestPngDimensionBomb(),
    }),
    /bounded|PNG/i,
  );
});

test('StoreKit evidence hashes the exact committed deterministic report transcript', async (t) => {
  const { inspectB3DeterministicStoreKitReport } =
    await import('../scripts/lib/b3-live-capture-adapters.mjs');
  const root = await mkdtemp(join(tmpdir(), 'b3-storekit-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'reports/b3'), { recursive: true });
  const report = {
    schemaVersion: 1,
    status: 'pass',
    evidenceBoundary: {
      deterministicFakes: true,
      liveStoreProof: false,
      liveCloudProof: false,
      physicalDeviceProof: false,
    },
    nonLiveStoreKit: {
      evidenceKind: 'xcode-storekit-test-non-live',
      physicalSandbox: false,
      liveStore: false,
      cases: [
        { name: 'delayed-approve', initialOutcome: 'pending', finalOutcome: 'purchased' },
        { name: 'delayed-decline', initialOutcome: 'pending', finalOutcome: 'cancelled' },
      ],
    },
  };
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(join(root, 'reports/b3/deterministic-proof.json'), bytes);
  assert.deepEqual(await inspectB3DeterministicStoreKitReport({ root }), {
    reportSha256: createHash('sha256').update(bytes).digest('hex'),
    scenarios: ['storekit-test-pending-approve', 'storekit-test-pending-decline'],
    liveSandbox: false,
  });

  report.nonLiveStoreKit.cases.reverse();
  await writeFile(
    join(root, 'reports/b3/deterministic-proof.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await assert.rejects(
    inspectB3DeterministicStoreKitReport({ root }),
    /StoreKit|transcript|authority/i,
  );
});
