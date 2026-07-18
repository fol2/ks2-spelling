import assert from 'node:assert/strict';
import test from 'node:test';

import {
  B3_PROOF_ACTION_CODES,
  B3_PROOF_GATEWAY_CALLS,
  B3_PROOF_PHASES,
  assertB3ProofProjectionPrivacy,
  canonicaliseB3ProofValue,
  createB3ProofObservation,
  deriveB3ProofBuildAuthoritySha256,
  validateB3ProofLaunchCommand,
  validateB3ProofObservation,
  validateB3ProofObservationForPublication,
} from '../src/app/b3-live-proof-protocol.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const COMMIT = 'c'.repeat(40);
const CAPTURE_ID = '018f1d7b-97e8-4a52-8cf2-783e5089c001';
const INSTALLATION_ID = '018f1d7b-97e8-4a52-8cf2-783e5089c002';
const INITIAL_TAIL = '0'.repeat(64);

function launchCommand(overrides = {}) {
  return {
    schemaVersion: 1,
    captureId: CAPTURE_ID,
    platform: 'ios-physical',
    testedApplicationCommit: COMMIT,
    applicationFingerprint: HASH_A,
    expectedScenarioIndex: 0,
    expectedSequence: 1,
    previousObservationSha256: INITIAL_TAIL,
    installationMode: 'existing',
    actionCode: 'ARM_CAPTURE',
    challengeSha256: HASH_A,
    ...overrides,
  };
}

function buildAuthority(overrides = {}) {
  return {
    mode: 'B3SandboxProof',
    proofKind: 'physical-live',
    platform: 'ios',
    distribution: 'development',
    publicSandboxOrigin: 'https://b3-gateway.eugnel.uk',
    workerName: 'ks2-spelling-b3-sandbox',
    bundleId: 'uk.eugnel.ks2spelling',
    testedApplicationCommit: COMMIT,
    applicationFingerprint: HASH_A,
    versionName: '0.3.0-b3',
    buildNumber: '1',
    ...overrides,
  };
}

function proofProjection(overrides = {}) {
  const androidStoreAuthority = overrides.androidStoreAuthority === true;
  const projectionOverrides = { ...overrides };
  delete projectionOverrides.androidStoreAuthority;
  const projection = {
    challengeSha256: HASH_A,
    scenarioOutcome: 'in-progress',
    entitlementState: 'none',
    packState: 'absent',
    storeCompletionObserved: false,
    storeEvents: [],
    storeAuthority: {
      environment: 'sandbox',
      productId: androidStoreAuthority ? 'full_ks2' : 'uk.eugnel.ks2spelling.fullks2',
      localisedPriceObserved: false,
      completionState: 'not-observed',
    },
    gatewayCalls: [],
    gatewaySmokeAuthority: null,
    syntheticLearners: {
      syntheticAuthorityMatched: true,
      positionalSnapshotSha256: [HASH_A, HASH_B],
    },
    transactionAuthority: {
      source: 'none',
      crossCheckedOnRefresh: false,
      domainSeparatedDigestSha256: null,
      rawProofCleared: false,
    },
    refreshHandleLifecycle: {
      present: false,
      positiveVersionObserved: false,
      rotated: false,
      deleted: false,
    },
    entitlementAuthority: {
      id: null,
      state: 'none',
      domainSeparatedDigestSha256: null,
      refreshHandlePresent: false,
    },
    packAuthority: {
      packId: null,
      manifestSha256: null,
      archiveSha256: null,
      installed: false,
    },
    transportAuthority: {
      storeAdapter: 'concreteCapacitorStore',
      gatewayAdapter: 'concreteHttpGateway',
      serverUrl: null,
      nativeOriginAllowed: true,
      noRedirects: true,
    },
    ...projectionOverrides,
  };
  if (!Object.hasOwn(projectionOverrides, 'storeAuthority') &&
      projection.storeCompletionObserved) {
    projection.storeAuthority.completionState = androidStoreAuthority
      ? 'acknowledged'
      : 'finished';
  }
  if (!Object.hasOwn(projectionOverrides, 'entitlementAuthority') &&
      ['active', 'revoked'].includes(projection.entitlementState)) {
    projection.entitlementAuthority = {
      id: 'full-ks2',
      state: projection.entitlementState,
      domainSeparatedDigestSha256: 'c'.repeat(64),
      refreshHandlePresent: projection.refreshHandleLifecycle.present,
    };
  }
  if (!Object.hasOwn(projectionOverrides, 'packAuthority') &&
      ['installed', 'locked'].includes(projection.packState)) {
    projection.packAuthority = {
      packId: 'b3-sandbox-proof',
      manifestSha256: 'd'.repeat(64),
      archiveSha256: 'e'.repeat(64),
      installed: true,
    };
  }
  if ((projection.storeCompletionObserved || [
    'installed', 'restored-active', 'redownloaded', 'revoked-locked',
  ].includes(projection.scenarioOutcome)) &&
      !Object.hasOwn(projectionOverrides, 'transactionAuthority')) {
    projection.transactionAuthority.rawProofCleared = true;
  }
  return projection;
}

