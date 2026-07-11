import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT_FILES = [
  'scripts/lib/run-command.mjs',
  'scripts/native-doctor.mjs',
  'scripts/native-sync-check.mjs',
  'scripts/test-ios.mjs',
  'scripts/test-android.mjs',
  'scripts/launch-ios-simulator.mjs',
  'scripts/launch-android-emulator.mjs',
];

async function importScript(path) {
  return import(pathToFileURL(join(ROOT, path)));
}

test('package scripts expose every deterministic native wrapper', async () => {
  assert.ok(
    SCRIPT_FILES.every((path) => existsSync(join(ROOT, path))),
    'missing native wrapper implementation',
  );

  const packageJson = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(
    Object.fromEntries(
      [
        'verify:vendor',
        'native:doctor',
        'native:sync:check',
        'test:ios',
        'test:android',
        'launch:ios',
        'launch:android',
      ].map((name) => [name, packageJson.scripts[name]]),
    ),
    {
      'verify:vendor': 'node scripts/verify-vendored-contract.mjs',
      'native:doctor': 'node scripts/native-doctor.mjs',
      'native:sync:check': 'node scripts/native-sync-check.mjs',
      'test:ios': 'node scripts/test-ios.mjs',
      'test:android': 'node scripts/test-android.mjs',
      'launch:ios': 'node scripts/launch-ios-simulator.mjs',
      'launch:android': 'node scripts/launch-android-emulator.mjs',
    },
  );
});

test('command results use stable exit codes and redact signing or environment secrets', async () => {
  assert.ok(existsSync(join(ROOT, 'scripts/lib/run-command.mjs')));
  const { EXIT_CODES, redactText, runCommand } = await importScript(
    'scripts/lib/run-command.mjs',
  );

  assert.deepEqual(EXIT_CODES, {
    success: 0,
    usage: 2,
    missingTool: 3,
    commandFailed: 4,
    stateMismatch: 5,
  });
  const env = {
    OPENAI_API_KEY: 'top-secret-value',
    SIGNING_PASSWORD: 'signing-secret-value',
    PROVISIONING_PROFILE_SPECIFIER: 'private-profile-name',
  };
  assert.equal(
    redactText(
      'OPENAI_API_KEY=top-secret-value --password=signing-secret-value',
      env,
    ),
    'OPENAI_API_KEY=[REDACTED] --password=[REDACTED]',
  );
  assert.equal(redactText('CODE_SIGNING_ALLOWED=NO', env), 'CODE_SIGNING_ALLOWED=NO');
  assert.equal(
    redactText('PROVISIONING_PROFILE_SPECIFIER=private-profile-name', env),
    'PROVISIONING_PROFILE_SPECIFIER=[REDACTED]',
  );

  const result = await runCommand(
    process.execPath,
    ['-e', 'process.stdout.write(process.env.OPENAI_API_KEY)'],
    { env: { ...process.env, ...env } },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '[REDACTED]');
  assert.doesNotMatch(
    JSON.stringify(result),
    /top-secret-value|signing-secret-value|private-profile-name/,
  );
});

