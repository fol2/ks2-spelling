import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TESTED_APPLICATION_COMMIT =
  'c7828c2da84d5828f7e7640992c78d3203dd1170';
const TESTED_APPLICATION_FINGERPRINT_SHA256 =
  '0755706083060caf3fa370d2abfd8acabefc0774ac45f3476edefe7b651125d6';
const TESTED_APPLICATION_FILE_COUNT = 153;
const SHA256 = /^[a-f0-9]{64}$/;
const execFileAsync = promisify(execFile);

async function importFingerprint() {
  return import(
    pathToFileURL(join(ROOT, 'scripts/fingerprint-b1-application.mjs'))
  );
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function isDerivedNativeFingerprintPath(path) {
  return (
    path.startsWith('ios/App/App/public/') ||
    path === 'ios/App/App/capacitor.config.json' ||
    path === 'ios/App/App/config.xml' ||
    path.startsWith('ios/capacitor-cordova-ios-plugins/') ||
    path.startsWith('android/app/src/main/assets/') ||
    path === 'android/app/src/main/res/xml/config.xml' ||
    path.startsWith('android/capacitor-cordova-android-plugins/')
  );
}

function assertSafeFingerprintPath(path) {
  assert.equal(typeof path, 'string', 'fingerprint path must be a string');
  assert.ok(path.length > 0, 'fingerprint path must not be empty');
  assert.equal(path.includes('\\'), false, `unsafe fingerprint path: ${path}`);
  assert.equal(path.includes('\0'), false, `unsafe fingerprint path: ${path}`);
  assert.equal(path.includes(':'), false, `unsafe fingerprint path: ${path}`);
  assert.equal(posix.isAbsolute(path), false, `unsafe fingerprint path: ${path}`);
  assert.equal(posix.normalize(path), path, `unsafe fingerprint path: ${path}`);
  assert.equal(path.startsWith('./'), false, `unsafe fingerprint path: ${path}`);
  assert.equal(
    path.split('/').some((component) => component === '.' || component === '..'),
    false,
    `unsafe fingerprint path: ${path}`,
  );
}

function aggregateFingerprintFiles(files) {
  const aggregate = createHash('sha256');
  for (const file of files) {
    aggregate.update(file.path);
    aggregate.update('\0');
    aggregate.update(file.sha256);
    aggregate.update('\0');
  }
  return aggregate.digest('hex');
}

async function validateRecordedB1Fingerprint({ commit, fingerprint }) {
  assert.equal(commit, TESTED_APPLICATION_COMMIT, 'unexpected tested application commit');
  assert.equal(Object.getPrototypeOf(fingerprint), Object.prototype);
  assert.deepEqual(Object.keys(fingerprint).toSorted(), [
    'algorithm',
    'fileCount',
    'files',
    'sha256',
  ]);
  assert.equal(fingerprint.algorithm, 'sha256');
  assert.equal(fingerprint.fileCount, TESTED_APPLICATION_FILE_COUNT);
  assert.equal(fingerprint.files.length, fingerprint.fileCount);
  assert.equal(fingerprint.sha256, TESTED_APPLICATION_FINGERPRINT_SHA256);

  const paths = [];
  for (const file of fingerprint.files) {
    assert.equal(Object.getPrototypeOf(file), Object.prototype);
    assert.deepEqual(Object.keys(file).toSorted(), ['path', 'sha256']);
    assertSafeFingerprintPath(file.path);
    assert.match(file.sha256, SHA256, file.path);
    paths.push(file.path);
  }
  assert.deepEqual(paths, paths.toSorted(), 'fingerprint paths must be sorted');
  assert.equal(new Set(paths).size, paths.length, 'fingerprint paths must be unique');
  assert.equal(
    aggregateFingerprintFiles(fingerprint.files),
    fingerprint.sha256,
    'fingerprint aggregate SHA-256 mismatch',
  );

  for (const file of fingerprint.files) {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['show', `${commit}:${file.path}`],
        { cwd: ROOT, encoding: 'buffer', maxBuffer: 20 * 1024 * 1024 },
      );
      assert.equal(
        createHash('sha256').update(stdout).digest('hex'),
        file.sha256,
        file.path,
      );
    } catch (error) {
      const stderr = error?.stderr?.toString('utf8') ?? '';
      assert.ok(
        isDerivedNativeFingerprintPath(file.path) &&
          /exists on disk, but not in|does not exist in/.test(stderr),
        `recorded fingerprint file is absent or mismatched at ${commit}: ${file.path}`,
      );
    }
  }

  return fingerprint;
}