function gatewaySmokeAuthority(overrides = {}) {
  return {
    schemaVersion: 1,
    deploymentVersionId: 'a8f32f60-16b9-4ca6-9b4a-f771dd5302f7',
    scriptAuthoritySha256: HASH_A,
    signedEnvelopeSha256: HASH_B,
    objects: [
      {
        role: 'signed-manifest',
        key: 'packs/b3-sandbox-proof/1.0.0-b3.1/signed-manifest.json',
        sha256: HASH_B,
        size: 1_135,
        etag: 'c76b2858b8345814279a1c92ae64e365',
      },
      {
        role: 'archive',
        key: 'packs/b3-sandbox-proof/1.0.0-b3.1/b3-sandbox-proof.zip',
        sha256: HASH_A,
        size: 1_324,
        etag: '913d2b2485ca6cd31d467bd7228d7e75',
      },
    ],
    accessBehaviour: {
      ttlSeconds: 600,
      valid: true,
      tamperedRejected: true,
      expiredRejected: true,
      canonicalEncodingRequired: true,
    },
    byteServingBehaviour: {
      full200: true,
      partial206: true,
      conditional304: true,
      unsatisfied416: true,
      noRedirects: true,
      cacheControl: 'private, no-store',
    },
    ...overrides,
  };
}

test('gateway smoke authority is nullable or one exact redacted deployment-bound projection', () => {
  assert.equal(proofProjection().gatewaySmokeAuthority, null);
  const complete = proofProjection({ gatewaySmokeAuthority: gatewaySmokeAuthority() });
  assert.deepEqual(assertB3ProofProjectionPrivacy(complete), complete);

  for (const mutate of [
    (value) => { value.gatewaySmokeAuthority.objects.pop(); },
    (value) => { delete value.gatewaySmokeAuthority.byteServingBehaviour.conditional304; },
    (value) => { value.gatewaySmokeAuthority.objects.reverse(); },
    (value) => { value.gatewaySmokeAuthority.objects[0].etag = HASH_A; },
    (value) => { value.gatewaySmokeAuthority.signedEnvelopeSha256 = HASH_A; },
    (value) => { value.gatewaySmokeAuthority.deploymentVersionId = 'version-stdout'; },
    (value) => { value.gatewaySmokeAuthority.deploymentVersionId = 'A8F32F60-16B9-4CA6-9B4A-F771DD5302F7'; },
    (value) => { value.gatewaySmokeAuthority.accessBehaviour.expiredRejected = false; },
    (value) => { value.gatewaySmokeAuthority.rateLimit = { selfClaimed: true }; },
    (value) => {
      value.gatewaySmokeAuthority.objects = Array.from(
        { length: 1_025 },
        () => structuredClone(value.gatewaySmokeAuthority.objects[0]),
      );
    },
  ]) {
    const candidate = proofProjection({ gatewaySmokeAuthority: gatewaySmokeAuthority() });
    mutate(candidate);
    assert.throws(
      () => assertB3ProofProjectionPrivacy(candidate),
      /gateway smoke|closed schema|authority|object|capability|Range|array|bound/i,
    );
  }
});

function gatewayCall(operation, relation, suffix = '1') {
  return {
    operation,
    relation,
    traceId: `018f1d7b-97e8-4a52-8cf2-${suffix.padStart(12, '0')}`,
  };
}

test('launch commands are canonical, exact and contain requested actions only', () => {
  const command = launchCommand();
  assert.deepEqual(validateB3ProofLaunchCommand(command), command);
  assert.equal(
    canonicaliseB3ProofValue({ z: ['é'], a: 1 }),
    '{"a":1,"z":["é"]}',
  );
  assert.throws(() => canonicaliseB3ProofValue({ value: 'e\u0301' }), /NFC/i);
  assert.ok(Object.isFrozen(B3_PROOF_ACTION_CODES));
  assert.ok(B3_PROOF_ACTION_CODES.includes('REBIND_FRESH_INSTALL'));
  assert.ok(B3_PROOF_ACTION_CODES.includes('ARM_GATEWAY_COMPLETION_HOLD'));
  assert.ok(Object.isFrozen(B3_PROOF_GATEWAY_CALLS['ios-physical']['normal-purchase']));

  for (const mutation of [
    { result: 'passed' },
    { evidence: {} },
    { actionCode: 'tap anything the operator wants' },
    { actionCode: 'file:///tmp/result.json' },
    { actionCode: 'ARM_CAPTURE; rm -rf /' },
    { applicationFingerprint: HASH_A.toUpperCase() },
    { expectedSequence: 0 },
  ]) {
    assert.throws(
      () => validateB3ProofLaunchCommand({ ...command, ...mutation }),
      /command|schema|action|hash/i,
    );
  }
});

