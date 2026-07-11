import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { EXIT_CODES, isMain, printJson } from './lib/run-command.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const REPORT_PATH = resolve(ROOT, 'reports/b1/dependency-audit.json');
const NOTICES_PATH = resolve(ROOT, 'THIRD_PARTY_NOTICES.md');

function policyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function packageNameFromPath(path) {
  return path.split('node_modules/').at(-1);
}

function stableSortByName(entries) {
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

function markdownCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

export function renderThirdPartyNotices({ lockPackages, spm, androidResolution }) {
  const rows = [...lockPackages]
    .sort((left, right) =>
      `${left.name}@${left.version}:${left.locator}`.localeCompare(
        `${right.name}@${right.version}:${right.locator}`,
      ),
    )
    .map(
      ({ name, version, licence, source, locator }) =>
        `| ${markdownCell(name)} | ${markdownCell(version)} | ${markdownCell(licence)} | npm | ${markdownCell(source)} | ${markdownCell(locator)} |`,
    );
  rows.push(
    `| ${markdownCell(spm.name)} | ${markdownCell(spm.version)} | ${markdownCell(spm.licence)} | SwiftPM | ${markdownCell(spm.source)} | revision ${markdownCell(spm.revision)} |`,
  );
  return `# Third-party notices

This is the deterministic preliminary dependency inventory for the B1 local prototype. It records package identity, source and declared licence; it is not a substitute for the full licence texts or final store disclosure review.

- Android resolution: \`${androidResolution}\`
- Runtime network endpoints: none
- Native plugins beyond Capacitor core/platform packages: none

| Package | Version | Declared licence | Source type | Source | Locator |
|---|---:|---|---|---|---|
${rows.join('\n')}
`;
}

async function listFiles(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await walk(root);
  return files.sort();
}

function commonClassification(policy, name, lockEntry) {
  const classification = policy.npmClassifications[name];
  if (!classification) {
    throw policyError('unclassified_dependency', `No classification for ${name}`);
  }
  return {
    name,
    version: lockEntry.version,
    source: lockEntry.resolved,
    licence: lockEntry.license,
    role: classification.role,
    platform: classification.platform,
    permissions: [],
    dataAccess: [],
    networkEndpoints: [],
    applePrivacyManifest: classification.applePrivacyManifest,
    googleDataSafety: classification.googleDataSafety,
    owner: policy.owner,
    reviewDate: policy.reviewDate,
  };
}

async function verifyRuntimeBoundary(packageJson) {
  const approvedCapacitorPackages = new Set([
    '@capacitor/android',
    '@capacitor/core',
    '@capacitor/ios',
  ]);
  const unexpectedPlugins = Object.keys(packageJson.dependencies ?? {}).filter(
    (name) => name.startsWith('@capacitor/') && !approvedCapacitorPackages.has(name),
  );
  if (unexpectedPlugins.length) {
    throw policyError('unapproved_native_plugin', unexpectedPlugins.join(', '));
  }

  const manifest = await readFile(
    resolve(ROOT, 'android/app/src/main/AndroidManifest.xml'),
    'utf8',
  );
  if (/<uses-permission\b/.test(manifest)) {
    throw policyError('android_permission_declared', 'B1 app manifest declares a permission');
  }
  const iosAppFiles = await listFiles(resolve(ROOT, 'ios/App/App'));
  const entitlements = iosAppFiles
    .filter((path) => path.endsWith('.entitlements'))
    .map((path) => path.slice(`${ROOT}/`.length));
  const infoPlist = await readFile(resolve(ROOT, 'ios/App/App/Info.plist'), 'utf8');
  const usageDescriptionKeys = [
    ...infoPlist.matchAll(/<key>([^<]*UsageDescription)<\/key>/g),
  ].map(([, key]) => key);
  if (entitlements.length || usageDescriptionKeys.length) {
    throw policyError(
      'ios_permission_surface_declared',
      `iOS permission surface found: ${[...entitlements, ...usageDescriptionKeys].join(', ')}`,
    );
  }
  const capacitorAndroid = await readFile(
    resolve(ROOT, 'android/app/capacitor.build.gradle'),
    'utf8',
  );
  const generatedDependencies = capacitorAndroid.match(/dependencies\s*\{([\s\S]*?)\}/)?.[1] ?? '';
  if (/\b(?:implementation|api|classpath)\b/.test(generatedDependencies)) {
    throw policyError('unapproved_native_plugin', 'Generated Android plugin dependency found');
  }
  const packageSwift = await readFile(resolve(ROOT, 'ios/App/CapApp-SPM/Package.swift'), 'utf8');
  const products = [...packageSwift.matchAll(/\.product\(name: "([^"]+)"/g)].map(
    ([, name]) => name,
  );
  if (products.join(',') !== 'Capacitor,Cordova') {
    throw policyError('unapproved_native_plugin', `Unexpected iOS products: ${products.join(',')}`);
  }
  for (const path of [
    'ios/App/Podfile',
    'ios/App/Podfile.lock',
    'ios/App/Pods',
    'ios/App/App.xcworkspace',
  ]) {
    if (existsSync(resolve(ROOT, path))) {
      throw policyError('cocoapods_active', `Active CocoaPods path found: ${path}`);
    }
  }
  const capacitorConfig = await readJson(resolve(ROOT, 'capacitor.config.json'));
  if (Object.hasOwn(capacitorConfig, 'server')) {
    throw policyError('runtime_endpoint_declared', 'Capacitor server configuration is forbidden');
  }
  const runtimeFiles = [resolve(ROOT, 'index.html'), ...(await listFiles(resolve(ROOT, 'src')))];
  for (const path of runtimeFiles) {
    if (/https?:\/\//i.test(await readFile(path, 'utf8'))) {
      throw policyError('runtime_endpoint_declared', `Runtime URL found in ${path}`);
    }
  }
  return {
    androidUsesPermissions: [],
    iosEntitlements: entitlements,
    iosUsageDescriptionKeys: usageDescriptionKeys,
  };
}

function validateLock(policy, lock) {
  const approvedLicences = new Set(policy.approvedLicences);
  const lockPackages = [];
  for (const [locator, entry] of Object.entries(lock.packages)) {
    if (!locator) continue;
    const name = packageNameFromPath(locator);
    if (!entry.version || !entry.resolved || !entry.integrity || !entry.license) {
      throw policyError('incomplete_lock_entry', `Incomplete lock entry: ${locator}`);
    }
    if (!entry.resolved.startsWith(policy.allowedSources.npm)) {
      throw policyError('unapproved_package_source', `${name}: ${entry.resolved}`);
    }
    if (/\s+(?:AND|OR)\s+|[()]/.test(entry.license) || !approvedLicences.has(entry.license)) {
      throw policyError('licence_review_required', `${name}: ${entry.license}`);
    }
    lockPackages.push({
      locator,
      name,
      version: entry.version,
      licence: entry.license,
      source: entry.resolved,
      integrity: entry.integrity,
      dev: entry.dev === true,
    });
  }
  return lockPackages;
}

async function verifyGradleDeclarations(policy) {
  const text = (
    await Promise.all(
      [
        'android/build.gradle',
        'android/app/build.gradle',
        'android/variables.gradle',
        'node_modules/@capacitor/android/capacitor/build.gradle',
      ].map((path) => readFile(resolve(ROOT, path), 'utf8')),
    )
  ).join('\n');
  for (const { coordinate, version } of policy.gradleDeclared) {
    if (!text.includes(coordinate) || !text.includes(version)) {
      throw policyError(
        'gradle_declaration_drift',
        `Missing declared Gradle input ${coordinate}:${version}`,
      );
    }
  }
  const repositories = [
    ...new Set([
      ...[...text.matchAll(/\b(google|mavenCentral)\(\)/g)].map(([, name]) => `${name}()`),
      ...[...text.matchAll(/maven\s*\{\s*url\s*=\s*"([^"]+)"/g)].map(([, url]) => url),
    ]),
  ].sort();
  for (const repository of repositories) {
    if (!policy.allowedSources.gradleRepositories.includes(repository)) {
      throw policyError('unapproved_gradle_source', `Unapproved Gradle source: ${repository}`);
    }
  }
  return {
    declarations: policy.gradleDeclared.map((entry) => ({
      ...entry,
      resolution: 'pending-toolchain',
    })),
    repositories,
  };
}

export async function buildDependencyArtifacts({ preBootstrap = false } = {}) {
  const [policy, packageJson, lock, packageLockText, packageResolved] = await Promise.all([
    readJson(resolve(ROOT, 'config/dependency-policy.json')),
    readJson(resolve(ROOT, 'package.json')),
    readJson(resolve(ROOT, 'package-lock.json')),
    readFile(resolve(ROOT, 'package-lock.json'), 'utf8'),
    readJson(
      resolve(
        ROOT,
        'ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved',
      ),
    ),
  ]);

  assertDirectPolicy(packageJson.dependencies, policy.directDependencies, 'runtime dependency');
  assertDirectPolicy(packageJson.devDependencies, policy.directBuildTools, 'build tool');
  assertDirectPolicy(lock.packages[''].dependencies, policy.directDependencies, 'lock runtime');
  assertDirectPolicy(lock.packages[''].devDependencies, policy.directBuildTools, 'lock build');
  const lockPackages = validateLock(policy, lock);
  const permissionEvidence = await verifyRuntimeBoundary(packageJson);

  const production = stableSortByName(
    lockPackages
      .filter(({ dev }) => !dev)
      .map(({ name }) => commonClassification(policy, name, lock.packages[`node_modules/${name}`])),
  );
  const directBuildTools = stableSortByName(
    Object.keys(policy.directBuildTools).map((name) =>
      commonClassification(policy, name, lock.packages[`node_modules/${name}`]),
    ),
  );

  const pin = packageResolved.pins?.find(({ identity }) => identity === policy.spm.name);
  if (
    packageResolved.version !== 3 ||
    !pin ||
    pin.location !== policy.spm.source ||
    pin.state?.version !== policy.spm.version ||
    pin.state?.revision !== policy.spm.revision ||
    !policy.allowedSources.spm.includes(pin.location)
  ) {
    throw policyError('spm_resolution_drift', 'Official Capacitor SwiftPM pin drifted');
  }
  const privacyManifests = [
    'node_modules/@capacitor/ios/Capacitor/Capacitor/PrivacyInfo.xcprivacy',
    'node_modules/@capacitor/ios/CapacitorCordova/CapacitorCordova/PrivacyInfo.xcprivacy',
  ];
  if (!privacyManifests.every((path) => existsSync(resolve(ROOT, path)))) {
    throw policyError('missing_privacy_manifest', 'Capacitor privacy manifest is missing');
  }
  for (const path of privacyManifests) {
    const manifest = await readFile(resolve(ROOT, path), 'utf8');
    if (!/<key>NSPrivacyTracking<\/key>\s*<false\/>/.test(manifest)) {
      throw policyError('privacy_manifest_drift', `${path} does not declare tracking false`);
    }
    for (const key of [
      'NSPrivacyAccessedAPITypes',
      'NSPrivacyCollectedDataTypes',
      'NSPrivacyTrackingDomains',
    ]) {
      if (
        !new RegExp(
          `<key>${key}</key>\\s*(?:<array\\s*/>|<array>\\s*</array>)`,
        ).test(manifest)
      ) {
        throw policyError('privacy_manifest_drift', `${path} has a non-empty ${key}`);
      }
    }
  }
  const spm = [
    {
      ...policy.spm,
      permissions: [],
      dataAccess: [],
      networkEndpoints: [],
      applePrivacyManifest: 'Framework privacy manifests supplied',
      googleDataSafety: 'Not applicable',
      owner: policy.owner,
      reviewDate: policy.reviewDate,
      privacyManifests,
    },
  ];
  const gradle = await verifyGradleDeclarations(policy);
  const report = {
    schemaVersion: 1,
    mode: 'pre-bootstrap',
    generatedFrom: {
      packageLockSha256: createHash('sha256').update(packageLockText).digest('hex'),
      spmResolvedVersion: packageResolved.version,
    },
    npm: {
      lockfileVersion: lock.lockfileVersion,
      lockPackageCount: lockPackages.length,
      approvedLicences: policy.approvedLicences,
      production,
      directBuildTools,
    },
    spm,
    androidResolution: 'pending-toolchain',
    gradleRepositories: gradle.repositories,
    gradleDeclared: gradle.declarations,
    plugins: {
      approved: policy.approvedNativePlugins,
      candidates: policy.candidatePlugins,
    },
    permissionEvidence,
    b1Truth: {
      childDataCollected: false,
      childDataTransmitted: false,
      analytics: false,
      advertising: false,
      appPermissions: [],
      storeCommerce: false,
      runtimeNetworkEndpoints: [],
      disclosureStatus: 'B1 evidence only; not a final store disclosure',
    },
  };
  const reportJson = `${JSON.stringify(report, null, 2)}\n`;
  const noticesMarkdown = renderThirdPartyNotices({
    lockPackages,
    spm: spm[0],
    androidResolution: report.androidResolution,
  });

  if (!preBootstrap) {
    throw policyError(
      'android_resolution_pending',
      'Android dependencies remain statically declared until Task 8 resolves the Gradle graph',
    );
  }
  return { report, reportJson, noticesMarkdown };
}

function assertDirectPolicy(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw policyError('direct_dependency_drift', `${label} versions do not match policy`);
  }
  for (const version of Object.values(actual)) {
    if (/^[~^]|latest|git|github/i.test(version)) {
      throw policyError('direct_dependency_range', `${label} is not exactly pinned: ${version}`);
    }
  }
}

export async function writeDependencyArtifacts(artifacts) {
  await mkdir(resolve(ROOT, 'reports/b1'), { recursive: true });
  await Promise.all([
    writeFile(REPORT_PATH, artifacts.reportJson, 'utf8'),
    writeFile(NOTICES_PATH, artifacts.noticesMarkdown, 'utf8'),
  ]);
}

export function assertDependencyEvidenceCurrent(artifacts, current) {
  if (
    current.reportJson !== artifacts.reportJson ||
    current.noticesMarkdown !== artifacts.noticesMarkdown
  ) {
    throw policyError(
      'dependency_evidence_stale',
      'Committed dependency report or third-party notices are stale; rerun with --write',
    );
  }
}

export async function main(args = process.argv.slice(2)) {
  const preBootstrap = args.includes('--pre-bootstrap');
  const write = args.includes('--write');
  try {
    const artifacts = await buildDependencyArtifacts({ preBootstrap });
    if (write) {
      await writeDependencyArtifacts(artifacts);
    } else {
      assertDependencyEvidenceCurrent(artifacts, {
        reportJson: await readFile(REPORT_PATH, 'utf8'),
        noticesMarkdown: await readFile(NOTICES_PATH, 'utf8'),
      });
    }
    printJson({
      ok: true,
      mode: artifacts.report.mode,
      npmPackages: artifacts.report.npm.lockPackageCount,
      androidResolution: artifacts.report.androidResolution,
      evidence: write ? 'written' : 'current',
    });
    return EXIT_CODES.success;
  } catch (error) {
    printJson(
      { ok: false, code: error.code ?? 'dependency_audit_failed', message: error.message },
      process.stderr,
    );
    return ['android_resolution_pending', 'dependency_evidence_stale'].includes(error.code)
      ? EXIT_CODES.stateMismatch
      : EXIT_CODES.commandFailed;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
