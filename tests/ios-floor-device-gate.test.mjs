import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  ASC_AUTH_ENV_NAMES,
  ASC_XCODEBUILD_FLAGS,
  COMMITTED_PHYSICAL_PROOF_RELATIVE,
  EXPECTED_IPHONEOS_DEPLOYMENT_TARGET_COUNT,
  FLOOR_DEVICES,
  FRAME_RATE_RISK_SURFACES,
  IPHONEOS_DEPLOYMENT_TARGET,
  OWNER_IPHONE_ARTEFACT_MODEL,
  PHYSICAL_FLOOR_COMPARATOR_SPECS,
  assertIphoneosDeploymentTargetFloor,
  classifyPhysicalDeviceReport,
  collectIphoneosDeploymentTargets,
  countProductCssFeatureUses,
  evaluateFloorDeviceMatrix,
  evaluatePhysicalFloorComparators,
  floorDeviceModelNames,
  hasRecordedFloorComparators,
  insertAllowProvisioningAuthenticationArguments,
  isHistoricalOwnerIphonePhysicalProof,
  matchFloorDevice,
  resolveAscAuthenticationArguments,
  unmeasuredFrameRateCapture,
  unmeasuredMemoryCapture,
  withOwnerForwardedAscAuthentication,
} from '../scripts/lib/ios-floor-device-gate.mjs';
import {
  createPhysicalXcodeBuildArguments,
  createPhysicalXcodeTestArguments,
} from '../scripts/prove-b4-ios-physical.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PBX_RELATIVE = 'ios/App/App.xcodeproj/project.pbxproj';
const GATE_LIB_RELATIVE = 'scripts/lib/ios-floor-device-gate.mjs';
const PHYSICAL_SCRIPT_RELATIVE = 'scripts/prove-b4-ios-physical.mjs';
const RELEASE_GATE_RELATIVE = 'docs/compliance/release-gate.md';
const VISUAL_AUTHORITY_RELATIVE = 'docs/product/v2-visual-authority.md';
const RUNBOOK_RELATIVE = 'docs/operations/2026-08-21-floor-device-gate-runbook.md';
const NATIVE_DEV_RELATIVE = 'docs/operations/native-development.md';
const CONCEPTS_RELATIVE = 'CONCEPTS.md';
const SWIFT_UITEST_RELATIVE = 'ios/App/B3ProofUITests/B4DevelopmentTests.swift';
const PRODUCT_APP_RELATIVE = 'src/app/ProductApp.jsx';

const COMPLETE_ASC_ENV = Object.freeze({
  KS2_ASC_KEY_ID: 'TESTKEYID1',
  KS2_ASC_ISSUER_ID: '00000000-0000-0000-0000-000000000000',
  KS2_ASC_KEY_PATH: '/tmp/owner-visible/AuthKey_TESTKEYID1.p8',
});

const FORBIDDEN_ASC_SOURCE = Object.freeze([
  'resolveAscPrivateKey',
  'DEFAULT_ASC_KEY_ID',
  '.appstoreconnect/private_keys',
  'security find-identity',
  'security find-certificate',
  'login.keychain',
  'getpass',
  'readlineSync',
]);


function assertTracked(relative) {
  execFileSync('git', ['ls-files', '--error-unmatch', '--', relative], { cwd: ROOT });
}

async function readUtf8(relative) {
  return readFile(join(ROOT, relative), 'utf8');
}

async function collectProductCss() {
  const files = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.name.endsWith('.css')) {
        files.push(path);
      }
    }
  }
  await walk(join(ROOT, 'src/app'));
  return files.sort();
}

