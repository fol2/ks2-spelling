import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertB3AndroidCaptureInput,
  b3AndroidProofExitCode,
  b3AndroidProofErrorRecord,
  captureB3AndroidEvidenceWithPrimitives,
  finaliseB3AndroidEvidence,
  pollSlowCard,
  holdUnacknowledgedPurchase,
  runB3AndroidProofCli,
} from '../scripts/prove-b3-android.mjs';
import {
  createB3AndroidSlowCardController,
} from '../scripts/lib/b3-live-capture-adapters.mjs';
import {
  cloudflareEvidence,
  platformEvidence,
} from './helpers/b3-evidence-fixtures.mjs';

function androidCliCapturePrimitives(platform, dispose = async () => {}) {
  const learners = (baseline) => {
    const row = platform.learnerPreservation.find((entry) => entry.baseline === baseline);
    return [
      { learnerId: 'learner-a', nickname: 'Ada', digest: row.learnerAInitialSha256 },
      { learnerId: 'learner-b', nickname: 'Ben', digest: row.learnerBInitialSha256 },
    ];
  };
  const transition = ({ scenario }) =>
    platform.transitions.find((entry) => entry.scenario === scenario);
  return {
    pinInvocation: async () => Object.freeze({ invocation: 'android-cli' }),
    finaliseInvocation: async () => Object.freeze({ status: 'not-applicable' }),
    inspectDistribution: async () => platform.distribution,
    inspectDeviceStore: async () => ({
      device: platform.device,
      store: platform.store,
      storeCompletion: platform.storeCompletion,
    }),
    inspectSyntheticLearners: async ({ baseline }) => learners(baseline),
    runScenario: async (authority) => transition(authority),
    beginSlowCardScenario: async () => {},
    pollSlowCardScenario: async ({ scenario }) =>
      scenario.endsWith('decline') ? 'declined' : 'approved',
    finishSlowCardScenario: async (authority) => transition(authority),
    beginUnacknowledgedScenario: async () => {},
    forceStopUnacknowledgedScenario: async () => {},
    finishUnacknowledgedScenario: async (authority) => transition(authority),
    wait: async () => {},
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
    captureScreenshot: async () => ({ sha256: platform.screenshotSha256 }),
    dispose,
  };
}

test('Android wrapper requires physical Play distribution and ordered pm-path hashes', () => {
  const platform = platformEvidence('android-play-physical');
  assert.equal(assertB3AndroidCaptureInput(platform).device.playCertified, true);
  const wrongOrder = structuredClone(platform);
  wrongOrder.distribution.installedApks.reverse();
  assert.throws(() => assertB3AndroidCaptureInput(wrongOrder), /pm path|order/i);
  const genericCertificate = structuredClone(platform);
  genericCertificate.distribution.signingCertificateSha256 = 'a'.repeat(64);
  assert.throws(() => assertB3AndroidCaptureInput(genericCertificate), /closed schema|certificate/i);
  assert.equal(finaliseB3AndroidEvidence({ platform, cloudflare: cloudflareEvidence() }).gateway.scriptAuthoritySha256, 'a'.repeat(64));
  assert.throws(() => finaliseB3AndroidEvidence({
    platform,
    cloudflare: { ...cloudflareEvidence(), applicationFingerprint: 'c'.repeat(64) },
  }), /application authority/i);
  assert.throws(() => finaliseB3AndroidEvidence({ platform: { ...platform, manualVisualInspection: 'pending' }, cloudflare: cloudflareEvidence() }), /pending|manual/i);
});

