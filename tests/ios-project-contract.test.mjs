import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const IOS_ROOT = join(ROOT, 'ios/App');
const PROJECT = join(IOS_ROOT, 'App.xcodeproj/project.pbxproj');
const INFO_PLIST = join(IOS_ROOT, 'App/Info.plist');
const SCHEME = join(
  IOS_ROOT,
  'App.xcodeproj/xcshareddata/xcschemes/KS2Spelling.xcscheme',
);
const PACKAGE_RESOLVED = join(
  IOS_ROOT,
  'App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved',
);

test('the committed iOS project freezes the unsigned B1 identity', async () => {
  assert.ok(
    existsSync(PROJECT) &&
      existsSync(INFO_PLIST) &&
      existsSync(SCHEME) &&
      existsSync(PACKAGE_RESOLVED),
    'missing committed iOS SPM project, shared scheme or Package.resolved',
  );

  const project = await readFile(PROJECT, 'utf8');
  const infoPlist = await readFile(INFO_PLIST, 'utf8');
  const scheme = await readFile(SCHEME, 'utf8');

  assert.ok(
    [...project.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = uk\.eugnel\.ks2spelling;/g)]
      .length >= 2,
    'bundle identifier must be frozen for Debug and Release',
  );
  assert.ok(
    [...project.matchAll(/IPHONEOS_DEPLOYMENT_TARGET = 15\.0;/g)].length >= 2,
    'iOS 15.0 must be the project deployment floor',
  );
  assert.ok(
    [...project.matchAll(/DEVELOPMENT_TEAM = V45S7U2LZB;/g)].length >= 2,
    'the non-secret Apple team metadata must be stable',
  );
  assert.match(
    infoPlist,
    /<key>CFBundleDisplayName<\/key>\s*<string>KS2 Spelling<\/string>/,
  );
  assert.match(scheme, /BuildableName = "App\.app"/);
  assert.match(scheme, /BlueprintName = "App"/);
});

test('the iOS project uses exact Capacitor SPM with no CocoaPods or live URL', async () => {
  assert.ok(existsSync(IOS_ROOT), 'missing committed iOS SPM project');

  const packageSwift = await readFile(join(IOS_ROOT, 'CapApp-SPM/Package.swift'), 'utf8');
  const packageResolved = JSON.parse(await readFile(PACKAGE_RESOLVED, 'utf8'));
  const capacitorIosPackage = JSON.parse(
    await readFile(join(ROOT, 'node_modules/@capacitor/ios/package.json'), 'utf8'),
  );
  const capacitorConfig = JSON.parse(
    await readFile(join(ROOT, 'capacitor.config.json'), 'utf8'),
  );

  assert.equal(capacitorIosPackage.version, '8.4.1');
  assert.match(
    packageSwift,
    /\.package\(url: "https:\/\/github\.com\/ionic-team\/capacitor-swift-pm\.git", exact: "8\.4\.1"\)/,
  );
  assert.match(
    packageSwift,
    /\.package\(name: "CapacitorCommunitySqlite", path: "\.\.\/\.\.\/\.\.\/node_modules\/@capacitor-community\/sqlite"\)/,
  );
  assert.match(
    packageSwift,
    /\.package\(name: "CapacitorApp", path: "\.\.\/\.\.\/\.\.\/node_modules\/@capacitor\/app"\)/,
  );
  assert.match(
    packageSwift,
    /\.product\(name: "CapacitorCommunitySqlite", package: "CapacitorCommunitySqlite"\)/,
  );
  assert.match(packageSwift, /\.product\(name: "CapacitorApp", package: "CapacitorApp"\)/);
  assert.equal(packageResolved.version, 3);
  assert.ok(Array.isArray(packageResolved.pins));
  const capacitorPin = packageResolved.pins.find(
    ({ identity }) => identity === 'capacitor-swift-pm',
  );
  assert.equal(capacitorPin?.location, 'https://github.com/ionic-team/capacitor-swift-pm.git');
  assert.deepEqual(capacitorPin?.state, {
    revision: '2231987d85b8b0b289320b1d0947b4ae8345cde4',
    version: '8.4.1',
  });
  assert.deepEqual(
    packageResolved.pins
      .filter(({ identity }) => identity !== 'capacitor-swift-pm')
      .map(({ identity, state }) => ({ identity, state })),
    [
      {
        identity: 'sqlcipher.swift',
        state: {
          revision: '205df55271aa1ba512a9bfe3fd1813bc9ac52a19',
          version: '4.17.0',
        },
      },
      {
        identity: 'zipfoundation',
        state: {
          revision: '22787ffb59de99e5dc1fbfe80b19c97a904ad48d',
          version: '0.9.20',
        },
      },
    ],
  );

  assert.equal(existsSync(join(IOS_ROOT, 'Podfile')), false);
  assert.equal(existsSync(join(IOS_ROOT, 'Podfile.lock')), false);
  assert.equal(existsSync(join(IOS_ROOT, 'Pods')), false);
  assert.equal(existsSync(join(IOS_ROOT, 'App.xcworkspace')), false);

  assert.deepEqual(capacitorConfig, {
    appId: 'uk.eugnel.ks2spelling',
    appName: 'KS2 Spelling',
    webDir: 'dist',
    loggingBehavior: 'none',
    plugins: {
      CapacitorSQLite: {
        iosDatabaseLocation: 'Library/CapacitorDatabase',
        iosIsEncryption: false,
        iosBiometric: { biometricAuth: false },
        androidIsEncryption: false,
        androidBiometric: { biometricAuth: false },
      },
    },
  });
  const nativeConfigPath = join(IOS_ROOT, 'App/capacitor.config.json');
  if (existsSync(nativeConfigPath)) {
    const nativeConfig = JSON.parse(await readFile(nativeConfigPath, 'utf8'));
    assert.equal(Object.hasOwn(nativeConfig, 'server'), false);
  }

  assert.ok(
    existsSync(
      join(ROOT, 'node_modules/@capacitor/ios/Capacitor/Capacitor/PrivacyInfo.xcprivacy'),
    ),
    'Capacitor SPM must supply its privacy manifest',
  );
  assert.ok(
    existsSync(
      join(
        ROOT,
        'node_modules/@capacitor/ios/CapacitorCordova/CapacitorCordova/PrivacyInfo.xcprivacy',
      ),
    ),
    'CapacitorCordova SPM must supply its privacy manifest',
  );
  assert.equal(
    existsSync(join(IOS_ROOT, 'App/PrivacyInfo.xcprivacy')),
    false,
    'B1 app code must not fabricate a privacy manifest',
  );
});

