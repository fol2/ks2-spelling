import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  ASC_AUTH_ENV_NAMES,
  ASC_XCODEBUILD_FLAGS,
  CAPACITOR_SWIFT_TOOLS_VERSION,
  COMMITTED_PHYSICAL_PROOF_RELATIVE,
  EXPECTED_IPHONEOS_DEPLOYMENT_TARGET_COUNT,
  FLOOR_DEVICES,
  FLOOR_DEVICE_REPORT_RELATIVES,
  FRAME_RATE_RISK_SURFACES,
  IPHONEOS_DEPLOYMENT_TARGET,
  OWNER_IPHONE_ARTEFACT_MODEL,
  PHYSICAL_FLOOR_COMPARATOR_SPECS,
  PHYSICAL_FLOOR_REPORT_SCHEMA_VERSION,
  assertIphoneosDeploymentTargetFloor,
  assertSwiftPmFloorContract,
  classifyPhysicalDeviceReport,
  collectIphoneosDeploymentTargets,
  countProductCssFeatureUses,
  evaluateFloorDeviceMatrix,
  evaluatePhysicalFloorComparators,
  floorDeviceModelNames,
  hasRecordedFloorComparators,
  scorePhysicalFloorComparatorsFromEvidence,
  insertAllowProvisioningAuthenticationArguments,
  isHistoricalOwnerIphonePhysicalProof,
  matchFloorDevice,
  physicalFloorReportRelative,
  resolveAscAuthenticationArguments,
  unmeasuredFrameRateCapture,
  unmeasuredMemoryCapture,
  withOwnerForwardedAscAuthentication,
} from '../scripts/lib/ios-floor-device-gate.mjs';
import {
  assembleB4PhysicalReport,
  createPhysicalXcodeBuildArguments,
  createPhysicalXcodeTestArguments,
} from '../scripts/prove-b4-ios-physical.mjs';
import { EXIT_CODES } from '../scripts/lib/run-command.mjs';

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
const CAPACITOR_CONFIG_RELATIVE = 'capacitor.config.json';
const PACKAGE_SWIFT_RELATIVE = 'ios/App/CapApp-SPM/Package.swift';

const FLOOR_CHECKPOINT_A = Object.freeze({
  commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  tree: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
});
const FLOOR_CHECKPOINT_B = Object.freeze({
  commit: 'cccccccccccccccccccccccccccccccccccccccc',
  tree: 'dddddddddddddddddddddddddddddddddddddddd',
});

function recordedFrameRateCapture() {
  return {
    questionCardDroppedFrames: 0,
    riskSurfaces: {
      codexZoomMonsterStage: { observedFps: 60 },
      celebrationTier: { observedFps: 60 },
      ambientBackdropPan: { observedFps: 60 },
    },
  };
}

function validFloorReport(deviceModel, checkpoint = FLOOR_CHECKPOINT_A, overrides = {}) {
  const journey = (coldLaunchMs) => ({
    schemaVersion: 1,
    coldLaunchMs,
    timeToInteractiveMs: coldLaunchMs,
    answerFeedbackMs: Array(10).fill(40),
    audioStartMs: [200, 180],
    minimumControlHeightPoints: 49,
    referenceTextHeightPoints: 23,
    softwareKeyboardObserved: true,
    enterSubmitted: true,
    backgroundAudioStoppedCount: 2,
    resumeProgressBefore: 'Card 2 of 5',
    resumeProgressAfter: 'Card 2 of 5',
    completed: true,
  });
  return assembleB4PhysicalReport({
    journeyObservations: [journey(1_500), journey(1_600), journey(1_550)],
    splitCapture: {
      schemaVersion: 1,
      clock: 'Unix epoch milliseconds',
      observations: Array.from({ length: 10 }, (_, index) => ({
        answerIndex: index + 1,
        expectedRevision: 2 + (index * 2),
        submitEpochMs: 1_000 + index,
        audioPlayingVisibleEpochMs: -1,
        feedbackVisibleEpochMs: 1_100 + index,
        replayToAudioPlayingVisibleMs: 300 + index,
      })),
      completed: true,
    },
    isolatedSqliteMaxMs: 29.454,
    frameRate: recordedFrameRateCapture(),
    memory: { peakBytes: 80 * 1024 * 1024 },
    runner: {
      hostOS: 'macOS 27.0 (26A5378n)',
      xcodeVersion: '26.6 (17F109)',
      sdk: 'iphoneos26.5',
      deviceModel,
      deviceOsVersion: '26.1',
      buildConfiguration: 'Release',
      reality: 'physical',
    },
    applicationCheckpoint: checkpoint,
    ...overrides,
  });
}

