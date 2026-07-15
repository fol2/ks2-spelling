import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertB3AndroidCaptureInput,
  captureB3AndroidEvidenceWithPrimitives,
  finaliseB3AndroidEvidence,
  pollSlowCard,
  holdUnacknowledgedPurchase,
} from '../scripts/prove-b3-android.mjs';
import { cloudflareEvidence, platformEvidence } from './helpers/b3-evidence-fixtures.mjs';

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
  const primitives = {
    inspectDistribution: async () => platform.distribution,
    inspectDeviceStore: async () => ({ device: platform.device, store: platform.store, storeCompletion: platform.storeCompletion }),
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
    inspectTerminalEvidence: async () => ({
      transport: platform.transport, storeTransactionAuthority: platform.storeTransactionAuthority,
      refreshHandleLifecycle: platform.refreshHandleLifecycle, entitlement: platform.entitlement,
      pack: platform.pack, syntheticLearnerAuthoritySha256: platform.syntheticLearnerAuthoritySha256,
      restore: platform.restore,
    }),
    captureScreenshot: async () => ({ sha256: platform.screenshotSha256 }),
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
  await assert.rejects(captureB3AndroidEvidenceWithPrimitives({
    approvalFile: '/operator/approval.json', runToken: 'a'.repeat(64), approvedScope: 'apple-sandbox-history-refund',
    cloudflare: cloudflareEvidence(), primitives, authorityGate: async () => {},
  }), /scope/i);
});

test('Android Task22 exposes secure checkpoint/PNG utilities and blocks without a native observation export', async () => {
  const adapter = await import('../scripts/lib/b3-live-capture-adapters.mjs').catch(() => ({}));
  assert.equal(typeof adapter.createDefaultB3AndroidCaptureAdapter, 'function');
  assert.equal(typeof adapter.persistB3PlatformScreenshot, 'function');
  assert.equal(typeof adapter.readB3CaptureCheckpoint, 'function');
  await assert.rejects(
    adapter.createDefaultB3AndroidCaptureAdapter({ root: '/tmp', env: {} }).inspectSyntheticLearners(),
    /does not yet export a device-generated observation/i,
  );
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
  let released = false;
  await holdUnacknowledgedPurchase({ wait: async (milliseconds) => assert.equal(milliseconds, 5_000), release: async () => { released = true; } });
  assert.equal(released, true);
});
