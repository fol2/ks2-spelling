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