test('observations bind the challenge, prior tail and their own canonical hash', async () => {
  const command = launchCommand();
  const observation = await createB3ProofObservation({
    command,
    buildAuthority: buildAuthority(),
    installationId: INSTALLATION_ID,
    sequence: 1,
    scenario: 'product-query',
    phase: 'ARMED',
    nextActionCode: 'QUERY_PRODUCT',
    completedTransitions: ['UNBOUND', 'ARMED'],
    proofProjection: proofProjection(),
    observedAt: '2026-07-15T10:00:00.000Z',
  });

  assert.deepEqual(
    await validateB3ProofObservation(observation, {
      command,
      buildAuthority: buildAuthority(),
    }),
    observation,
  );
  assert.deepEqual(Object.keys(observation).sort(), [
    'buildAuthoritySha256', 'captureId', 'completedTransitions', 'installationId',
    'nextActionCode', 'observationSha256', 'observedAt', 'phase', 'platform',
    'previousObservationSha256', 'proofProjection', 'scenario', 'scenarioIndex',
    'schemaVersion', 'sequence',
  ].sort());
  assert.match(observation.observationSha256, /^[0-9a-f]{64}$/u);

  for (const mutate of [
    (value) => { value.proofProjection.packState = 'installed'; },
    (value) => { value.proofProjection.storeAuthority.productId = 'full_ks2'; },
    (value) => { value.proofProjection.storeAuthority.completionState = 'acknowledged'; },
    (value) => { value.previousObservationSha256 = HASH_A; },
    (value) => { value.proofProjection.challengeSha256 = HASH_B; },
    (value) => { value.extra = true; },
  ]) {
    const changed = structuredClone(observation);
    mutate(changed);
    await assert.rejects(
      validateB3ProofObservation(changed, {
        command,
        buildAuthority: buildAuthority(),
      }),
      /observation|hash|challenge|schema|projection|authority/i,
    );
  }
});

test('observation chains enforce monotonic sequence, scenario and fresh-install rebinding', async () => {
  const firstCommand = launchCommand();
  firstCommand.expectedScenarioIndex = 5;
  const first = await createB3ProofObservation({
    command: firstCommand,
    buildAuthority: buildAuthority(),
    installationId: INSTALLATION_ID,
    sequence: 1,
    scenario: 'pack-install',
    phase: 'SCENARIO_COMPLETE',
    nextActionCode: 'REBIND_FRESH_INSTALL',
    completedTransitions: ['UNBOUND', 'ARMED', 'OBSERVING', 'SCENARIO_COMPLETE'],
    proofProjection: proofProjection({
      scenarioOutcome: 'installed',
      gatewayCalls: [gatewayCall('authorise', 'download-capability-authorisation')],
    }),
    observedAt: '2026-07-15T10:00:00.000Z',
  });
  const reinstallCommand = launchCommand({
    expectedScenarioIndex: 6,
    expectedSequence: 2,
    previousObservationSha256: first.observationSha256,
    installationMode: 'fresh-reinstall',
    actionCode: 'REBIND_FRESH_INSTALL',
    challengeSha256: HASH_B,
  });
  const second = await createB3ProofObservation({
    command: reinstallCommand,
    buildAuthority: buildAuthority(),
    installationId: '018f1d7b-97e8-4a52-8cf2-783e5089c003',
    sequence: 2,
    scenario: 'restore-after-reinstall',
    phase: 'REBIND_FRESH_INSTALL',
    nextActionCode: 'OBSERVE',
    completedTransitions: ['REBIND_FRESH_INSTALL'],
    proofProjection: proofProjection({ challengeSha256: HASH_B }),
    observedAt: '2026-07-15T10:01:00.000Z',
  });

  assert.deepEqual(
    await validateB3ProofObservationForPublication(second, {
      command: reinstallCommand,
      buildAuthority: buildAuthority(),
    }),
    second,
  );
  await assert.rejects(
    validateB3ProofObservation(second, {
      command: reinstallCommand,
      buildAuthority: buildAuthority(),
    }),
    /prior chain/i,
  );

  assert.deepEqual(
    await validateB3ProofObservation(second, {
      command: reinstallCommand,
      buildAuthority: buildAuthority(),
      previousObservation: first,
    }),
    second,
  );

  for (const mutation of [
    { sequence: 1 },
    { scenarioIndex: 0 },
    { installationId: INSTALLATION_ID },
  ]) {
    const changed = { ...second, ...mutation };
    await assert.rejects(
      validateB3ProofObservation(changed, {
        command: reinstallCommand,
        buildAuthority: buildAuthority(),
        previousObservation: first,
      }),
      /sequence|scenario|installation|hash/i,
    );
  }
});

test('the closed state machine rejects skipped, duplicate and unknown phases', async () => {
  assert.deepEqual(B3_PROOF_PHASES, [
    'UNBOUND', 'ARMED', 'WAITING_OPERATOR', 'OBSERVING', 'HOLD_REACHED',
    'HOST_FORCE_STOP', 'RELAUNCH_RECOVERY', 'SCENARIO_COMPLETE',
    'REBIND_FRESH_INSTALL', 'TERMINAL_CAPTURE', 'MANUAL_ATTESTATION', 'COMPLETE',
  ]);
  const command = launchCommand();
  for (const completedTransitions of [
    ['UNBOUND', 'OBSERVING'],
    ['UNBOUND', 'ARMED', 'ARMED'],
    ['UNBOUND', 'UNKNOWN'],
  ]) {
    await assert.rejects(createB3ProofObservation({
      command,
      buildAuthority: buildAuthority(),
      installationId: INSTALLATION_ID,
      sequence: 1,
      scenario: 'product-query',
      phase: completedTransitions.at(-1),
      nextActionCode: 'OBSERVE',
      completedTransitions,
      proofProjection: proofProjection(),
      observedAt: '2026-07-15T10:00:00.000Z',
    }), /phase|transition/i);
  }
});

