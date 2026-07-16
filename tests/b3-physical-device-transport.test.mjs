import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createB3TestPng } from './helpers/b3-test-png.mjs';

import { canonicaliseB3ProofValue } from '../src/app/b3-live-proof-protocol.js';
import { createB3PhysicalDeviceTransport } from '../scripts/lib/b3-physical-device-transport.mjs';

const COMMIT = 'a'.repeat(40);
const FINGERPRINT = 'b'.repeat(64);

function command(platform) {
  return {
    schemaVersion: 1,
    captureId: '018f1d7b-97e8-4a52-8cf2-783e5089c001',
    platform,
    testedApplicationCommit: COMMIT,
    applicationFingerprint: FINGERPRINT,
    expectedScenarioIndex: 0,
    expectedSequence: 1,
    previousObservationSha256: '0'.repeat(64),
    installationMode: 'existing',
    actionCode: 'ARM_CAPTURE',
    challengeSha256: 'c'.repeat(64),
  };
}

test('iOS transport launches only the fixed bundle and pulls only fixed appData bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-ios-transport-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const observationBytes = Buffer.from('{"device":"observation"}', 'utf8');
  const runner = async (executable, args) => {
    calls.push([executable, args]);
    if (args.slice(0, 4).join(' ') === 'devicectl device process launch') {
      const json = args[args.indexOf('--json-output') + 1];
      await writeFile(json, JSON.stringify({
        info: { outcome: 'success' },
        result: { processIdentifier: 4321 },
      }));
    }
    if (args.includes('processes')) {
      await writeFile(args[args.indexOf('--json-output') + 1], JSON.stringify({
        info: { outcome: 'success' },
        result: {
          runningProcesses: [{
            bundleIdentifier: 'uk.eugnel.ks2spelling',
            processIdentifier: 4321,
          }],
        },
      }));
    }
    if (args.includes('terminate')) {
      await writeFile(args[args.indexOf('--json-output') + 1], JSON.stringify({
        info: { outcome: 'success' },
        result: { processIdentifier: 4321 },
      }));
    }
    if (args.slice(0, 4).join(' ') === 'devicectl device copy from') {
      const destination = args[args.indexOf('--destination') + 1];
      await writeFile(destination, observationBytes);
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const transport = createB3PhysicalDeviceTransport({
    root,
    platform: 'ios',
    env: { B3_IOS_PHYSICAL_DEVICE_ID: '00008140-001234560123001C' },
    runner,
  });
  await transport.launch(command('ios-physical'));
  assert.equal(calls[0][0], 'xcrun');
  assert.deepEqual(calls[0][1].slice(0, 8), [
    'devicectl', 'device', 'process', 'launch', '--device',
    '00008140-001234560123001C', '--terminate-existing', '--json-output',
  ]);
  assert.deepEqual(calls[0][1].slice(-3), [
    'uk.eugnel.ks2spelling', '--b3-proof-command-v1',
    canonicaliseB3ProofValue(command('ios-physical')),
  ]);
  assert.deepEqual(await transport.pullObservation(), observationBytes);
  assert.deepEqual(calls[1][0], 'xcrun');
  assert.deepEqual(calls[1][1].slice(0, 7), [
    'devicectl', 'device', 'copy', 'from', '--device',
    '00008140-001234560123001C', '--source',
  ]);
  assert.equal(
    calls[1][1][calls[1][1].indexOf('--source') + 1],
    'Library/Application Support/b3-proof-observation-v1.json',
  );
  assert.equal(calls[1][1].includes('--domain-type'), true);
  assert.equal(calls[1][1][calls[1][1].indexOf('--domain-type') + 1], 'appDataContainer');
  assert.equal(calls[1][1][calls[1][1].indexOf('--domain-identifier') + 1], 'uk.eugnel.ks2spelling');
  let receiptRetained = false;
  await transport.forceStop({
    retainReceipt: async ({ processIdentifier }) => {
      assert.equal(processIdentifier, 4321);
      receiptRetained = true;
    },
  });
  assert.equal(receiptRetained, true);
  assert.ok(calls[2][1].includes('processes'));
  assert.deepEqual(calls[3][1].slice(0, 8), [
    'devicectl', 'device', 'process', 'terminate', '--device',
    '00008140-001234560123001C', '--pid', '4321',
  ]);
  assert.equal(calls[3][1].includes('--kill'), true);
});

test('resumed iOS force-stop requires one exact running bundle process from private JSON', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-ios-resumed-stop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const runner = async (executable, args) => {
    calls.push([executable, args]);
    if (args.includes('processes')) {
      await writeFile(args[args.indexOf('--json-output') + 1], JSON.stringify({
        info: { outcome: 'success' },
        result: {
          runningProcesses: [{
            bundleIdentifier: 'uk.eugnel.ks2spelling',
            processIdentifier: 9876,
          }],
        },
      }));
    }
    if (args.includes('terminate')) {
      await writeFile(args[args.indexOf('--json-output') + 1], JSON.stringify({
        info: { outcome: 'success' },
        result: { processIdentifier: 9876 },
      }));
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const transport = createB3PhysicalDeviceTransport({
    root,
    platform: 'ios',
    env: { B3_IOS_PHYSICAL_DEVICE_ID: '00008140-001234560123001C' },
    runner,
  });
  await transport.forceStop();
  assert.ok(calls[0][1].includes('processes'));
  assert.equal(calls[1][1][calls[1][1].indexOf('--pid') + 1], '9876');
  assert.equal(calls[1][1].includes('--kill'), true);

  for (const runningProcesses of [
    [],
    [
      { bundleIdentifier: 'uk.eugnel.ks2spelling', processIdentifier: 10 },
      { bundleIdentifier: 'uk.eugnel.ks2spelling', processIdentifier: 11 },
    ],
    [{ bundleIdentifier: 'another.bundle', processIdentifier: 12 }],
    [{ bundleIdentifier: 'uk.eugnel.ks2spelling', processIdentifier: 0 }],
  ]) {
    let terminateCalls = 0;
    const rejected = createB3PhysicalDeviceTransport({
      root,
      platform: 'ios',
      env: { B3_IOS_PHYSICAL_DEVICE_ID: '00008140-001234560123001C' },
      runner: async (_command, args) => {
        if (args.includes('processes')) {
          await writeFile(args[args.indexOf('--json-output') + 1], JSON.stringify({
            info: { outcome: 'success' },
            result: { runningProcesses },
          }));
        } else {
          terminateCalls += 1;
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    await assert.rejects(rejected.forceStop(), /process|PID|bundle/i);
    assert.equal(terminateCalls, 0);
  }
});

test('iOS force-stop rejects a recycled retained PID before SIGKILL', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-ios-pid-reuse-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let terminateCalls = 0;
  const runner = async (_executable, args) => {
    const output = args[args.indexOf('--json-output') + 1];
    if (args.includes('launch')) {
      await writeFile(output, JSON.stringify({
        info: { outcome: 'success' }, result: { processIdentifier: 4321 },
      }));
    } else if (args.includes('processes')) {
      await writeFile(output, JSON.stringify({
        info: { outcome: 'success' },
        result: { runningProcesses: [{
          bundleIdentifier: 'uk.eugnel.ks2spelling', processIdentifier: 9999,
        }] },
      }));
    } else {
      terminateCalls += 1;
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const transport = createB3PhysicalDeviceTransport({
    root,
    platform: 'ios',
    env: { B3_IOS_PHYSICAL_DEVICE_ID: '00008140-001234560123001C' },
    runner,
  });
  await transport.launch(command('ios-physical'));
  await assert.rejects(transport.forceStop(), /PID|process|bundle/i);
  assert.equal(terminateCalls, 0);
});

test('Android transport uses explicit activity, fixed external pull and direct binary screencap', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-android-transport-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const observationBytes = Buffer.from('{"device":"observation"}', 'utf8');
  const runner = async (executable, args) => {
    calls.push([executable, args]);
    if (args.includes('pull')) {
      await writeFile(args.at(-1), observationBytes);
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const png = createB3TestPng({ width: 1080, height: 2400 });
  const binaryRunner = async (executable, args) => {
    calls.push([executable, args]);
    return { exitCode: 0, stdout: png, stderr: Buffer.alloc(0) };
  };
  const transport = createB3PhysicalDeviceTransport({
    root,
    platform: 'android',
    env: { B3_ANDROID_PHYSICAL_DEVICE_ID: 'R5CT1234ABC' },
    runner,
    binaryRunner,
  });
  await transport.launch(command('android-play-physical'));
  assert.deepEqual(calls[0], [
    'adb',
    [
      '-s', 'R5CT1234ABC', 'shell', 'am', 'start', '-S', '-W', '-n',
      'uk.eugnel.ks2spelling/.MainActivity', '--es',
      'uk.eugnel.ks2spelling.B3_PROOF_COMMAND_V1',
      canonicaliseB3ProofValue(command('android-play-physical')),
    ],
  ]);
  assert.deepEqual(await transport.pullObservation(), observationBytes);
  assert.equal(
    calls[1][1].at(-2),
    '/sdcard/Android/data/uk.eugnel.ks2spelling/files/b3-proof-observation-v1.json',
  );
  assert.deepEqual(await transport.captureScreenshot(), png);
  await transport.foregroundApplication();
  assert.deepEqual(calls.at(-1)[1], [
    '-s', 'R5CT1234ABC', 'shell', 'am', 'start', '-W', '-n',
    'uk.eugnel.ks2spelling/.MainActivity',
  ]);
  assert.deepEqual(calls[2], [
    'adb',
    ['-s', 'R5CT1234ABC', 'exec-out', 'screencap', '-p'],
  ]);

  const invalid = createB3PhysicalDeviceTransport({
    root,
    platform: 'android',
    env: { B3_ANDROID_PHYSICAL_DEVICE_ID: 'R5CT1234ABC' },
    runner,
    binaryRunner: async () => ({
      exitCode: 0,
      stdout: Buffer.from('not a png'),
      stderr: Buffer.alloc(0),
    }),
  });
  await assert.rejects(invalid.captureScreenshot(), /PNG|screenshot/i);
});

test('device inspection derives bounded physical model and OS from platform tools', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-device-inspection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const iosId = '00008140-001234560123001C';
  const ios = createB3PhysicalDeviceTransport({
    root,
    platform: 'ios',
    env: { B3_IOS_PHYSICAL_DEVICE_ID: iosId },
    runner: async (_executable, args) => {
      await writeFile(args[args.indexOf('--json-output') + 1], JSON.stringify({
        info: { outcome: 'success' },
        result: {
          devices: [{
            identifier: iosId,
            hardwareProperties: { marketingName: 'iPhone 17', reality: 'physical' },
            deviceProperties: { osVersionNumber: '26.0' },
          }],
        },
      }));
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });
  assert.deepEqual(await ios.inspectDevice(), {
    model: 'iPhone 17', osVersion: '26.0', physical: true,
  });

  const android = createB3PhysicalDeviceTransport({
    root,
    platform: 'android',
    env: { B3_ANDROID_PHYSICAL_DEVICE_ID: 'R5CT1234ABC' },
    runner: async (_executable, args) => {
      const property = args.at(-1);
      const stdout = {
        'ro.kernel.qemu': '',
        'ro.product.model': 'Pixel 9 Pro\n',
        'ro.build.version.release': '16\n',
      }[property];
      return { exitCode: 0, stdout, stderr: '' };
    },
  });
  assert.deepEqual(await android.inspectDevice(), {
    model: 'Pixel 9 Pro', osVersion: '16', physical: true,
  });
});

test('transport fails closed for absent or injectable physical device identifiers', async () => {
  for (const [platform, env, expectedPlatform] of [
    ['ios', {}, 'ios-physical'],
    ['android', { B3_ANDROID_PHYSICAL_DEVICE_ID: 'serial; reboot' }, 'android-play-physical'],
  ]) {
    const transport = createB3PhysicalDeviceTransport({
      root: '/tmp',
      platform,
      env,
      runner: async () => assert.fail('runner must not execute'),
    });
    await assert.rejects(transport.launch(command(expectedPlatform)), /device identifier|physical device/i);
  }
});

test('transport rejects wrong platform commands and bounded command failures without leaking output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'b3-transport-failure-'));
  const secret = 'secret-output-must-not-escape';
  try {
    const transport = createB3PhysicalDeviceTransport({
      root,
      platform: 'ios',
      env: { B3_IOS_PHYSICAL_DEVICE_ID: '00008140-001234560123001C' },
      runner: async () => ({ exitCode: 1, stdout: secret, stderr: secret }),
    });
    await assert.rejects(
      transport.launch(command('android-play-physical')),
      /platform/i,
    );
    await assert.rejects(
      transport.launch(command('ios-physical')),
      (error) => error.code === 'b3_physical_device_command_failed' && !error.message.includes(secret),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