test('every PBX IPHONEOS_DEPLOYMENT_TARGET is 26.0 and the count is exact', async () => {
  assertTracked(PBX_RELATIVE);
  assertTracked('ios/App/CapApp-SPM/Package.swift');
  const packageSwift = await readUtf8('ios/App/CapApp-SPM/Package.swift');
  assert.match(packageSwift, /swift-tools-version: 5\.9/);
  assert.match(packageSwift, /platforms: \[\.iOS\(\.v26\)\]/);
  assert.doesNotMatch(packageSwift, /\.iOS\(\.v15\)/);
  const project = await readUtf8(PBX_RELATIVE);
  const values = collectIphoneosDeploymentTargets(project);
  assert.deepEqual(
    [...new Set(values)],
    [IPHONEOS_DEPLOYMENT_TARGET],
    'PBX must not retain a mixed deployment-target set',
  );
  assert.equal(values.length, EXPECTED_IPHONEOS_DEPLOYMENT_TARGET_COUNT);
  assert.deepEqual(
    assertIphoneosDeploymentTargetFloor(project),
    { count: EXPECTED_IPHONEOS_DEPLOYMENT_TARGET_COUNT, value: '26.0' },
  );
  assert.equal(project.includes('IPHONEOS_DEPLOYMENT_TARGET = 15.0;'), false);
});

test('a single reverted PBX deployment target fails the floor assertion', async () => {
  const project = await readUtf8(PBX_RELATIVE);
  const mutated = project.replace(
    'IPHONEOS_DEPLOYMENT_TARGET = 26.0;',
    'IPHONEOS_DEPLOYMENT_TARGET = 15.0;',
  );
  assert.notEqual(mutated, project);
  assert.equal(
    collectIphoneosDeploymentTargets(mutated).filter((value) => value === '15.0').length,
    1,
  );
  assert.throws(
    () => assertIphoneosDeploymentTargetFloor(mutated),
    (error) => error?.code === 'ios_deployment_target_value_invalid',
  );
});

test('the exact floor-device matrix is iPhone SE 2nd gen and iPad 8th gen', () => {
  assert.deepEqual(floorDeviceModelNames(), [
    'iPhone SE (2nd generation)',
    'iPad (8th generation)',
  ]);
  assert.equal(FLOOR_DEVICES.length, 2);
  assert.equal(matchFloorDevice('iPhone SE (2nd generation)')?.silicon, 'A13');
  assert.equal(matchFloorDevice('iPhone SE (2nd generation)')?.notch, false);
  assert.equal(matchFloorDevice('iPad (8th generation)')?.silicon, 'A12');
  assert.equal(matchFloorDevice('iPad (8th generation)')?.colourSpace, 'sRGB');
  assert.equal(matchFloorDevice(OWNER_IPHONE_ARTEFACT_MODEL), null);
  assert.equal(matchFloorDevice('iPhone 16 Pro Max'), null);
});

test('the committed physical proof is the owner-iPhone artefact and not the floor matrix', async () => {
  assertTracked(COMMITTED_PHYSICAL_PROOF_RELATIVE);
  const report = JSON.parse(await readUtf8(COMMITTED_PHYSICAL_PROOF_RELATIVE));
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.runner.reality, 'physical');
  assert.equal(report.runner.deviceModel, OWNER_IPHONE_ARTEFACT_MODEL);
  assert.equal(report.runner.deviceOsVersion, '27.0');
  assert.equal(isHistoricalOwnerIphonePhysicalProof(report), true);
  assert.equal(hasRecordedFloorComparators(report.comparators), false);
  const classification = classifyPhysicalDeviceReport(report);
  assert.equal(classification.kind, 'non-floor-physical');
  assert.equal(classification.ownerIphoneArtefact, true);
  assert.deepEqual(evaluateFloorDeviceMatrix([report]), {
    complete: false,
    matchedIds: [],
    missing: ['iPhone SE (2nd generation)', 'iPad (8th generation)'],
  });
});