function mutateComparators(report, mutate) {
  const clone = structuredClone(report);
  mutate(clone.comparators);
  return clone;
}

function booleanOnlyFloorReport(deviceModel, checkpoint = FLOOR_CHECKPOINT_A) {
  const booleanComparator = { recorded: true, within: true };
  return {
    schemaVersion: PHYSICAL_FLOOR_REPORT_SCHEMA_VERSION,
    platform: 'ios-physical',
    runner: {
      hostOS: 'macOS 27.0 (26A5378n)',
      xcodeVersion: '26.6 (17F109)',
      sdk: 'iphoneos26.5',
      deviceModel,
      deviceOsVersion: '26.1',
      buildConfiguration: 'Release',
      reality: 'physical',
    },
    applicationCheckpoint: checkpoint,
    comparators: {
      answerFeedback: { ...booleanComparator },
      audioStart: { ...booleanComparator },
      coldLaunch: { ...booleanComparator },
      frameRate: {
        recorded: true,
        within: true,
        questionCardDroppedFramesRecorded: true,
        questionCardDroppedFramesWithin: true,
        riskSurfaces: {
          codexZoomMonsterStage: { recorded: true },
          celebrationTier: { recorded: true },
          ambientBackdropPan: { recorded: true },
        },
      },
      memory: { ...booleanComparator },
      sqliteTransactionUpperBound: { ...booleanComparator },
      timeToInteractive: { ...booleanComparator },
    },
  };
}

function withCallerGreenBooleans(report) {
  return mutateComparators(report, (comparators) => {
    for (const comparator of Object.values(comparators)) {
      comparator.recorded = true;
      comparator.within = true;
    }
    comparators.frameRate.questionCardDroppedFramesRecorded = true;
    comparators.frameRate.questionCardDroppedFramesWithin = true;
    for (const surface of Object.values(comparators.frameRate.riskSurfaces)) {
      surface.recorded = true;
    }
  });
}

