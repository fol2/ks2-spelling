import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { EXIT_CODES, isMain, printJson, runCommand } from './lib/run-command.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const REPORT_PATH = resolve(ROOT, 'reports/b2/dependency-audit.json');
const NATIVE_PLUGIN_AUDIT_PATH = resolve(ROOT, 'reports/b2/native-plugin-audit.json');
const NATIVE_PLUGIN_BUILD_PATH = resolve(ROOT, 'reports/b2/native-plugin-build.json');
const NOTICES_PATH = resolve(ROOT, 'THIRD_PARTY_NOTICES.md');
const IOS_APP_PATH = resolve(
  ROOT,
  '.native-build/ios/Build/Products/Debug-iphonesimulator/App.app',
);
const EXPECTED_IOS_PACKAGED_PRIVACY_MANIFESTS = Object.freeze([
  {
    path: 'Frameworks/Capacitor.framework/PrivacyInfo.xcprivacy',
    sha256: '1bac827f49b2b8a5358491b9698203bf191791a6f1ba3a3ace3b1285d52d2d17',
    tracking: false,
    collectedDataTypes: [],
    trackingDomains: [],
    requiredReasonApis: [],
  },
  {
    path: 'Frameworks/Cordova.framework/PrivacyInfo.xcprivacy',
    sha256: '5a9b8fc0cddb10201bb47cc2804b3f004c7251476622d25bfc4eb54ed46e1084',
    tracking: false,
    collectedDataTypes: [],
    trackingDomains: [],
    requiredReasonApis: [],
  },
  {
    path: 'Frameworks/SQLCipher.framework/PrivacyInfo.xcprivacy',
    sha256: '9362796ba800a7b4169834eff8bde990866f40114ff7baac002b8bae543e8dd1',
    tracking: false,
    collectedDataTypes: [],
    trackingDomains: [],
    requiredReasonApis: [
      { category: 'NSPrivacyAccessedAPICategoryDiskSpace', reasons: ['E174.1'] },
      {
        category: 'NSPrivacyAccessedAPICategoryFileTimestamp',
        reasons: ['3B52.1', 'C617.1'],
      },
    ],
  },
  {
    path: 'ZIPFoundation_ZIPFoundation.bundle/PrivacyInfo.xcprivacy',
    sha256: '9a2f930cedb8d58309a581b9bf9bf3673685ec02ae2197d9f1c56828b718dffd',
    tracking: false,
    collectedDataTypes: [],
    trackingDomains: [],
    requiredReasonApis: [
      { category: 'NSPrivacyAccessedAPICategoryFileTimestamp', reasons: ['0A2A.1'] },
    ],
  },
]);
const EXPECTED_WEBVIEW_BUNDLE_PACKAGES = Object.freeze([
  '@capacitor-community/sqlite',
  '@capacitor/app',
  '@capacitor/core',
  'react',
  'react-dom',
  'scheduler',
]);
const NATIVE_BUILD_SOURCE_NPM_PACKAGES = new Set([
  '@capacitor-community/sqlite',
  '@capacitor/android',
  '@capacitor/app',
  '@capacitor/ios',
]);

function policyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function exactJson(value) {
  return JSON.stringify(value);
}

export function assertIosPackagedPrivacyManifestEvidenceCurrent(actual, committed) {
  if (
    exactJson(actual) !== exactJson(committed) ||
    exactJson(actual) !== exactJson(EXPECTED_IOS_PACKAGED_PRIVACY_MANIFESTS)
  ) {
    throw policyError(
      'ios_packaged_privacy_manifest_drift',
      'Packaged iOS privacy manifest path, bytes or Required Reason API evidence drifted',
    );
  }
}

function canonicalPrivacyManifestJson(raw, path) {
  if (
    exactJson(Object.keys(raw).sort()) !==
      exactJson([
        'NSPrivacyAccessedAPITypes',
        'NSPrivacyCollectedDataTypes',
        'NSPrivacyTracking',
        'NSPrivacyTrackingDomains',
      ]) ||
    raw.NSPrivacyTracking !== false ||
    !Array.isArray(raw.NSPrivacyCollectedDataTypes) ||
    raw.NSPrivacyCollectedDataTypes.length !== 0 ||
    !Array.isArray(raw.NSPrivacyTrackingDomains) ||
    raw.NSPrivacyTrackingDomains.length !== 0 ||
    !Array.isArray(raw.NSPrivacyAccessedAPITypes)
  ) {
    throw policyError(
      'ios_packaged_privacy_manifest_invalid',
      `Packaged iOS privacy manifest has an unexpected disclosure shape: ${path}`,
    );
  }
  const requiredReasonApis = raw.NSPrivacyAccessedAPITypes.map((entry) => {
    if (
      exactJson(Object.keys(entry ?? {}).sort()) !==
        exactJson(['NSPrivacyAccessedAPIType', 'NSPrivacyAccessedAPITypeReasons']) ||
      typeof entry.NSPrivacyAccessedAPIType !== 'string' ||
      !Array.isArray(entry.NSPrivacyAccessedAPITypeReasons) ||
      entry.NSPrivacyAccessedAPITypeReasons.some(
        (reason) => typeof reason !== 'string' || reason.length === 0,
      )
    ) {
      throw policyError(
        'ios_packaged_privacy_manifest_invalid',
        `Packaged iOS Required Reason API declaration is invalid: ${path}`,
      );
    }
    return {
      category: entry.NSPrivacyAccessedAPIType,
      reasons: [...entry.NSPrivacyAccessedAPITypeReasons].sort(),
    };
  }).sort((left, right) => left.category.localeCompare(right.category));
  if (new Set(requiredReasonApis.map(({ category }) => category)).size !== requiredReasonApis.length) {
    throw policyError(
      'ios_packaged_privacy_manifest_invalid',
      `Packaged iOS privacy manifest repeats an API category: ${path}`,
    );
  }
  return requiredReasonApis;
}

async function scanIosPackagedPrivacyManifests(appPath) {
  const paths = (await listFiles(appPath))
    .filter((path) => path.endsWith('/PrivacyInfo.xcprivacy'))
    .map((path) => relative(appPath, path))
    .sort();
  const manifests = [];
  for (const path of paths) {
    const absolutePath = resolve(appPath, path);
    const content = await readFile(absolutePath);
    const parsed = await runCommand(
      '/usr/bin/plutil',
      ['-convert', 'json', '-o', '-', absolutePath],
      { cwd: ROOT },
    );
    if (parsed.exitCode !== EXIT_CODES.success) {
      throw policyError(
        'ios_packaged_privacy_manifest_invalid',
        `Unable to parse packaged iOS privacy manifest: ${path}`,
      );
    }
    manifests.push({
      path,
      sha256: sha256(content),
      tracking: false,
      collectedDataTypes: [],
      trackingDomains: [],
      requiredReasonApis: canonicalPrivacyManifestJson(JSON.parse(parsed.stdout), path),
    });
  }
  assertIosPackagedPrivacyManifestEvidenceCurrent(
    manifests,
    EXPECTED_IOS_PACKAGED_PRIVACY_MANIFESTS,
  );
  return manifests;
}

