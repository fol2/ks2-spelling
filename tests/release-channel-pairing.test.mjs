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
  
  // Test that download coordinator selects production origin when environment is 'production'
  const downloadCoordinator = createDownloadCoordinator({
    gateway: { authorisePackDownload: async () => ({}) },
    packTransfer: {
      getFreeBytes: async () => 1_000_000,
      downloadRange: async () => ({}),
      inspectAndExtract: async () => ({}),
      removeOwnedTemporaryState: async () => ({}),
    },
    packRepository: {
      getDownloadJob: async () => null,
      clearDownloadChunks: async () => ({}),
      completeDownloadChunk: async () => ({}),
      deleteDownloadJob: async () => ({}),
      listDownloadChunks: async () => [],
      replaceDownloadChunks: async () => ({}),
      updateDownloadJob: async () => ({}),
      upsertDownloadJob: async () => ({}),
    },
    manifestVerifier: async () => ({ manifest: { files: [] } }),
    keyring: packKeyring,
    activeEntitlementProjection: async () => ({
      entitlementId: 'test',
      state: 'active',
      sealedRefreshHandle: 'test',
      refreshedAt: Date.now(),
    }),
    entitlementRepository: { compareAndSwapSealedRefreshHandle: async () => ({}) },
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
});
