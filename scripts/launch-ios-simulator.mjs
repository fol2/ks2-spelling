import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  EXIT_CODES,
  isMain,
  printJson,
  runCommand,
} from './lib/run-command.mjs';
import { fingerprintB1Application } from './fingerprint-b1-application.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APP_PATH = '.native-build/ios/Build/Products/Debug-iphonesimulator/App.app';
const REPORT_PATH = 'reports/b1/ios-simulator-launch.json';
const SCREENSHOT_PATH = 'reports/b1/ios-simulator.png';
const TESTED_APPLICATION_COMMIT =
  '66a6deee66672d13d98efd12ab13ff0f3e32ff57';

export const IOS_DEVICE = Object.freeze({
  name: 'KS2 Spelling iPhone 17',
  type: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
  runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
  bundleId: 'uk.eugnel.ks2spelling',
});

function iosCaptureError(message) {
  const error = new Error(message);
  error.code = 'ios_capture_invalid';
  return error;
}

export function parseIosLaunchProcess(output) {
  const match = output.trim().match(/^uk\.eugnel\.ks2spelling:\s+([1-9][0-9]*)$/);
  if (!match) throw iosCaptureError('iOS launch output does not prove the B1 process');
  return match[1];
}

export function parseIosRuntimeVersion(runtimeList) {
  const matches = (runtimeList?.runtimes ?? []).filter(
    ({ identifier }) => identifier === IOS_DEVICE.runtime,
  );
  if (
    matches.length !== 1 ||
    matches[0].isAvailable !== true ||
    matches[0].version !== '26.5'
  ) {
    throw iosCaptureError('iOS runtime evidence is not the frozen B1 runtime');
  }
  return matches[0].version;
}

export function parseIosHostProcess(output, processIdentifier) {
  if (!/^[1-9][0-9]*$/.test(processIdentifier)) {
    throw iosCaptureError('iOS process identifier is incomplete');
  }
  const pattern = new RegExp(
    `^\\s*${processIdentifier}\\s+.*\\/App\\.app\\/App$`,
    'm',
  );
  if (!pattern.test(output)) {
    throw iosCaptureError('Launched iOS process is not running from the installed app');
  }
  return 'running';
}

export function analyseIosScreenshotBmp(buffer) {
  if (
    !Buffer.isBuffer(buffer) ||
    buffer.length < 54 ||
    buffer.toString('ascii', 0, 2) !== 'BM'
  ) {
    throw iosCaptureError('iOS screenshot BMP header is invalid');
  }
  const pixelOffset = buffer.readUInt32LE(10);
  const dibSize = buffer.readUInt32LE(14);
  const width = buffer.readInt32LE(18);
  const signedHeight = buffer.readInt32LE(22);
  const height = Math.abs(signedHeight);
  const planes = buffer.readUInt16LE(26);
  const bitsPerPixel = buffer.readUInt16LE(28);
  const compression = buffer.readUInt32LE(30);
  const stride = width * 4;
  if (
    dibSize < 40 ||
    width <= 0 ||
    height <= 0 ||
    planes !== 1 ||
    bitsPerPixel !== 32 ||
    ![0, 3].includes(compression) ||
    pixelOffset < 54 ||
    pixelOffset + stride * height !== buffer.length
  ) {
    throw iosCaptureError('iOS screenshot must be an exact 32-bit BMP');
  }
  let darkPixels = 0;
  for (let offset = pixelOffset; offset < buffer.length; offset += 4) {
    if (buffer[offset] < 80 && buffer[offset + 1] < 80 && buffer[offset + 2] < 80) {
      darkPixels += 1;
    }
  }
  const darkPixelRatio = darkPixels / (width * height);
  if (darkPixelRatio < 0.3) {
    throw iosCaptureError('iOS screenshot does not show the dark bundled B1 shell');
  }
  return { width, height, darkPixelRatio };
}

export async function clearIosCaptureEvidence({ root = ROOT } = {}) {
  await Promise.all(
    [REPORT_PATH, SCREENSHOT_PATH, 'reports/b1/b1-exit-report.json'].map((path) =>
      rm(join(root, path), { force: true }),
    ),
  );
}