async function writeFloorFixtures(root, reportsById) {
  for (const [id, report] of Object.entries(reportsById)) {
    const relative = FLOOR_DEVICE_REPORT_RELATIVES[id];
    const path = join(root, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  }
}

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
  assertTracked(PACKAGE_SWIFT_RELATIVE);
  const packageSwift = await readUtf8(PACKAGE_SWIFT_RELATIVE);
  assert.match(packageSwift, /swift-tools-version: 6\.2/);
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

test('Capacitor SSOT pins SwiftPM tools 6.2 and generated Package.swift follows it', async () => {
  assertTracked(CAPACITOR_CONFIG_RELATIVE);
  assertTracked(PACKAGE_SWIFT_RELATIVE);
  assertTracked(PBX_RELATIVE);
  const [capacitorConfig, packageSwift, pbxprojText] = await Promise.all([
    readUtf8(CAPACITOR_CONFIG_RELATIVE).then((text) => JSON.parse(text)),
    readUtf8(PACKAGE_SWIFT_RELATIVE),
    readUtf8(PBX_RELATIVE),
  ]);
  assert.deepEqual(
    assertSwiftPmFloorContract({ capacitorConfig, packageSwift, pbxprojText }),
    { swiftToolsVersion: CAPACITOR_SWIFT_TOOLS_VERSION, iosVersion: '26' },
  );
  assert.equal(Object.hasOwn(capacitorConfig, 'server'), false);
  assert.equal(capacitorConfig.experimental.ios.spm.swiftToolsVersion, '6.2');

  const driftedConfig = structuredClone(capacitorConfig);
  driftedConfig.experimental.ios.spm.swiftToolsVersion = '5.9';
  assert.throws(
    () => assertSwiftPmFloorContract({
      capacitorConfig: driftedConfig,
      packageSwift,
      pbxprojText,
    }),
    (error) => error?.code === 'ios_swift_tools_version_invalid',
  );
  assert.throws(
    () => assertSwiftPmFloorContract({
      capacitorConfig,
      packageSwift: packageSwift.replace(
        'swift-tools-version: 6.2',
        'swift-tools-version: 5.9',
      ),
      pbxprojText,
    }),
    (error) => error?.code === 'ios_swiftpm_tools_version_drift',
  );
  assert.throws(
    () => assertSwiftPmFloorContract({
      capacitorConfig,
      packageSwift: packageSwift.replace('.iOS(.v26)', '.iOS(.v15)'),
      pbxprojText,
    }),
    (error) => error?.code === 'ios_swiftpm_platform_drift',
  );
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
    green: false,
    checkpointMismatch: false,
    matchedIds: [],
    missing: ['iPhone SE (2nd generation)', 'iPad (8th generation)'],
    invalid: [],
  });
  for (const relative of Object.values(FLOOR_DEVICE_REPORT_RELATIVES)) {
    assert.equal(existsSync(join(ROOT, relative)), false);
  }
});