test('the iOS app target explicitly links the frozen ZIPFoundation extraction product', async () => {
  const project = await readFile(PROJECT, 'utf8');
  const appDelegate = await readFile(join(IOS_ROOT, 'App/AppDelegate.swift'), 'utf8');
  assert.match(project, /XCRemoteSwiftPackageReference "ZIPFoundation"/);
  assert.match(project, /repositoryURL = "https:\/\/github\.com\/weichsel\/ZIPFoundation\.git"/);
  assert.match(project, /requirement = \{\s*kind = exactVersion;\s*version = 0\.9\.20;/s);
  assert.match(project, /ZIPFoundation in Frameworks/);
  assert.match(project, /productName = ZIPFoundation/);
  assert.match(project, /PackTransferPlugin\.swift in Sources/);
  assert.match(project, /PackDownloadFlow\.swift in Sources/);
  assert.match(project, /PackInstallSealer\.swift in Sources/);
  assert.match(project, /ZipCentralDirectoryInspector\.swift in Sources/);
  assert.match(project, /pack-signing-public-keys\.json in Resources/);
  assert.match(appDelegate, /PackTransferPlugin/);
  assert.match(appDelegate, /registerPluginInstance/);
  assert.deepEqual(
    JSON.parse(await readFile(join(IOS_ROOT, 'App/Resources/pack-signing-public-keys.json'))),
    JSON.parse(await readFile(join(ROOT, 'config/pack-signing-public-keys.json'))),
    'the native bundle must copy the tracked public verification keyring byte-for-byte in meaning',
  );
});

test('the iOS project owns a hosted StoreKit Test target and exact B3 product configuration', async () => {
  const project = await readFile(PROJECT, 'utf8');
  const scheme = await readFile(SCHEME, 'utf8');
  const storeKitConfiguration = JSON.parse(
    await readFile(join(IOS_ROOT, 'App/B3Sandbox.storekit'), 'utf8'),
  );
  const appDelegate = await readFile(join(IOS_ROOT, 'App/AppDelegate.swift'), 'utf8');

  assert.match(project, /PBXNativeTarget "AppTests"/);
  assert.match(project, /B3StoreKitDelayedTests\.swift in Sources/);
  assert.match(project, /B3Sandbox\.storekit in Resources/);
  assert.equal(
    [...project.matchAll(/B3Sandbox\.storekit in Resources \*\/ = \{isa = PBXBuildFile/g)].length,
    1,
    'the non-live StoreKit fixture must belong only to AppTests',
  );
  assert.match(project, /lastKnownFileType = text\.storekit; path = B3Sandbox\.storekit/);
  assert.match(project, /TEST_HOST = "\$\(BUILT_PRODUCTS_DIR\)\/App\.app\/App"/);
  assert.match(project, /BUNDLE_LOADER = "\$\(TEST_HOST\)"/);
  assert.match(scheme, /BlueprintName = "AppTests"/);
  assert.equal(
    [...scheme.matchAll(/identifier = "\.\.\/\.\.\/App\/B3Sandbox\.storekit"/g)].length,
    1,
    'only Test may resolve the non-live StoreKit configuration outside App.xcodeproj',
  );
  const launchAction = scheme.match(/<LaunchAction[\s\S]*?<\/LaunchAction>/)?.[0] ?? '';
  assert.doesNotMatch(launchAction, /StoreKitConfigurationFileReference/);
  assert.match(appDelegate, /CommercePlugin/);
  assert.match(appDelegate, /registerPluginInstance/);

  assert.equal(storeKitConfiguration.products.length, 1);
  assert.equal(storeKitConfiguration.products[0].productID, 'uk.eugnel.ks2spelling.fullks2');
  assert.equal(storeKitConfiguration.products[0].type, 'NonConsumable');
  assert.deepEqual(storeKitConfiguration.subscriptionGroups, []);
  assert.deepEqual(storeKitConfiguration.nonRenewingSubscriptions, []);
});