test('rewriting the committed proof model to one floor device still leaves the matrix incomplete', async () => {
  const report = JSON.parse(await readUtf8(COMMITTED_PHYSICAL_PROOF_RELATIVE));
  const fakeSe2 = {
    ...report,
    runner: { ...report.runner, deviceModel: 'iPhone SE (2nd generation)' },
  };
  assert.equal(classifyPhysicalDeviceReport(fakeSe2).kind, 'floor-device');
  assert.deepEqual(evaluateFloorDeviceMatrix([fakeSe2]).missing, [
    'iPad (8th generation)',
  ]);
  assert.equal(evaluateFloorDeviceMatrix([fakeSe2]).complete, false);
});

test('floor-device TTI, frame-rate and memory specs stay unnamed by #141/#152 thresholds', () => {
  assert.deepEqual(FRAME_RATE_RISK_SURFACES, [
    'codexZoomMonsterStage',
    'celebrationTier',
    'ambientBackdropPan',
  ]);
  assert.equal(PHYSICAL_FLOOR_COMPARATOR_SPECS.coldLaunch.threshold, 2_000);
  assert.equal(PHYSICAL_FLOOR_COMPARATOR_SPECS.timeToInteractive.threshold, null);
  assert.equal(PHYSICAL_FLOOR_COMPARATOR_SPECS.timeToInteractive.thresholdStatus, 'pending-owner-adjudication');
  assert.equal(PHYSICAL_FLOOR_COMPARATOR_SPECS.frameRate.threshold, null);
  assert.equal(PHYSICAL_FLOOR_COMPARATOR_SPECS.frameRate.questionCardDroppedFramesMustBeZero, true);
  assert.equal(PHYSICAL_FLOOR_COMPARATOR_SPECS.memory.threshold, null);
  const unmeasured = evaluatePhysicalFloorComparators({
    coldLaunchMs: 1_000,
    answerFeedbackMs: 40,
    sqliteTransactionUpperBoundMs: 20,
    audioStartMs: 100,
    timeToInteractiveMs: 1_200,
    frameRate: unmeasuredFrameRateCapture(),
    memory: unmeasuredMemoryCapture(),
  });
  assert.equal(unmeasured.timeToInteractive.recorded, true);
  assert.equal(unmeasured.timeToInteractive.within, false);
  assert.equal(unmeasured.frameRate.recorded, false);
  assert.equal(unmeasured.frameRate.within, false);
  assert.equal(unmeasured.memory.recorded, false);
  assert.equal(hasRecordedFloorComparators(unmeasured), false);
});

test('the UITest records time-to-interactive and does not fabricate frame-rate or memory numbers', async () => {
  assertTracked(SWIFT_UITEST_RELATIVE);
  const swift = await readUtf8(SWIFT_UITEST_RELATIVE);
  assert.match(swift, /let timeToInteractiveMs: Double/);
  assert.match(swift, /let timeToInteractiveMs = elapsedMilliseconds\(since: coldLaunchStart\)/);
  assert.match(swift, /timeToInteractiveMs: timeToInteractiveMs/);
  assert.doesNotMatch(swift, /questionCardDroppedFrames/);
  assert.doesNotMatch(swift, /peakMemoryBytes|peakBytes/);
  assert.doesNotMatch(swift, /observedFps/);
});