test('doctor probes are read-only and Android absence is deterministic', async () => {
  const {
    DOCTOR_COMMANDS,
    evaluateNativeToolchainVersions,
    hasExpectedAndroidAvd,
  } = await importScript(
    'scripts/native-doctor.mjs',
  );
  const { resolveAndroidEnvironment } = await importScript('scripts/test-android.mjs');

  const serialised = JSON.stringify(DOCTOR_COMMANDS);
  assert.doesNotMatch(serialised, /\b(?:create|boot|install|delete|erase|license|accept)\b/i);
  assert.match(serialised, /simctl/);
  assert.match(serialised, /runtimes/);
  assert.match(serialised, /devices/);

  const resolution = resolveAndroidEnvironment({
    env: { HOME: '/missing-home' },
    pathExists: () => false,
  });
  assert.equal(resolution.ready, false);
  assert.deepEqual(resolution.missing, ['jbr', 'androidSdk']);
  assert.equal(resolution.javaHome, null);
  assert.equal(resolution.javaSource, null);
  assert.equal(resolution.androidSdkRoot, null);

  const validAvdConfig = `avd.id=<build>
abi.type=arm64-v8a
hw.device.name=pixel_9
image.sysdir.1=system-images/android-36/google_apis/arm64-v8a/
tag.id=google_apis
`;
  const validAvdPointer = `avd.ini.encoding=UTF-8
path=/test-home/.android/avd/KS2_Spelling_API_36.avd
path.rel=avd/KS2_Spelling_API_36.avd
target=android-36
`;
  assert.equal(
    await hasExpectedAndroidAvd({
      home: '/test-home',
      readText: async (path) => {
        if (path.endsWith('/config.ini')) return validAvdConfig;
        if (path.endsWith('/KS2_Spelling_API_36.ini')) return validAvdPointer;
        assert.fail(`unexpected AVD identity path: ${path}`);
      },
    }),
    true,
  );
  assert.equal(
    await hasExpectedAndroidAvd({
      home: '/test-home',
      readText: async (path) =>
        path.endsWith('/config.ini')
          ? validAvdConfig.replace('pixel_9', 'pixel_8')
          : validAvdPointer,
    }),
    false,
  );
  assert.equal(
    await hasExpectedAndroidAvd({
      home: '/test-home',
      readText: async (path) =>
        path.endsWith('/config.ini')
          ? validAvdConfig
          : validAvdPointer.replace('target=android-36', 'target=android-35'),
    }),
    false,
  );
  assert.equal(
    await hasExpectedAndroidAvd({ home: null, readText: async () => validAvdConfig }),
    false,
  );

  const certified = {
    nodeVersion: 'v24.18.0',
    npmVersion: '11.16.0',
    xcodeVersion: 'Xcode 26.6\nBuild version 17F113',
    javaVersion: 'openjdk version "21.0.10" 2026-01-20',
    javaHome: '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
    javaSource: 'android-studio-jbr',
    hasExactBuildTools: true,
  };
  assert.deepEqual(evaluateNativeToolchainVersions(certified), []);
  const mismatches = [
    ['nodeVersion', 'v24.17.0', 'node24.18.0'],
    ['npmVersion', '11.15.0', 'npm11.16.0'],
    ['javaVersion', 'openjdk version "17.0.12"', 'jbr21'],
    ['javaHome', '/tmp/arbitrary-java-home', 'androidStudioJbr'],
    ['javaSource', 'JAVA_HOME', 'androidStudioJbrSource'],
    ['xcodeVersion', 'Xcode 25.4\nBuild version 16F6', 'xcode26'],
    ['hasExactBuildTools', false, 'androidBuildTools36.0.0'],
  ];
  for (const [key, value, expected] of mismatches) {
    assert.deepEqual(
      evaluateNativeToolchainVersions({ ...certified, [key]: value }),
      [expected],
      `${key} mismatch must fail closed`,
    );
  }
});

test('Task 8 records exact local toolchain, licence gate and disk evidence', async () => {
  const evidence = JSON.parse(
    await readFile(join(ROOT, 'reports/b1/native-toolchain.json'), 'utf8'),
  );
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.androidStudio.homebrewVersion, '2026.1.1.10,quail1-patch2');
  assert.equal(evidence.jbr.version, '21.0.10');
  assert.equal(evidence.licences.personallyAcceptedByJames, true);
  assert.equal(evidence.virtualDevices.android.name, 'KS2_Spelling_API_36');
  assert.equal(evidence.virtualDevices.android.hardwareProfile, 'pixel_9');
  assert.equal(evidence.virtualDevices.ios.name, 'KS2 Spelling iPhone 17');
  assert.ok(evidence.disk.afterAvailableKiB >= 25 * 1024 ** 2);
  assert.equal(
    evidence.disk.consumedKiB,
    evidence.disk.beforeAvailableKiB - evidence.disk.afterAvailableKiB,
  );
  const required = new Map(
    evidence.androidSdkPackages.map(({ path, version }) => [path, version]),
  );
  assert.equal(required.get('platform-tools'), '37.0.0');
  assert.equal(required.get('platforms;android-36'), '2');
  assert.equal(required.get('build-tools;36.0.0'), '36.0.0');
  assert.equal(required.get('emulator'), '36.6.11');
  assert.equal(
    required.get('system-images;android-36;google_apis;arm64-v8a'),
    '7',
  );
  assert.equal(evidence.incidentalPackages[0].path, 'build-tools;35.0.0');
  assert.equal(evidence.incidentalPackages[0].requiredByCertifiedBuild, false);
});

