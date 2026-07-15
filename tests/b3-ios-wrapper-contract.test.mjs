import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertB3IosCaptureInput,
  captureB3IosEvidenceWithPrimitives,
  finaliseB3IosEvidence,
} from '../scripts/prove-b3-ios.mjs';
import { cloudflareEvidence, platformEvidence } from './helpers/b3-evidence-fixtures.mjs';

test('iOS wrapper requires physical development distribution and screenshot SHA attestation', () => {
  const platform = platformEvidence();
  assert.equal(assertB3IosCaptureInput(platform).distribution.kind, 'development');
  const simulator = structuredClone(platform);
  simulator.device.physical = false;
  assert.throws(() => assertB3IosCaptureInput(simulator), /physical/i);
  const wrongCertificate = structuredClone(platform);
  wrongCertificate.distribution.signingCertificateSha256 = 'a'.repeat(64);
  assert.throws(() => assertB3IosCaptureInput(wrongCertificate), /closed schema|certificate/i);
  assert.equal(finaliseB3IosEvidence({ platform, cloudflare: cloudflareEvidence() }).gateway.deploymentVersionId, 'version-1');
  assert.throws(() => finaliseB3IosEvidence({ platform: { ...platform, manualVisualInspection: 'pending' }, cloudflare: cloudflareEvidence() }), /pending|manual/i);
});

test('iOS capture owns exact scenario order, learner redaction and scope-before-primitives', async () => {
  const platform = platformEvidence();
  const calls = [];
  const learnerCalls = [];
  const learners = (baseline) => {
    const row = platform.learnerPreservation.find((entry) => entry.baseline === baseline);
    return [
      { learnerId: 'learner-a', nickname: 'Ada', digest: row.learnerAInitialSha256 },
      { learnerId: 'learner-b', nickname: 'Ben', digest: row.learnerBInitialSha256 },
    ];
  };
  const primitives = {
    inspectDistribution: async () => platform.distribution,
    inspectDeviceStore: async () => ({ device: platform.device, store: platform.store, storeCompletion: platform.storeCompletion }),
    inspectSyntheticLearners: async ({ baseline, phase }) => {
      learnerCalls.push(`${baseline}:${phase}`);
      return learners(baseline);
    },
    runScenario: async ({ scenario }) => platform.transitions.find((entry) => entry.scenario === scenario),
    inspectTerminalEvidence: async () => ({
      transport: platform.transport, storeTransactionAuthority: platform.storeTransactionAuthority,
      refreshHandleLifecycle: platform.refreshHandleLifecycle, entitlement: platform.entitlement,
      pack: platform.pack, syntheticLearnerAuthoritySha256: platform.syntheticLearnerAuthoritySha256,
      restore: platform.restore,
    }),
    inspectStoreKitTest: async () => platform.storeKitTest,
    captureScreenshot: async () => ({ sha256: platform.screenshotSha256 }),
  };
  const pending = await captureB3IosEvidenceWithPrimitives({
    approvalFile: '/operator/approval.json', runToken: 'a'.repeat(64), approvedScope: 'apple-sandbox-history-refund', cloudflare: cloudflareEvidence(), primitives,
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
  await assert.rejects(captureB3IosEvidenceWithPrimitives({
    approvalFile: '/operator/approval.json', runToken: 'a'.repeat(64), approvedScope: 'google-test-track-refund-revoke',
    cloudflare: cloudflareEvidence(), primitives, authorityGate: async () => {},
  }), /scope/i);
  let primitiveCalls = 0;
  const counted = new Proxy({}, { get: () => async () => { primitiveCalls += 1; } });
  await assert.rejects(captureB3IosEvidenceWithPrimitives({
    runToken: 'c'.repeat(64), approvedScope: 'apple-sandbox-history-refund', cloudflare: cloudflareEvidence(), primitives: counted,
    authorityGate: async () => { throw new Error('run token rejected'); },
  }), /run token rejected/);
  assert.equal(primitiveCalls, 0);
});

test('iOS Task22 exposes secure checkpoint/PNG utilities and blocks without a native observation export', async () => {
  const adapter = await import('../scripts/lib/b3-live-capture-adapters.mjs').catch(() => ({}));
  assert.equal(typeof adapter.createDefaultB3IosCaptureAdapter, 'function');
  assert.equal(typeof adapter.persistB3PlatformScreenshot, 'function');
  assert.equal(typeof adapter.readB3CaptureCheckpoint, 'function');
  await assert.rejects(
    adapter.createDefaultB3IosCaptureAdapter({ root: '/tmp', env: {} }).inspectSyntheticLearners(),
    /does not yet export a device-generated observation/i,
  );
});

test('screenshot persistence keeps exact original PNG bytes at the committed evidence path', async (t) => {
  const adapter = await import('../scripts/lib/b3-live-capture-adapters.mjs');
  const root = await mkdtemp(join(tmpdir(), 'b3-png-root-'));
  const operator = await mkdtemp(join(tmpdir(), 'b3-png-operator-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(operator, { recursive: true, force: true })]));
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(1179, 16);
  png.writeUInt32BE(2556, 20);
  const source = join(operator, 'original.png');
  await writeFile(source, png, { mode: 0o600 });
  await chmod(source, 0o600);
  const result = await adapter.persistB3PlatformScreenshot({ root, platform: 'ios', sourcePath: source });
  const destination = join(root, result.path);
  assert.deepEqual(await readFile(destination), png);
  assert.equal((await lstat(destination)).mode & 0o777, 0o600);
  await assert.rejects(
    adapter.persistB3PlatformScreenshot({ root, platform: 'ios', sourcePath: source }),
    /exist|EEXIST/i,
  );
});
