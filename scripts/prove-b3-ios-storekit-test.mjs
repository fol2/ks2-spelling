import { readFile, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  EXIT_CODES,
  isMain,
  printJson,
  resolveExecutable,
  runCommand,
} from './lib/run-command.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const RESULT_BUNDLE = resolve(
  ROOT,
  '.native-build/ios-storekit-test/B3StoreKitTest.xcresult',
);
const DERIVED_DATA = resolve(ROOT, '.native-build/ios-storekit-test');
const PRODUCTS_DIR = resolve(DERIVED_DATA, 'Build/Products');
const STOREKIT_BUILD_TIMEOUT_MS = 600_000;
const STOREKIT_SIMULATOR_TIMEOUT_MS = 300_000;
const STOREKIT_TEST_TIMEOUT_MS = 90_000;
const STOREKIT_TEST_METHODS = Object.freeze([
  'testDelayedApproveProducesVerifiedPurchasedObservation',
  'testDelayedDeclineProducesNoPurchasedEntitlement',
]);
const OBSERVATION_PATTERN =
  /B3_STOREKIT_OBSERVATION case=(delayed-(?:approve|decline)) productId=([a-z][a-z0-9]*(?:[._][a-z0-9]+)+) initial=(pending) final=(purchased|cancelled) verifiedProof=(true|false)/g;

function proofError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function parseAvailableIosSimulators(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw proofError('invalid_simulator_inventory', 'Simulator inventory is invalid');
  }
  const devices = value.devices;
  if (!devices || typeof devices !== 'object' || Array.isArray(devices)) {
    throw proofError('invalid_simulator_inventory', 'Simulator devices are invalid');
  }
  const candidates = [];
  for (const [runtime, entries] of Object.entries(devices)) {
    if (!runtime.startsWith('com.apple.CoreSimulator.SimRuntime.iOS-') || !Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (
        entry?.isAvailable === true &&
        typeof entry.udid === 'string' &&
        /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(entry.udid) &&
        typeof entry.name === 'string' &&
        entry.name.length > 0
      ) {
        candidates.push({ runtime, udid: entry.udid, name: entry.name });
      }
    }
  }
  return candidates.sort((left, right) =>
    `${left.runtime}\u0000${left.name}\u0000${left.udid}`.localeCompare(
      `${right.runtime}\u0000${right.name}\u0000${right.udid}`,
    ));
}

export function selectIosSimulator(candidates, requestedUdid = '') {
  const requested = requestedUdid.trim();
  if (requested && !/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(requested)) {
    throw proofError(
      'invalid_simulator_request',
      'B3_IOS_STOREKIT_DEVICE must be an iOS Simulator UDID',
    );
  }
  const selected = requested
    ? candidates.find(({ udid }) => udid === requested)
    : candidates.find(({ name }) => name === 'KS2 Spelling iPhone 17') ?? candidates[0];
  if (!selected) {
    throw proofError('missing_ios_simulator', 'No matching available iOS Simulator exists');
  }
  return selected;
}

export function parseExecutedStoreKitObservations(output) {
  const observations = [];
  for (const match of output.matchAll(OBSERVATION_PATTERN)) {
    observations.push({
      case: match[1],
      productId: match[2],
      initialOutcome: match[3],
      finalOutcome: match[4],
      verifiedProof: match[5] === 'true',
    });
  }
  observations.sort((left, right) => left.case.localeCompare(right.case));
  return observations;
}

export function assertStoreKitConfiguration(value, expectedProductId) {
  const product = Array.isArray(value?.products) && value.products.length === 1
    ? value.products[0]
    : null;
  if (
    expectedProductId !== 'uk.eugnel.ks2spelling.fullks2' ||
    product?.productID !== expectedProductId ||
    product?.type !== 'NonConsumable' ||
    !Array.isArray(value?.subscriptionGroups) ||
    value.subscriptionGroups.length !== 0 ||
    !Array.isArray(value?.nonRenewingSubscriptions) ||
    value.nonRenewingSubscriptions.length !== 0
  ) {
    throw proofError(
      'storekit_configuration_mismatch',
      'StoreKit Test configuration does not match the closed transcript product',
    );
  }
  return product.productID;
}

export function assertExecutedStoreKitEvidence(output, transcript) {
  if (!output.includes('** TEST EXECUTE SUCCEEDED **')) {
    throw proofError('storekit_test_failed', 'Xcode StoreKit Test did not succeed');
  }
  for (const method of STOREKIT_TEST_METHODS) {
    if (!output.includes(method)) {
      throw proofError(
        'storekit_test_evidence_missing',
        `Executed result is missing ${method}`,
      );
    }
  }

  return assertExactStoreKitObservations(output, transcript, 'storekit_observation_mismatch');
}