export async function resolveIosPackagedPrivacyManifestEvidence({
  appPath = IOS_APP_PATH,
  committed,
  requireFresh = false,
}) {
  if (existsSync(appPath)) {
    const actual = await scanIosPackagedPrivacyManifests(appPath);
    if (committed && !requireFresh) {
      assertIosPackagedPrivacyManifestEvidenceCurrent(actual, committed);
    }
    return actual;
  }
  if (requireFresh || !committed) {
    throw policyError(
      'ios_packaged_privacy_manifest_missing',
      'Packaged iOS privacy manifest evidence is absent and no built App.app is available',
    );
  }
  assertIosPackagedPrivacyManifestEvidenceCurrent(
    committed,
    EXPECTED_IOS_PACKAGED_PRIVACY_MANIFESTS,
  );
  return committed;
}

export function assertWebViewBundleEvidenceCurrent(actual, committed) {
  if (exactJson(actual) !== exactJson(committed)) {
    throw policyError(
      'webview_bundle_evidence_drift',
      'Committed WebView bundle module evidence does not match the fresh write-false build',
    );
  }
  if (exactJson(actual?.packageNames) !== exactJson(EXPECTED_WEBVIEW_BUNDLE_PACKAGES)) {
    throw policyError(
      'webview_bundle_evidence_drift',
      'WebView bundle npm package set requires explicit policy review',
    );
  }
}

function npmLocatorFromModulePath(path) {
  if (!path.startsWith('node_modules/')) return null;
  const parts = path.split('/');
  return parts[1].startsWith('@')
    ? `node_modules/${parts[1]}/${parts[2]}`
    : `node_modules/${parts[1]}`;
}

export async function buildWebViewBundleEvidence(lock) {
  const { build } = await import('vite');
  const built = await build({ write: false, logLevel: 'silent' });
  const outputs = Array.isArray(built) ? built : [built];
  const rollupOutputs = outputs.flatMap(({ output }) => output);
  const moduleIds = [
    ...new Set(
      rollupOutputs
        .filter(({ type }) => type === 'chunk')
        .flatMap(({ modules }) => Object.keys(modules)),
    ),
  ].sort();
  const modules = [];
  for (const absoluteId of moduleIds) {
    if (absoluteId.startsWith('\0')) {
      modules.push({ id: absoluteId, kind: 'virtual', npmLocator: null, sha256: null });
      continue;
    }
    const id = relative(ROOT, absoluteId);
    if (id.startsWith('..') || id === '') {
      throw policyError('webview_bundle_evidence_invalid', `Bundle input is outside root: ${absoluteId}`);
    }
    const npmLocator = npmLocatorFromModulePath(id);
    if (npmLocator && !lock.packages[npmLocator]) {
      throw policyError(
        'webview_bundle_evidence_invalid',
        `Bundled npm module is absent from the lockfile: ${id}`,
      );
    }
    modules.push({
      id,
      kind: 'file',
      npmLocator,
      sha256: sha256(await readFile(absoluteId)),
    });
  }
  const outputInventory = rollupOutputs
    .map((output) => ({
      fileName: output.fileName,
      kind: output.type,
      sha256: sha256(output.type === 'chunk' ? output.code : output.source),
    }))
    .sort((left, right) => left.fileName.localeCompare(right.fileName));
  const packageLocators = [
    ...new Set(modules.map(({ npmLocator }) => npmLocator).filter(Boolean)),
  ].sort();
  const packageNames = [
    ...new Set(packageLocators.map((locator) => packageNameFromPath(locator))),
  ].sort();
  const payload = {
    mode: 'vite-rollup-write-false',
    moduleCount: modules.length,
    packageNames,
    packageLocators,
    modules,
    outputInventory,
  };
  const evidence = { ...payload, evidenceSha256: sha256(exactJson(payload)) };
  assertWebViewBundleEvidenceCurrent(evidence, evidence);
  return evidence;
}

function canonicalPackagedPermissionEvidence(evidence) {
  const allowedKeys = [
    'apkPath',
    'appIdentity',
    'buildToolsVersion',
    'declaredPermissions',
    'requestedPermissions',
    'schemaVersion',
    'permissionSurfaceSha256',
    'sourceBuildInputSha256',
  ];
  const actualKeys = Object.keys(evidence ?? {}).sort();
  if (
    actualKeys.some((key) => !allowedKeys.includes(key)) ||
    (Object.hasOwn(evidence ?? {}, 'schemaVersion') && evidence.schemaVersion !== 1)
  ) {
    throw policyError(
      'android_packaged_permission_evidence_invalid',
      'Packaged Android permission evidence has unexpected fields or schema',
    );
  }
  const canonical = {
    schemaVersion: 1,
    apkPath: evidence?.apkPath,
    appIdentity: evidence?.appIdentity,
    buildToolsVersion: evidence?.buildToolsVersion,
    permissionSurfaceSha256: evidence?.permissionSurfaceSha256,
    sourceBuildInputSha256: evidence?.sourceBuildInputSha256,
    declaredPermissions: evidence?.declaredPermissions,
    requestedPermissions: evidence?.requestedPermissions,
  };
  if (
    canonical.apkPath !==
      '.native-build/android/build/app/outputs/apk/debug/app-debug.apk' ||
    canonical.appIdentity !== 'uk.eugnel.ks2spelling' ||
    canonical.buildToolsVersion !== '36.0.0' ||
    !/^[a-f0-9]{64}$/.test(canonical.permissionSurfaceSha256 ?? '') ||
    !/^[a-f0-9]{64}$/.test(canonical.sourceBuildInputSha256 ?? '') ||
    !Array.isArray(canonical.declaredPermissions) ||
    canonical.declaredPermissions.length !== 0 ||
    !Array.isArray(canonical.requestedPermissions) ||
    canonical.requestedPermissions.length !== 0
  ) {
    throw policyError(
      'android_packaged_permission_evidence_invalid',
      'Packaged Android permission evidence is incomplete or non-empty',
    );
  }
  return canonical;
}