test('native build and sync commands freeze identity and derived outputs', async () => {
  const { SYNC_COMMANDS } = await importScript('scripts/native-sync-check.mjs');
  const { IOS_BUILD_COMMAND } = await importScript('scripts/test-ios.mjs');
  const { ANDROID_BUILD_COMMAND, ANDROID_BUILD_EVIDENCE, GRADLE_INIT_SCRIPT } =
    await importScript('scripts/test-android.mjs');

  assert.deepEqual(SYNC_COMMANDS, [
    ['npm', ['run', 'build']],
    ['npx', ['--no-install', 'cap', 'sync']],
    [
      process.execPath,
      [
        '--test',
        'tests/ios-project-contract.test.mjs',
        'tests/android-project-contract.test.mjs',
      ],
    ],
    ['git', ['diff', '--exit-code', '--', 'ios', 'android', 'capacitor.config.json']],
  ]);
  assert.deepEqual(IOS_BUILD_COMMAND, {
    command: 'xcodebuild',
    args: [
      '-project',
      'ios/App/App.xcodeproj',
      '-scheme',
      'KS2Spelling',
      '-sdk',
      'iphonesimulator',
      '-configuration',
      'Debug',
      '-derivedDataPath',
      '.native-build/ios',
      'CODE_SIGNING_ALLOWED=NO',
      'build',
    ],
  });
  assert.deepEqual(ANDROID_BUILD_COMMAND, {
    command: 'android/gradlew',
    args: [
      '--no-daemon',
      '--project-dir',
      'android',
      '--project-cache-dir',
      '../.native-build/android/project-cache',
      '--init-script',
      '../.native-build/android/native-output.init.gradle',
      'testDebugUnitTest',
      'assembleDebug',
    ],
  });
  assert.match(GRADLE_INIT_SCRIPT, /\.native-build\/android\/build/);
  assert.deepEqual(ANDROID_BUILD_EVIDENCE, {
    ok: true,
    platform: 'android',
    variant: 'debug',
    signing: 'debug',
    releaseSigned: false,
    declaredPermissions: [],
    requestedPermissions: [],
  });
  const { parsePackagedAndroidPermissions } = await importScript(
    'scripts/test-android.mjs',
  );
  assert.deepEqual(
    parsePackagedAndroidPermissions('package: uk.eugnel.ks2spelling\n'),
    {
      appIdentity: 'uk.eugnel.ks2spelling',
      declaredPermissions: [],
      requestedPermissions: [],
    },
  );
  assert.throws(
    () =>
      parsePackagedAndroidPermissions(
        "package: uk.eugnel.ks2spelling\nuses-permission: name='android.permission.INTERNET'\n",
      ),
    ({ code }) => code === 'android_packaged_permission_detected',
  );
  assert.throws(
    () =>
      parsePackagedAndroidPermissions(
        'package: uk.eugnel.ks2spelling\npermission: uk.eugnel.ks2spelling.UNEXPECTED\n',
      ),
    ({ code }) => code === 'android_packaged_permission_detected',
  );
  assert.throws(
    () => parsePackagedAndroidPermissions('package: uk.eugnel.ks2spelling\nbare-junk\n'),
    ({ code }) => code === 'android_packaged_permission_detected',
  );
});

