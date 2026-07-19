import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createB4IosXcodeTestArguments,
  measuredB4IosTextScale,
  selectB4IosRuntimeProfiles,
  validateB4IosLayoutDimensions,
} from '../scripts/prove-b4-ios.mjs';

const runtimePayload = {
  runtimes: [
    {
      identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-25-4',
      name: 'iOS 25.4',
      version: '25.4',
      buildversion: 'old',
      isAvailable: true,
      supportedDeviceTypes: [
        { identifier: 'phone-old', name: 'iPhone Old', productFamily: 'iPhone' },
        { identifier: 'tablet-old', name: 'iPad Old', productFamily: 'iPad' },
      ],
    },
    {
      identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
      name: 'iOS 26.5',
      version: '26.5',
      buildversion: '23F73',
      isAvailable: true,
      supportedDeviceTypes: [
        { identifier: 'phone-fallback', name: 'iPhone 16', productFamily: 'iPhone' },
        { identifier: 'phone-17', name: 'iPhone 17', productFamily: 'iPhone' },
        { identifier: 'tablet-fallback', name: 'iPad Air', productFamily: 'iPad' },
        { identifier: 'tablet-a16', name: 'iPad (A16)', productFamily: 'iPad' },
      ],
    },
  ],
};

test('the iOS runner selects one current owned phone and tablet profile', () => {
  assert.deepEqual(selectB4IosRuntimeProfiles(runtimePayload), {
    runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    runtimeLabel: 'iOS 26.5 26.5 (23F73)',
    phoneTypeIdentifier: 'phone-17',
    phoneTypeName: 'iPhone 17',
    tabletTypeIdentifier: 'tablet-a16',
    tabletTypeName: 'iPad (A16)',
  });
});

test('the iOS runner invokes only the owned B4 test method against an exact result bundle', () => {
  const args = createB4IosXcodeTestArguments({
    udid: 'phone-udid',
    resultPath: '/tmp/result.xcresult',
    testMethod: 'testInstalledFiveCardJourney',
  });
  assert.deepEqual(args.slice(-5), [
    '-resultBundlePath',
    '/tmp/result.xcresult',
    '-only-testing:B3ProofUITests/B4DevelopmentTests/testInstalledFiveCardJourney',
    'CODE_SIGNING_ALLOWED=NO',
    'test',
  ]);
  assert.match(args.join(' '), /B4DevelopmentUITests/u);
  assert.match(args.join(' '), /platform=iOS Simulator,id=phone-udid/u);
});

test('the iOS runner rejects a portrait framebuffer relabelled as landscape', () => {
  assert.throws(
    () => validateB4IosLayoutDimensions({
      portrait: { width: 1640, height: 2360 },
      landscape: { width: 1640, height: 2360 },
    }),
    (error) => error?.code === 'b4_ios_layout_orientation_invalid',
  );
  assert.deepEqual(validateB4IosLayoutDimensions({
    portrait: { width: 1640, height: 2360 },
    landscape: { width: 2360, height: 1640 },
  }), {
    portrait: { width: 1640, height: 2360 },
    landscape: { width: 2360, height: 1640 },
  });
});

test('the iOS runner accepts only a measured 200% text-size journey', () => {
  assert.equal(measuredB4IosTextScale({
    defaultHeightPoints: 20,
    scaledHeightPoints: 40,
  }), 2);
  assert.throws(
    () => measuredB4IosTextScale({
      defaultHeightPoints: 20,
      scaledHeightPoints: 39.5,
    }),
    (error) => error?.code === 'b4_ios_text_scale_invalid',
  );
  assert.throws(
    () => measuredB4IosTextScale({
      defaultHeightPoints: 0,
      scaledHeightPoints: 40,
    }),
    (error) => error?.code === 'b4_ios_text_scale_invalid',
  );
});

test('the bounded runner records 200% layout, raw sizes and honest Simulator limits', async () => {
  const [source, packageJson] = await Promise.all([
    readFile(new URL('../scripts/prove-b4-ios.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ]);
  for (const required of [
    'accessibility-extra-extra-extra-large',
    'measuredTextScale',
    'nativePayloadBytes',
    'localDatabaseBytes',
    'virtual-development-risk-observation',
    'Simulator only; not physical-device, signed-distribution or App Store evidence.',
    "connect-src 'none'",
    "clientTts: 'none'",
    'KS2 Spelling B4 Scaled Phone',
    'scaledPhoneUdid',
    'for (const udid of ownedSimulatorUdids)',
    "'--rotate', '-90'",
    'after landscape scene validation',
  ]) {
    assert.match(source, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(packageJson, /"prove:b4:ios":\s*"node scripts\/prove-b4-ios\.mjs"/u);
});
