import { resolve } from 'node:path';
import {
  EXIT_CODES,
  isMain,
  printJson,
  runCommand,
} from './lib/run-command.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APP_PATH = '.native-build/ios/Build/Products/Debug-iphonesimulator/App.app';

export const IOS_DEVICE = Object.freeze({
  name: 'KS2 Spelling iPhone 17',
  type: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
  runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
  bundleId: 'uk.eugnel.ks2spelling',
});

export function createIosLaunchPlan({ udid }) {
  const deviceId = udid ?? '$CREATED_UDID';
  const commands = [];
  if (!udid) {
    commands.push({
      command: 'xcrun',
      args: ['simctl', 'create', IOS_DEVICE.name, IOS_DEVICE.type, IOS_DEVICE.runtime],
    });
  }
  commands.push(
    { command: 'xcrun', args: ['simctl', 'boot', deviceId] },
    { command: 'xcrun', args: ['simctl', 'bootstatus', deviceId, '-b'] },
    { command: process.execPath, args: ['scripts/test-ios.mjs'] },
    { command: 'xcrun', args: ['simctl', 'install', deviceId, APP_PATH] },
    { command: 'xcrun', args: ['simctl', 'launch', deviceId, IOS_DEVICE.bundleId] },
  );
  return commands;
}

export function selectExistingIosDevice(devicesByRuntime) {
  const namedDevices = Object.entries(devicesByRuntime).flatMap(([runtime, devices]) =>
    devices
      .filter(({ name }) => name === IOS_DEVICE.name)
      .map((device) => ({ ...device, runtime })),
  );
  if (
    namedDevices.length > 1 ||
    (namedDevices[0] &&
      (namedDevices[0].runtime !== IOS_DEVICE.runtime ||
        namedDevices[0].deviceTypeIdentifier !== IOS_DEVICE.type))
  ) {
    const collision = new Error(`${IOS_DEVICE.name} does not match the frozen B1 runtime/type`);
    collision.code = 'ios_device_collision';
    throw collision;
  }
  return namedDevices[0] ?? null;
}

async function runRequired(command, args) {
  const result = await runCommand(command, args, { cwd: ROOT });
  if (result.exitCode !== 0) throw new Error(`${command} failed with ${result.exitCode}`);
  return result;
}

export async function main() {
  try {
    const listed = await runRequired('xcrun', ['simctl', 'list', 'devices', '-j']);
    const devicesByRuntime = JSON.parse(listed.stdout).devices ?? {};
    let device = selectExistingIosDevice(devicesByRuntime);
    let created = false;
    if (!device) {
      const createdResult = await runRequired('xcrun', [
        'simctl',
        'create',
        IOS_DEVICE.name,
        IOS_DEVICE.type,
        IOS_DEVICE.runtime,
      ]);
      device = { udid: createdResult.stdout.trim(), name: IOS_DEVICE.name, state: 'Shutdown' };
      created = true;
    }
    if (device.state !== 'Booted') {
      await runRequired('xcrun', ['simctl', 'boot', device.udid]);
    }
    await runRequired('xcrun', ['simctl', 'bootstatus', device.udid, '-b']);
    await runRequired(process.execPath, ['scripts/test-ios.mjs']);
    await runRequired('xcrun', ['simctl', 'install', device.udid, APP_PATH]);
    const launch = await runRequired('xcrun', [
      'simctl',
      'launch',
      device.udid,
      IOS_DEVICE.bundleId,
    ]);
    printJson({
      ok: true,
      platform: 'ios',
      device: { name: IOS_DEVICE.name, udid: device.udid, created },
      bundleId: IOS_DEVICE.bundleId,
      appPath: APP_PATH,
      launch: launch.stdout.trim(),
    });
    return EXIT_CODES.success;
  } catch (error) {
    const collision = error.code === 'ios_device_collision';
    printJson(
      {
        ok: false,
        code: collision ? error.code : 'ios_launch_failed',
        message: error.message,
      },
      process.stderr,
    );
    return collision ? EXIT_CODES.stateMismatch : EXIT_CODES.commandFailed;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
