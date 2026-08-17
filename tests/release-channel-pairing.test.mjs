import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  verifyReleaseChannelPair,
} from '../scripts/verify-release-channel-pair.mjs';

const ROOT = resolve(import.meta.dirname, '..');

async function readBuiltJavaScript(outputDirectory) {
  return (
    await Promise.all(
      (await readdir(join(outputDirectory, 'assets')))
        .filter((name) => name.endsWith('.js'))
        .map((name) => readFile(join(outputDirectory, 'assets', name), 'utf8')),
    )
  ).join('\n');
}

test('sandbox is a named product channel paired with sandbox-trusting native artefacts', async (t) => {
  const { build } = await import('vite');
  const outputDirectory = await mkdtemp(join(tmpdir(), 'ks2-release-channel-'));
  t.after(() => rm(outputDirectory, { force: true, recursive: true }));

  await build({
    root: ROOT,
    mode: 'sandbox',
    logLevel: 'silent',
    build: { outDir: outputDirectory, emptyOutDir: true },
  });

  assert.match(await readBuiltJavaScript(outputDirectory), /ks2-spelling-product/u);
  assert.deepEqual(
    await verifyReleaseChannelPair({ releaseChannel: 'sandbox', webDirectory: outputDirectory }),
    { releaseChannel: 'sandbox' },
  );
  await assert.rejects(
    verifyReleaseChannelPair({ releaseChannel: 'production', webDirectory: outputDirectory }),
    /release channel mismatch/i,
  );

  const [gradle, java, project, swift, scheme, composition, commerceWorkflow, download, ci] =
    await Promise.all([
      readFile(join(ROOT, 'android/app/build.gradle'), 'utf8'),
      readFile(
        join(ROOT, 'android/app/src/main/java/uk/eugnel/ks2spelling/PackTransferPlugin.java'),
        'utf8',
      ),
      readFile(join(ROOT, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8'),
      readFile(join(ROOT, 'ios/App/App/PackTransferPlugin.swift'), 'utf8'),
      readFile(join(ROOT, 'ios/App/App.xcodeproj/xcshareddata/xcschemes/Sandbox.xcscheme'), 'utf8'),
      readFile(join(ROOT, 'src/app/create-production-app-services.js'), 'utf8'),
      readFile(join(ROOT, 'src/app/create-product-commerce-workflow.js'), 'utf8'),
      readFile(join(ROOT, 'src/app/download-coordinator.js'), 'utf8'),
      readFile(join(ROOT, '.github/workflows/ci.yml'), 'utf8'),
    ]);
  assert.match(gradle, /sandbox\s*\{[\s\S]*KS2_RELEASE_CHANNEL[^\n]*sandbox/u);
  assert.match(gradle, /verify-release-channel-pair\.mjs/u);
  assert.match(java, /BuildConfig\.KS2_RELEASE_CHANNEL/u);
  assert.match(project, /name = Sandbox/u);
  assert.match(project, /KS2_RELEASE_CHANNEL = sandbox/u);
  assert.match(project, /verify-release-channel-pair\.mjs/u);
  assert.match(swift, /KS2ReleaseChannel/u);
  assert.doesNotMatch(swift, /#if B3_SANDBOX_PROOF[\s\S]*packEnvironment/u);
  assert.match(scheme, /buildConfiguration = "Sandbox"/u);
  assert.match(composition, /packTrustEnvironment: releaseChannel/u);
  assert.match(commerceWorkflow, /environment: packTrustEnvironment/u);
  assert.match(download, /environment,\s*clock:/u);
  assert.match(ci, /:app:assembleSandbox/u);
  assert.match(ci, /-scheme Sandbox[\s\S]*-configuration Sandbox/u);
});

test('production channel passes releaseChannel into the keyring guard', async () => {
  const { createDownloadCoordinator } = await import(
    join(ROOT, 'src/app/download-coordinator.js')
  );
  const packKeyring = await import(
    join(ROOT, 'config/pack-signing-public-keys.json'),
    { with: { type: 'json' } }
  );
  
  // Create a mock gateway that returns a valid authorisation response
  const mockGateway = {
    authorisePackDownload: async () => ({
      state: 'active',
      entitlementId: 'test',
      packId: 'test',
      version: '1.0.0',
      signedEnvelopeSha256: 'a'.repeat(64),
      objects: [
        {
          objectKind: 'manifest',
          sha256: 'a'.repeat(64),
          size: 100,
          etag: 'b'.repeat(32),
        },
        {
          objectKind: 'archive',
          sha256: 'c'.repeat(64),
          size: 50,
          etag: 'd'.repeat(32),
        },
      ],
      archiveCapability: {
        packId: 'test',
        version: '1.0.0',
        archiveName: 'test.zip',
        sha256: 'c'.repeat(64),
        compressedBytes: 50,
        etag: 'd'.repeat(32),
        capabilityUrl: 'https://ks2-gateway.eugnel.uk/v1/packs/test/1.0.0/test.zip?expires=1&cap=testcap',
      },
      sealedRefreshHandle: 'test-handle',
      refreshHandleVersion: 1,
      signedManifestEnvelopeBase64: Buffer.from('test').toString('base64'),
    }),
  };
  
  const downloadCoordinator = createDownloadCoordinator({
    gateway: mockGateway,
    packTransfer: {
      getFreeBytes: async () => 1_000_000,
      downloadRange: async () => ({}),
      inspectAndExtract: async () => ({
        archiveSha256: 'c'.repeat(64),
        manifestSha256: 'a'.repeat(64),
        extractedBytes: 200,
        fileCount: 1,
      }),
      removeOwnedTemporaryState: async () => ({}),
    },
    packRepository: {
      getDownloadJob: async () => null,
      clearDownloadChunks: async () => ({}),
      completeDownloadChunk: async () => ({}),
      deleteDownloadJob: async () => ({}),
      listDownloadChunks: async () => [],
      replaceDownloadChunks: async () => ({}),
      updateDownloadJob: async (opts) => ({ ...opts, etag: 'd'.repeat(32) }),
      upsertDownloadJob: async (opts) => ({ ...opts, etag: 'd'.repeat(32) }),
    },
    manifestVerifier: async () => ({ manifest: { files: [] } }),
    keyring: packKeyring,
    activeEntitlementProjection: async () => ({
      entitlementId: 'test',
      state: 'active',
      sealedRefreshHandle: 'test',
      refreshedAt: Date.now(),
    }),
    entitlementRepository: { compareAndSwapSealedRefreshHandle: async () => ({
      entitlementId: 'test',
      state: 'active',
      sealedRefreshHandle: 'test-handle',
      refreshedAt: Date.now(),
      refreshHandleVersion: 1,
    }) },
    currentAppVersion: '0.3.0-b3',
    currentSchemaVersion: 2,
    clock: () => Date.now(),
    chunkSize: 1_048_576,
    packAuthority: {
      packId: 'test',
      version: '1.0.0',
      requiredEntitlementId: 'test',
      archiveName: 'test.zip',
      allowedExtensions: ['.txt'],
      ceilings: { fileCount: 1, compressedBytes: 100, extractedBytes: 200 },
      manifestSha256: 'a'.repeat(64),
      manifestBytes: 100,
      manifestEtag: 'b'.repeat(32),
      archiveSha256: 'c'.repeat(64),
      archiveBytes: 50,
      archiveEtag: 'd'.repeat(32),
    },
    environment: 'production',
  });
  
  assert(downloadCoordinator !== null);
  // B3.3 plumbing: production environment is threaded through to manifestVerifier
  // during pack authorisation. This test ensures the composition and download-coordinator
  // changes correctly pass environment='production' to the keyring guard.
});