test('gateway call projection must be an unfiltered production segment', async () => {
  const command = launchCommand();
  await assert.rejects(createB3ProofObservation({
    command,
    buildAuthority: buildAuthority(),
    installationId: INSTALLATION_ID,
    sequence: 1,
    scenario: 'product-query',
    phase: 'ARMED',
    nextActionCode: 'QUERY_PRODUCT',
    completedTransitions: ['UNBOUND', 'ARMED'],
    proofProjection: proofProjection({
      gatewayCalls: [gatewayCall('authorise', 'download-capability-authorisation')],
    }),
    observedAt: '2026-07-15T10:00:00.000Z',
  }), /production trace segment/i);

  const packCommand = launchCommand({ expectedScenarioIndex: 5 });
  await assert.rejects(createB3ProofObservation({
    command: packCommand,
    buildAuthority: buildAuthority(),
    installationId: INSTALLATION_ID,
    sequence: 1,
    scenario: 'pack-install',
    phase: 'SCENARIO_COMPLETE',
    nextActionCode: 'CAPTURE_TERMINAL',
    completedTransitions: ['UNBOUND', 'ARMED', 'OBSERVING', 'SCENARIO_COMPLETE'],
    proofProjection: proofProjection({
      scenarioOutcome: 'installed',
      entitlementState: 'active',
      packState: 'installed',
      gatewayCalls: [gatewayCall('verify', 'transaction-verification')],
    }),
    observedAt: '2026-07-15T10:00:00.000Z',
  }), /production trace segment/i);
});

test('publication accepts an exact per-process gateway suffix for host aggregation', async () => {
  const command = launchCommand({
    expectedScenarioIndex: 4,
    expectedSequence: 7,
    previousObservationSha256: HASH_B,
    actionCode: 'RELAUNCH',
  });
  const observation = await createB3ProofObservation({
    command,
    buildAuthority: buildAuthority(),
    installationId: INSTALLATION_ID,
    sequence: 7,
    scenario: 'unfinished-relaunch',
    phase: 'SCENARIO_COMPLETE',
    nextActionCode: 'ARM_CAPTURE',
    completedTransitions: ['RELAUNCH_RECOVERY', 'SCENARIO_COMPLETE'],
    proofProjection: proofProjection({
      scenarioOutcome: 'finished-recovered',
      entitlementState: 'active',
      storeCompletionObserved: true,
      gatewayCalls: [
        gatewayCall('authorise', 'download-job-authorisation', '3'),
        gatewayCall('refresh', 'post-recovery-handle-refresh', '4'),
      ],
    }),
    observedAt: '2026-07-15T10:00:00.000Z',
  });

  assert.equal((await validateB3ProofObservationForPublication(observation, {
    command,
    buildAuthority: buildAuthority(),
  })).phase, 'SCENARIO_COMPLETE');
});