async function createMinimalApplicationTree() {
  const root = await mkdtemp(join(tmpdir(), 'ks2-spelling-fingerprint-'));
  for (const [path, content] of [
    ['.npmrc', 'fund=false\n'],
    ['.nvmrc', '24.18.0\n'],
    ['package.json', '{"name":"fixture"}\n'],
    ['package-lock.json', '{"lockfileVersion":3}\n'],
    ['index.html', '<main>fixture</main>\n'],
    ['vite.config.js', 'export default {};\n'],
    ['capacitor.config.json', '{"webDir":"dist"}\n'],
    ['ios/App/App/public/index.html', '<main>fixture</main>\n'],
    ['ios/App/App/capacitor.config.json', '{"webDir":"public"}\n'],
    ['ios/App/App/config.xml', '<widget id="fixture" />\n'],
    ['android/app/src/main/assets/public/index.html', '<main>fixture</main>\n'],
    ['android/app/src/main/assets/capacitor.config.json', '{"webDir":"public"}\n'],
    ['android/app/src/main/res/xml/config.xml', '<widget id="fixture" />\n'],
    ['android/capacitor-cordova-android-plugins/build.gradle', 'dependencies {}\n'],
    ['ios/capacitor-cordova-ios-plugins/CordovaPluginsResources.podspec', 'Pod::Spec.new\n'],
    ['src/main.js', 'export const value = 1;\n'],
    ['src/content.md', '# Bundled content\n'],
    ['scripts/build/tool.mjs', 'export const built = true;\n'],
    ['scripts/test-native.mjs', 'export const platform = "native";\n'],
  ]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content, 'utf8');
  }
  return root;
}