function assertExactStoreKitObservations(output, transcript, errorCode) {
  const observations = parseExecutedStoreKitObservations(output);
  const expected = transcript.cases
    .map(({ name: caseName, initialOutcome, finalOutcome, verifiedProofRequired }) => ({
      case: caseName,
      productId: transcript.productId,
      initialOutcome,
      finalOutcome,
      verifiedProof: verifiedProofRequired,
    }))
    .sort((left, right) => left.case.localeCompare(right.case));
  if (JSON.stringify(observations) !== JSON.stringify(expected)) {
    throw proofError(
      errorCode,
      'Executed StoreKit observations do not match the closed transcript',
    );
  }
  return observations;
}

export function assertCompletedStoreKitTimeoutEvidence(output, transcript) {
  const lines = output.split(/\r?\n/u);
  const suitePrefix = "Test Suite 'B3StoreKitDelayedTests' ";
  const terminalSuiteMarkers = lines
    .map((line, index) => ({ index, line }))
    .filter(
      ({ line }) => line.startsWith(suitePrefix) && !line.startsWith(`${suitePrefix}started at `),
    );
  const [terminalSuite] = terminalSuiteMarkers;
  const cleanSuiteSummary = terminalSuite
    && terminalSuiteMarkers.length === 1
    && terminalSuite.line.startsWith(`${suitePrefix}passed at `)
    && /^\s*Executed 2 tests, with 0 failures \(0 unexpected\)(?: .*)?$/u.test(
      lines[terminalSuite.index + 1] ?? '',
    );
  if (output.includes('** TEST EXECUTE FAILED **') || !cleanSuiteSummary) {
    throw proofError(
      'storekit_test_timeout',
      'Xcode StoreKit execution timed out before the selected suite completed cleanly',
    );
  }
  for (const method of STOREKIT_TEST_METHODS) {
    const casePrefix = `Test Case '-[AppTests.B3StoreKitDelayedTests ${method}]' `;
    const terminalCaseMarkers = lines.filter(
      (line) => line.startsWith(casePrefix) && line !== `${casePrefix}started.`,
    );
    if (
      terminalCaseMarkers.length !== 1
      || !terminalCaseMarkers[0].startsWith(`${casePrefix}passed (`)
    ) {
      throw proofError(
        'storekit_test_timeout',
        `Xcode StoreKit execution timed out without a clean result for ${method}`,
      );
    }
  }
  return assertExactStoreKitObservations(output, transcript, 'storekit_test_timeout');
}

