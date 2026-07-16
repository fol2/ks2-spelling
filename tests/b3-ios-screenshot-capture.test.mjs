import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { captureB3IosScreenshotBytes } from '../scripts/lib/b3-ios-proof-screenshot.mjs';
import { createB3TestPng } from './helpers/b3-test-png.mjs';

const DEVICE_ID = '00008140-001234560123001C';

test('iOS screenshot capture runs only independent B3ProofUITests and exports its named attachment', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-ios-screenshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const png = createB3TestPng({ width: 1179, height: 2556 });
  const calls = [];
  const runner = async (executable, args) => {
    calls.push([executable, args]);
    if (executable === 'xcodebuild') {
      await mkdir(args[args.indexOf('-resultBundlePath') + 1], { recursive: true });
    }
    if (args.slice(0, 3).join(' ') === 'xcresulttool export attachments') {
      const output = args[args.indexOf('--output-path') + 1];
      await mkdir(output, { recursive: true });
      await writeFile(join(output, 'attachment-1.png'), png);
      await writeFile(join(output, 'manifest.json'), JSON.stringify([{
        testIdentifier: 'B3ProofUITests/B3ProofScreenshotTests/testCaptureInstalledApplication()',
        attachments: [{
          exportedFileName: 'attachment-1.png',
          suggestedHumanReadableName: 'b3-ios-sandbox-proof.png',
          isAssociatedWithFailure: false,
          configurationName: 'Test Action',
          deviceName: 'James iPhone',
          deviceId: DEVICE_ID,
        }],
      }]));
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };

  assert.deepEqual(await captureB3IosScreenshotBytes({
    root,
    deviceId: DEVICE_ID,
    runner,
  }), png);
  assert.equal(calls[0][0], 'xcodebuild');
  assert.deepEqual(calls[0][1].slice(0, 6), [
    '-project', join(root, 'ios/App/App.xcodeproj'),
    '-scheme', 'B3ProofUITests',
    '-configuration', 'B3SandboxProof',
  ]);
  assert.ok(calls[0][1].includes(`id=${DEVICE_ID}`));
  assert.ok(calls[0][1].includes('-only-testing:B3ProofUITests/B3ProofScreenshotTests/testCaptureInstalledApplication'));
  assert.equal(calls[0][1].includes('B3SandboxProof'), true);
  assert.equal(calls[0][1].includes('App'), false);
  assert.deepEqual(calls[1][0], 'xcrun');
  assert.deepEqual(calls[1][1].slice(0, 3), ['xcresulttool', 'export', 'attachments']);
});

test('iOS screenshot capture rejects wrong attachment, device and path provenance', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-ios-screenshot-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const attachment of [
    {
      exportedFileName: '../outside.png',
      suggestedHumanReadableName: 'b3-ios-sandbox-proof.png',
      deviceId: DEVICE_ID,
    },
    {
      exportedFileName: 'attachment.png',
      suggestedHumanReadableName: 'operator-chosen.png',
      deviceId: DEVICE_ID,
    },
    {
      exportedFileName: 'attachment.png',
      suggestedHumanReadableName: 'b3-ios-sandbox-proof.png',
      deviceId: 'different-device',
    },
  ]) {
    const runner = async (_executable, args) => {
      if (args.includes('-resultBundlePath')) {
        await mkdir(args[args.indexOf('-resultBundlePath') + 1], { recursive: true });
      }
      if (args.slice(0, 3).join(' ') === 'xcresulttool export attachments') {
        const output = args[args.indexOf('--output-path') + 1];
        await mkdir(output, { recursive: true });
        await writeFile(join(output, 'attachment.png'), Buffer.alloc(33));
        await writeFile(join(output, 'manifest.json'), JSON.stringify([{
          testIdentifier: 'B3ProofUITests/B3ProofScreenshotTests/testCaptureInstalledApplication()',
          attachments: [{
            isAssociatedWithFailure: false,
            configurationName: 'Test Action',
            deviceName: 'iPhone',
            ...attachment,
          }],
        }]));
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    await assert.rejects(
      captureB3IosScreenshotBytes({ root, deviceId: DEVICE_ID, runner }),
      /attachment|device|path|manifest/i,
    );
  }
});

test('iOS screenshot capture fails closed before xcodebuild for invalid device IDs', async () => {
  await assert.rejects(
    captureB3IosScreenshotBytes({
      root: '/tmp',
      deviceId: 'id; open Calculator',
      runner: async () => assert.fail('runner must not execute'),
    }),
    /device identifier/i,
  );
});