function create32BitBmp({ width, height, pixels }) {
  const pixelOffset = 54;
  const buffer = Buffer.alloc(pixelOffset + width * height * 4);
  buffer.write('BM', 0, 'ascii');
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(pixelOffset, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(-height, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(32, 28);
  buffer.writeUInt32LE(width * height * 4, 34);
  pixels.forEach(({ red, green, blue }, index) => {
    const offset = pixelOffset + index * 4;
    buffer[offset] = blue;
    buffer[offset + 1] = green;
    buffer[offset + 2] = red;
    buffer[offset + 3] = 255;
  });
  return buffer;
}

test('application fingerprint is deterministic and covers nested build inputs', async () => {
  const { fingerprintB1Application } = await importFingerprint();
  const root = await createMinimalApplicationTree();
  try {
    const first = await fingerprintB1Application({ root });
    const second = await fingerprintB1Application({ root });
    assert.deepEqual(second, first);
    assert.equal(first.algorithm, 'sha256');
    assert.match(first.sha256, SHA256);
    assert.equal(first.fileCount, first.files.length);
    assert.deepEqual(
      first.files.map(({ path }) => path),
      first.files.map(({ path }) => path).toSorted(),
    );
    assert.ok(first.files.some(({ path }) => path === 'src/main.js'));
    assert.ok(first.files.some(({ path }) => path === 'src/content.md'));
    assert.ok(first.files.some(({ path }) => path === 'scripts/build/tool.mjs'));
    assert.ok(first.files.some(({ path }) => path === 'ios/App/App/public/index.html'));
    assert.ok(
      first.files.some(
        ({ path }) => path === 'android/app/src/main/assets/public/index.html',
      ),
    );
    assert.ok(first.files.some(({ path }) => path === 'scripts/test-native.mjs'));

    await writeFile(join(root, 'src/main.js'), 'export const value = 2;\n', 'utf8');
    const changed = await fingerprintB1Application({ root });
    assert.notEqual(changed.sha256, first.sha256);
    await writeFile(join(root, 'src/main.js'), 'export const value = 1;\n', 'utf8');
    await writeFile(join(root, 'ios/App/App/public/index.html'), '<main>changed</main>\n', 'utf8');
    const changedIosBundle = await fingerprintB1Application({ root });
    assert.notEqual(changedIosBundle.sha256, first.sha256);
    await writeFile(join(root, 'ios/App/App/public/index.html'), '<main>fixture</main>\n', 'utf8');
    await writeFile(
      join(root, 'android/app/src/main/assets/public/index.html'),
      '<main>changed</main>\n',
      'utf8',
    );
    const changedAndroidBundle = await fingerprintB1Application({ root });
    assert.notEqual(changedAndroidBundle.sha256, first.sha256);
    await writeFile(
      join(root, 'android/app/src/main/assets/public/index.html'),
      '<main>fixture</main>\n',
      'utf8',
    );
    await writeFile(
      join(root, 'ios/App/App/capacitor.config.json'),
      '{"server":{"url":"https://example.test"}}\n',
      'utf8',
    );
    const changedNativeConfig = await fingerprintB1Application({ root });
    assert.notEqual(changedNativeConfig.sha256, first.sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('application fingerprint rejects unregistered root inputs and environment files', async () => {
  const { fingerprintB1Application } = await importFingerprint();
  for (const path of ['unexpected-build.js', '.env.local']) {
    const root = await createMinimalApplicationTree();
    try {
      await writeFile(join(root, path), 'must not be silently excluded\n', 'utf8');
      await assert.rejects(
        () => fingerprintB1Application({ root }),
        ({ code }) => code === 'b1_unregistered_root_input',
        path,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('every fingerprinted application byte matches the exact clean Task 8 commit', async () => {
  const exit = JSON.parse(
    await readFile(join(ROOT, 'reports/b1/b1-exit-report.json'), 'utf8'),
  );
  assert.equal(exit.testedApplicationCommit, TESTED_APPLICATION_COMMIT);
  assert.deepEqual(
    await validateRecordedB1Fingerprint({
      commit: TESTED_APPLICATION_COMMIT,
      fingerprint: exit.applicationFingerprint,
    }),
    exit.applicationFingerprint,
  );
});

test('recorded B1 fingerprint validation fails closed on structural drift', async () => {
  const exit = JSON.parse(
    await readFile(join(ROOT, 'reports/b1/b1-exit-report.json'), 'utf8'),
  );
  const cases = [
    {
      name: 'commit',
      commit: '0000000000000000000000000000000000000000',
      mutate: () => {},
    },
    {
      name: 'file count',
      commit: TESTED_APPLICATION_COMMIT,
      mutate: (fingerprint) => {
        fingerprint.fileCount -= 1;
      },
    },
    {
      name: 'unsafe path',
      commit: TESTED_APPLICATION_COMMIT,
      mutate: (fingerprint) => {
        fingerprint.files[0].path = '../escape';
      },
    },
    {
      name: 'duplicate path',
      commit: TESTED_APPLICATION_COMMIT,
      mutate: (fingerprint) => {
        fingerprint.files[1].path = fingerprint.files[0].path;
      },
    },
    {
      name: 'unsorted paths',
      commit: TESTED_APPLICATION_COMMIT,
      mutate: (fingerprint) => {
        [fingerprint.files[0], fingerprint.files[1]] = [
          fingerprint.files[1],
          fingerprint.files[0],
        ];
      },
    },
    {
      name: 'file hash',
      commit: TESTED_APPLICATION_COMMIT,
      mutate: (fingerprint) => {
        fingerprint.files[0].sha256 = '0'.repeat(64);
      },
    },
    {
      name: 'aggregate hash',
      commit: TESTED_APPLICATION_COMMIT,
      mutate: (fingerprint) => {
        fingerprint.sha256 = '0'.repeat(64);
      },
    },
  ];

  for (const fixture of cases) {
    const fingerprint = structuredClone(exit.applicationFingerprint);
    fixture.mutate(fingerprint);
    await assert.rejects(
      () => validateRecordedB1Fingerprint({ commit: fixture.commit, fingerprint }),
      fixture.name,
    );
  }
});

test('native capture parsers fail closed on exact foreground and installation evidence', async () => {
  const {
    analyseIosScreenshotBmp,
    clearIosCaptureEvidence,
    parseIosHostProcess,
    parseIosLaunchProcess,
    parseIosRuntimeVersion,
    runWithIosCaptureCleanup,
  } = await import(
    pathToFileURL(join(ROOT, 'scripts/launch-ios-simulator.mjs'))
  );
  const {
    analyseAndroidScreenshotBmp,
    assertAndroidBundledShellHierarchy,
    assertStartedAndroidEmulatorProcess,
    clearAndroidCaptureEvidence,
    createAndroidCaptureCleanupPlan,
    createAndroidLaunchPlan,
    parseAndroidInstalledApkPath,
    parseAndroidPackageMetadata,
    parseAndroidResumedActivity,
    runAndroidCaptureCleanup,
    waitForAndroidProcess,
    waitForAndroidBundledShell,
    waitForAndroidScreenshotShell,
  } = await import(
    pathToFileURL(join(ROOT, 'scripts/launch-android-emulator.mjs'))
  );
  const { createIosLaunchPlan } = await import(
    pathToFileURL(join(ROOT, 'scripts/launch-ios-simulator.mjs'))
  );
  for (const plan of [
    createIosLaunchPlan({ udid: 'existing-ios' }),
    createAndroidLaunchPlan({ avdExists: true }),
  ]) {
    const syncIndex = plan.findIndex(
      ({ command, args }) =>
        command === process.execPath && args.includes('scripts/native-sync-check.mjs'),
    );
    const buildIndex = plan.findIndex(
      ({ command, args }) =>
        command === process.execPath &&
        args.some((argument) => /^scripts\/test-(?:ios|android)\.mjs$/.test(argument)),
    );
    assert.ok(syncIndex >= 0 && buildIndex === syncIndex + 1);
  }
  assert.equal(
    parseIosLaunchProcess('uk.eugnel.ks2spelling: 4321\n'),
    '4321',
  );
  assert.deepEqual(
    parseAndroidPackageMetadata('versionCode=1 minSdk=23 targetSdk=36\nversionName=1.0\n'),
    { versionCode: '1', versionName: '1.0' },
  );
  const renderedHierarchy = `<?xml version="1.0"?><hierarchy>
    <node text="KS2 Spelling" />
    <node text="Starter content: 20 words" />
    <node text="Bundled locally" />
  </hierarchy>`;
  assert.equal(assertAndroidBundledShellHierarchy(renderedHierarchy), 'ready');
  assert.throws(
    () => assertAndroidBundledShellHierarchy('<hierarchy><node text="" /></hierarchy>'),
    ({ code }) => code === 'android_capture_invalid',
  );
  assert.throws(
    () =>
      assertAndroidBundledShellHierarchy(
        'UI hierchary dumped to: /dev/tty\n',
      ),
    ({ code }) => code === 'android_capture_invalid',
  );
  const hierarchyProbes = [
    { exitCode: 0, stdout: '<hierarchy />' },
    { exitCode: 0, stdout: renderedHierarchy },
  ];
  assert.deepEqual(
    await waitForAndroidBundledShell({
      probe: async () => hierarchyProbes.shift(),
      attempts: 2,
      delay: async () => {},
    }),
    {
      status: 'ready',
      requiredTexts: [
        'KS2 Spelling',
        'Starter content: 20 words',
        'Bundled locally',
      ],
      hierarchySha256: createHash('sha256')
        .update(renderedHierarchy)
        .digest('hex'),
      attempts: 2,
    },
  );
  assert.throws(
    () => parseAndroidPackageMetadata('versionName=1.0\n'),
    ({ code }) => code === 'android_capture_invalid',
  );
  assert.throws(
    () => parseIosLaunchProcess('uk.eugnel.wrong: 4321\n'),
    ({ code }) => code === 'ios_capture_invalid',
  );
  assert.equal(
    parseIosRuntimeVersion({
      runtimes: [
        {
          identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
          version: '26.5',
          buildversion: '23F73',
          isAvailable: true,
        },
      ],
    }),
    '26.5',
  );
  assert.equal(
    parseIosHostProcess(
      '4321 /Users/test/data/Containers/Bundle/Application/id/App.app/App\n',
      '4321',
    ),
    'running',
  );
  const white = { red: 255, green: 255, blue: 255 };
  const dark = { red: 13, green: 29, blue: 41 };
  const teal = { red: 132, green: 210, blue: 195 };
  const muted = { red: 90, green: 95, blue: 100 };
  // A visually approved capture measured 0.921349583129357 dark,
  // 0.025063469836173823 bright and 0.012600991988949229 accent pixels.
  const validShellProfile = analyseIosScreenshotBmp(
    create32BitBmp({
      width: 10000,
      height: 1,
      pixels: [
        ...Array(9213).fill(dark),
        ...Array(251).fill(white),
        ...Array(126).fill(teal),
        ...Array(410).fill(muted),
      ],
    }),
  );
  assert.deepEqual(validShellProfile, {
    width: 10000,
    height: 1,
    darkPixelRatio: 0.9213,
    brightPixelRatio: 0.0251,
    accentPixelRatio: 0.0126,
  });
  // The rejected 1206x2622 capture contained 3,005,374 dark pixels:
  // 0.9504264844098855 dark, with only status chrome and no shell accent surface.
  const rejectedBlankPixels = [
    ...Array(9504).fill(dark),
    ...Array(30).fill(white),
    ...Array(466).fill(muted),
  ];
  assert.throws(
    () =>
      analyseIosScreenshotBmp(
        create32BitBmp({
          width: 10000,
          height: 1,
          pixels: rejectedBlankPixels,
        }),
      ),
    ({ code }) => code === 'ios_capture_invalid',
  );
  assert.deepEqual(
    analyseAndroidScreenshotBmp(
      create32BitBmp({
        width: 10000,
        height: 1,
        pixels: [
          ...Array(9213).fill(dark),
          ...Array(251).fill(white),
          ...Array(126).fill(teal),
          ...Array(410).fill(muted),
        ],
      }),
    ),
    validShellProfile,
  );
  assert.throws(
    () =>
      analyseAndroidScreenshotBmp(
        create32BitBmp({
          width: 10000,
          height: 1,
          pixels: rejectedBlankPixels,
        }),
      ),
    ({ code }) => code === 'android_capture_invalid',
  );
  const screenshotProbes = [
    create32BitBmp({
      width: 10000,
      height: 1,
      pixels: rejectedBlankPixels,
    }),
    create32BitBmp({
      width: 10000,
      height: 1,
      pixels: [
        ...Array(9213).fill(dark),
        ...Array(251).fill(white),
        ...Array(126).fill(teal),
        ...Array(410).fill(muted),
      ],
    }),
  ];
  assert.deepEqual(
    await waitForAndroidScreenshotShell({
      probe: async () => screenshotProbes.shift(),
      attempts: 2,
      delay: async () => {},
    }),
    {
      source: 'screenshot-bmp-shell-colour-populations',
      width: 10000,
      height: 1,
      darkPixelRatio: 0.9213,
      brightPixelRatio: 0.0251,
      accentPixelRatio: 0.0126,
      screenshotAttempts: 2,
    },
  );
  assert.deepEqual(
    analyseIosScreenshotBmp(
      create32BitBmp({
        width: 2,
        height: 2,
        pixels: [dark, dark, teal, white],
      }),
    ),
    {
      width: 2,
      height: 2,
      darkPixelRatio: 0.5,
      brightPixelRatio: 0.25,
      accentPixelRatio: 0.25,
    },
  );
  assert.throws(
    () =>
      analyseIosScreenshotBmp(
        create32BitBmp({ width: 2, height: 2, pixels: [white, white, white, white] }),
      ),
    ({ code }) => code === 'ios_capture_invalid',
  );
  assert.throws(
    () => parseIosHostProcess('4321 /usr/bin/evil\n', '4321'),
    ({ code }) => code === 'ios_capture_invalid',
  );
  assert.equal(
    parseAndroidInstalledApkPath(
      'package:/data/app/~~token/uk.eugnel.ks2spelling-token/base.apk\n',
    ),
    '/data/app/~~token/uk.eugnel.ks2spelling-token/base.apk',
  );
  assert.equal(
    parseAndroidResumedActivity(
      'mResumedActivity: ActivityRecord{abc u0 uk.eugnel.ks2spelling/.MainActivity t12}\n',
    ),
    'uk.eugnel.ks2spelling/.MainActivity',
  );
  assert.equal(
    parseAndroidResumedActivity(
      'topResumedActivity=ActivityRecord{151642442 u0 uk.eugnel.ks2spelling/.MainActivity t7}\n',
    ),
    'uk.eugnel.ks2spelling/.MainActivity',
  );
  assert.equal(
    parseAndroidResumedActivity(
      'mResumedActivity: ActivityRecord{abc u0 uk.eugnel.ks2spelling/uk.eugnel.ks2spelling.MainActivity t12}\n',
    ),
    'uk.eugnel.ks2spelling/.MainActivity',
  );
  for (const output of ['', 'mResumedActivity: ActivityRecord{abc u0 evil/.MainActivity t12}']) {
    assert.throws(
      () => parseAndroidResumedActivity(output),
      ({ code }) => code === 'android_capture_invalid',
    );
  }
  assert.throws(
    () =>
      parseAndroidResumedActivity(
        'topResumedActivity=ActivityRecord{one u0 uk.eugnel.ks2spelling/.MainActivity t7}\n' +
          'mResumedActivity: ActivityRecord{two u0 uk.eugnel.ks2spelling/.MainActivity t7}\n',
      ),
    ({ code }) => code === 'android_capture_invalid',
  );
  assert.throws(
    () =>
      parseAndroidResumedActivity(
        'topResumedActivity=ActivityRecord{one u0 uk.eugnel.ks2spelling/.MainActivity t7}\n' +
          'mResumedActivity: ActivityRecord{two u0 uk.eugnel.ks2spelling/.MainActivity t7}\n',
      ),
    ({ code }) => code === 'android_capture_invalid',
  );
  const processProbes = [
    { exitCode: 1, stdout: '' },
    { exitCode: 0, stdout: '2040\n' },
  ];
  assert.equal(
    await waitForAndroidProcess({
      probe: async () => processProbes.shift(),
      attempts: 2,
      delay: async () => {},
    }),
    '2040',
  );
  const iosShutdowns = [];
  await assert.rejects(
    () =>
      runWithIosCaptureCleanup({
        capture: true,
        device: { udid: 'exact-b1-ios' },
        work: async () => {
          throw new Error('bootstatus timeout');
        },
        shutdown: async (udid) => iosShutdowns.push(udid),
      }),
    /bootstatus timeout/,
  );
  assert.deepEqual(iosShutdowns, ['exact-b1-ios']);
  assert.deepEqual(
    createAndroidCaptureCleanupPlan({
      capture: true,
      ownsB1Serial: false,
      startedDetachedPid: 4321,
    }),
    [{ type: 'terminate-started-process-group', pid: 4321 }],
  );
  assert.deepEqual(
    createAndroidCaptureCleanupPlan({
      capture: true,
      ownsB1Serial: true,
      startedDetachedPid: 4321,
    }),
    [{ type: 'kill-owned-b1-serial', serial: 'emulator-5580' }],
  );
  assert.deepEqual(
    createAndroidCaptureCleanupPlan({
      capture: true,
      ownsB1Serial: false,
      startedDetachedPid: null,
    }),
    [],
  );
  assert.equal(
    assertStartedAndroidEmulatorProcess(
      '/Users/test/Android/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd KS2_Spelling_API_36 -port 5580 -no-snapshot-save',
    ),
    'owned-b1-emulator-process',
  );
  assert.throws(
    () =>
      assertStartedAndroidEmulatorProcess(
        '/Users/test/Android/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd Some_Other_AVD -port 5580',
      ),
    ({ code }) => code === 'android_capture_invalid',
  );
  const androidCleanupCalls = [];
  await runAndroidCaptureCleanup({
    plan: createAndroidCaptureCleanupPlan({
      capture: true,
      ownsB1Serial: false,
      startedDetachedPid: 4321,
    }),
    killOwnedSerial: async () => androidCleanupCalls.push('serial'),
    terminateProcessGroup: async (pid) => androidCleanupCalls.push(`pid:${pid}`),
  });
  assert.deepEqual(androidCleanupCalls, ['pid:4321']);

  const evidenceRoot = await mkdtemp(join(tmpdir(), 'ks2-spelling-capture-cleanup-'));
  try {
    await mkdir(join(evidenceRoot, 'reports/b1'), { recursive: true });
    for (const file of [
      'ios-simulator-launch.json',
      'ios-simulator.png',
      'android-emulator-launch.json',
      'android-emulator.png',
      'b1-exit-report.json',
    ]) {
      await writeFile(join(evidenceRoot, 'reports/b1', file), 'stale\n', 'utf8');
    }
    await clearIosCaptureEvidence({ root: evidenceRoot });
    assert.equal(existsSync(join(evidenceRoot, 'reports/b1/ios-simulator-launch.json')), false);
    assert.equal(existsSync(join(evidenceRoot, 'reports/b1/ios-simulator.png')), false);
    assert.equal(existsSync(join(evidenceRoot, 'reports/b1/b1-exit-report.json')), false);
    assert.equal(existsSync(join(evidenceRoot, 'reports/b1/android-emulator.png')), true);
    await writeFile(
      join(evidenceRoot, 'reports/b1/b1-exit-report.json'),
      'stale again\n',
      'utf8',
    );
    await clearAndroidCaptureEvidence({ root: evidenceRoot });
    assert.equal(existsSync(join(evidenceRoot, 'reports/b1/android-emulator-launch.json')), false);
    assert.equal(existsSync(join(evidenceRoot, 'reports/b1/android-emulator.png')), false);
    assert.equal(existsSync(join(evidenceRoot, 'reports/b1/b1-exit-report.json')), false);
  } finally {
    await rm(evidenceRoot, { recursive: true, force: true });
  }
});

test('B1 exit evidence binds both installed native apps to the frozen application', async () => {
  const [ios, android, exit] = await Promise.all([
    readFile(join(ROOT, 'reports/b1/ios-simulator-launch.json'), 'utf8').then(JSON.parse),
    readFile(join(ROOT, 'reports/b1/android-emulator-launch.json'), 'utf8').then(JSON.parse),
    readFile(join(ROOT, 'reports/b1/b1-exit-report.json'), 'utf8').then(JSON.parse),
  ]);
  const frozenFingerprint = await validateRecordedB1Fingerprint({
    commit: TESTED_APPLICATION_COMMIT,
    fingerprint: exit.applicationFingerprint,
  });

  for (const report of [ios, android]) {
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.testedApplicationCommit, TESTED_APPLICATION_COMMIT);
    assert.deepEqual(report.applicationFingerprint, frozenFingerprint);
    assert.deepEqual(report.packageVersions, {
      application: '0.0.0',
      capacitorCore: '8.4.1',
      capacitorPlatform: '8.4.1',
    });
    assert.equal(report.bundle.serverUrl, null);
    assert.match(report.bundle.indexHtmlSha256, SHA256);
    assert.match(report.screenshot.sha256, SHA256);
    assert.equal(
      report.screenshot.sha256,
      await sha256(join(ROOT, report.screenshot.path)),
    );
  }

  assert.equal(ios.platform, 'ios-simulator');
  assert.deepEqual(ios.identity, { bundleId: 'uk.eugnel.ks2spelling' });
  assert.equal(ios.device.name, 'KS2 Spelling iPhone 17');
  assert.equal(ios.device.runtimeIdentifier, 'com.apple.CoreSimulator.SimRuntime.iOS-26-5');
  assert.equal(ios.device.osVersion, '26.5');
  assert.match(ios.nativeVersions.xcode, /^26\.6 \(17F113\)$/);
  assert.match(ios.installation.installedAppPath, /\/data\/Containers\/Bundle\/Application\//);
  assert.equal(ios.installation.bundleShortVersion, '1.0');
  assert.equal(ios.installation.bundleVersion, '1');
  assert.match(ios.foreground.processIdentifier, /^[1-9][0-9]*$/);
  assert.equal(ios.foreground.bundleId, 'uk.eugnel.ks2spelling');
  assert.equal(ios.uiReadiness.source, 'screenshot-bmp-shell-colour-populations');
  assert.equal(ios.uiReadiness.width, 1206);
  assert.equal(ios.uiReadiness.height, 2622);
  assert.ok(ios.uiReadiness.darkPixelRatio >= 0.3);
  assert.ok(ios.uiReadiness.brightPixelRatio >= 0.01);
  assert.ok(ios.uiReadiness.accentPixelRatio >= 0.005);
  assert.ok(Number.isInteger(ios.uiReadiness.attempts));
  assert.ok(ios.uiReadiness.attempts >= 1);

  assert.equal(android.platform, 'android-emulator');
  assert.deepEqual(android.identity, { packageId: 'uk.eugnel.ks2spelling' });
  assert.equal(android.device.name, 'KS2_Spelling_API_36');
  assert.equal(android.device.serial, 'emulator-5580');
  assert.equal(android.device.apiLevel, 36);
  assert.equal(android.nativeVersions.buildTools, '36.0.0');
  assert.match(android.installation.installedApkPath, /^\/data\/app\//);
  assert.match(android.foreground.processIdentifier, /^[1-9][0-9]*$/);
  assert.equal(
    android.foreground.resumedActivity,
    'uk.eugnel.ks2spelling/.MainActivity',
  );
  assert.deepEqual(android.packagedPermissions, {
    declared: [],
    requested: [],
  });
  assert.equal(android.uiReadiness.status, 'ready');
  assert.equal(
    android.uiReadiness.source,
    'uiautomator-required-texts-and-screenshot-bmp-shell-colour-populations',
  );
  assert.deepEqual(android.uiReadiness.requiredTexts, [
    'KS2 Spelling',
    'Starter content: 20 words',
    'Bundled locally',
  ]);
  assert.match(android.uiReadiness.hierarchySha256, SHA256);
  assert.ok(Number.isInteger(android.uiReadiness.hierarchyAttempts));
  assert.ok(android.uiReadiness.hierarchyAttempts >= 1);
  assert.equal(android.uiReadiness.width, 1080);
  assert.equal(android.uiReadiness.height, 2424);
  assert.ok(android.uiReadiness.darkPixelRatio >= 0.3);
  assert.ok(android.uiReadiness.brightPixelRatio >= 0.01);
  assert.ok(android.uiReadiness.accentPixelRatio >= 0.005);
  assert.ok(Number.isInteger(android.uiReadiness.screenshotAttempts));
  assert.ok(android.uiReadiness.screenshotAttempts >= 1);

  assert.equal(ios.bundle.indexHtmlSha256, android.bundle.indexHtmlSha256);
  assert.equal(exit.schemaVersion, 1);
  assert.equal(exit.status, 'pass');
  assert.equal(exit.testedApplicationCommit, TESTED_APPLICATION_COMMIT);
  assert.deepEqual(exit.applicationFingerprint, frozenFingerprint);
  assert.equal(exit.serverUrl, null);
  assert.deepEqual(exit.platforms, {
    ios: {
      report: 'reports/b1/ios-simulator-launch.json',
      sha256: await sha256(join(ROOT, 'reports/b1/ios-simulator-launch.json')),
    },
    android: {
      report: 'reports/b1/android-emulator-launch.json',
      sha256: await sha256(join(ROOT, 'reports/b1/android-emulator-launch.json')),
    },
  });
  assert.deepEqual(exit.visualReview, {
    identicalBundledB1Shell: true,
    iosErrorOrLiveReloadScreen: false,
    androidErrorOrLiveReloadScreen: false,
  });
});