export async function runB3IosStoreKitTest({ env = process.env, stream = true } = {}) {
  for (const command of ['xcodebuild', 'xcrun']) {
    if (!(await resolveExecutable(command, env))) {
      throw proofError('missing_xcode_tool', `${command} is unavailable`);
    }
  }

  const transcript = JSON.parse(
    await readFile(resolve(ROOT, 'tests/fixtures/storekit-bridge-transcript.json'), 'utf8'),
  );
  if (
    transcript.evidenceKind !== 'xcode-storekit-test-non-live' ||
    transcript.physicalSandbox !== false ||
    transcript.liveStore !== false
  ) {
    throw proofError(
      'invalid_non_live_transcript',
      'StoreKit transcript could be mislabelled as live evidence',
    );
  }
  const storeKitConfiguration = JSON.parse(
    await readFile(resolve(ROOT, 'ios/App/App/B3Sandbox.storekit'), 'utf8'),
  );
  const configurationProductId = assertStoreKitConfiguration(
    storeKitConfiguration,
    transcript.productId,
  );

  const inventory = await runCommand(
    'xcrun',
    ['simctl', 'list', 'devices', 'available', '--json'],
    { cwd: ROOT, env },
  );
  if (inventory.exitCode !== 0) {
    throw proofError('simulator_inventory_failed', 'Unable to enumerate iOS Simulators');
  }
  let simulatorInventory;
  try {
    simulatorInventory = JSON.parse(inventory.stdout);
  } catch {
    throw proofError('invalid_simulator_inventory', 'Simulator inventory is not JSON');
  }
  const simulator = selectIosSimulator(
    parseAvailableIosSimulators(simulatorInventory),
    env.B3_IOS_STOREKIT_DEVICE ?? '',
  );
  const simulatorResult = await runCommand(
    'xcrun',
    ['simctl', 'bootstatus', simulator.udid, '-b'],
    { cwd: ROOT, env, stream, timeoutMs: STOREKIT_SIMULATOR_TIMEOUT_MS },
  );
  if (simulatorResult.timedOut) {
    throw proofError(
      'storekit_simulator_timeout',
      'The iOS Simulator did not become ready within 300 seconds',
    );
  }
  if (simulatorResult.exitCode !== 0) {
    throw proofError(
      'storekit_simulator_failed',
      `The iOS Simulator readiness check exited ${simulatorResult.exitCode}`,
    );
  }

  await rm(RESULT_BUNDLE, { recursive: true, force: true });
  const destination = `platform=iOS Simulator,id=${simulator.udid}`;
  const xcodeBuildArgs = [
    '-project',
    'ios/App/App.xcodeproj',
    '-scheme',
    'KS2Spelling',
    '-destination',
    destination,
    '-derivedDataPath',
    DERIVED_DATA,
    '-only-testing:AppTests/B3StoreKitDelayedTests',
  ];
  const buildResult = await runCommand(
    'xcodebuild',
    [
      ...xcodeBuildArgs,
      'build-for-testing',
    ],
    { cwd: ROOT, env, stream, timeoutMs: STOREKIT_BUILD_TIMEOUT_MS },
  );
  if (buildResult.timedOut) {
    throw proofError(
      'storekit_build_timeout',
      'Xcode StoreKit build-for-testing exceeded its 600 second process deadline',
    );
  }
  if (buildResult.exitCode !== 0) {
    throw proofError(
      'storekit_build_failed',
      `Xcode StoreKit build-for-testing exited ${buildResult.exitCode}`,
    );
  }

  let xcTestRunEntries;
  try {
    xcTestRunEntries = await readdir(PRODUCTS_DIR, { withFileTypes: true });
  } catch {
    throw proofError(
      'storekit_build_output_mismatch',
      'Xcode StoreKit build did not expose its test execution manifest',
    );
  }
  const xcTestRuns = xcTestRunEntries.filter(
    (entry) => entry.isFile() && entry.name.endsWith('.xctestrun'),
  );
  if (xcTestRuns.length !== 1) {
    throw proofError(
      'storekit_build_output_mismatch',
      'Xcode StoreKit build must produce exactly one test execution manifest',
    );
  }
  const xcTestRun = resolve(PRODUCTS_DIR, xcTestRuns[0].name);

  const result = await runCommand(
    'xcodebuild',
    [
      '-xctestrun',
      xcTestRun,
      '-destination',
      destination,
      '-resultBundlePath',
      RESULT_BUNDLE,
      '-test-timeouts-enabled',
      'YES',
      '-default-test-execution-time-allowance',
      '20',
      '-maximum-test-execution-time-allowance',
      '30',
      '-only-testing:AppTests/B3StoreKitDelayedTests',
      'test-without-building',
    ],
    { cwd: ROOT, env, stream, timeoutMs: STOREKIT_TEST_TIMEOUT_MS },
  );
  const executionOutput = result.stdout + result.stderr;
  let completionMode = 'normal-process-exit';
  let observations;
  if (result.timedOut) {
    observations = assertCompletedStoreKitTimeoutEvidence(executionOutput, transcript);
    completionMode = 'completed-suite-before-xcode-process-timeout';
  } else if (result.exitCode !== 0) {
    throw proofError('storekit_test_failed', `Xcode StoreKit Test exited ${result.exitCode}`);
  } else {
    observations = assertExecutedStoreKitEvidence(executionOutput, transcript);
  }
  return {
    ok: true,
    evidenceKind: 'xcode-storekit-test-non-live',
    physicalSandbox: false,
    liveStore: false,
    signedStoreReadiness: false,
    destination: 'iOS Simulator',
    simulator,
    productId: configurationProductId,
    observations,
    completionMode,
    resultBundle: '.native-build/ios-storekit-test/B3StoreKitTest.xcresult',
  };
}

function exitCodeFor(error) {
  if (error?.code === 'missing_xcode_tool') return EXIT_CODES.missingTool;
  if (
    error?.code === 'missing_ios_simulator' ||
    error?.code === 'invalid_simulator_request' ||
    error?.code === 'invalid_non_live_transcript' ||
    error?.code === 'storekit_configuration_mismatch'
  ) return EXIT_CODES.stateMismatch;
  return EXIT_CODES.commandFailed;
}

export async function main() {
  try {
    printJson(await runB3IosStoreKitTest());
    return EXIT_CODES.success;
  } catch (error) {
    printJson({ ok: false, code: error.code, message: error.message }, process.stderr);
    return exitCodeFor(error);
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
