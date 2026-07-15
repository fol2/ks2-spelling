import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import { assertPrivateSigningFixtureExcluded } from '../tests/helpers/private-signing-fixture-exclusion.mjs';
import { buildDependencyArtifacts } from './audit-dependencies.mjs';
import { EXIT_CODES, isMain, printJson, runCommand } from './lib/run-command.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const OUTPUT = resolve(ROOT, 'reports/b3');
const SOURCE_AUTHORITY_PATHS = Object.freeze([
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
const COMPILED_OUTPUT_PATHS = Object.freeze([
  '.native-build/ios/Build/Products/Debug-iphonesimulator/App.app/App',
  '.native-build/android/build/app/outputs/apk/debug/app-debug.apk',
  '.native-build/android/build/app/outputs/apk/release/app-release-unsigned.apk',
  ...['debug', 'release'].flatMap((variant) =>
    ['CommercePlugin', 'PackTransferPlugin', 'ZipCentralDirectoryInspector'].map((name) =>
      `.native-build/android/build/app/intermediates/javac/${variant}/compile${variant[0].toUpperCase()}${variant.slice(1)}JavaWithJavac/classes/uk/eugnel/ks2spelling/${name}.class`)),
]);
const ANDROID_JUNIT_PATHS = Object.freeze([
  '.native-build/android/build/app/test-results/testDebugUnitTest/TEST-uk.eugnel.ks2spelling.CommercePluginTest.xml',
  '.native-build/android/build/app/test-results/testDebugUnitTest/TEST-uk.eugnel.ks2spelling.PackTransferPluginTest.xml',
  '.native-build/android/build/app/test-results/testDebugUnitTest/TEST-uk.eugnel.ks2spelling.ZipCentralDirectoryInspectorTest.xml',
]);
const PACK_TRANSFER_METHODS = Object.freeze([
  'getFreeBytes', 'downloadRange', 'inspectAndExtract', 'sealAndInstall',
  'inventoryInstalledVersions', 'removeOwnedTemporaryState',
]);
const COMMERCE_METHODS = Object.freeze([
  'queryProducts', 'purchase', 'queryTransactions', 'restore', 'finishTransaction',
]);
const EXPECTED_ANDROID_PERMISSIONS = Object.freeze([
  'android.permission.INTERNET',
  'com.android.vending.BILLING',
  'android.permission.ACCESS_NETWORK_STATE',
]);
const PUBLIC_FIXTURE_AUTHORITY = Object.freeze({
  testSigningFixtureSha256: '930c320433c65f7b500f06ebf5a2a31637b96e84bb1572e551c90054ed1dea49',
  publicSpkiSha256: '5a7a78cca4a0f420d9bc62bb669c3c2759e39f723d3ae10dcbe0f0815a07ecd4',
  signatureDerSha256: 'a29963a93137589dd46ddb18684d1a6c30851f86a39e17cf830276a8ff430bc5',
  signedEnvelopeSha256: '39b6a788a3686d7cbf1fd4791bce45623af21ef53c60eabc03d955395856218a',
  canonicalManifestSha256: '2047ad1a1f968de11430f2eec0b1938448d4653bf99146ea8273872259c976b2',
  archiveSha256: '4c2ca2eb4d4bb7ac3347b66e3483dcb6aa71b41958704733bfc471c970ce7664',
});
const PROHIBITED_REPORT_DATA =
  /"(?:opaqueProof|purchaseToken|refreshHandle|capabilityUrl|privateKey|serviceAccount|learnerId|nickname)"/i;

function auditError(code, message) {
  return Object.assign(new Error(message), { code });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function hashFile(root, path) {
  return sha256(await readFile(resolve(root, path)));
}

async function compiledOutput(root, path) {
  const absolute = resolve(root, path);
  const [metadata, bytes] = await Promise.all([lstat(absolute), readFile(absolute)]);
  if (!metadata.isFile() || metadata.isSymbolicLink() || bytes.length === 0) {
    throw auditError('b3_compiled_output_invalid', `Compiled output is not a regular non-empty file: ${path}`);
  }
  return Object.freeze({ path, bytes: bytes.length, sha256: sha256(bytes) });
}

function pluginMethods(source, pattern) {
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

function requireExactList(actual, expected, code, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw auditError(code, `${label} drifted`);
  }
  return actual;
}

async function androidJUnitEvidence(root, path) {
  const bytes = await readFile(resolve(root, path));
  const source = bytes.toString('utf8');
  const suite = source.match(/<testsuite name="([^"]+)"/)?.[1];
  const count = (name) => Number(source.match(new RegExp(`\\b${name}="([0-9]+)"`))?.[1]);
  const evidence = {
    path,
    sha256: sha256(bytes),
    suite,
    tests: count('tests'),
    failures: count('failures'),
    errors: count('errors'),
    skipped: count('skipped'),
  };
  if (!suite?.startsWith('uk.eugnel.ks2spelling.') || !Number.isSafeInteger(evidence.tests) ||
      evidence.tests <= 0 || evidence.failures !== 0 || evidence.errors !== 0 ||
      evidence.skipped !== 0) {
    throw auditError('b3_android_native_tests_failed', `Android native JUnit evidence is not green: ${path}`);
  }
  return Object.freeze(evidence);
}

async function iosHostileHarnessEvidence(root) {
  const result = await runCommand(process.execPath, ['scripts/test-ios-pack-inspector.mjs'], {
    cwd: root,
  });
  let parsed;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    throw auditError('b3_ios_hostile_harness_failed', 'iOS hostile harness returned invalid JSON');
  }
  const expected = {
    ok: true,
    approvedRuntimeSmoke: true,
    securityMatrix: true,
    hostileFixturesRejected: 53,
  };
  if (result.exitCode !== EXIT_CODES.success || JSON.stringify(parsed) !== JSON.stringify(expected)) {
    throw auditError('b3_ios_hostile_harness_failed', 'iOS hostile harness did not reject the exact corpus');
  }
  return Object.freeze({
    ...expected,
    harnessSha256: await hashFile(root, 'scripts/test-ios-pack-inspector.mjs'),
  });
}

async function listFiles(root, path) {
  const directory = resolve(root, path);
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort();
}

function exactJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function assertNoPrivateRegistry(root, lock, policy) {
  for (const entry of Object.values(lock.packages ?? {})) {
    if (entry?.resolved && !entry.resolved.startsWith('https://registry.npmjs.org/')) {
      throw auditError('b3_private_registry_detected', 'npm lockfile contains a private registry');
    }
  }
  if (policy.allowedSources.gradleRepositories.some((source) =>
    !['google()', 'mavenCentral()', 'https://plugins.gradle.org/m2/'].includes(source))) {
    throw auditError('b3_private_registry_detected', 'Gradle policy contains a private registry');
  }
  const settings = await readFile(resolve(root, 'android/settings.gradle'), 'utf8');
  if (/maven\s*\{\s*url(?!\s*=\s*uri\(['"]\.\.\/node_modules)/u.test(settings)) {
    throw auditError('b3_private_registry_detected', 'Gradle settings contain an unreviewed registry');
  }
}

function readPlistKeys(source, pattern) {
  return [...source.matchAll(pattern)].map((match) => match[1]).sort();
}

export async function buildB3NativeAudit({
  root = ROOT,
  outputDirectory = OUTPUT,
  dependencyArtifacts,
} = {}) {
  const [packageJson, packageLock, policy, packageResolved, capacitorConfig, infoPlist,
    hostileManifest, proofPack, keyring, storeKitTranscript, iosCommerce,
    androidCommerce, androidBuild, capacitorPack, iosPack, androidPack] = await Promise.all([
    readFile(resolve(root, 'package.json'), 'utf8').then(JSON.parse),
    readFile(resolve(root, 'package-lock.json'), 'utf8').then(JSON.parse),
    readFile(resolve(root, 'config/dependency-policy.json'), 'utf8').then(JSON.parse),
    readFile(
      resolve(root, 'ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved'),
      'utf8',
    ).then(JSON.parse),
    readFile(resolve(root, 'capacitor.config.json'), 'utf8').then(JSON.parse),
    readFile(resolve(root, 'ios/App/App/Info.plist'), 'utf8'),
    readFile(resolve(root, 'tests/fixtures/b3-hostile-zips/manifest.json'), 'utf8').then(JSON.parse),
    readFile(resolve(root, 'reports/b3/b3-proof-pack-build.json'), 'utf8').then(JSON.parse),
    readFile(resolve(root, 'config/pack-signing-public-keys.json'), 'utf8').then(JSON.parse),
    readFile(resolve(root, 'tests/fixtures/storekit-bridge-transcript.json'), 'utf8').then(JSON.parse),
    readFile(resolve(root, 'ios/App/App/CommercePlugin.swift'), 'utf8'),
    readFile(resolve(root, 'android/app/src/main/java/uk/eugnel/ks2spelling/CommercePlugin.java'), 'utf8'),
    readFile(resolve(root, 'android/app/build.gradle'), 'utf8'),
    readFile(resolve(root, 'src/platform/pack-transfer/capacitor-pack-transfer.js'), 'utf8'),
    readFile(resolve(root, 'ios/App/App/PackTransferPlugin.swift'), 'utf8'),
    readFile(resolve(root, 'android/app/src/main/java/uk/eugnel/ks2spelling/PackTransferPlugin.java'), 'utf8'),
  ]);
  await assertNoPrivateRegistry(root, packageLock, policy);

  const billing = policy.gradleDeclared.filter(({ coordinate }) =>
    coordinate === 'com.android.billingclient:billing');
  if (billing.length !== 1 || billing[0].version !== '9.1.0' ||
      !/implementation\s+["']com\.android\.billingclient:billing:9\.1\.0["']/.test(androidBuild)) {
    throw auditError('b3_billing_authority_drift', 'BillingClient must be exactly 9.1.0');
  }
  const appOwnedKotlin = [
    ...(await listFiles(root, 'android/app/src/main')).filter((path) => /\.kts?$/u.test(path)),
    ...(await listFiles(root, 'android/app/src/test')).filter((path) => /\.kts?$/u.test(path)),
  ];
  const androidGradleSources = (await listFiles(root, 'android')).filter((path) =>
    /(?:\.gradle|\.gradle\.kts)$/u.test(path));
  const gradleSource = (await Promise.all(androidGradleSources.map((path) =>
    readFile(resolve(root, path), 'utf8')))).join('\n');
  const installedDependencyText = JSON.stringify({
    dependencies: packageJson.dependencies,
    devDependencies: packageJson.devDependencies,
    lockedRoot: packageLock.packages?.[''],
  }).toLowerCase();
  if (appOwnedKotlin.length !== 0 || /org\.jetbrains\.kotlin|kotlin\(["']android/.test(gradleSource) ||
      installedDependencyText.includes('revenuecat')) {
    throw auditError('b3_dependency_boundary_drift', 'App-owned commerce dependency boundary drifted');
  }
  if (!iosCommerce.includes('import StoreKit') || /import\s+(RevenueCat|Purchases)/.test(iosCommerce) ||
      !androidCommerce.includes('com.android.billingclient.api.BillingClient')) {
    throw auditError('b3_commerce_source_drift', 'Native commerce source boundary drifted');
  }

  const sourceAuthority = await Promise.all(SOURCE_AUTHORITY_PATHS.map(async (path) => ({
    path,
    sha256: await hashFile(root, path),
  })));
  const compiledOutputs = await Promise.all(COMPILED_OUTPUT_PATHS.map((path) =>
    compiledOutput(root, path)));
  const hostileBytes = await readFile(resolve(root, 'tests/fixtures/b3-hostile-zips/manifest.json'));
  const hostileDigest = sha256(hostileBytes);
  if (hostileManifest.fixtures.length !== 53 ||
      proofPack.hostileZipCorpus.manifestSha256 !== hostileDigest ||
      proofPack.hostileZipCorpus.fixtureCount !== hostileManifest.fixtures.length) {
    throw auditError('b3_hostile_corpus_drift', 'Hostile ZIP corpus authority drifted');
  }
  const categories = hostileManifest.fixtures.map(({ category }) => category);
  const hostileFixtureAuthority = await Promise.all(hostileManifest.fixtures.map(async (fixture) => {
    const [sourceSha256, androidSha256] = await Promise.all([
      hashFile(root, `tests/fixtures/b3-hostile-zips/${fixture.file}`),
      hashFile(root, `android/app/src/test/resources/b3-hostile-zips/${fixture.file}`),
    ]);
    if (sourceSha256 !== fixture.sha256 || androidSha256 !== fixture.sha256) {
      throw auditError('b3_hostile_corpus_drift', `Hostile ZIP copy drifted: ${fixture.file}`);
    }
    return { file: fixture.file, sha256: fixture.sha256 };
  }));
  const key = keyring.keys.length === 1 ? keyring.keys[0] : null;
  if (!key || key.publicKeySpkiSha256 !==
      sha256(Buffer.from(key.publicKeySpkiDerBase64, 'base64'))) {
    throw auditError('b3_public_key_drift', 'Public SPKI authority drifted');
  }
  const testSigningFixtures = (await listFiles(root, 'tests/fixtures/keys'))
    .filter((path) => path.endsWith('.pem'));
  if (testSigningFixtures.length !== 1) {
    throw auditError('b3_public_fixture_drift', 'Exact B3 test signing fixture set drifted');
  }
  const publicFixtureEvidence = {
    testSigningFixtureSha256: await hashFile(root, testSigningFixtures[0]),
    publicSpkiSha256: key.publicKeySpkiSha256,
    signatureDerSha256: await hashFile(
      root,
      'tests/fixtures/keys/b3-sandbox-proof-manifest-signature.der',
    ),
    signedEnvelopeSha256: await hashFile(root, 'tests/fixtures/b3-signed-manifest.json'),
    canonicalManifestSha256: await hashFile(root, '.native-build/b3/pack/canonical-manifest.json'),
    archiveSha256: await hashFile(root, '.native-build/b3/pack/b3-sandbox-proof.zip'),
  };
  if (
    JSON.stringify(publicFixtureEvidence) !== JSON.stringify(PUBLIC_FIXTURE_AUTHORITY) ||
    proofPack.signatureDer.sha256 !== publicFixtureEvidence.signatureDerSha256 ||
    proofPack.signedEnvelope.sha256 !== publicFixtureEvidence.signedEnvelopeSha256 ||
    proofPack.canonicalManifest.sha256 !== publicFixtureEvidence.canonicalManifestSha256 ||
    proofPack.archive.sha256 !== publicFixtureEvidence.archiveSha256
  ) {
    throw auditError('b3_public_fixture_drift', 'Exact B3 public test-vector authority drifted');
  }
  const [privateFixtureScan, iosHarness, androidJUnit] = await Promise.all([
    assertPrivateSigningFixtureExcluded({ root }),
    iosHostileHarnessEvidence(root),
    Promise.all(ANDROID_JUNIT_PATHS.map((path) => androidJUnitEvidence(root, path))),
  ]);
  const privateFixtureExcluded = privateFixtureScan.filesScanned > 0 &&
    privateFixtureScan.bytesScanned > 0;
  if (!privateFixtureExcluded) {
    throw auditError('b3_private_fixture_scan_empty', 'Private fixture exclusion scan was empty');
  }

  const resolved = dependencyArtifacts ?? await buildDependencyArtifacts({
    preBootstrap: false,
    discoverAndroidSources: true,
  });
  if (resolved.report.mode !== 'resolved-toolchain') {
    throw auditError('b3_dependency_audit_incomplete', 'B3 dependency audit is not resolved');
  }
  const resolvedDependencyIdentities = [
    ...resolved.report.npm.allPackages.flatMap(({ name, locator, source }) =>
      [name, locator, source]),
    ...resolved.report.spm.flatMap(({ identity, source }) => [identity, source]),
    ...resolved.report.android.components.flatMap(({ coordinate, group, name }) =>
      [coordinate, group, name]),
    ...resolved.report.gradleDeclared.map(({ coordinate }) => coordinate),
  ].filter((value) => typeof value === 'string').map((value) => value.toLowerCase());
  const revenueCatDetected = resolvedDependencyIdentities.some((value) =>
    /revenuecat|purchases-ios|com\.revenuecat/u.test(value));
  const billingKtxDetected = resolvedDependencyIdentities.some((value) =>
    value.includes('com.android.billingclient:billing-ktx'));
  const kotlinGradlePlugin = /org\.jetbrains\.kotlin|kotlin\(["']android/u.test(gradleSource);
  if (revenueCatDetected || billingKtxDetected || kotlinGradlePlugin) {
    throw auditError(
      'b3_dependency_boundary_drift',
      'Resolved commerce dependency boundary contains RevenueCat, Billing KTX or Kotlin plugin',
    );
  }
  const packagedPermissionEvidence = resolved.report.permissionEvidence?.packagedAndroid;
  requireExactList(
    packagedPermissionEvidence?.requestedPermissions,
    EXPECTED_ANDROID_PERMISSIONS,
    'b3_packaged_permission_drift',
    'Packaged Android requested permissions',
  );
  requireExactList(
    packagedPermissionEvidence?.declaredPermissions,
    [],
    'b3_packaged_permission_drift',
    'Packaged Android declared permissions',
  );
  const spm = policy.spm.map((entry) => {
    const pin = packageResolved.pins.find(({ identity }) => identity === entry.identity);
    if (!pin || pin.state.revision !== entry.revision) {
      throw auditError('b3_spm_authority_drift', `SwiftPM authority drifted: ${entry.identity}`);
    }
    return {
      identity: entry.identity,
      version: entry.requirement.version,
      revision: entry.revision,
      sourceSha256: sha256(JSON.stringify({
        identity: entry.identity,
        location: pin.location,
        state: pin.state,
      })),
    };
  });
  const entitlements = (await listFiles(root, 'ios')).filter((path) => path.endsWith('.entitlements'));
  const usageKeys = readPlistKeys(infoPlist, /<key>(NS[^<]*UsageDescription)<\/key>/g);
  requireExactList(entitlements, [], 'b3_ios_runtime_surface_drift', 'iOS entitlements');
  requireExactList(usageKeys, [], 'b3_ios_runtime_surface_drift', 'iOS usage-description keys');

  const methodAuthority = {
    javascriptPackTransfer: requireExactList(
      pluginMethods(capacitorPack, /^ {4}async (\w+)\(/gm),
      PACK_TRANSFER_METHODS,
      'b3_pack_transfer_surface_drift',
      'JavaScript PackTransfer surface',
    ),
    iosPackTransfer: requireExactList(
      pluginMethods(iosPack, /CAPPluginMethod\(name: "([^"]+)"/g),
      PACK_TRANSFER_METHODS,
      'b3_pack_transfer_surface_drift',
      'iOS PackTransfer surface',
    ),
    androidPackTransfer: requireExactList(
      pluginMethods(androidPack, /@PluginMethod public void (\w+)\(/g),
      PACK_TRANSFER_METHODS,
      'b3_pack_transfer_surface_drift',
      'Android PackTransfer surface',
    ),
    iosCommerce: requireExactList(
      pluginMethods(iosCommerce, /CAPPluginMethod\(name: "([^"]+)"/g),
      COMMERCE_METHODS,
      'b3_commerce_surface_drift',
      'iOS Commerce surface',
    ),
    androidCommerce: requireExactList(
      pluginMethods(androidCommerce, /@PluginMethod public void (\w+)\(/g),
      COMMERCE_METHODS,
      'b3_commerce_surface_drift',
      'Android Commerce surface',
    ),
  };
  const filesystemPackageInstalled = Boolean(
    packageLock.packages?.['node_modules/@capacitor/filesystem'] ||
    installedDependencyText.includes('@capacitor/filesystem'),
  );
  if (filesystemPackageInstalled) {
    throw auditError('b3_arbitrary_filesystem_api_detected', 'Capacitor Filesystem entered the app');
  }
  const compiledCapability = compiledOutputs.length === COMPILED_OUTPUT_PATHS.length &&
    iosHarness.securityMatrix === true && iosHarness.hostileFixturesRejected === 53 &&
    androidJUnit.every(({ failures, errors, skipped }) =>
      failures === 0 && errors === 0 && skipped === 0);
  const executableArchiveMembersAccepted = !(
    categories.includes('executable-extension') &&
    hostileFixtureAuthority.length === 53 &&
    iosHarness.hostileFixturesRejected === 53 &&
    androidJUnit.some(({ suite, tests }) =>
      suite.endsWith('.ZipCentralDirectoryInspectorTest') && tests === 3)
  );
  if (!compiledCapability || executableArchiveMembersAccepted) {
    throw auditError('b3_native_hostile_matrix_failed', 'Compiled native hostile matrix is incomplete');
  }

  const report = {
    schemaVersion: 1,
    status: 'pass',
    evidenceBoundary: {
      compiledCapability,
      liveStoreProof: false,
      liveCloudProof: false,
      physicalDeviceProof: false,
    },
    dependencies: {
      billingClient: {
        coordinate: 'com.android.billingclient:billing',
        version: '9.1.0',
        source: 'google()',
      },
      appOwnedKotlinSources: appOwnedKotlin.length,
      kotlinGradlePlugin,
      transitiveKotlinRuntimePresent: resolved.report.android.components.some(({ coordinate }) =>
        coordinate.startsWith('org.jetbrains.kotlin:')),
      billingKtx: billingKtxDetected,
      revenueCat: revenueCatDetected,
      privateRegistry: false,
      storeKit: 'system-framework-only',
      spm,
      dependencyAuditSha256: sha256(resolved.reportJson),
    },
    sourceAuthority,
    compiledOutputs,
    nativeParity: {
      hostileArchiveManifestSha256: hostileDigest,
      hostileArchiveFixtureCount: hostileManifest.fixtures.length,
      hostileArchiveFixtureSetSha256: sha256(exactJson(hostileFixtureAuthority)),
      structuralOverlapCovered: categories.includes('central-directory-overlap') &&
        categories.includes('overlapping-data-range'),
      eocdAmbiguityCovered: categories.includes('ambiguous-eocd') &&
        categories.includes('multiple-eocd') && categories.includes('eocd-not-at-eof'),
      zipFoundationExtractionSeam: /Archive\(url: .*accessMode: \.read\)/s.test(
        await readFile(resolve(root, 'ios/App/App/PackTransferPlugin.swift'), 'utf8'),
      ),
      ios: {
        hostileArchiveManifestSha256: hostileDigest,
        executedHarness: iosHarness,
        inspectorSha256: await hashFile(root, 'ios/App/App/ZipCentralDirectoryInspector.swift'),
      },
      android: {
        hostileArchiveManifestSha256: await hashFile(
          root,
          'android/app/src/test/resources/b3-hostile-zips/manifest.json',
        ),
        harnessSha256: await hashFile(
          root,
          'android/app/src/test/java/uk/eugnel/ks2spelling/PackTransferPluginTest.java',
        ),
        inspectorSha256: await hashFile(
          root,
          'android/app/src/main/java/uk/eugnel/ks2spelling/ZipCentralDirectoryInspector.java',
        ),
        junit: androidJUnit,
      },
    },
    runtimeSurface: {
      capacitorServer: { url: capacitorConfig.server?.url ?? null },
      ios: { addedUsageDescriptionKeys: usageKeys, addedEntitlements: entitlements },
      android: {
        appIdentity: packagedPermissionEvidence.appIdentity,
        buildToolsVersion: packagedPermissionEvidence.buildToolsVersion,
        permissionSurfaceSha256: packagedPermissionEvidence.permissionSurfaceSha256,
        declaredPermissions: packagedPermissionEvidence.declaredPermissions,
        requestedPermissions: packagedPermissionEvidence.requestedPermissions,
        dangerousPermissions: [],
      },
      methodAuthority,
      filesystemPackageInstalled,
      arbitraryFilesystemApi: filesystemPackageInstalled,
      executableArchiveMembersAccepted,
    },
    publicFixtures: {
      keyringSha256: await hashFile(root, 'config/pack-signing-public-keys.json'),
      ...publicFixtureEvidence,
      exclusionScan: {
        authorisedFixtureDirectory: privateFixtureScan.authorisedFixtureDirectory,
        filesScanned: privateFixtureScan.filesScanned,
        bytesScanned: privateFixtureScan.bytesScanned,
        expandedArchiveBytesScanned: privateFixtureScan.expandedArchiveBytesScanned,
      },
      signingFixturePackaged: !privateFixtureExcluded,
    },
    nonLiveStoreKit: {
      evidenceKind: storeKitTranscript.evidenceKind,
      physicalSandbox: storeKitTranscript.physicalSandbox,
      liveStore: storeKitTranscript.liveStore,
      signedStoreReadiness: false,
      cases: storeKitTranscript.cases.map(({ name }) => name).sort(),
    },
  };
  const nativeBuildJson = exactJson(report);
  if (PROHIBITED_REPORT_DATA.test(nativeBuildJson) || PROHIBITED_REPORT_DATA.test(resolved.reportJson)) {
    throw auditError('b3_audit_privacy_violation', 'B3 audit contains prohibited private data');
  }
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(resolve(outputDirectory, 'native-build.json'), nativeBuildJson, 'utf8'),
    writeFile(resolve(outputDirectory, 'dependency-audit.json'), resolved.reportJson, 'utf8'),
  ]);
  return Object.freeze({
    nativeBuildJson,
    dependencyAuditJson: resolved.reportJson,
    nativeBuildSha256: sha256(nativeBuildJson),
    dependencyAuditSha256: sha256(resolved.reportJson),
  });
}

export async function main() {
  try {
    const result = await buildB3NativeAudit();
    printJson({
      ok: true,
      evidenceBoundary: 'compiled-capability-not-live-proof',
      nativeBuildSha256: result.nativeBuildSha256,
      dependencyAuditSha256: result.dependencyAuditSha256,
    });
    return EXIT_CODES.success;
  } catch (error) {
    printJson({ ok: false, code: error.code ?? 'b3_native_audit_failed', message: error.message }, process.stderr);
    return EXIT_CODES.commandFailed;
  }
}

if (isMain(import.meta.url)) process.exitCode = await main();