test('rewriting the committed proof model to one floor device still leaves the matrix incomplete', async () => {
  const report = JSON.parse(await readUtf8(COMMITTED_PHYSICAL_PROOF_RELATIVE));
  const fakeSe2 = {
    ...report,
    runner: { ...report.runner, deviceModel: 'iPhone SE (2nd generation)' },
  };
  assert.equal(classifyPhysicalDeviceReport(fakeSe2).kind, 'floor-device');
  const evaluation = evaluateFloorDeviceMatrix([fakeSe2]);
  assert.equal(evaluation.complete, false);
  assert.equal(evaluation.green, false);
  assert.deepEqual(evaluation.missing, [
    'iPhone SE (2nd generation)',
    'iPad (8th generation)',
  ]);
  assert.deepEqual(evaluation.invalid, ['iPhone SE (2nd generation)']);
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

test('two minimal floor runners do not complete the matrix', () => {
  const se2 = {
    runner: { reality: 'physical', deviceModel: 'iPhone SE (2nd generation)' },
  };
  const ipad8 = {
    runner: { reality: 'physical', deviceModel: 'iPad (8th generation)' },
  };
  const ownerPhone = {
    runner: { reality: 'physical', deviceModel: OWNER_IPHONE_ARTEFACT_MODEL },
  };
  const evaluation = evaluateFloorDeviceMatrix([se2, ipad8]);
  assert.equal(evaluation.complete, false);
  assert.equal(evaluation.green, false);
  assert.deepEqual(evaluation.matchedIds, []);
  assert.deepEqual(evaluation.missing, [
    'iPhone SE (2nd generation)',
    'iPad (8th generation)',
  ]);
  assert.deepEqual(evaluation.invalid, [
    'iPhone SE (2nd generation)',
    'iPad (8th generation)',
  ]);
  assert.equal(evaluateFloorDeviceMatrix([se2, ownerPhone]).complete, false);
  assert.equal(evaluateFloorDeviceMatrix([ipad8, ownerPhone]).complete, false);
  assert.equal(
    classifyPhysicalDeviceReport({ runner: { reality: 'simulator', deviceModel: 'iPhone SE (2nd generation)' } }).kind,
    'not-physical',
  );
});

test('schema-v2 floor reports with unmeasured fps and memory stay incomplete', () => {
  const se2 = validFloorReport('iPhone SE (2nd generation)', FLOOR_CHECKPOINT_A, {
    frameRate: unmeasuredFrameRateCapture(),
    memory: unmeasuredMemoryCapture(),
  });
  const ipad8 = validFloorReport('iPad (8th generation)', FLOOR_CHECKPOINT_A, {
    frameRate: unmeasuredFrameRateCapture(),
    memory: unmeasuredMemoryCapture(),
  });
  const evaluation = evaluateFloorDeviceMatrix([se2, ipad8]);
  assert.equal(se2.schemaVersion, PHYSICAL_FLOOR_REPORT_SCHEMA_VERSION);
  assert.equal(evaluation.complete, false);
  assert.equal(evaluation.green, false);
  assert.deepEqual(evaluation.invalid, [
    'iPhone SE (2nd generation)',
    'iPad (8th generation)',
  ]);
});

test('same-checkpoint recorded floor reports complete the matrix but stay not GREEN', () => {
  const se2 = validFloorReport('iPhone SE (2nd generation)', FLOOR_CHECKPOINT_A);
  const ipad8 = validFloorReport('iPad (8th generation)', FLOOR_CHECKPOINT_A);
  const evaluation = evaluateFloorDeviceMatrix([se2, ipad8]);
  assert.equal(evaluation.complete, true);
  assert.equal(evaluation.green, false);
  assert.equal(evaluation.checkpointMismatch, false);
  assert.deepEqual(evaluation.matchedIds, ['iphone-se-2', 'ipad-8']);
  assert.deepEqual(evaluation.missing, []);
  assert.deepEqual(evaluation.invalid, []);
});

test('mixed applicationCheckpoint identities fail the two-device matrix', () => {
  const se2 = validFloorReport('iPhone SE (2nd generation)', FLOOR_CHECKPOINT_A);
  const ipad8 = validFloorReport('iPad (8th generation)', FLOOR_CHECKPOINT_B);
  const evaluation = evaluateFloorDeviceMatrix([se2, ipad8]);
  assert.equal(hasRecordedFloorComparators(se2.comparators), true);
  assert.equal(hasRecordedFloorComparators(ipad8.comparators), true);
  assert.notEqual(se2.applicationCheckpoint.commit, ipad8.applicationCheckpoint.commit);
  assert.equal(evaluation.complete, false);
  assert.equal(evaluation.green, false);
  assert.equal(evaluation.checkpointMismatch, true);
  assert.deepEqual(evaluation.matchedIds, ['iphone-se-2', 'ipad-8']);
  assert.deepEqual(evaluation.missing, []);
});

test('canonical comparators recompute from observations rather than stored booleans', () => {
  const se2 = validFloorReport('iPhone SE (2nd generation)');
  assert.deepEqual(
    scorePhysicalFloorComparatorsFromEvidence(se2.comparators),
    se2.comparators,
  );
});

test('boolean-only recorded/within comparators do not complete or GREEN the matrix', () => {
  const se2 = booleanOnlyFloorReport('iPhone SE (2nd generation)');
  const ipad8 = booleanOnlyFloorReport('iPad (8th generation)');
  assert.equal(hasRecordedFloorComparators(se2.comparators), false);
  assert.equal(hasRecordedFloorComparators(ipad8.comparators), false);
  const evaluation = evaluateFloorDeviceMatrix([se2, ipad8]);
  assert.equal(evaluation.complete, false);
  assert.equal(evaluation.green, false);
  assert.deepEqual(evaluation.invalid, [
    'iPhone SE (2nd generation)',
    'iPad (8th generation)',
  ]);
});

test('NaN, wrong unit and caller-supplied GREEN booleans fail closed', () => {
  const se2 = validFloorReport('iPhone SE (2nd generation)');
  const ipad8 = validFloorReport('iPad (8th generation)');

  const nanEvaluation = evaluateFloorDeviceMatrix([
    mutateComparators(se2, (comparators) => {
      comparators.coldLaunch.observedMs = Number.NaN;
    }),
    mutateComparators(ipad8, (comparators) => {
      comparators.memory.observedBytes = Number.POSITIVE_INFINITY;
    }),
  ]);
  assert.equal(nanEvaluation.complete, false);
  assert.equal(nanEvaluation.green, false);
  assert.deepEqual(nanEvaluation.invalid, [
    'iPhone SE (2nd generation)',
    'iPad (8th generation)',
  ]);

  const wrongUnitEvaluation = evaluateFloorDeviceMatrix([
    mutateComparators(se2, (comparators) => {
      comparators.coldLaunch.unit = 's';
    }),
    mutateComparators(ipad8, (comparators) => {
      comparators.answerFeedback.observedMs = '40';
    }),
  ]);
  assert.equal(wrongUnitEvaluation.complete, false);
  assert.equal(wrongUnitEvaluation.green, false);
  assert.deepEqual(wrongUnitEvaluation.invalid, [
    'iPhone SE (2nd generation)',
    'iPad (8th generation)',
  ]);

  const lying = evaluateFloorDeviceMatrix([
    withCallerGreenBooleans(se2),
    withCallerGreenBooleans(ipad8),
  ]);
  assert.equal(lying.complete, true);
  assert.equal(lying.green, false);
});

test('physical proof source writes distinct floor reports and never the owner-iPhone artefact', async () => {
  const source = await readUtf8(PHYSICAL_SCRIPT_RELATIVE);
  assert.match(source, /physicalFloorReportRelative/);
  assert.match(source, /b4_ios_physical_floor_device_unrecognised/);
  assert.match(source, /checkFloorDeviceMatrix/);
  assert.match(source, /matrixComplete: matrix\.complete/);
  assert.doesNotMatch(source, /matrixComplete:\s*true/);
  assert.doesNotMatch(
    source,
    /writeFile\(OUTPUT_PATH|writeFile\(join\(ROOT, COMMITTED_PHYSICAL_PROOF_RELATIVE\)/,
  );
  assert.equal(
    physicalFloorReportRelative('iPhone SE (2nd generation)'),
    'reports/b4-physical/ios-floor-iphone-se-2.json',
  );
  assert.equal(
    physicalFloorReportRelative('iPad (8th generation)'),
    'reports/b4-physical/ios-floor-ipad-8.json',
  );
  assert.equal(physicalFloorReportRelative(OWNER_IPHONE_ARTEFACT_MODEL), null);
});

function runFloorMatrixCheckCli(reportsRoot) {
  return spawnSync(
    process.execPath,
    [
      join(ROOT, 'scripts/prove-b4-ios-physical.mjs'),
      '--check-floor-matrix',
      '--reports-root',
      reportsRoot,
    ],
    { encoding: 'utf8', cwd: ROOT },
  );
}

function parseFloorMatrixCliPayload(result) {
  const text = `${result.stderr || ''}${result.stdout || ''}`;
  const start = text.indexOf('{');
  assert.notEqual(start, -1, `floor-matrix CLI emitted no JSON: ${text}`);
  return JSON.parse(text.slice(start));
}

test('the floor-matrix CLI fails closed on missing, null-comparator and mixed-checkpoint files', async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'ks2-floor-matrix-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const missingRun = runFloorMatrixCheckCli(tempRoot);
  assert.equal(missingRun.status, EXIT_CODES.stateMismatch);
  const missing = parseFloorMatrixCliPayload(missingRun);
  assert.equal(missing.ok, false);
  assert.equal(missing.complete, false);
  assert.equal(missing.green, false);
  assert.equal(missing.code, 'b4_ios_floor_matrix_incomplete');
  assert.deepEqual(missing.missingFiles, [
    'reports/b4-physical/ios-floor-iphone-se-2.json',
    'reports/b4-physical/ios-floor-ipad-8.json',
  ]);

  await writeFloorFixtures(tempRoot, {
    'iphone-se-2': validFloorReport('iPhone SE (2nd generation)', FLOOR_CHECKPOINT_A, {
      frameRate: unmeasuredFrameRateCapture(),
      memory: unmeasuredMemoryCapture(),
    }),
    'ipad-8': validFloorReport('iPad (8th generation)', FLOOR_CHECKPOINT_A, {
      frameRate: unmeasuredFrameRateCapture(),
      memory: unmeasuredMemoryCapture(),
    }),
  });
  const unmeasuredRun = runFloorMatrixCheckCli(tempRoot);
  assert.equal(unmeasuredRun.status, EXIT_CODES.stateMismatch);
  const unmeasured = parseFloorMatrixCliPayload(unmeasuredRun);
  assert.equal(unmeasured.complete, false);
  assert.equal(unmeasured.green, false);
  assert.equal(unmeasured.missingFiles.length, 0);
  assert.deepEqual(unmeasured.invalid, [
    'iPhone SE (2nd generation)',
    'iPad (8th generation)',
  ]);

  await writeFloorFixtures(tempRoot, {
    'iphone-se-2': validFloorReport('iPhone SE (2nd generation)', FLOOR_CHECKPOINT_A),
    'ipad-8': validFloorReport('iPad (8th generation)', FLOOR_CHECKPOINT_B),
  });
  const mixedRun = runFloorMatrixCheckCli(tempRoot);
  assert.equal(mixedRun.status, EXIT_CODES.stateMismatch);
  const mixed = parseFloorMatrixCliPayload(mixedRun);
  assert.equal(mixed.complete, false);
  assert.equal(mixed.green, false);
  assert.equal(mixed.checkpointMismatch, true);
  assert.equal(mixed.code, 'b4_ios_floor_matrix_incomplete');
});

test('the floor-matrix CLI reads both files and stays not GREEN while thresholds are pending', async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'ks2-floor-matrix-complete-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  await writeFloorFixtures(tempRoot, {
    'iphone-se-2': validFloorReport('iPhone SE (2nd generation)', FLOOR_CHECKPOINT_A),
    'ipad-8': validFloorReport('iPad (8th generation)', FLOOR_CHECKPOINT_A),
  });
  const run = runFloorMatrixCheckCli(tempRoot);
  assert.equal(run.status, EXIT_CODES.success);
  const result = parseFloorMatrixCliPayload(run);
  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.equal(result.green, false);
  assert.equal(result.code, 'b4_ios_floor_matrix_complete_pending_thresholds');
  assert.equal(result.checkpointMismatch, false);
});