test('launch plans target only the named B1 virtual devices and exact app identity', async () => {
  const { IOS_DEVICE, createIosLaunchPlan, selectExistingIosDevice } = await importScript(
    'scripts/launch-ios-simulator.mjs',
  );
  const {
    ANDROID_DEVICE,
    assertAndroidAvdIdentity,
    assertAndroidAvdPointerIdentity,
    assertAndroidSerialOwnership,
    createAndroidLaunchPlan,
  } = await importScript('scripts/launch-android-emulator.mjs');

  assert.deepEqual(IOS_DEVICE, {
    name: 'KS2 Spelling iPhone 17',
    type: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
    runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    bundleId: 'uk.eugnel.ks2spelling',
  });
  const existingIos = createIosLaunchPlan({ udid: 'existing-ios-udid' });
  assert.equal(existingIos.some(({ args }) => args.includes('create')), false);
  assert.deepEqual(existingIos.at(-1), {
    command: 'xcrun',
    args: ['simctl', 'launch', 'existing-ios-udid', 'uk.eugnel.ks2spelling'],
  });
  assert.deepEqual(createIosLaunchPlan({ udid: null })[0], {
    command: 'xcrun',
    args: [
      'simctl',
      'create',
      'KS2 Spelling iPhone 17',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ],
  });
  assert.throws(
    () =>
      selectExistingIosDevice({
        'com.apple.CoreSimulator.SimRuntime.iOS-25-0': [
          {
            name: 'KS2 Spelling iPhone 17',
            udid: 'collision',
            deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
          },
        ],
      }),
    ({ code }) => code === 'ios_device_collision',
  );

  assert.deepEqual(ANDROID_DEVICE, {
    name: 'KS2_Spelling_API_36',
    image: 'system-images;android-36;google_apis;arm64-v8a',
    device: 'pixel_9',
    port: '5580',
    serial: 'emulator-5580',
    packageId: 'uk.eugnel.ks2spelling',
    activity: 'uk.eugnel.ks2spelling/.MainActivity',
  });
  const existingAndroid = createAndroidLaunchPlan({ avdExists: true });
  assert.equal(existingAndroid.some(({ args }) => args.includes('create')), false);
  for (const { command, args } of existingAndroid.filter(({ command }) => command === 'adb')) {
    assert.equal(command, 'adb');
    assert.deepEqual(args.slice(0, 2), ['-s', 'emulator-5580']);
  }
  assert.ok(
    existingAndroid.some(
      ({ command, args }) =>
        command === 'emulator' &&
        args.includes('-port') &&
        args.includes('5580') &&
        args.includes('KS2_Spelling_API_36'),
    ),
  );
  assert.deepEqual(existingAndroid.at(-1), {
    command: 'adb',
    args: [
      '-s',
      'emulator-5580',
      'shell',
      'am',
      'start',
      '-n',
      'uk.eugnel.ks2spelling/.MainActivity',
    ],
  });
  assert.deepEqual(createAndroidLaunchPlan({ avdExists: false })[0], {
    command: 'avdmanager',
    args: [
      'create',
      'avd',
      '--name',
      'KS2_Spelling_API_36',
      '--package',
      'system-images;android-36;google_apis;arm64-v8a',
      '--device',
      'pixel_9',
    ],
    input: 'no\n',
  });
  const expectedAvdConfig = `avd.id=<build>
abi.type=arm64-v8a
hw.device.name=pixel_9
image.sysdir.1=system-images/android-36/google_apis/arm64-v8a/
tag.id=google_apis
`;
  assert.doesNotThrow(() => assertAndroidAvdIdentity(expectedAvdConfig));
  for (const [field, value] of [
    ['abi.type', 'x86_64'],
    ['hw.device.name', 'pixel_8'],
    ['image.sysdir.1', 'system-images/android-35/google_apis/arm64-v8a/'],
    ['tag.id', 'google_apis_playstore'],
  ]) {
    assert.throws(
      () =>
        assertAndroidAvdIdentity(
          expectedAvdConfig.replace(new RegExp(`^${field}=.*$`, 'm'), `${field}=${value}`),
        ),
      ({ code }) => code === 'android_avd_identity_mismatch',
      field,
    );
  }
  assert.throws(
    () => assertAndroidAvdIdentity(expectedAvdConfig.replace(/^hw\.device\.name=.*\n/m, '')),
    ({ code }) => code === 'android_avd_identity_mismatch',
    'missing hardware profile',
  );
  const expectedAvdPointer = `avd.ini.encoding=UTF-8
path=/test-home/.android/avd/KS2_Spelling_API_36.avd
path.rel=avd/KS2_Spelling_API_36.avd
target=android-36
`;
  assert.doesNotThrow(() =>
    assertAndroidAvdPointerIdentity(expectedAvdPointer, '/test-home'),
  );
  for (const [field, value] of [
    ['path', '/test-home/.android/avd/Some_Other_AVD.avd'],
    ['path.rel', 'avd/Some_Other_AVD.avd'],
    ['target', 'android-35'],
  ]) {
    assert.throws(
      () =>
        assertAndroidAvdPointerIdentity(
          expectedAvdPointer.replace(new RegExp(`^${field}=.*$`, 'm'), `${field}=${value}`),
          '/test-home',
        ),
      ({ code }) => code === 'android_avd_identity_mismatch',
      field,
    );
  }
  assert.doesNotThrow(() => assertAndroidSerialOwnership('KS2_Spelling_API_36\nOK\n'));
  assert.throws(
    () => assertAndroidSerialOwnership('Some_Other_AVD\nOK\n'),
    ({ code }) => code === 'android_serial_collision',
  );

  for (const path of [
    'scripts/launch-ios-simulator.mjs',
    'scripts/launch-android-emulator.mjs',
  ]) {
    assert.doesNotMatch(await readFile(join(ROOT, path), 'utf8'), /stream:\s*true/);
  }
});
