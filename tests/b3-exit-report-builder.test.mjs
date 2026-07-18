import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import { B3_SYNTHETIC_LEARNER_AUTHORITY_SHA256 } from '../scripts/lib/b3-evidence.mjs';
import { publishB3FinalProofOutput } from '../scripts/lib/b3-final-proof-output.mjs';
import {
  B3_TEST_COMMIT,
  B3_TEST_HASH,
  cloudflareEvidence,
  platformEvidence,
} from './helpers/b3-evidence-fixtures.mjs';
import { createB3TestPng } from './helpers/b3-test-png.mjs';

const SOURCE_ROOT = resolve(import.meta.dirname, '..');
const EXIT_PATH = 'reports/b3/b3-exit-report.json';
const B2_AUTHORITY = Object.freeze({
  schemaVersion: 1,
  commit: '1'.repeat(40),
  tree: '2'.repeat(40),
  exitReportSha256: '3'.repeat(64),
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function put(root, path, value) {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(`${JSON.stringify(value)}\n`);
  await writeFile(absolute, bytes, { mode: 0o600 });
  return bytes;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ks2-spelling-b3-exit-'));
  const cloudflare = cloudflareEvidence();
  const ios = platformEvidence();
  const android = platformEvidence('android-play-physical');
  const png = createB3TestPng({ width: 320, height: 480 });
  ios.screenshotSha256 = sha256(png);
  android.screenshotSha256 = sha256(png);

  const packAuthority = {
    schemaVersion: 1,
    packId: 'b3-sandbox-proof',
    version: '1.0.0-b3.1',
    bucketName: 'ks2-spelling-b3-sandbox-packs',
    objects: [
      {
        role: 'archive', key: cloudflare.objects[1].key, sha256: B3_TEST_HASH,
        bytes: 10, etag: cloudflare.objects[1].etag,
        metadata: cloudflare.objects[1].customMetadata,
      },
      {
        role: 'signed-manifest', key: cloudflare.objects[0].key, sha256: B3_TEST_HASH,
        bytes: 10, etag: cloudflare.objects[0].etag,
        metadata: cloudflare.objects[0].customMetadata,
      },
    ],
  };
  const packAuthorityBytes = Buffer.from(`${JSON.stringify(packAuthority)}\n`);

  await Promise.all([
    put(root, 'reports/b3/cloudflare-sandbox-proof.json', cloudflare),
    put(root, 'reports/b3/ios-sandbox-proof.json', ios),
    put(root, 'reports/b3/ios-sandbox-proof.png', png),
    put(root, 'reports/b3/android-sandbox-proof.json', android),
    put(root, 'reports/b3/android-sandbox-proof.png', png),
    put(root, 'reports/b3/b3-proof-pack-build.json', {
      schemaVersion: 1, status: 'pass', builderMode: 'verify-only', environment: 'sandbox',
      packId: 'b3-sandbox-proof', version: '1.0.0-b3.1',
      signedEnvelope: { sha256: B3_TEST_HASH }, archive: { sha256: B3_TEST_HASH },
    }),
    put(root, 'reports/b3/native-build.json', {
      schemaVersion: 1, status: 'pass',
      evidenceBoundary: {
        compiledCapability: true, liveStoreProof: false,
        liveCloudProof: false, physicalDeviceProof: false,
      },
      publicFixtures: {
        signedEnvelopeSha256: B3_TEST_HASH, archiveSha256: B3_TEST_HASH,
        signingFixturePackaged: false,
      },
    }),
    put(root, 'reports/b3/dependency-audit.json', {
      schemaVersion: 2, mode: 'resolved-toolchain',
      b3Truth: {
        childOrProgressPayloadSentToCommerceGateway: false,
        appConfiguredAnalytics: false,
        appConfiguredAdvertising: false,
        liveStoreProof: false,
        liveCloudProof: false,
        disclosureStatus: 'Not a final store disclosure',
      },
    }),
    put(root, 'reports/b3/deterministic-proof.json', {
      schemaVersion: 1, status: 'pass', traceIdValid: true, traceIdsUnique: true,
      evidenceBoundary: {
        deterministicFakes: true, liveStoreProof: false,
        liveCloudProof: false, physicalDeviceProof: false,
      },
      scenarioMatrix: {
        privacyContinuity: {
          parentOnlyDiagnostic: true, childSalesCopy: false, safeStoreIdsOnly: true,
          sealedHandlesOnly: true, offlineInstalledPackReady: true,
        },
      },
      syntheticDigests: {
        signedManifestSha256: B3_TEST_HASH,
        packObjectAuthoritySha256: sha256(packAuthorityBytes),
        syntheticLearnerAuthoritySha256: B3_SYNTHETIC_LEARNER_AUTHORITY_SHA256,
      },
    }),
    put(root, 'config/b3-gateway-authority.json', {
      schemaVersion: 1, environment: 'sandbox',
      cloudflareAccountId: cloudflare.worker.accountId,
      workerName: cloudflare.worker.name,
      publicSandboxOrigin: cloudflare.worker.publicSandboxOrigin,
      privateR2BucketName: cloudflare.bucket.approvedIdentifier,
      distribution: { iosKind: 'development', androidTrack: 'internal', applicationId: 'uk.eugnel.ks2spelling' },
      allowedOrigins: ['capacitor://localhost', 'http://localhost'],
    }),
    put(root, 'config/b3-pack-object-authority.json', packAuthority),
    put(root, 'config/store-products.json', {
      schemaVersion: 1,
      products: [{
        entitlementId: 'full-ks2', type: 'non-consumable',
        appleProductId: 'uk.eugnel.ks2spelling.fullks2', googleProductId: 'full_ks2',
        packIds: ['b3-sandbox-proof'],
      }],
    }),
    mkdir(join(root, 'config'), { recursive: true }).then(() =>
      readFile(join(SOURCE_ROOT, 'config/b3-synthetic-learners.json')).then((bytes) =>
        writeFile(join(root, 'config/b3-synthetic-learners.json'), bytes, { mode: 0o600 }))),
  ]);
  return { root, cloudflare, ios, android, png };
}

async function withFixture(callback) {
  const value = await fixture();
  try {
    return await callback(value);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
}

async function mutate(root, path, update) {
  const value = JSON.parse(await readFile(join(root, path), 'utf8'));
  update(value);
  await put(root, path, value);
}

async function build(root, overrides = {}) {
  const { buildB3ExitReport } = await import('../scripts/build-b3-exit-report.mjs');
  return buildB3ExitReport({
    root,
    expectedApplicationCommit: B3_TEST_COMMIT,
    expectedApplicationFingerprint: B3_TEST_HASH,
    verifyAuthority: async () => B2_AUTHORITY,
    fingerprintApplication: async () => ({ schemaVersion: 1, sha256: B3_TEST_HASH, files: [] }),
    ...overrides,
  });
}

test('B3 exit builder composes one hash-only sandbox checkpoint', async () => {
  await withFixture(async ({ root }) => {
    const report = await build(root);
    assert.equal(report.status, 'pass');
    assert.equal(report.testedApplicationCommit, B3_TEST_COMMIT);
    assert.equal(report.applicationFingerprint, B3_TEST_HASH);
    assert.deepEqual(report.b2Authority, {
      commit: B2_AUTHORITY.commit,
      tree: B2_AUTHORITY.tree,
      exitReport: {
        sha256: B2_AUTHORITY.exitReportSha256,
      },
    });
    assert.deepEqual(Object.keys(report.deterministicInputs), [
      'proofPack', 'nativeBuild', 'dependencyAudit', 'deterministicProof',
    ]);
    assert.equal(report.liveEvidence.ios.platform, 'ios-physical');
    assert.equal(report.liveEvidence.android.platform, 'android-play-physical');
    assert.deepEqual(report.claimBoundary, {
      scope: 'sandbox-test-only',
      localLearningAuthority: true,
      productionReady: false,
      productionContent: false,
    });
    assert.doesNotMatch(JSON.stringify(report), /Ada|Ben|learner-a|learner-b|traceId|device/iu);
  });
});
test('B3 exit builder rejects commit and fingerprint drift', async () => {
  await withFixture(async ({ root }) => {
    await mutate(root, 'reports/b3/ios-sandbox-proof.json', (value) => {
      value.testedApplicationCommit = 'c'.repeat(40);
      value.distribution.embeddedCommit = value.testedApplicationCommit;
    });
    await assert.rejects(build(root), /commit|application authority/i);
  });
  await withFixture(async ({ root }) => {
    await assert.rejects(
      build(root, { fingerprintApplication: async () => ({ sha256: 'c'.repeat(64) }) }),
      /fingerprint/i,
    );
  });
});

test('B3 exit builder rejects deterministic and tracked authority drift', async () => {
  const cases = [
    ['deterministic signed envelope', 'reports/b3/deterministic-proof.json', (value) => {
      value.syntheticDigests.signedManifestSha256 = 'c'.repeat(64);
    }],
    ['tracked pack objects', 'config/b3-pack-object-authority.json', (value) => {
      value.objects[0].sha256 = 'c'.repeat(64);
    }],
    ['tracked gateway', 'config/b3-gateway-authority.json', (value) => {
      value.workerName = 'different-worker';
    }],
    ['tracked products', 'config/store-products.json', (value) => {
      value.products[0].googleProductId = 'different_product';
    }],
  ];
  for (const [name, path, update] of cases) {
    await withFixture(async ({ root }) => {
      await mutate(root, path, update);
      await assert.rejects(build(root), /authority|deterministic|product|worker|pack/i, name);
    });
  }
});

test('B3 exit builder delegates Cloudflare/platform equality and screenshot truth', async () => {
  await withFixture(async ({ root }) => {
    await mutate(root, 'reports/b3/android-sandbox-proof.json', (value) => {
      value.gateway.scriptAuthoritySha256 = 'c'.repeat(64);
    });
    await assert.rejects(build(root), /Cloudflare|gateway|differ/i);
  });
  await withFixture(async ({ root }) => {
    await writeFile(join(root, 'reports/b3/ios-sandbox-proof.png'), Buffer.from('not a png'));
    await assert.rejects(build(root), /PNG|screenshot/i);
  });
});

test('B3 exit builder preserves platform-specific certificate fields', async () => {
  const cases = [
    ['generic certificate', 'reports/b3/ios-sandbox-proof.json', (value) => {
      value.distribution.signingCertificateSha256 = value.distribution.codeSigningCertificateSha256;
      delete value.distribution.codeSigningCertificateSha256;
    }],
    ['cross-platform iOS certificate', 'reports/b3/ios-sandbox-proof.json', (value) => {
      value.distribution.playAppSigningCertificateSha256 = value.distribution.codeSigningCertificateSha256;
      delete value.distribution.codeSigningCertificateSha256;
    }],
    ['cross-platform Android certificate', 'reports/b3/android-sandbox-proof.json', (value) => {
      value.distribution.codeSigningCertificateSha256 = value.distribution.playAppSigningCertificateSha256;
      delete value.distribution.playAppSigningCertificateSha256;
    }],
  ];
  for (const [name, path, update] of cases) {
    await withFixture(async ({ root }) => {
      await mutate(root, path, update);
      await assert.rejects(build(root), /certificate|closed schema/i, name);
    });
  }
});

test('B3 exit output publication is create-only and byte exact', async () => {
  await withFixture(async ({ root }) => {
    const report = await build(root);
    const bytes = Buffer.from(`${JSON.stringify(report)}\n`);
    await publishB3FinalProofOutput({ root, output: EXIT_PATH, bytes });
    assert.equal((await publishB3FinalProofOutput({ root, output: EXIT_PATH, bytes })).status, 'identical');
    await assert.rejects(
      publishB3FinalProofOutput({ root, output: EXIT_PATH, bytes: Buffer.from('{}\n') }),
      /conflict/i,
    );
  });
});