test('the floor-matrix CLI fails closed on boolean-only, wrong-unit and non-finite JSON files', async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'ks2-floor-matrix-hostile-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  await writeFloorFixtures(tempRoot, {
    'iphone-se-2': booleanOnlyFloorReport('iPhone SE (2nd generation)'),
    'ipad-8': booleanOnlyFloorReport('iPad (8th generation)'),
  });
  const booleanRun = runFloorMatrixCheckCli(tempRoot);
  assert.equal(booleanRun.status, EXIT_CODES.stateMismatch);
  const booleanOnly = parseFloorMatrixCliPayload(booleanRun);
  assert.equal(booleanOnly.ok, false);
  assert.equal(booleanOnly.complete, false);
  assert.equal(booleanOnly.green, false);
  assert.equal(booleanOnly.code, 'b4_ios_floor_matrix_incomplete');
  assert.deepEqual(booleanOnly.invalid, [
    'iPhone SE (2nd generation)',
    'iPad (8th generation)',
  ]);

  await writeFloorFixtures(tempRoot, {
    'iphone-se-2': mutateComparators(
      validFloorReport('iPhone SE (2nd generation)'),
      (comparators) => {
        comparators.coldLaunch.unit = 's';
      },
    ),
    'ipad-8': mutateComparators(
      validFloorReport('iPad (8th generation)'),
      (comparators) => {
        comparators.memory.unit = 'mb';
      },
    ),
  });
  const wrongUnitRun = runFloorMatrixCheckCli(tempRoot);
  assert.equal(wrongUnitRun.status, EXIT_CODES.stateMismatch);
  const wrongUnit = parseFloorMatrixCliPayload(wrongUnitRun);
  assert.equal(wrongUnit.complete, false);
  assert.equal(wrongUnit.green, false);
  assert.deepEqual(wrongUnit.invalid, [
    'iPhone SE (2nd generation)',
    'iPad (8th generation)',
  ]);

  await writeFloorFixtures(tempRoot, {
    'iphone-se-2': mutateComparators(
      validFloorReport('iPhone SE (2nd generation)'),
      (comparators) => {
        comparators.timeToInteractive.observedMs = 'NaN';
      },
    ),
    'ipad-8': mutateComparators(
      validFloorReport('iPad (8th generation)'),
      (comparators) => {
        comparators.answerFeedback.observedMs = '40';
      },
    ),
  });
  const nonFiniteRun = runFloorMatrixCheckCli(tempRoot);
  assert.equal(nonFiniteRun.status, EXIT_CODES.stateMismatch);
  const nonFinite = parseFloorMatrixCliPayload(nonFiniteRun);
  assert.equal(nonFinite.complete, false);
  assert.equal(nonFinite.green, false);

  await writeFloorFixtures(tempRoot, {
    'iphone-se-2': withCallerGreenBooleans(validFloorReport('iPhone SE (2nd generation)')),
    'ipad-8': withCallerGreenBooleans(validFloorReport('iPad (8th generation)')),
  });
  const lyingRun = runFloorMatrixCheckCli(tempRoot);
  assert.equal(lyingRun.status, EXIT_CODES.success);
  const lying = parseFloorMatrixCliPayload(lyingRun);
  assert.equal(lying.complete, true);
  assert.equal(lying.green, false);
  assert.equal(lying.code, 'b4_ios_floor_matrix_complete_pending_thresholds');
});

