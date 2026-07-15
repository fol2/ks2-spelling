import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SHA256 = /^[a-f0-9]{64}$/;
const PROHIBITED =
  /opaqueProof|purchaseToken|refreshHandle|capabilityUrl|privateKey|serviceAccount|learnerId|nickname|email|Ada|Ben|https?:\/\//i;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('B3 deterministic proof runs the closed fake matrix twice byte-identically', async () => {
  const {
    buildB3DeterministicProof,
    runB3DeterministicScenario,
  } = await import('../scripts/run-b3-deterministic-proof.mjs');
  const firstDirectory = await mkdtemp(join(tmpdir(), 'b3-proof-a-'));
  const secondDirectory = await mkdtemp(join(tmpdir(), 'b3-proof-b-'));
  try {
    const first = await buildB3DeterministicProof({ root: ROOT, outputDirectory: firstDirectory });
    const second = await buildB3DeterministicProof({ root: ROOT, outputDirectory: secondDirectory });
    assert.equal(first.reportJson, second.reportJson);
    assert.equal(sha256(first.reportJson), sha256(second.reportJson));
    const report = JSON.parse(first.reportJson);
    assert.deepEqual(Object.keys(report), [
      'schemaVersion',
      'status',
      'evidenceBoundary',
      'clock',
      'traceIdValid',
      'traceIdsUnique',
      'scenarioMatrix',
      'nonLiveStoreKit',
      'syntheticDigests',
    ]);
    assert.deepEqual(report.evidenceBoundary, {
      deterministicFakes: true,
      liveStoreProof: false,
      liveCloudProof: false,
      physicalDeviceProof: false,
    });
    assert.equal(report.clock, '2026-07-13T23:55:00.000Z');
    assert.equal(report.traceIdValid, true);
    assert.equal(report.traceIdsUnique, true);
    assert.deepEqual(
      Object.keys(report.scenarioMatrix),
      ['commerce', 'download', 'activation', 'privacyContinuity'],
    );
    assert.deepEqual(
      report.scenarioMatrix.commerce.map(({ scenario }) => scenario),
      ['cancelled', 'offline-retry', 'pending', 'purchased', 'restored', 'revoked', 'sealed-handle-replay'],
    );
    assert.deepEqual(
      report.scenarioMatrix.download.map(({ scenario }) => scenario),
      ['capability-expired', 'fresh', 'manifest-rejected', 'offline-continuity', 'range-resume', 'storage-rejected'],
    );
    assert.deepEqual(
      report.scenarioMatrix.activation.map(({ scenario }) => scenario),
      ['already-installed', 'crash-before-switch', 'fresh-install', 'reconcile-interrupted', 'rollback-preserved'],
    );
    assert.ok(
      [...report.scenarioMatrix.commerce, ...report.scenarioMatrix.download, ...report.scenarioMatrix.activation]
        .every(({ passed }) => passed === true),
    );
    assert.deepEqual(report.scenarioMatrix.privacyContinuity, {
      parentOnlyDiagnostic: true,
      childSalesCopy: false,
      safeStoreIdsOnly: true,
      sealedHandlesOnly: true,
      offlineInstalledPackReady: true,
    });
    assert.deepEqual(report.nonLiveStoreKit, {
      evidenceKind: 'xcode-storekit-test-non-live',
      physicalSandbox: false,
      liveStore: false,
      cases: [
        { name: 'delayed-approve', initialOutcome: 'pending', finalOutcome: 'purchased' },
        { name: 'delayed-decline', initialOutcome: 'pending', finalOutcome: 'cancelled' },
      ],
    });
    assert.deepEqual(report.syntheticDigests.beforePurchase, [
      'f938d0e0028f1b3de65bdbf7e8a3b0f873c3257de81f2cd5263ed8611af00342',
      '6a5a50b2df1a0d7bdb4ab7d1f4b7d5a87a6c7a3e58dddf16a65b87e482d114cd',
    ]);
    assert.deepEqual(
      report.syntheticDigests.afterFreshInstallReseed,
      report.syntheticDigests.beforePurchase,
    );
    assert.equal(
      report.syntheticDigests.v1CellTypeAndBytesSha256,
      'f1c4876c485df887b3184b3a78852c0d0df895f5a5fa1c6b8983e138bdeb5a11',
    );
    assert.equal(
      report.syntheticDigests.signedManifestSha256,
      '39b6a788a3686d7cbf1fd4791bce45623af21ef53c60eabc03d955395856218a',
    );
    assert.ok([
      report.syntheticDigests.packObjectAuthoritySha256,
      report.syntheticDigests.syntheticLearnerAuthoritySha256,
      report.syntheticDigests.scenarioMatrixSha256,
    ].every((digest) => SHA256.test(digest)));
    assert.doesNotMatch(first.reportJson, PROHIBITED);
    assert.equal(
      await readFile(join(firstDirectory, 'deterministic-proof.json'), 'utf8'),
      first.reportJson,
    );

    const executed = [];
    const wrappedDirectory = await mkdtemp(join(tmpdir(), 'b3-proof-wrapped-'));
    try {
      await buildB3DeterministicProof({
        root: ROOT,
        outputDirectory: wrappedDirectory,
        async scenarioRunner(input) {
          executed.push(`${input.group}:${input.scenario}`);
          return runB3DeterministicScenario(input);
        },
      });
      assert.equal(executed.length, 18);
      assert.equal(new Set(executed).size, 18);
    } finally {
      await rm(wrappedDirectory, { recursive: true, force: true });
    }
    await assert.rejects(
      buildB3DeterministicProof({
        root: ROOT,
        outputDirectory: firstDirectory,
        async scenarioRunner() {
          return { passed: false, stateSha256: '0'.repeat(64) };
        },
      }),
      ({ code }) => code === 'b3_scenario_failed',
    );
  } finally {
    await Promise.all([
      rm(firstDirectory, { recursive: true, force: true }),
      rm(secondDirectory, { recursive: true, force: true }),
    ]);
  }
});
