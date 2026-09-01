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

  const sandboxJavaScript = await readBuiltJavaScript(outputDirectory);
  assert.match(sandboxJavaScript, /ks2-spelling-product/u);
  assert.match(sandboxJavaScript, /b3-gateway\.eugnel\.uk/u);
  assert.match(sandboxJavaScript, /b3-test-p256-2026-07/u);
  assert.match(sandboxJavaScript, /b3-sandbox-proof/u);
  assert.deepEqual(
    await verifyReleaseChannelPair({ releaseChannel: 'sandbox', webDirectory: outputDirectory }),
    { releaseChannel: 'sandbox' },
  );
  await assert.rejects(
    verifyReleaseChannelPair({ releaseChannel: 'production', webDirectory: outputDirectory }),
    /release channel mismatch/i,
  );

  const [gradle, java, project, swift, scheme, productionComposition,
    sandboxComposition, productServices, commerceWorkflow, download, ci,
    iosReleaseVerifier] =
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
      readFile(join(ROOT, 'src/app/create-sandbox-app-services.js'), 'utf8'),
      readFile(join(ROOT, 'src/app/create-product-app-services.js'), 'utf8'),
      readFile(join(ROOT, 'src/app/create-product-commerce-workflow.js'), 'utf8'),
      readFile(join(ROOT, 'src/app/download-coordinator.js'), 'utf8'),
      readFile(join(ROOT, '.github/workflows/ci.yml'), 'utf8'),
      readFile(join(ROOT, 'scripts/verify-ios-release-artefacts.mjs'), 'utf8'),
    ]);
  assert.match(gradle, /sandbox\s*\{[\s\S]*KS2_RELEASE_CHANNEL[^\n]*sandbox/u);
  assert.match(gradle, /verify-release-channel-pair\.mjs/u);
  assert.match(java, /BuildConfig\.KS2_RELEASE_CHANNEL/u);
  /* A gateway hostname written out beside the channel-selected origin is how the
     production channel shipped a validator that could reject every capability:
     `PackTransferPlugin.java` checked the host against a `b3-` literal and the
     whole URL against `BuildConfig.KS2_GATEWAY_ORIGIN`, so on `production` the
     two requirements excluded each other. Neither shipping transfer plugin may
     name a host; both derive it. The one legitimate place to write the names down
     is the selector itself, `ZipCentralDirectoryInspector.swift`, which is not
     read here. */
  const hostLiteral = /["']\w+-gateway\.eugnel\.uk["']/u;
  assert.doesNotMatch(java, hostLiteral);
  assert.doesNotMatch(swift, hostLiteral);
  assert.match(project, /name = Sandbox/u);
  assert.match(project, /KS2_RELEASE_CHANNEL = sandbox/u);
  assert.match(project, /verify-release-channel-pair\.mjs/u);
  assert.match(swift, /KS2ReleaseChannel/u);
  assert.doesNotMatch(swift, /#if B3_SANDBOX_PROOF[\s\S]*packEnvironment/u);
  assert.match(scheme, /buildConfiguration = "Sandbox"/u);
  assert.match(productionComposition, /packTrustEnvironment: 'production'/u);
  assert.match(productionComposition, /ks2-gateway\.eugnel\.uk/u);
  assert.match(sandboxComposition, /packTrustEnvironment: 'sandbox'/u);
  assert.match(sandboxComposition, /b3-gateway\.eugnel\.uk/u);
  assert.doesNotMatch(productServices, /(?:b3|ks2)-gateway\.eugnel\.uk/u);
  assert.doesNotMatch(commerceWorkflow, /(?:b3|ks2)-gateway\.eugnel\.uk/u);
  assert.doesNotMatch(download, /(?:b3|ks2)-gateway\.eugnel\.uk/u);
  assert.match(commerceWorkflow, /gatewayOrigin/u);
  assert.match(commerceWorkflow, /packRegistryForEnvironment/u);
  assert.match(
    download,
    /dependencies\.createDownloadAccessContract \?\? createSignedDownloadAccessContract/u,
  );
  assert.match(download, /\)\(packAuthority, gatewayOrigin\)/u);
  assert.match(ci, /:app:assembleSandbox/u);
  assert.match(ci, /npm run verify:ios-release-artefacts/u);
  assert.match(iosReleaseVerifier, /'-scheme', 'Sandbox',[\s\S]*'-configuration', 'Sandbox'/u);
});