test('the repository floor-matrix CLI fails closed without fabricating reports', () => {
  assert.throws(
    () => execFileSync(
      process.execPath,
      [join(ROOT, 'scripts/prove-b4-ios-physical.mjs'), '--check-floor-matrix'],
      { encoding: 'utf8', cwd: ROOT },
    ),
    (error) => {
      assert.equal(error.status, EXIT_CODES.stateMismatch);
      const payload = JSON.parse(error.stderr);
      assert.equal(payload.ok, false);
      assert.equal(payload.complete, false);
      assert.equal(payload.green, false);
      assert.equal(payload.code, 'b4_ios_floor_matrix_incomplete');
      assert.deepEqual(payload.missingFiles, [
        'reports/b4-physical/ios-floor-iphone-se-2.json',
        'reports/b4-physical/ios-floor-ipad-8.json',
      ]);
      return true;
    },
  );
  assert.equal(existsSync(join(ROOT, FLOOR_DEVICE_REPORT_RELATIVES['iphone-se-2'])), false);
  assert.equal(existsSync(join(ROOT, FLOOR_DEVICE_REPORT_RELATIVES['ipad-8'])), false);
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
  assert.match(runbook, /experimental\.ios\.spm\.swiftToolsVersion/);
  assert.match(runbook, /swift-tools-version: 6\.2/);
  assert.match(runbook, /ios-floor-iphone-se-2\.json/);
  assert.match(runbook, /ios-floor-ipad-8\.json/);
  assert.match(runbook, /node scripts\/prove-b4-ios-physical\.mjs --check-floor-matrix/);
  assert.match(runbook, /--reports-root DIR/);
  assert.match(runbook, /does not trust\s+caller-supplied `recorded` or `within`/);
  assert.match(runbook, /boolean-only/);
  assert.match(runbook, /wrong unit/);
  assert.doesNotMatch(runbook, /iPad\s+`[0-9A-Z]{10}`/);
  assert.doesNotMatch(runbook, /SE 2\s+`[0-9A-Z]{10}`/);
  assert.doesNotMatch(runbook, /Status:\s*GREEN/i);
  assert.match(nativeDev, /2026-08-21-floor-device-gate-runbook/);

  assert.match(concepts, /### Geometry floor/);
  assert.match(concepts, /### Performance floor/);
  assert.match(concepts, /### Aesthetics judge/);
  assert.doesNotMatch(concepts, /#152|#150|GREEN/i);
});
