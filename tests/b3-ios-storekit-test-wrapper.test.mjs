import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertStoreKitConfiguration,
  assertExecutedStoreKitEvidence,
  parseAvailableIosSimulators,
  parseExecutedStoreKitObservations,
  selectIosSimulator,
} from '../scripts/prove-b3-ios-storekit-test.mjs';

const ROOT = new URL('../', import.meta.url);

test('the B3 StoreKit proof command is explicitly a non-live Xcode StoreKit Test', async () => {
  const packageJson = JSON.parse(await readFile(new URL('package.json', ROOT), 'utf8'));
  assert.equal(
    packageJson.scripts['prove:b3:ios-storekit-test'],
    'node scripts/prove-b3-ios-storekit-test.mjs',
  );

  const source = await readFile(
    new URL('scripts/prove-b3-ios-storekit-test.mjs', ROOT),
    'utf8',
  );
  assert.match(source, /xcode-storekit-test-non-live/);
  assert.match(source, /physicalSandbox:\s*false/);
  assert.match(source, /liveStore:\s*false/);
  assert.match(source, /platform=iOS Simulator/);
  assert.match(source, /-only-testing:AppTests\/B3StoreKitDelayedTests/);
  assert.match(source, /'-test-timeouts-enabled',\s*'YES'/);
  assert.match(source, /'-default-test-execution-time-allowance',\s*'20'/);
  assert.match(source, /'-maximum-test-execution-time-allowance',\s*'30'/);
  assert.match(source, /const STOREKIT_TEST_TIMEOUT_MS = 240_000/);
  assert.match(source, /timeoutMs:\s*STOREKIT_TEST_TIMEOUT_MS/);
  assert.match(source, /result\.timedOut[\s\S]*?'storekit_test_timeout'/);
  assert.doesNotMatch(source, /platform=iOS(?:,|$)(?! Simulator)/m);
  assert.doesNotMatch(source, /mobileprovision|App Store Connect|sandbox account/i);
});

test('the native delayed tests use SKTestSession approval and decline without finishing', async () => {
  const source = await readFile(
    new URL('ios/App/AppTests/B3StoreKitDelayedTests.swift', ROOT),
    'utf8',
  );
  assert.match(source, /url\(forResource:\s*"B3Sandbox",\s*withExtension:\s*"storekit"\)/);
  assert.match(source, /SKTestSession\(contentsOf:\s*configurationURL\)/);
  assert.match(source, /askToBuyEnabled\s*=\s*true/);
  assert.match(source, /approveAskToBuyTransaction/);
  assert.match(source, /declineAskToBuyTransaction/);
  assert.match(source, /XCTAssertEqual\([^\n]*"pending"/);
  assert.match(source, /XCTAssertEqual\([^\n]*"purchased"/);
  assert.match(source, /XCTAssertEqual\([^\n]*"cancelled"/);
  assert.doesNotMatch(source, /\.finish\(\)/);

  const declineStart = source.indexOf(
    'func testDelayedDeclineProducesNoPurchasedEntitlement()',
  );
  const helperStart = source.indexOf('private func beginDelayedPurchase()', declineStart);
  assert.notEqual(declineStart, -1);
  assert.notEqual(helperStart, -1);
  const decline = source.slice(declineStart, helperStart);
  assert.match(decline, /pendingAskToBuyConfirmation\s*==\s*false/);
  assert.match(decline, /currentEntitlement\s*==\s*nil/);
  assert.doesNotMatch(decline, /\.state\s*==\s*\.failed|cancelDate|Task\.sleep/);
});

test('the wrapper selects only an inventoried iOS Simulator and rejects injected authority', () => {
  const udid = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
  const candidates = parseAvailableIosSimulators({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
        { isAvailable: true, name: 'KS2 Spelling iPhone 17', udid },
      ],
      'com.apple.CoreSimulator.SimRuntime.tvOS-26-5': [
        { isAvailable: true, name: 'Apple TV', udid: 'FFFFFFFF-1111-2222-3333-444444444444' },
      ],
    },
  });
  assert.deepEqual(candidates, [{
    runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    name: 'KS2 Spelling iPhone 17',
    udid,
  }]);
  assert.deepEqual(selectIosSimulator(candidates), candidates[0]);
  assert.throws(
    () => selectIosSimulator(candidates, `${udid},platform=iOS`),
    ({ code }) => code === 'invalid_simulator_request',
  );
});

test('the wrapper derives exact observations from executed test output and fails closed', async () => {
  const transcript = JSON.parse(
    await readFile(new URL('tests/fixtures/storekit-bridge-transcript.json', ROOT), 'utf8'),
  );
  const storeKitConfiguration = JSON.parse(
    await readFile(new URL('ios/App/App/B3Sandbox.storekit', ROOT), 'utf8'),
  );
  assert.equal(
    assertStoreKitConfiguration(storeKitConfiguration, transcript.productId),
    transcript.productId,
  );
  const executed = [
    'B3StoreKitDelayedTests testDelayedApproveProducesVerifiedPurchasedObservation',
    `B3_STOREKIT_OBSERVATION case=delayed-approve productId=${transcript.productId} initial=pending final=purchased verifiedProof=true`,
    'B3StoreKitDelayedTests testDelayedDeclineProducesNoPurchasedEntitlement',
    `B3_STOREKIT_OBSERVATION case=delayed-decline productId=${transcript.productId} initial=pending final=cancelled verifiedProof=false`,
    '** TEST SUCCEEDED **',
  ].join('\n');
  assert.deepEqual(
    parseExecutedStoreKitObservations(executed),
    [
      {
        case: 'delayed-approve',
        productId: transcript.productId,
        initialOutcome: 'pending',
        finalOutcome: 'purchased',
        verifiedProof: true,
      },
      {
        case: 'delayed-decline',
        productId: transcript.productId,
        initialOutcome: 'pending',
        finalOutcome: 'cancelled',
        verifiedProof: false,
      },
    ],
  );
  assert.equal(assertExecutedStoreKitEvidence(executed, transcript).length, 2);
  assert.throws(
    () => assertExecutedStoreKitEvidence(executed.replace('purchased', 'cancelled'), transcript),
    ({ code }) => code === 'storekit_observation_mismatch',
  );
  assert.throws(
    () => assertExecutedStoreKitEvidence(executed.replace('** TEST SUCCEEDED **', '** TEST FAILED **'), transcript),
    ({ code }) => code === 'storekit_test_failed',
  );
  assert.throws(
    () => assertStoreKitConfiguration(storeKitConfiguration, 'full_ks2'),
    ({ code }) => code === 'storekit_configuration_mismatch',
  );
});