test('Android capture owns exact scenario order, learner redaction and scope-before-primitives', async () => {
  const platform = platformEvidence('android-play-physical');
  const learners = (baseline) => {
    const row = platform.learnerPreservation.find((entry) => entry.baseline === baseline);
    return [
      { learnerId: 'learner-a', nickname: 'Ada', digest: row.learnerAInitialSha256 },
      { learnerId: 'learner-b', nickname: 'Ben', digest: row.learnerBInitialSha256 },
    ];
  };
  const learnerCalls = [];
  const timing = [];
  const calls = [];
  const physicalOrder = [];
  const primitives = {
    pinInvocation: async () => {
      physicalOrder.push('invocation-pinned');
      return Object.freeze({ invocation: 'android-test' });
    },
    finaliseInvocation: async ({ invocation, distribution }) => {
      assert.deepEqual(invocation, { invocation: 'android-test' });
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
    beginSlowCardScenario: async ({ scenario }) => timing.push(`begin:${scenario}`),
    pollSlowCardScenario: async ({ scenario }) => {
      timing.push(`poll:${scenario}`);
      return scenario.includes('decline') ? 'declined' : 'approved';
    },
    finishSlowCardScenario: async ({ scenario }) => platform.transitions.find((entry) => entry.scenario === scenario),
    beginUnacknowledgedScenario: async () => timing.push('begin:unacknowledged-relaunch'),
    forceStopUnacknowledgedScenario: async () => timing.push('force-stop:unacknowledged-relaunch'),
    finishUnacknowledgedScenario: async () => platform.transitions.find((entry) => entry.scenario === 'unacknowledged-relaunch'),
    wait: async (milliseconds) => timing.push(`wait:${milliseconds}`),
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
    captureScreenshot: async () => {
      physicalOrder.push('screenshot');
      return { sha256: platform.screenshotSha256 };
    },
  };
  const pending = await captureB3AndroidEvidenceWithPrimitives({
    approvalFile: '/operator/approval.json', runToken: 'a'.repeat(64), approvedScope: 'google-test-track-refund-revoke', cloudflare: cloudflareEvidence(), primitives,
    authorityGate: async ({ requestedScope }) => calls.push(requestedScope),
  });
  assert.equal(pending.manualVisualInspection, 'pending');
  assert.deepEqual(pending.transitions.map(({ scenario }) => scenario), platform.transitions.map(({ scenario }) => scenario));
  assert.equal(JSON.stringify(pending).includes('Ben'), false);
  assert.deepEqual(calls, ['google-test-track-refund-revoke']);
  assert.deepEqual(learnerCalls, [
    'before-purchase:initial', 'before-purchase:final',
    'after-fresh-install-reseed:initial', 'after-fresh-install-reseed:final',
  ]);
  assert.ok(timing.includes('wait:5000'));
  assert.ok(timing.includes('force-stop:unacknowledged-relaunch'));
  assert.deepEqual(physicalOrder, [
    'invocation-pinned', 'distribution-before', 'invocation-finalised',
    'device-store', 'terminal', 'chain', 'screenshot',
    'distribution-after',
  ]);
  let distributionReads = 0;
  await assert.rejects(captureB3AndroidEvidenceWithPrimitives({
    approvalFile: '/operator/approval.json', runToken: 'a'.repeat(64),
    approvedScope: 'google-test-track-refund-revoke', cloudflare: cloudflareEvidence(),
    primitives: {
      ...primitives,
      inspectDistribution: async () => (++distributionReads === 1
        ? platform.distribution
        : { ...platform.distribution, installer: 'not.play' }),
    },
    authorityGate: async () => {},
  }), /distribution changed/i);
  await assert.rejects(captureB3AndroidEvidenceWithPrimitives({
    approvalFile: '/operator/approval.json', runToken: 'a'.repeat(64), approvedScope: 'apple-sandbox-history-refund',
    cloudflare: cloudflareEvidence(), primitives, authorityGate: async () => {},
  }), /scope/i);

  const crossAuthorityCloudflare = cloudflareEvidence();
  crossAuthorityCloudflare.applicationFingerprint = 'c'.repeat(64);
  let crossAuthorityFinaliseCalls = 0;
  let crossAuthorityLaterCalls = 0;
  await assert.rejects(captureB3AndroidEvidenceWithPrimitives({
    approvalFile: '/operator/approval.json', runToken: 'a'.repeat(64),
    approvedScope: 'google-test-track-refund-revoke',
    cloudflare: crossAuthorityCloudflare,
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

  let invocationTail = 'absent';
  let lateTailDeviceCalls = 0;
  await assert.rejects(captureB3AndroidEvidenceWithPrimitives({
    approvalFile: '/operator/approval.json',
    runToken: 'a'.repeat(64),
    approvedScope: 'google-test-track-refund-revoke',
    cloudflare: cloudflareEvidence(),
    primitives: {
      ...primitives,
      pinInvocation: async () => Object.freeze({ tail: invocationTail }),
      inspectDistribution: async () => {
        invocationTail = 'planned-rebind';
        return platform.distribution;
      },
      finaliseInvocation: async ({ invocation }) => Object.freeze({
        status: invocation.tail === invocationTail ? 'not-applicable' : 'rejected',
      }),
      inspectSyntheticLearners: async () => {
        lateTailDeviceCalls += 1;
        throw new Error('unexpected device work');
      },
    },
    authorityGate: async () => {},
  }), /recovery.*rejected|pinned invocation/i);
  assert.equal(lateTailDeviceCalls, 0);

  for (const status of ['recovered', 'already-recovered']) {
    const pending = await captureB3AndroidEvidenceWithPrimitives({
      approvalFile: '/operator/approval.json',
      runToken: 'a'.repeat(64),
      approvedScope: 'google-test-track-refund-revoke',
      cloudflare: cloudflareEvidence(),
      primitives: {
        ...primitives,
        finaliseInvocation: async () => Object.freeze({ status }),
      },
      authorityGate: async () => {},
    });
    assert.equal(pending.platform, 'android-play-physical');
  }

  for (const [result, expected] of [
    [Object.freeze({ status: 'operator-required' }), (error) =>
      b3AndroidProofExitCode(error) === 7 && error.instructionCode === 'REINSTALL_EXACT_BUILD'],
    [Object.freeze({ status: 'recovered', extra: true }),
      /finalisation.*invalid|recovery.*invalid/i],
    [Object.freeze({ status: 'unknown' }), /finalisation.*invalid|recovery.*invalid/i],
  ]) {
    let laterCalls = 0;
    await assert.rejects(captureB3AndroidEvidenceWithPrimitives({
      approvalFile: '/operator/approval.json', runToken: 'a'.repeat(64),
      approvedScope: 'google-test-track-refund-revoke', cloudflare: cloudflareEvidence(),
      primitives: {
        ...primitives,
        finaliseInvocation: async () => result,
        inspectSyntheticLearners: async () => {
          laterCalls += 1;
          throw new Error('unexpected device work');
        },
      },
      authorityGate: async () => {},
    }), expected);
    assert.equal(laterCalls, 0);
  }
});

test('Android capture validates final Cloudflare authority before every physical primitive', async () => {
  const cases = [
    ['malformed', null],
    ['authority-drifted', {
      ...cloudflareEvidence(),
      signedEnvelopeSha256: 'f'.repeat(64),
    }],
  ];

  for (const [label, cloudflare] of cases) {
    let authorityCalls = 0;
    let primitiveCalls = 0;
    const primitives = new Proxy({}, {
      get: () => async () => { primitiveCalls += 1; },
    });

    await assert.rejects(captureB3AndroidEvidenceWithPrimitives({
      approvalFile: '/operator/approval.json',
      runToken: 'a'.repeat(64),
      approvedScope: 'google-test-track-refund-revoke',
      cloudflare,
      primitives,
      authorityGate: async () => { authorityCalls += 1; },
    }), /Cloudflare|evidence|authority|object/i, label);
    assert.equal(authorityCalls, 1, `${label} bypassed the local authority gate`);
    assert.equal(primitiveCalls, 0, `${label} reached a physical primitive`);
  }
});

test('Android default slow-card controller polls one fresh process until delayed terminal state', async () => {
  const transitions = platformEvidence('android-play-physical').transitions;
  const authority = transitions.find(
    ({ scenario }) => scenario === 'slow-card-pending-approve',
  );
  const completedDecline = transitions.find(
    ({ scenario }) => scenario === 'slow-card-pending-decline',
  );
  let observedScenario = completedDecline.scenario;
  let state = 'terminal';
  let freshProcesses = 0;
  const waits = [];
  const controller = createB3AndroidSlowCardController({
    readRecords: async () => [{ observation: {
      scenario: observedScenario,
      phase: state === 'terminal' ? 'SCENARIO_COMPLETE' : 'OBSERVING',
      nextActionCode: state === 'operator-pending'
        ? 'APPROVE_PENDING_PURCHASE'
        : 'ARM_GATEWAY_COMPLETION_HOLD',
      observationSha256: 'a'.repeat(64),
    } }],
    consumeStoreActionResume: ({ actionCode }) => actionCode === 'APPROVE_PENDING_PURCHASE',
    pollFreshProcess: async () => {
      freshProcesses += 1;
      state = freshProcesses < 3 ? 'device-pending' : 'terminal';
    },
    deriveTransition: () => {
      if (state !== 'terminal') throw new Error('B3 scenario outcome is absent');
      return observedScenario === authority.scenario ? authority : completedDecline;
    },
  });

  await controller.begin(completedDecline);
  assert.equal(await controller.poll(completedDecline), 'declined');
  assert.equal(await controller.finish(completedDecline), completedDecline);

  observedScenario = authority.scenario;
  state = 'operator-pending';
  await controller.begin(authority);
  const terminal = await pollSlowCard({
    poll: () => controller.poll(authority),
    wait: async (milliseconds) => waits.push(milliseconds),
  });
  assert.equal(terminal, 'approved');
  assert.equal(freshProcesses, 3);
  assert.deepEqual(waits, [5_000, 5_000]);
  assert.equal(await controller.finish(authority), authority);
});

test('Android slow-card deadline includes arming work before the first poll', async () => {
  const platform = platformEvidence('android-play-physical');
  const learners = (baseline) => {
    const row = platform.learnerPreservation.find((entry) => entry.baseline === baseline);
    return [
      { learnerId: 'learner-a', nickname: 'Ada', digest: row.learnerAInitialSha256 },
      { learnerId: 'learner-b', nickname: 'Ben', digest: row.learnerBInitialSha256 },
    ];
  };
  let elapsed = 0;
  let polls = 0;
  const primitives = {
    pinInvocation: async () => Object.freeze({ invocation: 'android-cli' }),
    finaliseInvocation: async () => Object.freeze({ status: 'not-applicable' }),
    inspectDistribution: async () => platform.distribution,
    inspectSyntheticLearners: async ({ baseline }) => learners(baseline),
    runScenario: async ({ scenario }) =>
      platform.transitions.find((entry) => entry.scenario === scenario),
    beginSlowCardScenario: async () => { elapsed = 600_000; },
    pollSlowCardScenario: async () => { polls += 1; return 'pending'; },
    finishSlowCardScenario: async () => { throw new Error('finish must not run'); },
    beginUnacknowledgedScenario: async () => { throw new Error('later scenario must not run'); },
    forceStopUnacknowledgedScenario: async () => {},
    finishUnacknowledgedScenario: async () => {},
    wait: async () => {},
    inspectDeviceStore: async () => {},
    inspectTerminalEvidence: async () => {},
    inspectProofObservationChain: async () => {},
    captureScreenshot: async () => {},
  };
  await assert.rejects(captureB3AndroidEvidenceWithPrimitives({
    approvalFile: '/operator/approval.json', runToken: 'a'.repeat(64),
    approvedScope: 'google-test-track-refund-revoke', cloudflare: cloudflareEvidence(),
    primitives, authorityGate: async () => {}, monotonicClock: () => elapsed,
  }), /ten minutes|deadline|polling/i);
  assert.equal(polls, 0);
});

test('Android Task22 exposes real host utilities and fails closed before device work without authority', async () => {
  const adapter = await import('../scripts/lib/b3-live-capture-adapters.mjs').catch(() => ({}));
  assert.equal(typeof adapter.createDefaultB3AndroidCaptureAdapter, 'function');
  assert.equal(typeof adapter.persistB3PlatformScreenshot, 'function');
  assert.equal(typeof adapter.readB3CaptureCheckpoint, 'function');
  await assert.rejects(
    adapter.createDefaultB3AndroidCaptureAdapter({ root: '/tmp', env: {} })
      .inspectSyntheticLearners({ baseline: 'before-purchase', phase: 'initial' }),
    /signed distribution path|required/i,
  );
  const hostile = {
    code: 'b3_operator_action_required',
    instructionCode: 'COMPLETE_STORE_ACTION',
    message: 'secret free text must never leave the host',
  };
  assert.equal(b3AndroidProofExitCode(hostile), 7);
  assert.deepEqual(b3AndroidProofErrorRecord(hostile), {
    ok: false,
    code: 'b3_operator_action_required',
    instructionCode: 'COMPLETE_STORE_ACTION',
  });
  assert.equal(JSON.stringify(b3AndroidProofErrorRecord(hostile)).includes('secret'), false);
  assert.equal(b3AndroidProofExitCode({ ...hostile, instructionCode: 'FREE_TEXT' }), 6);
  assert.equal(b3AndroidProofExitCode(new Error('ordinary failure')), 6);
  for (const instructionCode of [
    'SHOW_PLAY_PROTECT_SETTINGS',
    'ATTEST_PLAY_PROTECT_SETTINGS',
  ]) {
    const operatorGate = {
      code: 'b3_operator_action_required', instructionCode,
      message: 'private screen contents must not escape',
    };
    assert.equal(b3AndroidProofExitCode(operatorGate), 7);
    assert.deepEqual(b3AndroidProofErrorRecord(operatorGate), {
      ok: false, code: 'b3_operator_action_required', instructionCode,
    });
    assert.equal(JSON.stringify(b3AndroidProofErrorRecord(operatorGate)).includes('private'), false);
  }
});

test('Android capture waits for and reuses the final Cloudflare report', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-android-order-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let primitiveCalls = 0;
  const capturePrimitives = new Proxy({}, {
    get: () => async () => { primitiveCalls += 1; },
  });
  const stderr = [];
  assert.equal(await runB3AndroidProofCli({
    root,
    env: {
      B3_REMOTE_RUN_TOKEN: 'a'.repeat(64),
      B3_REMOTE_MUTATION_SCOPE: 'google-test-track-refund-revoke',
    },
    args: [],
    capturePrimitives,
    stdout: { write: () => {} },
    stderr: { write: (value) => stderr.push(value) },
  }), 6);
  assert.equal(primitiveCalls, 0);
  assert.match(JSON.parse(stderr.join('')).message, /cloudflare-sandbox-proof|ENOENT/i);
});

test('Android CLI disposes capture primitives once after success and failure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-android-disposal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const reports = join(root, 'reports/b3');
  await mkdir(reports, { recursive: true });
  await writeFile(
    join(reports, 'cloudflare-sandbox-proof.json'),
    `${JSON.stringify(cloudflareEvidence(), null, 2)}\n`,
  );
  const env = {
    B3_PREREQUISITES_FILE: '/operator/approval.json',
    B3_REMOTE_RUN_TOKEN: 'a'.repeat(64),
    B3_REMOTE_MUTATION_SCOPE: 'google-test-track-refund-revoke',
  };
  const platform = platformEvidence('android-play-physical');
  const stream = { write() {} };
  let successfulDisposals = 0;
  assert.equal(await runB3AndroidProofCli({
    root,
    env,
    args: [],
    authorityGate: async () => {},
    capturePrimitives: androidCliCapturePrimitives(
      platform,
      async () => { successfulDisposals += 1; },
    ),
    stdout: stream,
    stderr: stream,
  }), 5);
  assert.equal(successfulDisposals, 1);

  let failedDisposals = 0;
  const failed = androidCliCapturePrimitives(
    platform,
    async () => { failedDisposals += 1; },
  );
  failed.pinInvocation = async () => { throw new Error('injected capture failure'); };
  assert.equal(await runB3AndroidProofCli({
    root,
    env,
    args: [],
    authorityGate: async () => {},
    capturePrimitives: failed,
    stdout: stream,
    stderr: stream,
  }), 6);
  assert.equal(failedDisposals, 1);
});

test('Android B3 proof transport is flavour-only, explicit-intent and fixed app storage', async () => {
  const root = new URL('../', import.meta.url);
  const [plugin, activity, gradle, manifest] = await Promise.all([
    readFile(new URL('android/app/src/b3SandboxProof/java/uk/eugnel/ks2spelling/B3ProofObservationPlugin.java', root), 'utf8'),
    readFile(new URL('android/app/src/main/java/uk/eugnel/ks2spelling/MainActivity.java', root), 'utf8'),
    readFile(new URL('android/app/build.gradle', root), 'utf8'),
    readFile(new URL('android/app/src/main/AndroidManifest.xml', root), 'utf8'),
  ]);

  assert.match(plugin, /@CapacitorPlugin\(name = "B3ProofObservation"\)/u);
  assert.match(plugin, /getLaunchCommand/u);
  assert.match(plugin, /publishObservation/u);
  assert.match(plugin, /uk\.eugnel\.ks2spelling\.B3_PROOF_COMMAND_V1/u);
  assert.match(plugin, /getExternalFilesDir\(null\)/u);
  assert.match(plugin, /b3-proof-observation-v1\.json/u);
  assert.match(plugin, /Files\.isSymbolicLink/u);
  assert.match(plugin, /isFile\(\)/u);
  assert.match(plugin, /Files\.move[\s\S]*ATOMIC_MOVE[\s\S]*REPLACE_EXISTING/u);
  assert.match(plugin, /Os\.fsync/u);
  assert.match(activity, /BuildConfig\.B3_SANDBOX_PROOF/u);
  assert.match(activity, /B3ProofObservationPlugin/u);
  assert.match(activity, /onNewIntent/u);
  assert.match(gradle, /b3SandboxProof/u);
  assert.doesNotMatch(manifest, /B3ProofObservationPlugin|B3_PROOF_COMMAND_V1/u);
  assert.doesNotMatch(manifest, /WRITE_EXTERNAL_STORAGE|READ_EXTERNAL_STORAGE|MANAGE_EXTERNAL_STORAGE/u);
});

test('slow-card polling is five seconds with a ten-minute ceiling and unack hold auto-releases', async () => {
  const delays = [];
  let polls = 0;
  const result = await pollSlowCard({
    poll: async () => (++polls === 3 ? 'approved' : 'pending'),
    wait: async (milliseconds) => delays.push(milliseconds),
  });
  assert.equal(result, 'approved');
  assert.deepEqual(delays, [5_000, 5_000]);

  let elapsed = 0;
  let deadlinePolls = 0;
  const deadlineWaits = [];
  await assert.rejects(pollSlowCard({
    poll: async () => {
      deadlinePolls += 1;
      elapsed += 210_000;
      return 'pending';
    },
    wait: async (milliseconds) => {
      deadlineWaits.push(milliseconds);
      elapsed += milliseconds;
    },
    monotonicClock: () => elapsed,
    deadlineMs: 600_000,
  }), /ten minutes|deadline|polling/i);
  assert.equal(deadlinePolls, 3);
  assert.deepEqual(deadlineWaits, [5_000, 5_000]);

  let released = false;
  await holdUnacknowledgedPurchase({ wait: async (milliseconds) => assert.equal(milliseconds, 5_000), release: async () => { released = true; } });
  assert.equal(released, true);
});