export async function runWithIosCaptureCleanup({
  capture,
  device,
  work,
  shutdown,
}) {
  try {
    return await work();
  } finally {
    if (capture && device) await shutdown(device.udid);
  }
}

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
    { command: process.execPath, args: ['scripts/native-sync-check.mjs'] },
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
  if (result.exitCode !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with ${result.exitCode}`);
  }
  return result;
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function parseXcodeVersion(output) {
  const match = output.match(/^Xcode ([^\n]+)\nBuild version ([^\n]+)$/);
  if (!match) throw iosCaptureError('Xcode version output is incomplete');
  return `${match[1]} (${match[2]})`;
}

async function captureIosEvidence({ device, launchOutput }) {
  const processIdentifier = parseIosLaunchProcess(launchOutput);
  await new Promise((completion) => setTimeout(completion, 2000));
  const [container, runtimeList, processState, xcodeVersion, packageJson] =
    await Promise.all([
      runRequired('xcrun', [
        'simctl',
        'get_app_container',
        device.udid,
        IOS_DEVICE.bundleId,
        'app',
      ]),
      runRequired('xcrun', ['simctl', 'list', 'runtimes', '-j']),
      runRequired('/bin/ps', ['-p', processIdentifier, '-o', 'pid=,comm=']),
      runRequired('xcodebuild', ['-version']),
      readFile(join(ROOT, 'package.json'), 'utf8').then(JSON.parse),
    ]);
  const installedAppPath = container.stdout.trim();
  if (!installedAppPath.includes('/data/Containers/Bundle/Application/')) {
    throw iosCaptureError('Installed iOS application container is not exact');
  }
  const foregroundState = parseIosHostProcess(
    processState.stdout,
    processIdentifier,
  );
  const osVersion = parseIosRuntimeVersion(JSON.parse(runtimeList.stdout));
  const [bundleShortVersion, bundleVersion] = await Promise.all([
    runRequired('plutil', [
      '-extract',
      'CFBundleShortVersionString',
      'raw',
      '-o',
      '-',
      join(installedAppPath, 'Info.plist'),
    ]),
    runRequired('plutil', [
      '-extract',
      'CFBundleVersion',
      'raw',
      '-o',
      '-',
      join(installedAppPath, 'Info.plist'),
    ]),
  ]);
  const installedConfig = JSON.parse(
    await readFile(join(installedAppPath, 'capacitor.config.json'), 'utf8'),
  );
  const serverUrl = installedConfig.server?.url ?? null;
  if (serverUrl !== null) {
    throw iosCaptureError('Installed iOS application contains server.url');
  }
  const indexPath = join(installedAppPath, 'public/index.html');
  const indexHtmlSha256 = sha256(await readFile(indexPath));
  await mkdir(join(ROOT, 'reports/b1'), { recursive: true });
  await mkdir(join(ROOT, '.native-build/ios'), { recursive: true });
  const readinessBmp = join(ROOT, '.native-build/ios/b1-readiness.bmp');
  let uiReadiness = null;
  try {
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      await runRequired('xcrun', [
        'simctl',
        'io',
        device.udid,
        'screenshot',
        join(ROOT, SCREENSHOT_PATH),
      ]);
      await runRequired('sips', [
        '-s',
        'format',
        'bmp',
        join(ROOT, SCREENSHOT_PATH),
        '--out',
        readinessBmp,
      ]);
      try {
        uiReadiness = {
          source: 'screenshot-bmp-dark-shell-ratio',
          ...analyseIosScreenshotBmp(await readFile(readinessBmp)),
          attempts: attempt,
        };
        break;
      } catch (error) {
        if (error.code !== 'ios_capture_invalid') throw error;
      }
      await new Promise((completion) => setTimeout(completion, 500));
    }
  } finally {
    await rm(readinessBmp, { force: true });
  }
  if (!uiReadiness) {
    throw iosCaptureError('iOS bundled B1 shell did not become visible');
  }
  const screenshotSha256 = sha256(await readFile(join(ROOT, SCREENSHOT_PATH)));
  const applicationFingerprint = await fingerprintB1Application({ root: ROOT });
  const report = {
    schemaVersion: 1,
    platform: 'ios-simulator',
    testedApplicationCommit: TESTED_APPLICATION_COMMIT,
    applicationFingerprint,
    packageVersions: {
      application: packageJson.version,
      capacitorCore: packageJson.dependencies['@capacitor/core'],
      capacitorPlatform: packageJson.dependencies['@capacitor/ios'],
    },
    nativeVersions: {
      xcode: parseXcodeVersion(xcodeVersion.stdout.trim()),
      iosSdk: '26.5',
    },
    identity: { bundleId: IOS_DEVICE.bundleId },
    device: {
      name: IOS_DEVICE.name,
      udid: device.udid,
      typeIdentifier: IOS_DEVICE.type,
      runtimeIdentifier: IOS_DEVICE.runtime,
      osVersion,
    },
    installation: {
      buildAppPath: APP_PATH,
      installedAppPath,
      bundleShortVersion: bundleShortVersion.stdout.trim(),
      bundleVersion: bundleVersion.stdout.trim(),
    },
    foreground: {
      processIdentifier,
      bundleId: IOS_DEVICE.bundleId,
      processState: foregroundState,
    },
    uiReadiness,
    bundle: {
      serverUrl,
      indexHtmlPath: `${installedAppPath}/public/index.html`,
      indexHtmlSha256,
    },
    screenshot: {
      path: SCREENSHOT_PATH,
      sha256: screenshotSha256,
    },
  };
  await writeFile(
    join(ROOT, REPORT_PATH),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  return report;
}

export async function main(args = process.argv.slice(2)) {
  const capture = args.includes('--capture');
  if (capture) await clearIosCaptureEvidence();
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
    return await runWithIosCaptureCleanup({
      capture,
      device,
      shutdown: (udid) =>
        runCommand('xcrun', ['simctl', 'shutdown', udid], { cwd: ROOT }),
      work: async () => {
        if (device.state !== 'Booted') {
          await runRequired('xcrun', ['simctl', 'boot', device.udid]);
        }
        await runRequired('xcrun', ['simctl', 'bootstatus', device.udid, '-b']);
        await runRequired(process.execPath, ['scripts/native-sync-check.mjs']);
        await runRequired(process.execPath, ['scripts/test-ios.mjs']);
        await runRequired('xcrun', ['simctl', 'install', device.udid, APP_PATH]);
        const launch = await runRequired('xcrun', [
          'simctl',
          'launch',
          device.udid,
          IOS_DEVICE.bundleId,
        ]);
        const evidence = capture
          ? await captureIosEvidence({ device, launchOutput: launch.stdout })
          : null;
        printJson({
          ok: true,
          platform: 'ios',
          device: { name: IOS_DEVICE.name, udid: device.udid, created },
          bundleId: IOS_DEVICE.bundleId,
          appPath: APP_PATH,
          launch: launch.stdout.trim(),
          evidence: evidence ? REPORT_PATH : null,
        });
        return EXIT_CODES.success;
      },
    });
  } catch (error) {
    if (capture) await clearIosCaptureEvidence();
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