export function assertPackagedPermissionEvidenceCurrent(actual, committed) {
  const actualCanonical = canonicalPackagedPermissionEvidence(actual);
  const committedCanonical = canonicalPackagedPermissionEvidence(committed);
  if (JSON.stringify(actualCanonical) !== JSON.stringify(committedCanonical)) {
    throw policyError(
      'android_packaged_permission_evidence_stale',
      'Committed packaged Android permission evidence does not match the fresh APK',
    );
  }
  return actualCanonical;
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

export function renderThirdPartyNotices({
  lockPackages,
  spm,
  androidResolution,
  androidComponents = [],
}) {
  const rows = [...lockPackages]
    .sort((left, right) =>
      `${left.name}@${left.version}:${left.locator}`.localeCompare(
        `${right.name}@${right.version}:${right.locator}`,
      ),
    )
    .map(
      ({ name, version, licence, source, locator, distribution, packaged }) =>
        `| ${markdownCell(name)} | ${markdownCell(version)} | ${markdownCell(licence)} | npm | ${markdownCell(source)} | ${markdownCell(locator)} | ${markdownCell(distribution)}; packaged=${packaged} |`,
    );
  for (const dependency of spm) {
    const resolvedRequirement = dependency.requirement.kind === 'version'
      ? `version ${dependency.requirement.version}`
      : `branch ${dependency.requirement.branch}`;
    rows.push(
      `| ${markdownCell(dependency.identity)} | ${markdownCell(dependency.requirement.version ?? dependency.requirement.branch)} | ${markdownCell(dependency.licence)} | SwiftPM | ${markdownCell(dependency.source)} | ${resolvedRequirement}; revision ${markdownCell(dependency.revision)} | packaged=${dependency.packaged} |`,
    );
  }
  for (const component of androidComponents) {
    rows.push(
      `| ${markdownCell(`${component.group}:${component.name}`)} | ${markdownCell(component.version)} | ${markdownCell(component.licence.expression)} | Maven | ${markdownCell(component.pom.sourceUrl)} | ${markdownCell(component.distribution)} | packaged=${component.packaged} |`,
    );
  }
  return `# Third-party notices

This is the deterministic dependency inventory for the B2 local persistence proof. It records package identity, source and declared licence; it is not a substitute for the full licence texts or final store disclosure review.

- Android resolution: \`${typeof androidResolution === 'string' ? androidResolution : androidResolution.status}\`
- npm lock identities: ${lockPackages.length}
- SwiftPM identities: ${spm.length}
- Maven selected module identities: ${typeof androidResolution === 'string' ? 0 : androidResolution.componentCount}
- Maven task-created build-tool identities: ${typeof androidResolution === 'string' ? 0 : androidResolution.taskCreatedBuildToolCount}
- Maven verification inventory: ${typeof androidResolution === 'string' ? 0 : androidResolution.verificationComponentCount} components and ${typeof androidResolution === 'string' ? 0 : androidResolution.verificationArtifactCount} artefacts
- Notice rows: ${rows.length}
- Physically bundled WebView npm packages: ${EXPECTED_WEBVIEW_BUNDLE_PACKAGES.join(', ')}
- Notice inclusion is deliberately conservative and does not mean an npm artefact is packaged
- Runtime network endpoints: none
- Native plugins: @capacitor-community/sqlite 8.1.0 and @capacitor/app 8.1.0, conditionally approved for B2 proof only
- SQLCipher is packaged even though B2 uses no-encryption mode; US export classification remains unresolved before store release

| Package | Version | Declared licence | Source type | Source | Locator | Distribution |
|---|---:|---|---|---|---|---|
${rows.join('\n')}
`;
}

async function listFiles(root) {
  const files = [];
  async function walk(directory) {
    const directoryStats = await lstat(directory);
    if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
      throw policyError('unsafe_audited_path', `Audited directory is not regular: ${directory}`);
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw policyError('unsafe_audited_path', `Symbolic link in audited tree: ${path}`);
      }
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
      else {
        throw policyError('unsafe_audited_path', `Non-regular entry in audited tree: ${path}`);
      }
    }
  }
  await walk(root);
  return files.sort();
}

async function assertRegularFilePath(root, path) {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(root, path);
  const relativePath = relative(absoluteRoot, absolutePath);
  if (relativePath.startsWith('..') || relativePath === '') {
    throw policyError('unsafe_audited_path', `Audited file is outside its root: ${path}`);
  }
  const rootStats = await lstat(absoluteRoot);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw policyError('unsafe_audited_path', `Audited root is not regular: ${absoluteRoot}`);
  }
  const components = relativePath.split('/');
  let current = absoluteRoot;
  for (const [index, component] of components.entries()) {
    current = join(current, component);
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) {
      throw policyError('unsafe_audited_path', `Symbolic link in audited path: ${path}`);
    }
    const isLast = index === components.length - 1;
    if ((isLast && !stats.isFile()) || (!isLast && !stats.isDirectory())) {
      throw policyError('unsafe_audited_path', `Audited path is not regular: ${path}`);
    }
  }
}

function commonClassification(
  policy,
  name,
  lockEntry,
  distribution,
  licenceOverride = null,
) {
  const classification = policy.npmClassifications[name];
  if (!classification) {
    throw policyError('unclassified_dependency', `No classification for ${name}`);
  }
  return {
    name,
    version: lockEntry.version,
    source: lockEntry.resolved,
    integrity: lockEntry.integrity,
    licence: licenceOverride?.approvedForNotice ?? lockEntry.license,
    declaredLicence: lockEntry.license,
    role: distribution.role,
    platform: distribution.platform,
    permissions: [],
    dataAccess: [],
    networkEndpoints: [],
    applePrivacyManifest: classification.applePrivacyManifest,
    googleDataSafety: classification.googleDataSafety,
    sourceRepository: classification.sourceRepository ?? null,
    packaged: distribution.packaged,
    distribution: distribution.distribution,
    privacyRole: distribution.privacyRole,
    restrictedExportClassification:
      classification.restrictedExportClassification ?? 'None identified',
    restrictedClassification: licenceOverride ? 'exact-licence-notice-override' : 'none',
    exportClassification:
      classification.restrictedExportClassification ?? 'none-identified',
    owner: policy.owner,
    reviewDate: policy.reviewDate,
  };
}

function npmDistribution(entry, webViewBundle) {
  const bundledLocators = new Set(webViewBundle.packageLocators);
  if (bundledLocators.has(entry.locator)) {
    return {
      packaged: true,
      distribution: 'webview-bundle',
      role: 'runtime code physically included by the deterministic Vite/Rollup build',
      platform: 'WebView JavaScript bundle',
      privacyRole: 'Physically included in the local WebView JavaScript bundle',
    };
  }
  if (NATIVE_BUILD_SOURCE_NPM_PACKAGES.has(entry.name)) {
    return {
      packaged: false,
      distribution: 'native-build-source',
      role:
        'native build source that compiles into separately evidenced SwiftPM or Maven outputs',
      platform: 'Native build input',
      privacyRole:
        'Source input only; resulting SwiftPM and Maven outputs are certified separately',
    };
  }
  if (entry.dev) {
    return {
      packaged: false,
      distribution: 'build-tool-not-packaged',
      role: 'build-tool dependency absent from application outputs',
      platform: 'Build host',
      privacyRole: 'Build-only lock closure; absent from the WebView bundle',
    };
  }
  return {
    packaged: false,
    distribution: 'installed-not-packaged',
    role:
      'installed optional dependency code absent from the WebView bundle and native source set',
    platform: 'Installed dependency closure only',
    privacyRole:
      'Conservative notice closure only; absent from the WebView bundle and native source set',
  };
}

