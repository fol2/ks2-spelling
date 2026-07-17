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
  /"(?:opaqueProof|purchaseToken|refreshHandle|capabilityUrl|privateKey|serviceAccount|learnerId|nickname)"|\bAda\b|\bBen\b/i;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value) ||
      ArrayBuffer.isView(value)) return value;
  for (const member of Reflect.ownKeys(value)) deepFreeze(value[member]);
  return Object.freeze(value);
}

test('B3 native audit is rebuilt from closed fresh inputs without weakening B2', async () => {
  const { buildB3NativeAudit } = await import('../scripts/build-b3-native-audit.mjs');
  const {
    buildDependencyArtifacts,
    writeB3DependencyArtifacts,
  } = await import('../scripts/audit-dependencies.mjs');
  const firstDirectory = await mkdtemp(join(tmpdir(), 'b3-native-audit-a-'));
  const secondDirectory = await mkdtemp(join(tmpdir(), 'b3-native-audit-b-'));
  const frozenPaths = [
    'reports/b2/dependency-audit.json',
    'reports/b2/native-plugin-audit.json',
    'reports/b2/native-plugin-build.json',
    'reports/b2/b2-exit-report.json',
  ];
  const frozenBefore = await Promise.all(
    frozenPaths.map((path) => readFile(join(ROOT, path))),
  );
  try {
    const dependencyArtifacts = deepFreeze(await buildDependencyArtifacts({
      preBootstrap: false,
      discoverAndroidSources: true,
    }));
    const first = await buildB3NativeAudit({
      root: ROOT,
      outputDirectory: firstDirectory,
      dependencyArtifacts,
    });
    const second = await buildB3NativeAudit({
      root: ROOT,
      outputDirectory: secondDirectory,
      dependencyArtifacts,
    });
    assert.equal(first.nativeBuildJson, second.nativeBuildJson);
    assert.equal(first.dependencyAuditJson, second.dependencyAuditJson);
    assert.equal(sha256(first.nativeBuildJson), sha256(second.nativeBuildJson));
    assert.equal(sha256(first.dependencyAuditJson), sha256(second.dependencyAuditJson));

    const report = JSON.parse(first.nativeBuildJson);
    assert.deepEqual(
      Object.keys(report),
      [
        'schemaVersion',
        'status',
        'evidenceBoundary',
        'dependencies',
        'sourceAuthority',
        'compiledOutputs',
        'nativeParity',
        'runtimeSurface',
        'publicFixtures',
        'nonLiveStoreKit',
      ],
    );
    assert.deepEqual(report.evidenceBoundary, {
      compiledCapability: true,
      liveStoreProof: false,
      liveCloudProof: false,
      physicalDeviceProof: false,
    });
    assert.deepEqual(report.dependencies.billingClient, {
      coordinate: 'com.android.billingclient:billing',
      version: '9.1.0',
      source: 'google()',
    });
    assert.equal(report.dependencies.appOwnedKotlinSources, 0);
    assert.equal(report.dependencies.kotlinGradlePlugin, false);
    assert.equal(report.dependencies.transitiveKotlinRuntimePresent, true);
    assert.equal(report.dependencies.billingKtx, false);
    assert.equal(report.dependencies.revenueCat, false);
    assert.equal(report.dependencies.privateRegistry, false);
    assert.equal(report.dependencies.storeKit, 'system-framework-only');
    assert.ok(report.dependencies.spm.every(({ sourceSha256 }) => SHA256.test(sourceSha256)));
    assert.deepEqual(report.dependencies.spm.map(({ identity }) => identity), [
      'capacitor-swift-pm',
      'sqlcipher.swift',
      'zipfoundation',
    ]);
    assert.deepEqual(report.sourceAuthority.map(({ path }) => path), [
      'src/platform/commerce/capacitor-store.js',
      'src/platform/pack-transfer/capacitor-pack-transfer.js',
      'src/platform/gateway/http-entitlement-gateway.js',
      'ios/App/App/CommercePlugin.swift',
      'ios/App/App/PackTransferPlugin.swift',
      'ios/App/App/ZipCentralDirectoryInspector.swift',
      'android/app/src/main/java/uk/eugnel/ks2spelling/CommercePlugin.java',
      'android/app/src/main/java/uk/eugnel/ks2spelling/PackTransferPlugin.java',
      'android/app/src/main/java/uk/eugnel/ks2spelling/ZipCentralDirectoryInspector.java',
      'config/b3-gateway-authority.json',
      'config/b3-pack-object-authority.json',
      'config/b3-synthetic-learners.json',
    ]);
    assert.ok(report.sourceAuthority.every(({ sha256: digest }) => SHA256.test(digest)));
    assert.deepEqual(report.compiledOutputs.map(({ path }) => path), [
      '.native-build/ios/Build/Products/Debug-iphonesimulator/App.app/App',
      '.native-build/android/build/app/outputs/apk/debug/app-debug.apk',
      '.native-build/android/build/app/outputs/apk/release/app-release-unsigned.apk',
      '.native-build/android/build/app/intermediates/javac/debug/compileDebugJavaWithJavac/classes/uk/eugnel/ks2spelling/CommercePlugin.class',
      '.native-build/android/build/app/intermediates/javac/debug/compileDebugJavaWithJavac/classes/uk/eugnel/ks2spelling/PackTransferPlugin.class',
      '.native-build/android/build/app/intermediates/javac/debug/compileDebugJavaWithJavac/classes/uk/eugnel/ks2spelling/ZipCentralDirectoryInspector.class',
      '.native-build/android/build/app/intermediates/javac/release/compileReleaseJavaWithJavac/classes/uk/eugnel/ks2spelling/CommercePlugin.class',
      '.native-build/android/build/app/intermediates/javac/release/compileReleaseJavaWithJavac/classes/uk/eugnel/ks2spelling/PackTransferPlugin.class',
      '.native-build/android/build/app/intermediates/javac/release/compileReleaseJavaWithJavac/classes/uk/eugnel/ks2spelling/ZipCentralDirectoryInspector.class',
    ]);
    assert.ok(report.compiledOutputs.every(({ bytes, sha256: digest }) =>
      Number.isSafeInteger(bytes) && bytes > 0 && SHA256.test(digest)));
    assert.equal(report.nativeParity.hostileArchiveManifestSha256, report.nativeParity.ios.hostileArchiveManifestSha256);
    assert.equal(report.nativeParity.hostileArchiveManifestSha256, report.nativeParity.android.hostileArchiveManifestSha256);
    assert.equal(report.nativeParity.structuralOverlapCovered, true);
    assert.equal(report.nativeParity.eocdAmbiguityCovered, true);
    assert.equal(report.nativeParity.zipFoundationExtractionSeam, true);
    assert.deepEqual(report.nativeParity.ios.executedHarness, {
      ok: true,
      approvedRuntimeSmoke: true,
      securityMatrix: true,
      hostileFixturesRejected: 53,
      harnessSha256: report.nativeParity.ios.executedHarness.harnessSha256,
    });
    assert.match(report.nativeParity.ios.executedHarness.harnessSha256, SHA256);
    assert.deepEqual(
      report.nativeParity.android.junit.map(({ suite, tests, failures, errors, skipped }) => ({
        suite, tests, failures, errors, skipped,
      })),
      [
        { suite: 'uk.eugnel.ks2spelling.CommercePluginTest', tests: 6, failures: 0, errors: 0, skipped: 0 },
        { suite: 'uk.eugnel.ks2spelling.PackTransferPluginTest', tests: 4, failures: 0, errors: 0, skipped: 0 },
        { suite: 'uk.eugnel.ks2spelling.ZipCentralDirectoryInspectorTest', tests: 3, failures: 0, errors: 0, skipped: 0 },
      ],
    );
    assert.ok(report.nativeParity.android.junit.every(({ sha256: digest }) => SHA256.test(digest)));
    assert.deepEqual(report.runtimeSurface.capacitorServer, { url: null });
    assert.deepEqual(report.runtimeSurface.ios.addedUsageDescriptionKeys, []);
    assert.deepEqual(report.runtimeSurface.ios.addedEntitlements, []);
    assert.deepEqual(report.runtimeSurface.android.declaredPermissions, []);
    assert.deepEqual(report.runtimeSurface.android.requestedPermissions, [
      'android.permission.INTERNET',
      'com.android.vending.BILLING',
      'android.permission.ACCESS_NETWORK_STATE',
    ]);
    assert.deepEqual(report.runtimeSurface.android.dangerousPermissions, []);
    assert.deepEqual(report.runtimeSurface.methodAuthority.javascriptPackTransfer, [
      'getFreeBytes', 'downloadRange', 'inspectAndExtract', 'sealAndInstall',
      'inventoryInstalledVersions', 'removeOwnedTemporaryState',
    ]);
    assert.deepEqual(
      report.runtimeSurface.methodAuthority.iosPackTransfer,
      report.runtimeSurface.methodAuthority.javascriptPackTransfer,
    );
    assert.deepEqual(
      report.runtimeSurface.methodAuthority.androidPackTransfer,
      report.runtimeSurface.methodAuthority.javascriptPackTransfer,
    );
    assert.deepEqual(report.runtimeSurface.methodAuthority.iosCommerce, [
      'queryProducts', 'purchase', 'queryTransactions', 'restore', 'finishTransaction',
    ]);
    assert.deepEqual(
      report.runtimeSurface.methodAuthority.androidCommerce,
      report.runtimeSurface.methodAuthority.iosCommerce,
    );
    assert.equal(report.runtimeSurface.filesystemPackageInstalled, false);
    assert.equal(report.runtimeSurface.arbitraryFilesystemApi, false);
    assert.equal(report.runtimeSurface.executableArchiveMembersAccepted, false);
    assert.equal(report.publicFixtures.signingFixturePackaged, false);
    assert.equal(report.publicFixtures.testSigningFixtureSha256, '930c320433c65f7b500f06ebf5a2a31637b96e84bb1572e551c90054ed1dea49');
    assert.equal(report.publicFixtures.publicSpkiSha256, '5a7a78cca4a0f420d9bc62bb669c3c2759e39f723d3ae10dcbe0f0815a07ecd4');
    assert.equal(report.publicFixtures.signatureDerSha256, 'a29963a93137589dd46ddb18684d1a6c30851f86a39e17cf830276a8ff430bc5');
    assert.equal(report.publicFixtures.signedEnvelopeSha256, '39b6a788a3686d7cbf1fd4791bce45623af21ef53c60eabc03d955395856218a');
    assert.equal(report.publicFixtures.canonicalManifestSha256, '2047ad1a1f968de11430f2eec0b1938448d4653bf99146ea8273872259c976b2');
    assert.equal(report.publicFixtures.archiveSha256, '4c2ca2eb4d4bb7ac3347b66e3483dcb6aa71b41958704733bfc471c970ce7664');
    assert.match(report.publicFixtures.keyringSha256, SHA256);
    assert.equal(report.publicFixtures.exclusionScan.authorisedFixtureDirectory, 'tests/fixtures/keys');
    assert.ok(report.publicFixtures.exclusionScan.filesScanned > 0);
    assert.deepEqual(report.nonLiveStoreKit, {
      evidenceKind: 'xcode-storekit-test-non-live',
      physicalSandbox: false,
      liveStore: false,
      signedStoreReadiness: false,
      cases: ['delayed-approve', 'delayed-decline'],
    });

    assert.doesNotMatch(first.nativeBuildJson, PROHIBITED);
    assert.doesNotMatch(first.dependencyAuditJson, PROHIBITED);
    assert.doesNotMatch(
      first.dependencyAuditJson,
      /Native application dependency; no collection or transmission declared in B2/,
    );
    const dependencyReport = JSON.parse(first.dependencyAuditJson);
    assert.deepEqual(dependencyReport.b3Truth.appOwnedRuntimeNetworkEndpoints, [
      'https://b3-gateway.eugnel.uk',
    ]);
    assert.equal('runtimeNetworkEndpoints' in dependencyReport.b3Truth, false);
    const packagedAndroidComponents = dependencyReport.android.components.filter(
      ({ packaged }) => packaged,
    );
    assert.ok(packagedAndroidComponents.length > 0);
    const sqlCipher = packagedAndroidComponents.find(
      ({ coordinate }) => coordinate === 'net.zetetic:sqlcipher-android:4.10.0',
    );
    assert.equal(
      sqlCipher?.privacyRole,
      'Local database implementation in no-encryption mode; final store disclosure review pending',
    );
    assert.ok(packagedAndroidComponents
      .filter(({ coordinate }) => coordinate !== 'net.zetetic:sqlcipher-android:4.10.0')
      .every(({ privacyRole }) => privacyRole ===
        'B3 compiled dependency closure; no app-configured analytics, advertising or learner payload; vendor runtime data-practice and final Play Data Safety review pending'));
    await writeB3DependencyArtifacts(
      { reportJson: first.dependencyAuditJson },
      { root: firstDirectory },
    );
    assert.equal(
      await readFile(join(firstDirectory, 'reports/b3/dependency-audit.json'), 'utf8'),
      first.dependencyAuditJson,
    );
    await assert.rejects(readFile(join(firstDirectory, 'reports/b2/dependency-audit.json')));
    const frozenAfter = await Promise.all(
      frozenPaths.map((path) => readFile(join(ROOT, path))),
    );
    assert.deepEqual(frozenAfter, frozenBefore);
  } finally {
    await Promise.all([
      rm(firstDirectory, { recursive: true, force: true }),
      rm(secondDirectory, { recursive: true, force: true }),
    ]);
  }
});

test('B3 dependency write targets B3 only and rejects incomplete fresh input', async () => {
  const {
    assertB3DependencyEvidenceCurrent,
    writeB3DependencyArtifacts,
  } = await import('../scripts/audit-dependencies.mjs');
  const outputRoot = await mkdtemp(join(tmpdir(), 'b3-dependency-write-'));
  try {
    await assert.rejects(
      writeB3DependencyArtifacts({ reportJson: '{}\n' }, { root: outputRoot }),
      /resolved/i,
    );
    await assert.rejects(
      writeB3DependencyArtifacts({
        reportJson: '{"schemaVersion":2,"mode":"resolved-toolchain"}\n',
      }, { root: outputRoot }),
      /resolved/i,
    );
    const current = { reportJson: 'resolved\n', noticesMarkdown: 'notices\n' };
    assert.doesNotThrow(() => assertB3DependencyEvidenceCurrent(current, current));
    assert.throws(
      () => assertB3DependencyEvidenceCurrent(current, {
        ...current,
        noticesMarkdown: 'stale\n',
      }),
      ({ code }) => code === 'dependency_evidence_stale',
    );
    await assert.rejects(readFile(join(outputRoot, 'reports/b2/dependency-audit.json')));
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});