test('initial sequence, exact edges, action applicability and canonical bytes fail closed', async () => {
  const command = launchCommand();
  const observation = await createB3ProofObservation({
    command,
    buildAuthority: buildAuthority(),
    installationId: INSTALLATION_ID,
    sequence: 1,
    scenario: 'product-query',
    phase: 'ARMED',
    nextActionCode: 'QUERY_PRODUCT',
    completedTransitions: ['UNBOUND', 'ARMED'],
    proofProjection: proofProjection(),
    observedAt: '2026-07-15T10:00:00.000Z',
  });
  const canonicalBytes = canonicaliseB3ProofValue(observation);
  assert.deepEqual(
    await validateB3ProofObservation(observation, {
      command,
      buildAuthority: buildAuthority(),
      canonicalBytes,
    }),
    observation,
  );
  await assert.rejects(
    validateB3ProofObservation(observation, {
      command,
      buildAuthority: buildAuthority(),
      canonicalBytes: JSON.stringify(
        Object.fromEntries(Object.entries(observation).reverse()),
      ),
    }),
    /canonical/i,
  );

  const staleCommand = launchCommand({
    expectedSequence: 2,
    previousObservationSha256: HASH_B,
  });
  const stale = { ...observation, sequence: 2, previousObservationSha256: HASH_B };
  await assert.rejects(
    validateB3ProofObservation(stale, {
      command: staleCommand,
      buildAuthority: buildAuthority(),
    }),
    /prior chain/i,
  );

  const accessor = {};
  Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 1 });
  assert.throws(() => canonicaliseB3ProofValue(accessor), /data fields/i);
  const sparse = [];
  sparse.length = 1;
  assert.throws(() => canonicaliseB3ProofValue(sparse), /dense/i);

  await assert.rejects(createB3ProofObservation({
    command,
    buildAuthority: buildAuthority(),
    installationId: INSTALLATION_ID,
    sequence: 1,
    scenario: 'product-query',
    phase: 'COMPLETE',
    nextActionCode: 'COMPLETE_CAPTURE',
    completedTransitions: ['UNBOUND', 'ARMED', 'COMPLETE'],
    proofProjection: proofProjection(),
    observedAt: '2026-07-15T10:00:00.000Z',
  }), /illegal edge/i);

  const wrongHold = launchCommand({ actionCode: 'ARM_GATEWAY_COMPLETION_HOLD' });
  const wrongHoldObservation = { ...observation };
  await assert.rejects(
    validateB3ProofObservation(wrongHoldObservation, {
      command: wrongHold,
      buildAuthority: buildAuthority(),
    }),
    /applicable|initial/i,
  );

  const iosHoldCommand = launchCommand({
    expectedScenarioIndex: 3,
    expectedSequence: 2,
    previousObservationSha256: HASH_B,
    actionCode: 'ARM_GATEWAY_COMPLETION_HOLD',
  });
  const iosHold = await createB3ProofObservation({
    command: iosHoldCommand,
    buildAuthority: buildAuthority(),
    installationId: INSTALLATION_ID,
    sequence: 2,
    scenario: 'normal-purchase',
    phase: 'HOLD_REACHED',
    nextActionCode: 'RELAUNCH',
    completedTransitions: ['HOLD_REACHED'],
    proofProjection: proofProjection({
      scenarioOutcome: 'verified-active',
      entitlementState: 'active',
      storeEvents: [{ operation: 'purchase', outcome: 'purchased' }],
      gatewayCalls: [gatewayCall('verify', 'transaction-verification')],
    }),
    observedAt: '2026-07-15T10:00:00.000Z',
  });
  assert.equal(
    (await validateB3ProofObservationForPublication(iosHold, {
      command: iosHoldCommand,
      buildAuthority: buildAuthority(),
    })).phase,
    'HOLD_REACHED',
  );
});

test('build authority is domain-bound to the exact command and async validation snapshots inputs', async () => {
  const command = launchCommand();
  const authority = buildAuthority();
  const expectedBuildAuthoritySha256 = await deriveB3ProofBuildAuthoritySha256({
    command,
    buildAuthority: authority,
  });
  const observation = await createB3ProofObservation({
    command,
    buildAuthority: authority,
    installationId: INSTALLATION_ID,
    sequence: 1,
    scenario: 'product-query',
    phase: 'ARMED',
    nextActionCode: 'QUERY_PRODUCT',
    completedTransitions: ['UNBOUND', 'ARMED'],
    proofProjection: proofProjection(),
    observedAt: '2026-07-15T10:00:00.000Z',
  });
  assert.equal(observation.buildAuthoritySha256, expectedBuildAuthoritySha256);

  const pending = validateB3ProofObservation(observation, {
    command,
    buildAuthority: authority,
  });
  observation.proofProjection.packState = 'installed';
  command.actionCode = 'COMPLETE_CAPTURE';
  authority.buildNumber = '2';
  const validated = await pending;
  assert.equal(validated.proofProjection.packState, 'absent');
  assert.equal(validated.phase, 'ARMED');

  await assert.rejects(validateB3ProofObservation(validated, {
    command: launchCommand(),
    buildAuthority: buildAuthority({ buildNumber: '2' }),
  }), /build authority/i);
});

