import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  B2_ANDROID_DEVICE,
  B2_IOS_DEVICE,
  analyseAndroidScreenshotBmp,
  analyseIosScreenshotBmp,
  assertAndroidSerialOwnership,
  assertStartedAndroidEmulatorProcess,
  createAndroidCaptureCleanupPlan,
  createB2AndroidFreshInstallPlan,
  createB2IosFreshInstallPlan,
  runWithB2AndroidCleanup,
  runWithB2IosCleanup,
  selectExistingIosDevice,
  waitForAndroidBundledShell,
} from '../scripts/lib/b2-evidence.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('B2 ownership stays pinned to the exact B1 virtual devices', () => {
  assert.deepEqual(B2_IOS_DEVICE, {
    name: 'KS2 Spelling iPhone 17',
    type: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
    runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    bundleId: 'uk.eugnel.ks2spelling',
  });
  assert.deepEqual(B2_ANDROID_DEVICE, {
    name: 'KS2_Spelling_API_36',
    image: 'system-images;android-36;google_apis;arm64-v8a',
    device: 'pixel_9',
    port: '5580',
    serial: 'emulator-5580',
    packageId: 'uk.eugnel.ks2spelling',
    activity: 'uk.eugnel.ks2spelling/.MainActivity',
  });
});

test('B2 reuses the exact collision, process and screenshot authorities', async () => {
  const ios = await import('../scripts/launch-ios-simulator.mjs');
  const android = await import('../scripts/launch-android-emulator.mjs');
  assert.equal(selectExistingIosDevice, ios.selectExistingIosDevice);
  assert.equal(analyseIosScreenshotBmp, ios.analyseIosScreenshotBmp);
  assert.equal(assertAndroidSerialOwnership, android.assertAndroidSerialOwnership);
  assert.equal(
    assertStartedAndroidEmulatorProcess,
    android.assertStartedAndroidEmulatorProcess,
  );
  assert.equal(analyseAndroidScreenshotBmp, android.analyseAndroidScreenshotBmp);
  assert.equal(waitForAndroidBundledShell, android.waitForAndroidBundledShell);

  assert.throws(
    () => assertAndroidSerialOwnership('Some_Other_AVD\nOK\n'),
    ({ code }) => code === 'android_serial_collision',
  );
  assert.doesNotThrow(() =>
    assertStartedAndroidEmulatorProcess(
      '/sdk/emulator/qemu-system-aarch64 -avd KS2_Spelling_API_36 -port 5580',
    ),
  );
  assert.deepEqual(
    createAndroidCaptureCleanupPlan({
      capture: true,
      ownsB1Serial: false,
      startedDetachedPid: 321,
    }),
    [{ type: 'terminate-started-process-group', pid: 321 }],
  );
});

test('B2 fresh-install plans uninstall only the exact application before install', () => {
  const ios = createB2IosFreshInstallPlan({ udid: 'owned-udid', appPath: '/tmp/App.app' });
  assert.deepEqual(ios, [
    ['xcrun', ['simctl', 'uninstall', 'owned-udid', 'uk.eugnel.ks2spelling']],
    ['xcrun', ['simctl', 'install', 'owned-udid', '/tmp/App.app']],
  ]);
  const android = createB2AndroidFreshInstallPlan({ apkPath: '/tmp/app-debug.apk' });
  assert.deepEqual(android, [
    ['adb', ['-s', 'emulator-5580', 'uninstall', 'uk.eugnel.ks2spelling']],
    ['adb', ['-s', 'emulator-5580', 'install', '/tmp/app-debug.apk']],
  ]);
});

test('B2 cleanup always shuts down only owned devices', async () => {
  const iosEvents = [];
  await assert.rejects(
    runWithB2IosCleanup({
      ownsDevice: true,
      udid: 'owned-udid',
      work: async () => { throw new Error('proof failed'); },
      shutdown: async (udid) => { iosEvents.push(udid); },
    }),
    /proof failed/,
  );
  assert.deepEqual(iosEvents, ['owned-udid']);

  const androidEvents = [];
  await assert.rejects(
    runWithB2AndroidCleanup({
      cleanupPlan: [{ type: 'kill-owned-b1-serial', serial: 'emulator-5580' }],
      work: async () => { throw new Error('proof failed'); },
      killOwnedSerial: async (serial) => { androidEvents.push(serial); },
      terminateProcessGroup: async () => assert.fail('wrong cleanup route'),
    }),
    /proof failed/,
  );
  assert.deepEqual(androidEvents, ['emulator-5580']);
});

test('shared ownership helpers stay read-only and preserve B1 evidence', async () => {
  const source = await readFile(join(ROOT, 'scripts/lib/b2-evidence.mjs'), 'utf8');
  assert.doesNotMatch(source, /reports\/b1.*(?:writeFile|rm)|(?:writeFile|rm).*reports\/b1/s);
  assert.doesNotMatch(source, /process\.exit|main\s*\(/);
  assert.match(source, /selectExistingIosDevice/);
  assert.match(source, /assertAndroidSerialOwnership/);
  assert.match(source, /analyseIosScreenshotBmp/);
  assert.match(source, /waitForAndroidBundledShell/);
});