async function verifyRuntimeBoundary(packageJson) {
  const approvedCapacitorPackages = new Set([
    '@capacitor-community/sqlite',
    '@capacitor/android',
    '@capacitor/app',
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
  const permissionRemovalPattern =
    /<(permission|uses-permission)\s+android:name="([^"]+)"\s+tools:node="remove"\s*\/>/g;
  const permissionRemovalMarkers = [...manifest.matchAll(permissionRemovalPattern)];
  let manifestWithoutRemovalMarkers = manifest;
  for (const marker of permissionRemovalMarkers) {
    manifestWithoutRemovalMarkers = manifestWithoutRemovalMarkers.replace(marker[0], '');
  }
  if (
    permissionRemovalMarkers.length !== 4 ||
    JSON.stringify(permissionRemovalMarkers.map((match) => match[2]).sort()) !==
      JSON.stringify([
        '${applicationId}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION',
        '${applicationId}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION',
        'android.permission.USE_BIOMETRIC',
        'android.permission.USE_FINGERPRINT',
      ].sort()) ||
    /<(?:permission|uses-permission)\b/.test(manifestWithoutRemovalMarkers)
  ) {
    throw policyError(
      'android_permission_declared',
      'B2 app manifest permission surface is not the exact merge-removal contract',
    );
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
  const generatedProjects = [...generatedDependencies.matchAll(/implementation\s+project\('(:[^']+)'\)/g)]
    .map(([, project]) => project)
    .sort();
  if (
    JSON.stringify(generatedProjects) !==
      JSON.stringify([':capacitor-app', ':capacitor-community-sqlite']) ||
    /\b(?:api|classpath)\b/.test(generatedDependencies)
  ) {
    throw policyError('unapproved_native_plugin', 'Generated Android plugin dependency drifted');
  }
  const packageSwift = await readFile(resolve(ROOT, 'ios/App/CapApp-SPM/Package.swift'), 'utf8');
  const products = [...packageSwift.matchAll(/\.product\(name: "([^"]+)"/g)].map(
    ([, name]) => name,
  );
  if (
    products.join(',') !==
    'Capacitor,Cordova,CapacitorCommunitySqlite,CapacitorApp'
  ) {
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
    androidPermissionRemovalMarkers: permissionRemovalMarkers
      .map((match) => `${match[1]}:${match[2]}`)
      .sort(),
    iosEntitlements: entitlements,
    iosUsageDescriptionKeys: usageDescriptionKeys,
  };
}

function validateLock(policy, lock, noticeOverrides) {
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
    const override = noticeOverrides.npmLicenceExpressions[`${name}@${entry.version}`];
    const licenceApproved = override
      ? override.declared === entry.license &&
        typeof override.approvedForNotice === 'string' &&
        override.approvedForNotice.length > 0
      : !/\s+(?:AND|OR)\s+|[()]/.test(entry.license) &&
        approvedLicences.has(entry.license);
    if (!licenceApproved) {
      throw policyError('licence_review_required', `${name}: ${entry.license}`);
    }
    lockPackages.push({
      locator,
      name,
      version: entry.version,
      licence: override?.approvedForNotice ?? entry.license,
      declaredLicence: entry.license,
      licenceOverride: override ?? null,
      source: entry.resolved,
      integrity: entry.integrity,
      dev: entry.dev === true,
    });
  }
  return lockPackages;
}

function stripGradleComments(text) {
  let output = '';
  let state = 'normal';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (state === 'line-comment') {
      if (character === '\n') {
        output += character;
        state = 'normal';
      }
      continue;
    }
    if (state === 'block-comment') {
      if (character === '*' && next === '/') {
        index += 1;
        state = 'normal';
      } else if (character === '\n') {
        output += character;
      }
      continue;
    }
    if (state === 'single-quote' || state === 'double-quote') {
      output += character;
      if (character === '\\' && next) {
        output += next;
        index += 1;
      } else if (
        (state === 'single-quote' && character === "'") ||
        (state === 'double-quote' && character === '"')
      ) {
        state = 'normal';
      }
      continue;
    }
    if (character === '/' && next === '/') {
      state = 'line-comment';
      index += 1;
    } else if (character === '/' && next === '*') {
      state = 'block-comment';
      index += 1;
    } else {
      output += character;
      if (character === "'") state = 'single-quote';
      if (character === '"') state = 'double-quote';
    }
  }
  return output;
}

function extractNamedBlocks(text, keyword) {
  const blocks = [];
  const pattern = new RegExp(`\\b${keyword}\\s*\\{`, 'g');
  for (const match of text.matchAll(pattern)) {
    const openingBrace = match.index + match[0].lastIndexOf('{');
    let depth = 0;
    for (let index = openingBrace; index < text.length; index += 1) {
      if (text[index] === '{') depth += 1;
      if (text[index] === '}') depth -= 1;
      if (depth === 0) {
        blocks.push(text.slice(openingBrace + 1, index));
        break;
      }
    }
  }
  return blocks;
}