test('host chain links prior action and phase and rejects premature or duplicate terminals', async () => {
  const authority = buildAuthority();
  const firstCommand = launchCommand();
  const first = await createB3ProofObservation({
    command: firstCommand,
    buildAuthority: authority,
    installationId: INSTALLATION_ID,
    sequence: 1,
    scenario: 'product-query',
    phase: 'ARMED',
    nextActionCode: 'QUERY_PRODUCT',
    completedTransitions: ['UNBOUND', 'ARMED'],
    proofProjection: proofProjection(),
    observedAt: '2026-07-15T10:00:00.000Z',
  });
  const secondCommand = launchCommand({
    expectedSequence: 2,
    previousObservationSha256: first.observationSha256,
    actionCode: 'QUERY_PRODUCT',
  });
  const second = await createB3ProofObservation({
    command: secondCommand,
    buildAuthority: authority,
    installationId: INSTALLATION_ID,
    sequence: 2,
    scenario: 'product-query',
    phase: 'SCENARIO_COMPLETE',
    nextActionCode: 'ARM_CAPTURE',
    completedTransitions: [
      'UNBOUND', 'ARMED', 'WAITING_OPERATOR', 'OBSERVING', 'SCENARIO_COMPLETE',
    ],
    proofProjection: proofProjection({
      scenarioOutcome: 'products-visible',
      storeEvents: [{ operation: 'queryProducts', outcome: 'products-visible' }],
    }),
    observedAt: '2026-07-15T10:00:01.000Z',
  });
  assert.equal((await validateB3ProofObservation(second, {
    command: secondCommand,
    buildAuthority: authority,
    previousObservation: first,
  })).phase, 'SCENARIO_COMPLETE');

  await assert.rejects(validateB3ProofObservation(second, {
    command: { ...secondCommand, actionCode: 'OBSERVE' },
    buildAuthority: authority,
    previousObservation: first,
  }), /prior next action/i);

  const prematureCommand = { ...secondCommand, expectedScenarioIndex: 1 };
  const premature = {
    ...second,
    scenarioIndex: 1,
    scenario: 'cancel',
    proofProjection: proofProjection({
      scenarioOutcome: 'cancelled',
      storeEvents: [{ operation: 'purchase', outcome: 'cancelled' }],
    }),
  };
  await assert.rejects(validateB3ProofObservation(premature, {
    command: prematureCommand,
    buildAuthority: authority,
    previousObservation: first,
  }), /scenario.*complet/i);

  const firstComplete = await createB3ProofObservation({
    command: firstCommand,
    buildAuthority: authority,
    installationId: INSTALLATION_ID,
    sequence: 1,
    scenario: 'product-query',
    phase: 'SCENARIO_COMPLETE',
    nextActionCode: 'ARM_CAPTURE',
    completedTransitions: ['UNBOUND', 'ARMED', 'OBSERVING', 'SCENARIO_COMPLETE'],
    proofProjection: proofProjection({
      scenarioOutcome: 'products-visible',
      storeEvents: [{ operation: 'queryProducts', outcome: 'products-visible' }],
    }),
    observedAt: '2026-07-15T10:00:00.000Z',
  });
  const duplicateCommand = launchCommand({
    expectedSequence: 2,
    previousObservationSha256: firstComplete.observationSha256,
    actionCode: 'ARM_CAPTURE',
  });
  const duplicate = await createB3ProofObservation({
    command: duplicateCommand,
    buildAuthority: authority,
    installationId: INSTALLATION_ID,
    sequence: 2,
    scenario: 'product-query',
    phase: 'ARMED',
    nextActionCode: 'QUERY_PRODUCT',
    completedTransitions: ['ARMED'],
    proofProjection: proofProjection(),
    observedAt: '2026-07-15T10:00:01.000Z',
  });
  await assert.rejects(validateB3ProofObservation(duplicate, {
    command: duplicateCommand,
    buildAuthority: authority,
    previousObservation: firstComplete,
  }), /duplicate|completed scenario/i);

  const terminalCommand = launchCommand({ actionCode: 'COMPLETE_CAPTURE' });
  await assert.rejects(createB3ProofObservation({
    command: terminalCommand,
    buildAuthority: authority,
    installationId: INSTALLATION_ID,
    sequence: 1,
    scenario: 'product-query',
    phase: 'COMPLETE',
    nextActionCode: 'COMPLETE_CAPTURE',
    completedTransitions: ['COMPLETE'],
    proofProjection: proofProjection(),
    observedAt: '2026-07-15T10:00:00.000Z',
  }), /applicable|initial|sequence|transition/i);
});

test('host chain accepts cumulative transition prefixes without launching host-only wait checkpoints', async () => {
  const authority = buildAuthority();
  const armCommand = launchCommand();
  const armed = await createB3ProofObservation({
    command: armCommand,
    buildAuthority: authority,
    installationId: INSTALLATION_ID,
    sequence: 1,
    scenario: 'product-query',
    phase: 'ARMED',
    nextActionCode: 'QUERY_PRODUCT',
    completedTransitions: ['UNBOUND', 'ARMED'],
    proofProjection: proofProjection(),
    observedAt: '2026-07-15T10:00:00.000Z',
  });
  const queryCommand = launchCommand({
    expectedSequence: 2,
    previousObservationSha256: armed.observationSha256,
    actionCode: 'QUERY_PRODUCT',
  });
  const completed = await createB3ProofObservation({
    command: queryCommand,
    buildAuthority: authority,
    installationId: INSTALLATION_ID,
    sequence: 2,
    scenario: 'product-query',
    phase: 'SCENARIO_COMPLETE',
    nextActionCode: 'ARM_CAPTURE',
    completedTransitions: [
      'UNBOUND', 'ARMED', 'WAITING_OPERATOR', 'OBSERVING', 'SCENARIO_COMPLETE',
    ],
    proofProjection: proofProjection({
      scenarioOutcome: 'products-visible',
      storeEvents: [{ operation: 'queryProducts', outcome: 'products-visible' }],
    }),
    observedAt: '2026-07-15T10:00:01.000Z',
  });

  assert.equal((await validateB3ProofObservation(completed, {
    command: queryCommand,
    buildAuthority: authority,
    previousObservation: armed,
  })).phase, 'SCENARIO_COMPLETE');
});

