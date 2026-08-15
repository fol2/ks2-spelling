import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const IOS_APP_ROOT = join(ROOT, 'ios/App/App');
const PROJECT = join(ROOT, 'ios/App/App.xcodeproj/project.pbxproj');
const SOURCE_ROOT = join(ROOT, 'src');
const SOURCE_EXTENSIONS = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.mjs',
  '.ts',
  '.tsx',
]);

const EXPECTED_PRIVACY_MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>NSPrivacyAccessedAPITypes</key>
\t<array>
\t\t<dict>
\t\t\t<key>NSPrivacyAccessedAPIType</key>
\t\t\t<string>NSPrivacyAccessedAPICategoryDiskSpace</string>
\t\t\t<key>NSPrivacyAccessedAPITypeReasons</key>
\t\t\t<array>
\t\t\t\t<string>E174.1</string>
\t\t\t</array>
\t\t</dict>
\t\t<dict>
\t\t\t<key>NSPrivacyAccessedAPIType</key>
\t\t\t<string>NSPrivacyAccessedAPICategoryFileTimestamp</string>
\t\t\t<key>NSPrivacyAccessedAPITypeReasons</key>
\t\t\t<array>
\t\t\t\t<string>C617.1</string>
\t\t\t</array>
\t\t</dict>
\t</array>
\t<key>NSPrivacyCollectedDataTypes</key>
\t<array/>
\t<key>NSPrivacyTracking</key>
\t<false/>
\t<key>NSPrivacyTrackingDomains</key>
\t<array/>
</dict>
</plist>
`;

const LINK_OUT_PATTERNS = Object.freeze([
  {
    name: 'anchor href',
    pattern: /<a\b[^>]*\bhref\s*=/iu,
    example: '<a href="/privacy">Privacy</a>',
  },
  {
    name: 'window.open',
    pattern: /\bwindow\s*\.\s*open\s*\(/u,
    example: 'window.open(destination)',
  },
  {
    name: 'location navigation',
    pattern: /\b(?:window\s*\.\s*)?location\s*\.\s*(?:href|assign|replace)\b/u,
    example: 'location.href = destination',
  },
  {
    name: 'mailto scheme',
    pattern: /\bmailto:/iu,
    example: 'mailto:parent@example.invalid',
  },
  {
    name: 'telephone scheme',
    pattern: /\btel:/iu,
    example: 'tel:00000000000',
  },
  {
    name: 'URL scheme',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\//iu,
    example: 'https://example.invalid',
  },
  {
    name: 'Capacitor App openUrl',
    pattern: /\bopenUrl\s*\(/u,
    example: 'openUrl({ url: destination })',
  },
]);

async function listSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(path)));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

function linkOutFindings(path, source) {
  return LINK_OUT_PATTERNS.filter(({ pattern }) => pattern.test(source)).map(
    ({ name }) => `${relative(ROOT, path)}: ${name}`,
  );
}

function resourcesPhase(project, id) {
  const marker = `${id} /* Resources */ = {`;
  const start = project.indexOf(marker);
  assert.notEqual(start, -1, `missing Resources build phase ${id}`);
  const end = project.indexOf('\n\t\t};', start);
  assert.notEqual(end, -1, `unterminated Resources build phase ${id}`);
  return project.slice(start, end + 5);
}

test('the link-out detector rejects every prohibited source primitive', () => {
  for (const { name, pattern, example } of LINK_OUT_PATTERNS) {
    assert.match(example, pattern, `${name} must be detectable`);
  }
});

test('the Android submission build cannot auto-enable Firebase from a local file', async () => {
  const buildGradle = await readFile(join(ROOT, 'android/app/build.gradle'), 'utf8');
  assert.doesNotMatch(buildGradle, /google-services\.json/);
  assert.doesNotMatch(buildGradle, /com\.google\.gms\.google-services/);
});

test('the iOS app owns the exact Required Reason API manifest and no StoreKit fixture', async () => {
  const [manifest, project, packTransfer, packInstallSealer] = await Promise.all([
    readFile(join(IOS_APP_ROOT, 'PrivacyInfo.xcprivacy'), 'utf8'),
    readFile(PROJECT, 'utf8'),
    readFile(join(IOS_APP_ROOT, 'PackTransferPlugin.swift'), 'utf8'),
    readFile(join(IOS_APP_ROOT, 'PackInstallSealer.swift'), 'utf8'),
  ]);

  assert.equal(manifest, EXPECTED_PRIVACY_MANIFEST);
  assert.match(packTransfer, /volumeAvailableCapacityForImportantUsageKey/);
  assert.match(packInstallSealer, /\blstat\(/);
  assert.match(packInstallSealer, /\bfstat\(/);
  assert.match(project, /lastKnownFileType = text\.xml; path = PrivacyInfo\.xcprivacy;/);
  assert.equal(
    [
      ...project.matchAll(
        /PrivacyInfo\.xcprivacy in Resources \*\/ = \{isa = PBXBuildFile/g,
      ),
    ].length,
    1,
    'the first-party privacy manifest must belong to the App target exactly once',
  );

  const appResources = resourcesPhase(project, '504EC3021FED79650016851F');
  const appTestResources = resourcesPhase(project, 'B31500000000000000000024');
  assert.match(appResources, /PrivacyInfo\.xcprivacy in Resources/);
  assert.doesNotMatch(appResources, /B3Sandbox\.storekit in Resources/);
  assert.match(appTestResources, /B3Sandbox\.storekit in Resources/);
  assert.doesNotMatch(appTestResources, /PrivacyInfo\.xcprivacy in Resources/);
});

test('Kids Category source and dependencies cannot acquire a link-out capability', async () => {
  const [packageJson, packageLock] = await Promise.all([
    readFile(join(ROOT, 'package.json'), 'utf8'),
    readFile(join(ROOT, 'package-lock.json'), 'utf8'),
  ]);
  assert.doesNotMatch(packageJson, /@capacitor\/browser/);
  assert.doesNotMatch(packageLock, /node_modules\/@capacitor\/browser/);

  const findings = [];
  for (const path of await listSourceFiles(SOURCE_ROOT)) {
    findings.push(...linkOutFindings(path, await readFile(path, 'utf8')));
  }
  assert.deepEqual(
    findings,
    [],
    `link-out capability found in product source:\n${findings.join('\n')}`,
  );
});

test('native share sheets and App Store restore remain allowed local surfaces', async () => {
  const [iosBackup, androidBackup, iosCommerce] = await Promise.all([
    readFile(join(IOS_APP_ROOT, 'LearningBackupFilePlugin.swift'), 'utf8'),
    readFile(
      join(
        ROOT,
        'android/app/src/main/java/uk/eugnel/ks2spelling/LearningBackupFilePlugin.java',
      ),
      'utf8',
    ),
    readFile(join(IOS_APP_ROOT, 'CommercePlugin.swift'), 'utf8'),
  ]);
  assert.match(iosBackup, /UIActivityViewController/);
  assert.match(androidBackup, /Intent\.ACTION_SEND/);
  assert.match(iosCommerce, /AppStore\.sync\(\)/);
});