export function parseGradleEvidence(sources) {
  const cleanSources = sources.map(({ path, text }) => ({
    path,
    text: stripGradleComments(text),
  }));
  const combined = cleanSources.map(({ text }) => text).join('\n');
  const variables = new Map(
    [...combined.matchAll(/\b([A-Za-z][A-Za-z0-9_]*Version)\s*=\s*['"]([^'"]+)['"]/g)].map(
      ([, name, value]) => [name, value],
    ),
  );
  const declarations = new Map();
  const localDependencies = new Set();
  function recordDeclaration({ configuration, raw, path }) {
    const resolved = raw.replace(/\$\{?([A-Za-z][A-Za-z0-9_]*)\}?/g, (_, name) => {
      const value = variables.get(name);
      if (!value) {
        throw policyError(
          'gradle_declaration_drift',
          `Unresolved Gradle variable ${name} in ${path}`,
        );
      }
      return value;
    });
    const [group, artifact, ...versionParts] = resolved.split(':');
    if (!group || !artifact || versionParts.length === 0) {
      throw policyError(
        'gradle_declaration_drift',
        `Unresolved Maven coordinate in ${path}: ${raw}`,
      );
    }
    const version = versionParts.join(':');
    const key = `${group}:${artifact}:${version}`;
    const existing = declarations.get(key) ?? {
      coordinate: `${group}:${artifact}`,
      version,
      configurations: new Set(),
      sources: new Set(),
    };
    existing.configurations.add(configuration);
    existing.sources.add(path);
    declarations.set(key, existing);
  }
  for (const { path, text } of cleanSources) {
    for (const dependencyBlock of extractNamedBlocks(text, 'dependencies')) {
      for (const [, raw] of dependencyBlock.matchAll(
        /['"]([^'"\r\n]+:[^'"\r\n]+:[^'"\r\n]+)['"]/g,
      )) {
        recordDeclaration({ configuration: 'literal', raw, path });
      }
      const mapDeclarations = [
        ...dependencyBlock.matchAll(
          /\bgroup\s*:\s*['"]([^'"]+)['"]\s*,\s*name\s*:\s*['"]([^'"]+)['"]\s*,\s*version\s*:\s*['"]([^'"]+)['"]/g,
        ),
      ];
      for (const match of mapDeclarations) {
        recordDeclaration({
          configuration: 'map-literal',
          raw: `${match[1]}:${match[2]}:${match[3]}`,
          path,
        });
      }
      if ([...dependencyBlock.matchAll(/\bgroup\s*:/g)].length !== mapDeclarations.length) {
        throw policyError(
          'gradle_declaration_drift',
          `Dynamic Gradle map dependency is not permitted in ${path}`,
        );
      }
      const projectDependencies = [
        ...dependencyBlock.matchAll(/\bproject\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
      ];
      for (const match of projectDependencies) {
        localDependencies.add(`project:${match[1]}`);
      }
      if ([...dependencyBlock.matchAll(/\bproject\s*\(/g)].length !== projectDependencies.length) {
        throw policyError(
          'gradle_declaration_drift',
          `Dynamic Gradle project dependency is not permitted in ${path}`,
        );
      }
      const fileTreeDependencies = [...dependencyBlock.matchAll(/\bfileTree\s*\(([^)]*)\)/g)];
      for (const match of fileTreeDependencies) {
        const dir = match[1].match(/\bdir\s*:\s*['"]([^'"]+)['"]/)?.[1];
        if (!dir) {
          throw policyError('gradle_declaration_drift', `Unresolved fileTree in ${path}`);
        }
        localDependencies.add(`fileTree:${dir}`);
      }
      if ([...dependencyBlock.matchAll(/\bfileTree\s*\(/g)].length !== fileTreeDependencies.length) {
        throw policyError(
          'gradle_declaration_drift',
          `Dynamic Gradle fileTree dependency is not permitted in ${path}`,
        );
      }
      if (/\badd\s*\(/.test(dependencyBlock) || /\blibs(?:\.|\[)/.test(dependencyBlock)) {
        throw policyError(
          'gradle_declaration_drift',
          `Dynamic Gradle dependency syntax is not permitted in ${path}`,
        );
      }
      const fragments = dependencyBlock.replaceAll('{', '\n').replaceAll('}', '\n').split(/[;\n\r]+/);
      for (const fragment of fragments) {
        const statement = fragment.trim();
        if (!statement || /^(?:if|else|try|catch|finally)\b/.test(statement)) continue;
        const statementMatch = statement.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(.*)$/);
        if (!statementMatch) continue;
        const [, configuration, syntax] = statementMatch;
        if (!syntax) {
          if (configuration === 'constraints') continue;
          throw policyError(
            'gradle_declaration_drift',
            `Unresolved dependency statement in ${path}: ${statement}`,
          );
        }
        const projectMatch = syntax.match(/^project\(\s*['"]([^'"]+)['"]/);
        if (projectMatch) {
          localDependencies.add(`project:${projectMatch[1]}`);
          continue;
        }
        if (/^fileTree\b/.test(syntax)) {
          const dir = syntax.match(/\bdir\s*:\s*['"]([^'"]+)['"]/)?.[1];
          if (!dir) {
            throw policyError('gradle_declaration_drift', `Unresolved fileTree in ${path}`);
          }
          localDependencies.add(`fileTree:${dir}`);
          continue;
        }
        const stringMatch = syntax.match(
          /^(?:\(\s*)?(?:(?:platform|enforcedPlatform)\s*\(\s*)?['"]([^'"]+)['"]/,
        );
        if (stringMatch) {
          recordDeclaration({ configuration, raw: stringMatch[1], path });
          continue;
        }
        const mapMatch = syntax.match(
          /^(?:\(\s*)?group\s*:\s*['"]([^'"]+)['"]\s*,\s*name\s*:\s*['"]([^'"]+)['"]\s*,\s*version\s*:\s*['"]([^'"]+)['"]/,
        );
        if (mapMatch) {
          recordDeclaration({
            configuration,
            raw: `${mapMatch[1]}:${mapMatch[2]}:${mapMatch[3]}`,
            path,
          });
          continue;
        }
        throw policyError(
          'gradle_declaration_drift',
          `Unresolved ${configuration} declaration in ${path}: ${syntax}`,
        );
      }
    }
  }

  const repositories = new Set();
  const flatDirs = new Set();
  for (const { text } of cleanSources) {
    for (const block of extractNamedBlocks(text, 'repositories')) {
      for (const [, call] of block.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)/g)) {
        repositories.add(`${call}()`);
      }
      const urls = [
        ...block.matchAll(
          /(?:\burl\s*(?:=\s*)?(?:uri\s*\(\s*)?|\bsetUrl\s*\(\s*)['"]([^'"]+)['"]/g,
        ),
      ].map(([, url]) => url);
      for (const url of urls) repositories.add(url);
      for (const repositoryType of ['maven', 'ivy']) {
        for (const repositoryBlock of extractNamedBlocks(block, repositoryType)) {
          const hasLiteralUrl = /(?:\burl\s*(?:=\s*)?(?:uri\s*\(\s*)?|\bsetUrl\s*\(\s*)['"][^'"]+['"]/.test(
            repositoryBlock,
          );
          if (!hasLiteralUrl) repositories.add(`${repositoryType}:<missing-url>`);
        }
      }
      for (const flatDirBlock of extractNamedBlocks(block, 'flatDir')) {
        let literalCount = 0;
        for (const dirs of flatDirBlock.matchAll(/\bdirs\s*(?:\(\s*)?([^\n\r}]+)/g)) {
          for (const [, path] of dirs[1].matchAll(/['"]([^'"]+)['"]/g)) {
            flatDirs.add(path);
            literalCount += 1;
          }
        }
        if (literalCount === 0) flatDirs.add('flatDir:<dynamic>');
      }
    }
  }

  return {
    sourceFiles: sources
      .map(({ path, text }) => ({
        path,
        sha256: createHash('sha256').update(text).digest('hex'),
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    declarations: [...declarations.values()]
      .map((entry) => ({
        ...entry,
        configurations: [...entry.configurations].sort(),
        sources: [...entry.sources].sort(),
      }))
      .sort((left, right) =>
        `${left.coordinate}:${left.version}`.localeCompare(`${right.coordinate}:${right.version}`),
      ),
    repositories: [...repositories].sort(),
    flatDirs: [...flatDirs].sort(),
    localDependencies: [...localDependencies].sort(),
  };
}

function isGradleInputPath(path) {
  if (path.startsWith('android/capacitor-cordova-android-plugins/')) return false;
  if (path.startsWith('android/.gradle/') || path.includes('/build/')) return false;
  if (path.includes('/buildSrc/')) return true;
  return (
    /\.(?:gradle|gradle\.kts)$/.test(path) ||
    /(?:^|\/)libs\.versions\.toml$/.test(path) ||
    /(?:^|\/)gradle\.properties$/.test(path) ||
    /(?:^|\/)gradle-wrapper\.(?:properties|jar)$/.test(path) ||
    /(?:^|\/)gradlew(?:\.bat)?$/.test(path)
  );
}

export async function discoverGradleInputs(root = ROOT) {
  const androidRoot = resolve(root, 'android');
  const androidPaths = (await listFiles(androidRoot))
    .map((path) => relative(root, path))
    .filter(isGradleInputPath);
  const paths = [
    ...androidPaths,
    'node_modules/@capacitor/android/capacitor/build.gradle',
    'node_modules/@capacitor/app/android/build.gradle',
    'node_modules/@capacitor-community/sqlite/android/build.gradle',
  ].sort();
  const entries = await Promise.all(
    paths.map(async (path) => {
      await assertRegularFilePath(root, path);
      const content = await readFile(resolve(root, path));
      return {
        path,
        sha256: createHash('sha256').update(content).digest('hex'),
        content,
      };
    }),
  );
  return {
    inventory: entries.map(({ path, sha256 }) => ({ path, sha256 })),
    parserSources: entries
      .filter(
        ({ path }) =>
          /\.(?:gradle|gradle\.kts)$/.test(path) &&
          !path.startsWith('node_modules/@capacitor/app/') &&
          !path.startsWith('node_modules/@capacitor-community/sqlite/'),
      )
      .map(({ path, content }) => ({ path, text: content.toString('utf8') })),
  };
}

export function assertGradleInputInventoryMatchesPolicy(inventory, policy) {
  const expected = policy.gradleInputFiles ?? [];
  const actualByPath = new Map(inventory.map((entry) => [entry.path, entry.sha256]));
  const expectedByPath = new Map(expected.map((entry) => [entry.path, entry.sha256]));
  const duplicateActual = inventory.length !== actualByPath.size;
  const duplicateExpected = expected.length !== expectedByPath.size;
  const extra = [...actualByPath.keys()].filter((path) => !expectedByPath.has(path));
  const missing = [...expectedByPath.keys()].filter((path) => !actualByPath.has(path));
  const changed = [...actualByPath].flatMap(([path, sha256]) =>
    expectedByPath.has(path) && expectedByPath.get(path) !== sha256 ? [path] : [],
  );
  if (duplicateActual || duplicateExpected || extra.length || missing.length || changed.length) {
    throw policyError(
      'gradle_input_drift',
      `Gradle input allow-list drifted; extra=${extra.join(',')}; missing=${missing.join(',')}; changed=${changed.join(',')}`,
    );
  }
}

function exactSetDifference(actual, expected) {
  const expectedSet = new Set(expected);
  return actual.filter((value) => !expectedSet.has(value));
}

export function assertGradleEvidenceMatchesPolicy(evidence, policy) {
  const actualDeclarations = evidence.declarations.map(
    ({ coordinate, version }) => `${coordinate}:${version}`,
  );
  const expectedDeclarations = policy.gradleDeclared.map(
    ({ coordinate, version }) => `${coordinate}:${version}`,
  );
  const extraDeclarations = exactSetDifference(actualDeclarations, expectedDeclarations);
  const missingDeclarations = exactSetDifference(expectedDeclarations, actualDeclarations);
  if (extraDeclarations.length || missingDeclarations.length) {
    throw policyError(
      'gradle_declaration_drift',
      `Gradle declaration set drifted; extra=${extraDeclarations.join(',')}; missing=${missingDeclarations.join(',')}`,
    );
  }
  const extraRepositories = exactSetDifference(
    evidence.repositories,
    policy.allowedSources.gradleRepositories,
  );
  const missingRepositories = exactSetDifference(
    policy.allowedSources.gradleRepositories,
    evidence.repositories,
  );
  if (extraRepositories.length || missingRepositories.length) {
    throw policyError(
      'unapproved_gradle_source',
      `Gradle repository set drifted; extra=${extraRepositories.join(',')}; missing=${missingRepositories.join(',')}`,
    );
  }
  const extraFlatDirs = exactSetDifference(evidence.flatDirs, policy.allowedSources.gradleFlatDirs);
  const missingFlatDirs = exactSetDifference(policy.allowedSources.gradleFlatDirs, evidence.flatDirs);
  if (extraFlatDirs.length || missingFlatDirs.length) {
    throw policyError(
      'unapproved_flat_dir',
      `Gradle flatDir set drifted; extra=${extraFlatDirs.join(',')}; missing=${missingFlatDirs.join(',')}`,
    );
  }
  const extraLocalDependencies = exactSetDifference(
    evidence.localDependencies,
    policy.allowedSources.gradleLocalDependencies,
  );
  const missingLocalDependencies = exactSetDifference(
    policy.allowedSources.gradleLocalDependencies,
    evidence.localDependencies,
  );
  if (extraLocalDependencies.length || missingLocalDependencies.length) {
    throw policyError(
      'gradle_declaration_drift',
      `Gradle local dependency set drifted; extra=${extraLocalDependencies.join(',')}; missing=${missingLocalDependencies.join(',')}`,
    );
  }
}

async function verifyGradleDeclarations(policy, androidCertification = null) {
  const discovered = await discoverGradleInputs();
  assertGradleInputInventoryMatchesPolicy(discovered.inventory, policy);
  const evidence = parseGradleEvidence(discovered.parserSources);
  assertGradleEvidenceMatchesPolicy(evidence, policy);
  return {
    inputs: discovered.inventory,
    declarations: policy.gradleDeclared.map((entry) => {
      if (!androidCertification) return { ...entry, resolution: 'pending-toolchain' };
      const coordinate = `${entry.coordinate}:${entry.version}`;
      const resolved = androidCertification.components.find(
        (component) => component.coordinate === coordinate,
      );
      if (resolved) {
        return {
          ...entry,
          resolution: 'resolved-toolchain',
          distribution: resolved.distribution,
        };
      }
      if (coordinate === 'io.github.gradle-nexus:publish-plugin:1.3.0') {
        return {
          ...entry,
          resolution: 'inactive-condition',
          condition: 'CAP_PUBLISH is not enabled',
        };
      }
      throw policyError(
        'android_resolution_incomplete',
        `Declared Maven dependency is absent from the resolved graph: ${coordinate}`,
      );
    }),
    repositories: evidence.repositories,
    flatDirs: evidence.flatDirs,
    localDependencies: evidence.localDependencies,
  };
}

export async function buildDependencyArtifacts({
  preBootstrap = false,
  discoverAndroidSources = false,
} = {}) {
  const [
    policy,
    packageJson,
    lock,
    packageLockText,
    packageResolved,
    nativePluginBuild,
    noticeOverrides,
  ] = await Promise.all([
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
    readJson(NATIVE_PLUGIN_BUILD_PATH),
    readJson(resolve(ROOT, 'config/third-party-notices-overrides.json')),
  ]);
  const nativePluginBuildText = await readFile(NATIVE_PLUGIN_BUILD_PATH);
  const nativePluginBuildSha256 = createHash('sha256')
    .update(nativePluginBuildText)
    .digest('hex');
  const committedB2Report = existsSync(REPORT_PATH) ? await readJson(REPORT_PATH) : null;
  const androidCertification = preBootstrap
    ? null
    : await (
        await import('./certify-android-dependencies.mjs')
      ).buildAndroidCertification({
        discoverSources: discoverAndroidSources,
        committed: discoverAndroidSources
          ? null
          : committedB2Report?.android,
      });

  assertDirectPolicy(packageJson.dependencies, policy.directDependencies, 'runtime dependency');
  assertDirectPolicy(packageJson.devDependencies, policy.directBuildTools, 'build tool');
  assertDirectPolicy(lock.packages[''].dependencies, policy.directDependencies, 'lock runtime');
  assertDirectPolicy(lock.packages[''].devDependencies, policy.directBuildTools, 'lock build');
  const lockPackages = validateLock(policy, lock, noticeOverrides);
  const webViewBundle = await buildWebViewBundleEvidence(lock);
  const committedPrivacyManifests = committedB2Report?.ios?.packagedPrivacyManifests;
  const iosPackagedPrivacyManifests =
    await resolveIosPackagedPrivacyManifestEvidence({
      committed: committedPrivacyManifests,
      requireFresh: discoverAndroidSources,
    });
  const permissionEvidence = await verifyRuntimeBoundary(packageJson);
  permissionEvidence.packagedAndroid = {
    appIdentity: nativePluginBuild.android.packagedPermissions.appIdentity,
    buildToolsVersion: nativePluginBuild.android.packagedPermissions.buildToolsVersion,
    permissionSurfaceSha256:
      nativePluginBuild.android.packagedPermissions.permissionSurfaceSha256,
    declaredPermissions:
      nativePluginBuild.android.packagedPermissions.declaredPermissions,
    requestedPermissions:
      nativePluginBuild.android.packagedPermissions.requestedPermissions,
  };

  const production = stableSortByName(
    lockPackages
      .filter(({ dev }) => !dev)
      .map((entry) => ({
        ...commonClassification(
          policy,
          entry.name,
          lock.packages[entry.locator],
          npmDistribution(entry, webViewBundle),
          entry.licenceOverride,
        ),
        locator: entry.locator,
      })),
  );
  const directBuildTools = stableSortByName(
    Object.keys(policy.directBuildTools).map((name) =>
      commonClassification(
        policy,
        name,
        lock.packages[`node_modules/${name}`],
        npmDistribution(
          lockPackages.find(({ locator }) => locator === `node_modules/${name}`),
          webViewBundle,
        ),
        noticeOverrides.npmLicenceExpressions[
          `${name}@${lock.packages[`node_modules/${name}`].version}`
        ],
      ),
    ),
  );
  const allPackages = lockPackages
    .map((entry) => {
      const classification = policy.npmClassifications[entry.name];
      const distribution = npmDistribution(entry, webViewBundle);
      return {
        locator: entry.locator,
        name: entry.name,
        version: entry.version,
        source: entry.source,
        integrity: entry.integrity,
        declaredLicence: entry.declaredLicence,
        licence: entry.licence,
        dev: entry.dev,
        packaged: distribution.packaged,
        distribution: distribution.distribution,
        role: distribution.role,
        platform: distribution.platform,
        privacyRole: distribution.privacyRole,
        restrictedExportClassification:
          classification?.restrictedExportClassification ?? 'None identified',
        restrictedClassification: entry.licenceOverride
          ? 'exact-licence-notice-override'
          : 'none',
        exportClassification:
          classification?.restrictedExportClassification ?? 'none-identified',
      };
    })
    .sort((left, right) =>
      `${left.name}@${left.version}:${left.locator}`.localeCompare(
        `${right.name}@${right.version}:${right.locator}`,
      ),
    );

  if (packageResolved.version !== 3 || packageResolved.pins.length !== policy.spm.length) {
    throw policyError('spm_resolution_drift', 'SwiftPM resolution count drifted');
  }
  const nativePins = new Map(
    nativePluginBuild.ios.spmPins.map((entry) => [entry.identity, entry]),
  );
  const spm = policy.spm.map((dependency) => {
    const pin = packageResolved.pins.find(({ identity }) => identity === dependency.identity);
    const nativePin = nativePins.get(dependency.identity);
    const expectedState = dependency.requirement.kind === 'version'
      ? { revision: dependency.revision, version: dependency.requirement.version }
      : { branch: dependency.requirement.branch, revision: dependency.revision };
    if (
      !pin ||
      !nativePin ||
      pin.kind !== 'remoteSourceControl' ||
      pin.location !== dependency.source ||
      JSON.stringify(pin.state) !== JSON.stringify(expectedState) ||
      JSON.stringify(nativePin.state) !== JSON.stringify(expectedState) ||
      nativePin.location !== dependency.source ||
      !policy.allowedSources.spm.includes(pin.location)
    ) {
      throw policyError(
        'spm_resolution_drift',
        `SwiftPM resolution drifted: ${dependency.identity}`,
      );
    }
    return {
      ...dependency,
      name: dependency.identity,
      version:
        dependency.requirement.version ?? dependency.requirement.branch,
      permissions: [],
      dataAccess: [],
      networkEndpoints: [],
      applePrivacyManifest: dependency.privacyRole,
      googleDataSafety: 'Not applicable',
      owner: policy.owner,
      reviewDate: policy.reviewDate,
    };
  });
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
  spm[0].privacyManifests = privacyManifests;
  const gradle = await verifyGradleDeclarations(policy, androidCertification);
  const androidResolution = androidCertification
    ? {
        status: androidCertification.mode,
        evidencePath: 'reports/b2/dependency-audit.json#android',
        componentCount: androidCertification.componentCount,
        scopeMembershipCount: androidCertification.scopeMembershipCount,
        packagedRuntimeCount: androidCertification.packagedRuntimeCount,
        scopeRestrictedToolingCount:
          androidCertification.scopeRestrictedToolingCount,
        taskCreatedBuildToolCount:
          androidCertification.taskCreatedBuildToolCount,
        verificationComponentCount:
          androidCertification.verificationInventory.componentCount,
        verificationArtifactCount:
          androidCertification.verificationInventory.artifactCount,
      }
    : 'pending-toolchain';
  const report = {
    schemaVersion: 2,
    mode: androidCertification ? 'resolved-toolchain' : 'pre-bootstrap',
    generatedFrom: {
      packageLockSha256: createHash('sha256').update(packageLockText).digest('hex'),
      spmResolvedVersion: packageResolved.version,
      nativePluginBuildSha256,
      webViewBundleEvidenceSha256: webViewBundle.evidenceSha256,
    },
    npm: {
      lockfileVersion: lock.lockfileVersion,
      lockPackageCount: lockPackages.length,
      webViewBundle,
      allPackages,
      approvedLicences: policy.approvedLicences,
      production,
      directBuildTools,
    },
    spm,
    ios: {
      packagedPrivacyManifests: iosPackagedPrivacyManifests,
    },
    android: androidCertification,
    androidResolution,
    gradleInputs: gradle.inputs,
    gradleRepositories: gradle.repositories,
    gradleFlatDirs: gradle.flatDirs,
    gradleLocalDependencies: gradle.localDependencies,
    gradleDeclared: gradle.declarations,
    plugins: {
      approved: policy.approvedNativePlugins,
      candidates: policy.candidatePlugins,
    },
    permissionEvidence,
    b2Truth: {
      childDataCollected: false,
      childDataTransmitted: false,
      analytics: false,
      advertising: false,
      appPermissions: [],
      storeCommerce: false,
      runtimeNetworkEndpoints: [],
      localDatabase: true,
      sqliteMode: 'no-encryption',
      sqlCipherPackaged: true,
      applicationEncryptionAtRestProved: false,
      usEncryptionExportClassification: 'unresolved-before-store-release',
      approval: 'B2-proof-only',
      disclosureStatus: 'B2 proof only; not a final store disclosure',
    },
  };
  const pluginAudit = {
    schemaVersion: 1,
    nativePluginBuildSha256,
    dependencyAuditSha256: null,
    sqliteMode: 'no-encryption',
    webFallbackInitialised: false,
    androidPackagedPermissions:
      nativePluginBuild.android.packagedPermissions.requestedPermissions,
    iosAddedUsageDescriptionKeys: nativePluginBuild.ios.addedUsageDescriptionKeys,
    iosAddedEntitlements: nativePluginBuild.ios.addedEntitlements,
    iosPackagedPrivacyManifests,
    webViewBundleEvidenceSha256: webViewBundle.evidenceSha256,
    androidBackupEnabled: nativePluginBuild.android.packagedManifest.allowBackup,
    androidDataExtraction: 'all-domains-excluded-until-c2',
    androidBackupRulesSha256:
      nativePluginBuild.android.packagedBackupRules.xmlTreeSha256,
    androidBackupExcludedDomains:
      nativePluginBuild.android.packagedBackupRules.excludedDomains,
    androidDataExtractionRulesSha256:
      nativePluginBuild.android.packagedDataExtractionRules.xmlTreeSha256,
    androidCloudBackupExcludedDomains:
      nativePluginBuild.android.packagedDataExtractionRules.cloudBackupExcludedDomains,
    androidDeviceTransferExcludedDomains:
      nativePluginBuild.android.packagedDataExtractionRules.deviceTransferExcludedDomains,
    sqlCipherPackaged: nativePluginBuild.ios.outputInventory.some(({ path }) =>
      path.includes('/SQLCipher.framework/'),
    ),
    applicationEncryptionAtRestProved: false,
    usEncryptionExportClassification: 'unresolved-before-store-release',
    approval: 'B2-proof-only',
  };
  const reportJson = `${JSON.stringify(report, null, 2)}\n`;
  pluginAudit.dependencyAuditSha256 = createHash('sha256')
    .update(reportJson)
    .digest('hex');
  const pluginAuditJson = `${JSON.stringify(pluginAudit, null, 2)}\n`;
  const noticesMarkdown = renderThirdPartyNotices({
    lockPackages: allPackages,
    spm,
    androidResolution: report.androidResolution,
    androidComponents: androidCertification
      ? [
          ...androidCertification.components,
          ...androidCertification.taskCreatedBuildTools,
        ]
      : [],
  });
  return { report, reportJson, pluginAudit, pluginAuditJson, noticesMarkdown };
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
  await mkdir(resolve(ROOT, 'reports/b2'), { recursive: true });
  await Promise.all([
    writeFile(REPORT_PATH, artifacts.reportJson, 'utf8'),
    writeFile(NATIVE_PLUGIN_AUDIT_PATH, artifacts.pluginAuditJson, 'utf8'),
    writeFile(NOTICES_PATH, artifacts.noticesMarkdown, 'utf8'),
  ]);
}

export function assertDependencyEvidenceCurrent(artifacts, current) {
  if (
    current.reportJson !== artifacts.reportJson ||
    current.pluginAuditJson !== artifacts.pluginAuditJson ||
    current.noticesMarkdown !== artifacts.noticesMarkdown
  ) {
    throw policyError(
      'dependency_evidence_stale',
      'Committed B2 dependency, plugin or third-party notice evidence is stale; rerun with --write',
    );
  }
}

export async function main(args = process.argv.slice(2)) {
  const preBootstrap = args.includes('--pre-bootstrap');
  const write = args.includes('--write');
  try {
    if (!preBootstrap) {
      const androidBuild = await runCommand(
        process.execPath,
        ['scripts/test-android.mjs'],
        { cwd: ROOT },
      );
      if (androidBuild.exitCode !== EXIT_CODES.success) {
        throw policyError(
          'android_packaged_permission_gate_failed',
          `Android build and packaged permission inspection failed with ${androidBuild.exitCode}`,
        );
      }
      const { verifyPackagedAndroidPermissions } = await import('./test-android.mjs');
      const currentPermissionEvidence = await verifyPackagedAndroidPermissions();
      const nativeBuild = await readJson(NATIVE_PLUGIN_BUILD_PATH);
      if (
        JSON.stringify(currentPermissionEvidence.requestedPermissions) !==
          JSON.stringify(nativeBuild.android.packagedPermissions.requestedPermissions) ||
        JSON.stringify(currentPermissionEvidence.declaredPermissions) !==
          JSON.stringify(nativeBuild.android.packagedPermissions.declaredPermissions)
      ) {
        throw policyError(
          'android_packaged_permission_evidence_stale',
          'Fresh APK permission surface does not match the B2 native build report',
        );
      }
    }
    const artifacts = await buildDependencyArtifacts({
      preBootstrap,
      discoverAndroidSources: write && !preBootstrap,
    });
    if (write) {
      await writeDependencyArtifacts(artifacts);
    } else {
      assertDependencyEvidenceCurrent(artifacts, {
        reportJson: await readFile(REPORT_PATH, 'utf8'),
        pluginAuditJson: await readFile(NATIVE_PLUGIN_AUDIT_PATH, 'utf8'),
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