test('question-card source keeps canvas and celebration stages off the answer path', async () => {
  assertTracked(PRODUCT_APP_RELATIVE);
  assertTracked(VISUAL_AUTHORITY_RELATIVE);
  const [productApp, visualAuthority] = await Promise.all([
    readUtf8(PRODUCT_APP_RELATIVE),
    readUtf8(VISUAL_AUTHORITY_RELATIVE),
  ]);
  assert.match(visualAuthority, /A canvas never appears during a question card/);
  assert.match(visualAuthority, /Celebrations never\s+appear during a question card/);
  assert.match(
    productApp,
    /Phaser \+ the living Monster Stage load only when a caught codex entry is\n\/\/ opened for a closer look/,
  );
  assert.match(productApp, /\{zoomed && hero\?\.found && \(/);
  assert.match(
    productApp,
    /if \(previousScreen !== 'summary' && next\.screen === 'summary'\)/,
  );
  assert.match(
    productApp,
    /void import\('\.\/celebrations\/CelebrationStage\.jsx'\)/,
  );
});

test('only both exact floor devices complete the matrix, and iPhone 16 Pro Max never counts', () => {
  const se2 = {
    runner: { reality: 'physical', deviceModel: 'iPhone SE (2nd generation)' },
  };
  const ipad8 = {
    runner: { reality: 'physical', deviceModel: 'iPad (8th generation)' },
  };
  const ownerPhone = {
    runner: { reality: 'physical', deviceModel: OWNER_IPHONE_ARTEFACT_MODEL },
  };
  assert.deepEqual(evaluateFloorDeviceMatrix([se2, ipad8]), {
    complete: true,
    matchedIds: ['iphone-se-2', 'ipad-8'],
    missing: [],
  });
  assert.equal(evaluateFloorDeviceMatrix([se2, ownerPhone]).complete, false);
  assert.equal(evaluateFloorDeviceMatrix([ipad8, ownerPhone]).complete, false);
  assert.equal(
    classifyPhysicalDeviceReport({ runner: { reality: 'simulator', deviceModel: 'iPhone SE (2nd generation)' } }).kind,
    'not-physical',
  );
});

test('owner-controlled ASC auth is forwarded as xcodebuild flags or omitted, never completed from a hidden source', () => {
  assert.deepEqual(resolveAscAuthenticationArguments({}), {
    forwarded: false,
    arguments: [],
  });
  assert.deepEqual(resolveAscAuthenticationArguments(COMPLETE_ASC_ENV), {
    forwarded: true,
    arguments: [
      '-authenticationKeyID',
      COMPLETE_ASC_ENV.KS2_ASC_KEY_ID,
      '-authenticationKeyIssuerID',
      COMPLETE_ASC_ENV.KS2_ASC_ISSUER_ID,
      '-authenticationKeyPath',
      COMPLETE_ASC_ENV.KS2_ASC_KEY_PATH,
    ],
  });
  assert.throws(
    () => resolveAscAuthenticationArguments({ KS2_ASC_KEY_ID: 'ONLYONE' }),
    (error) => error?.code === 'b4_ios_physical_asc_auth_incomplete'
      && /KS2_ASC_ISSUER_ID/.test(error.message)
      && /KS2_ASC_KEY_PATH/.test(error.message)
      && /does not read the keychain/.test(error.message),
  );
  const inserted = withOwnerForwardedAscAuthentication(
    ['-allowProvisioningUpdates', 'build'],
    COMPLETE_ASC_ENV,
  );
  assert.deepEqual(inserted.slice(0, 7), [
    '-allowProvisioningUpdates',
    '-authenticationKeyID',
    COMPLETE_ASC_ENV.KS2_ASC_KEY_ID,
    '-authenticationKeyIssuerID',
    COMPLETE_ASC_ENV.KS2_ASC_ISSUER_ID,
    '-authenticationKeyPath',
    COMPLETE_ASC_ENV.KS2_ASC_KEY_PATH,
  ]);
});

test('removing ASC flag insertion from an xcodebuild argv fails the source helper', () => {
  assert.throws(
    () => insertAllowProvisioningAuthenticationArguments(
      ['-project', 'ios/App/App.xcodeproj', 'test'],
      ['-authenticationKeyID', 'x'],
    ),
    (error) => error?.code === 'b4_ios_physical_allow_provisioning_missing',
  );
});

test('physical xcodebuild argv forwards owner ASC auth next to -allowProvisioningUpdates', () => {
  const testArgs = createPhysicalXcodeTestArguments({
    udid: 'DEVICE-UDID',
    resultPath: '/tmp/result.xcresult',
    testMethod: 'testInstalledFiveCardJourney',
    keychain: '/tmp/does-not-read-this.keychain-db',
    env: COMPLETE_ASC_ENV,
  });
  const allowIndex = testArgs.indexOf('-allowProvisioningUpdates');
  assert.notEqual(allowIndex, -1);
  assert.equal(testArgs[allowIndex + 1], '-authenticationKeyID');
  assert.equal(testArgs[allowIndex + 2], COMPLETE_ASC_ENV.KS2_ASC_KEY_ID);
  assert.equal(testArgs[allowIndex + 3], '-authenticationKeyIssuerID');
  assert.equal(testArgs[allowIndex + 5], '-authenticationKeyPath');
  assert.equal(testArgs[allowIndex + 6], COMPLETE_ASC_ENV.KS2_ASC_KEY_PATH);

  const buildArgs = createPhysicalXcodeBuildArguments({
    keychain: '/tmp/does-not-read-this.keychain-db',
    env: {},
  });
  assert.equal(buildArgs.includes('-allowProvisioningUpdates'), true);
  assert.equal(buildArgs.includes('-authenticationKeyID'), false);
  assert.equal(buildArgs.includes('-authenticationKeyPath'), false);
});

test('ASC auth-forwarding source never reads keychain, certificates, profiles or hidden prompts', async () => {
  const [gateSource, physicalSource] = await Promise.all([
    readUtf8(GATE_LIB_RELATIVE),
    readUtf8(PHYSICAL_SCRIPT_RELATIVE),
  ]);
  assertTracked(GATE_LIB_RELATIVE);
  assertTracked(PHYSICAL_SCRIPT_RELATIVE);
  for (const name of ASC_AUTH_ENV_NAMES) {
    assert.match(gateSource, new RegExp(name));
  }
  for (const flag of Object.values(ASC_XCODEBUILD_FLAGS)) {
    assert.match(gateSource, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
  }
  assert.match(physicalSource, /withOwnerForwardedAscAuthentication/);
  assert.match(physicalSource, /createPhysicalXcodeBuildArguments/);
  assert.match(physicalSource, /createPhysicalXcodeTestArguments/);
  for (const fragment of FORBIDDEN_ASC_SOURCE) {
    assert.equal(
      gateSource.includes(fragment),
      false,
      `floor-device gate source must not contain ${fragment}`,
    );
    if (fragment !== 'login.keychain') {
      assert.equal(
        physicalSource.includes(fragment),
        false,
        `physical proof source must not contain ${fragment}`,
      );
    }
  }
  assert.doesNotMatch(gateSource, /readFile|createReadStream|homedir\(/u);
  assert.doesNotMatch(physicalSource, /resolveAscPrivateKey|ASC_PRIVATE_KEY/u);
});

function extractAtSupportsBlocks(cssText) {
  const blocks = [];
  let searchFrom = 0;
  while (true) {
    const start = cssText.indexOf('@supports', searchFrom);
    if (start === -1) break;
    const open = cssText.indexOf('{', start);
    if (open === -1) break;
    let depth = 0;
    let end = open;
    for (; end < cssText.length; end += 1) {
      if (cssText[end] === '{') depth += 1;
      else if (cssText[end] === '}') {
        depth -= 1;
        if (depth === 0) {
          end += 1;
          break;
        }
      }
    }
    blocks.push(cssText.slice(start, end));
    searchFrom = end;
  }
  return blocks;
}

test('unguarded color-mix and text-wrap: balance remain, and iOS 26.0 is the fallback-removing floor', async () => {
  const cssFiles = await collectProductCss();
  const cssText = (await Promise.all(cssFiles.map((path) => readFile(path, 'utf8')))).join('\n');
  const counts = countProductCssFeatureUses(cssText);
  assert.equal(counts.colorMix, 38);
  assert.equal(counts.textWrapBalance, 4);
  assert.equal(counts.supportsBlocks, 1);
  const supportsBlocks = extractAtSupportsBlocks(cssText);
  assert.equal(supportsBlocks.length, 1);
  assert.match(supportsBlocks[0], /font: -apple-system-body/);
  assert.doesNotMatch(supportsBlocks[0], /color-mix\(/u);
  assert.doesNotMatch(supportsBlocks[0], /text-wrap:\s*balance/u);
  assert.equal(IPHONEOS_DEPLOYMENT_TARGET, '26.0');
});

test('release-gate, visual authority, runbook and concepts source pin the floor decision without fabricating evidence', async () => {
  const [releaseGate, visualAuthority, runbook, concepts, nativeDev] = await Promise.all([
    readUtf8(RELEASE_GATE_RELATIVE),
    readUtf8(VISUAL_AUTHORITY_RELATIVE),
    readUtf8(RUNBOOK_RELATIVE),
    readUtf8(CONCEPTS_RELATIVE),
    readUtf8(NATIVE_DEV_RELATIVE),
  ]);
  for (const relative of [
    RELEASE_GATE_RELATIVE,
    VISUAL_AUTHORITY_RELATIVE,
    RUNBOOK_RELATIVE,
    CONCEPTS_RELATIVE,
    NATIVE_DEV_RELATIVE,
  ]) {
    assertTracked(relative);
  }

  assert.match(releaseGate, /IPHONEOS_DEPLOYMENT_TARGET = 26\.0/);
  assert.match(releaseGate, /21% of active iPhones/);
  assert.match(releaseGate, /32% of active iPads/);
  assert.match(releaseGate, /reversible/);
  assert.match(releaseGate, /iPhone SE \(2nd generation\)/);
  assert.match(releaseGate, /iPad \(8th generation\)/);
  assert.doesNotMatch(releaseGate, /iPad \(7th gen/);
  assert.match(releaseGate, /owner-iPhone artefact/);
  assert.match(releaseGate, /iPhone 16 Pro Max/);
  assert.match(releaseGate, /pending-owner-adjudication/);
  assert.match(releaseGate, /time-to-interactive/);
  assert.match(releaseGate, /nothing may drop frames during a/);
  assert.doesNotMatch(releaseGate, /Status:\s*GREEN/i);

  assert.match(visualAuthority, /No meaning may depend on wide gamut or fine tonal separation/);
  assert.match(visualAuthority, /it must read on sRGB/);
  assert.match(visualAuthority, /Playable is enough/);
  assert.match(visualAuthority, /panel quality only/);

  assert.match(runbook, /KS2_ASC_KEY_ID/);
  assert.match(runbook, /KS2_ASC_ISSUER_ID/);
  assert.match(runbook, /KS2_ASC_KEY_PATH/);
  assert.match(runbook, /-authenticationKeyID/);
  assert.match(runbook, /Settings → Developer → UI Automation/);
  assert.match(runbook, /owner-gated/);
  assert.match(runbook, /unsigned Simulator build/);
  assert.match(runbook, /signed physical RC/);
  assert.match(runbook, /does not grant/);
  assert.match(runbook, /pending-owner-adjudication/);
  assert.match(runbook, /time-to-interactive/);
  assert.match(runbook, /nothing may drop them during a question card/);
  assert.match(runbook, /identifiers stay in the\s+#152 issue comment/);
  assert.match(runbook, /PackageDescription 6\.2/);
  assert.match(runbook, /experimental\.ios\.spm\.swiftToolsVersion/);
  assert.doesNotMatch(runbook, /iPad\s+`[0-9A-Z]{10}`/);
  assert.doesNotMatch(runbook, /SE 2\s+`[0-9A-Z]{10}`/);
  assert.doesNotMatch(runbook, /Status:\s*GREEN/i);
  assert.match(nativeDev, /2026-08-21-floor-device-gate-runbook/);

  assert.match(concepts, /### Geometry floor/);
  assert.match(concepts, /### Performance floor/);
  assert.match(concepts, /### Aesthetics judge/);
  assert.doesNotMatch(concepts, /#152|#150|GREEN/i);
});