test('host-owned force-stop bridges the iOS hold into a fresh relaunch observation', async () => {
  const authority = buildAuthority();
  const holdCommand = launchCommand({
    expectedScenarioIndex: 3,
    expectedSequence: 2,
    previousObservationSha256: HASH_B,
    actionCode: 'ARM_GATEWAY_COMPLETION_HOLD',
  });
  const held = await createB3ProofObservation({
    command: holdCommand,
    buildAuthority: authority,
    installationId: INSTALLATION_ID,
    sequence: 2,
    scenario: 'normal-purchase',
    phase: 'HOLD_REACHED',
    nextActionCode: 'RELAUNCH',
    completedTransitions: [
      'UNBOUND', 'ARMED', 'WAITING_OPERATOR', 'OBSERVING', 'HOLD_REACHED',
    ],
    proofProjection: proofProjection({
      scenarioOutcome: 'verified-active',
      entitlementState: 'active',
      storeEvents: [{ operation: 'purchase', outcome: 'purchased' }],
      gatewayCalls: [gatewayCall('verify', 'transaction-verification')],
    }),
    observedAt: '2026-07-15T10:00:00.000Z',
  });
  const relaunchCommand = launchCommand({
    expectedScenarioIndex: 4,
    expectedSequence: 3,
    previousObservationSha256: held.observationSha256,
    actionCode: 'RELAUNCH',
  });
  const recovered = await createB3ProofObservation({
    command: relaunchCommand,
    buildAuthority: authority,
    installationId: INSTALLATION_ID,
    sequence: 3,
    scenario: 'unfinished-relaunch',
    phase: 'SCENARIO_COMPLETE',
    nextActionCode: 'ARM_CAPTURE',
    completedTransitions: [
      'HOST_FORCE_STOP', 'RELAUNCH_RECOVERY', 'SCENARIO_COMPLETE',
    ],
    proofProjection: proofProjection({
      scenarioOutcome: 'finished-recovered',
      entitlementState: 'active',
      storeCompletionObserved: true,
      gatewayCalls: [
        gatewayCall('verify', 'recovery-reverification', '2'),
        gatewayCall('complete', 'completion-of-prior-verify', '3'),
        gatewayCall('authorise', 'download-job-authorisation', '4'),
        gatewayCall('refresh', 'post-recovery-handle-refresh', '5'),
      ],
    }),
    observedAt: '2026-07-15T10:00:01.000Z',
  });

  assert.equal((await validateB3ProofObservation(recovered, {
    command: relaunchCommand,
    buildAuthority: authority,
    previousObservation: held,
  })).scenario, 'unfinished-relaunch');
});