test("production environment reaches the keyring guard and rejects sandbox-signed manifests", async () => {
  const { createDownloadCoordinator } = await import(join(ROOT, "src/app/download-coordinator.js"));
  const { createHarness, HANDLE } = await import(join(ROOT, "tests/helpers/range-fixture-server.mjs"));

  // The harness fixture envelope is signed with the sandbox test key, whose
  // allowedEnvironments exclude production. If the coordinator threads
  // environment=production through to the keyring guard, verification must
  // fail closed; reverting the environment plumbing turns this test red.
  const harness = createHarness();
  const coordinator = createDownloadCoordinator({
    ...harness.dependencies,
    environment: "production",
    gatewayOrigin: "https://ks2-gateway.eugnel.uk",
  });
  await assert.rejects(
    coordinator.queue({ sealedRefreshHandle: HANDLE }),
    /Pack verification key is not approved for this environment/,
  );
});

test('channel wrappers inject their build-selected pack-transfer origins', async () => {
  const [productServices, production, sandbox] = await Promise.all([
    readFile(join(ROOT, 'src/app/create-product-app-services.js'), 'utf8'),
    readFile(join(ROOT, 'src/app/create-production-app-services.js'), 'utf8'),
    readFile(join(ROOT, 'src/app/create-sandbox-app-services.js'), 'utf8'),
  ]);
  assert.doesNotMatch(productServices, /(?:b3|ks2)-gateway\.eugnel\.uk/u);
  assert.match(production, /ks2-gateway\.eugnel\.uk/u);
  assert.match(sandbox, /b3-gateway\.eugnel\.uk/u);
  assert.match(
    productServices,
    /createCapacitorPackTransfer\(\{\s*PackTransfer: PackTransferPlugin,\s*gatewayOrigin\s*\}/u,
  );
});

test("production environment pins capability URLs to the production gateway origin", async () => {
  const { createDownloadCoordinator } = await import(join(ROOT, "src/app/download-coordinator.js"));
  const {
    authorisation, capabilityUrl, createHarness, realManifestVerifier, HANDLE,
  } = await import(join(ROOT, "tests/helpers/range-fixture-server.mjs"));

  // Verify the fixture envelope under sandbox keyring rules regardless of the
  // coordinator environment, isolating the gateway-origin selection seam.
  const sandboxVerifier = (input) =>
    realManifestVerifier({ ...input, environment: "sandbox" });

  // A sandbox-origin capability must be rejected by a production coordinator.
  const rejected = createHarness({ manifestVerifier: sandboxVerifier });
  await assert.rejects(
    createDownloadCoordinator({
      ...rejected.dependencies,
      environment: "production",
      gatewayOrigin: "https://ks2-gateway.eugnel.uk",
    })
      .queue({ sealedRefreshHandle: HANDLE }),
    { code: "DOWNLOAD_CAPABILITY_INVALID" },
  );

  // The identical capability re-issued on the production origin must pass the
  // origin gate and complete; reverting the origin selection in
  // download-coordinator.js turns this test red.
  const productionAuthorisation = () => {
    const value = authorisation();
    value.archiveCapability.capabilityUrl = capabilityUrl()
      .replace("b3-gateway.eugnel.uk", "ks2-gateway.eugnel.uk");
    return value;
  };
  const accepted = createHarness({
    manifestVerifier: sandboxVerifier,
    authoriseOutcomes: [productionAuthorisation(), productionAuthorisation()],
  });
  const result = await createDownloadCoordinator({
    ...accepted.dependencies,
    environment: "production",
    gatewayOrigin: "https://ks2-gateway.eugnel.uk",
  }).queue({ sealedRefreshHandle: HANDLE });
  assert.equal(result.state, "downloaded");
});