test('host-owned Android store decisions are proved by the next fresh process', async () => {
  const authority = buildAuthority({ platform: 'android', distribution: 'play-internal', buildNumber: 1 });
  const pendingDeclineCommand = launchCommand({
    platform: 'android-play-physical',
    expectedScenarioIndex: 2,
    expectedSequence: 4,
    previousObservationSha256: HASH_B,
    actionCode: 'INITIATE_PURCHASE',
  });
  const pendingDecline = await createB3ProofObservation({
    command: pendingDeclineCommand,
    buildAuthority: authority,
    installationId: INSTALLATION_ID,
    sequence: 4,
    scenario: 'slow-card-pending-decline',
    phase: 'OBSERVING',
    nextActionCode: 'DECLINE_PENDING_PURCHASE',
    completedTransitions: ['ARMED', 'WAITING_OPERATOR', 'OBSERVING'],
    proofProjection: proofProjection({
      androidStoreAuthority: true,
      storeEvents: [{ operation: 'purchase', outcome: 'pending' }],
    }),
    observedAt: '2026-07-15T10:00:00.000Z',
  });
  const armApproveCommand = launchCommand({
    platform: 'android-play-physical',
    expectedScenarioIndex: 3,
    expectedSequence: 5,
    previousObservationSha256: pendingDecline.observationSha256,
    actionCode: 'ARM_CAPTURE',
    challengeSha256: HASH_B,
  });
  const armApprove = await createB3ProofObservation({
    command: armApproveCommand,
    buildAuthority: authority,
    installationId: INSTALLATION_ID,
    sequence: 5,
    scenario: 'slow-card-pending-approve',
    phase: 'ARMED',
    nextActionCode: 'INITIATE_PURCHASE',
    completedTransitions: ['ARMED'],
    proofProjection: proofProjection({
      androidStoreAuthority: true,
      challengeSha256: HASH_B,
      storeEvents: [{ operation: 'queryTransactions', outcome: 'none' }],
    }),
    observedAt: '2026-07-15T10:00:01.000Z',
  });
  assert.equal((await validateB3ProofObservation(armApprove, {
    command: armApproveCommand,
    buildAuthority: authority,
    previousObservation: pendingDecline,
  })).scenario, 'slow-card-pending-approve');
  const improperlyEntitledAfterDecline = await createB3ProofObservation({
    command: armApproveCommand,
    buildAuthority: authority,
    installationId: INSTALLATION_ID,
    sequence: 5,
    scenario: 'slow-card-pending-approve',
    phase: 'ARMED',
    nextActionCode: 'INITIATE_PURCHASE',
    completedTransitions: ['ARMED'],
    proofProjection: proofProjection({
      androidStoreAuthority: true,
      challengeSha256: HASH_B,
      entitlementState: 'active',
      storeEvents: [{ operation: 'queryTransactions', outcome: 'none' }],
      transactionAuthority: {
        source: 'google-order-id', crossCheckedOnRefresh: false,
        domainSeparatedDigestSha256: 'f'.repeat(64), rawProofCleared: false,
      },
      entitlementAuthority: {
        id: 'full-ks2', state: 'active',
        domainSeparatedDigestSha256: 'e'.repeat(64), refreshHandlePresent: true,
      },
      refreshHandleLifecycle: {
        present: true, positiveVersionObserved: true, rotated: false, deleted: false,
      },
    }),
    observedAt: '2026-07-15T10:00:01.000Z',
  });
  await assert.rejects(validateB3ProofObservation(improperlyEntitledAfterDecline, {
    command: armApproveCommand,
    buildAuthority: authority,
    previousObservation: pendingDecline,
  }), /prior next action|scenario|advance|command/i);

  const pendingApproveCommand = launchCommand({
    platform: 'android-play-physical',
    expectedScenarioIndex: 3,
    expectedSequence: 6,
    previousObservationSha256: armApprove.observationSha256,
    actionCode: 'INITIATE_PURCHASE',
    challengeSha256: HASH_A,
  });
  const pendingApprove = await createB3ProofObservation({
    command: pendingApproveCommand,
    buildAuthority: authority,
    installationId: INSTALLATION_ID,
    sequence: 6,
    scenario: 'slow-card-pending-approve',
    phase: 'OBSERVING',
    nextActionCode: 'APPROVE_PENDING_PURCHASE',
    completedTransitions: ['ARMED', 'WAITING_OPERATOR', 'OBSERVING'],
    proofProjection: proofProjection({
      androidStoreAuthority: true,
      storeEvents: [{ operation: 'purchase', outcome: 'pending' }],
    }),
    observedAt: '2026-07-15T10:00:02.000Z',
  });
  const holdCommand = launchCommand({
    platform: 'android-play-physical',
    expectedScenarioIndex: 4,
    expectedSequence: 7,
    previousObservationSha256: pendingApprove.observationSha256,
    actionCode: 'ARM_GATEWAY_COMPLETION_HOLD',
    challengeSha256: HASH_B,
  });
  const held = await createB3ProofObservation({
    command: holdCommand,
    buildAuthority: authority,
    installationId: INSTALLATION_ID,
    sequence: 7,
    scenario: 'unacknowledged-relaunch',
    phase: 'HOLD_REACHED',
    nextActionCode: 'RELAUNCH',
    completedTransitions: ['ARMED', 'WAITING_OPERATOR', 'OBSERVING', 'HOLD_REACHED'],
    proofProjection: proofProjection({
      androidStoreAuthority: true,
      challengeSha256: HASH_B,
      entitlementState: 'active',
      storeEvents: [
        { operation: 'queryTransactions', outcome: 'purchased' },
      ],
      gatewayCalls: [gatewayCall('verify', 'transaction-verification', '1')],
      transactionAuthority: {
        source: 'google-order-id', crossCheckedOnRefresh: false,
        domainSeparatedDigestSha256: 'f'.repeat(64), rawProofCleared: false,
      },
    }),
    observedAt: '2026-07-15T10:00:03.000Z',
  });
  assert.equal((await validateB3ProofObservation(held, {
    command: holdCommand,
    buildAuthority: authority,
    previousObservation: pendingApprove,
  })).phase, 'HOLD_REACHED');

  const recoveryCommand = launchCommand({
    platform: 'android-play-physical',
    expectedScenarioIndex: 4,
    expectedSequence: 8,
    previousObservationSha256: held.observationSha256,
    actionCode: 'RELAUNCH',
    challengeSha256: HASH_A,
  });
  const recovered = await createB3ProofObservation({
    command: recoveryCommand,
    buildAuthority: authority,
    installationId: INSTALLATION_ID,
    sequence: 8,
    scenario: 'unacknowledged-relaunch',
    phase: 'SCENARIO_COMPLETE',
    nextActionCode: 'ARM_CAPTURE',
    completedTransitions: ['HOST_FORCE_STOP', 'RELAUNCH_RECOVERY', 'SCENARIO_COMPLETE'],
    proofProjection: proofProjection({
      androidStoreAuthority: true,
      challengeSha256: HASH_A,
      scenarioOutcome: 'acknowledged-recovered',
      entitlementState: 'active',
      storeCompletionObserved: true,
      storeEvents: [
        { operation: 'queryTransactions', outcome: 'purchased' },
        { operation: 'finishTransaction', outcome: 'finished' },
      ],
      gatewayCalls: [
        gatewayCall('verify', 'recovery-reverification', '2'),
        gatewayCall('complete', 'completion-of-prior-verify', '3'),
        gatewayCall('authorise', 'download-job-authorisation', '4'),
        gatewayCall('refresh', 'post-recovery-handle-refresh', '5'),
      ],
    }),
    observedAt: '2026-07-15T10:00:04.000Z',
  });
  assert.equal((await validateB3ProofObservation(recovered, {
    command: recoveryCommand,
    buildAuthority: authority,
    previousObservation: held,
  })).scenario, 'unacknowledged-relaunch');
});
