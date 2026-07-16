import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createB3AppServices,
  createGatewayRecorder,
} from '../src/app/create-b3-app-services.js';
import {
  createB3ObservedGateway,
  createB3ObservedStore,
  createB3LiveProofSession,
} from '../src/app/b3-live-proof-composition.js';
import {
  canonicaliseB3ProofValue,
  createB3ProofObservation,
} from '../src/app/b3-live-proof-protocol.js';
import {
  createSelectedAppServices,
  selectNativeAppComposition,
} from '../src/app/create-app-services.js';
import { assertB3ProofObservationPort } from '../src/platform/proof/b3-proof-observation-port.js';
import { createCapacitorB3ProofObservation } from '../src/platform/proof/capacitor-b3-proof-observation.js';
import { seedB2Learners } from '../src/platform/database/b2-seed.js';
import { configureAndMigrateDatabase } from '../src/platform/database/migrate-database.js';
import { createNodeSqliteConnection } from './helpers/node-sqlite-connection.mjs';

const GOOGLE_PRODUCT = Object.freeze({
  productId: 'full_ks2',
  displayName: 'Full KS2',
  description: 'The complete statutory spelling catalogue.',
  displayPrice: '£4.99',
  currencyCode: 'GBP',
});

test('physical gateway recorder starts smoke after exact authorisation and returns production result unchanged', async () => {
  const result = Object.freeze({
    signedManifestEnvelopeBase64: 'ZXhhY3Q=',
    archiveCapability: Object.freeze({ capabilityUrl: 'must-remain-closure-only' }),
  });
  const calls = [];
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const gateway = createGatewayRecorder({
    verifyTransaction: async () => result,
    completeTransaction: async () => result,
    refreshEntitlement: async () => result,
    authorisePackDownload: async () => result,
  }, (envelope) => calls.push(`envelope:${envelope}`), () => {
    calls.push('probe-started');
    return pending;
  });
  assert.equal(await gateway.authorisePackDownload({}), result);
  assert.deepEqual(calls, ['envelope:ZXhhY3Q=', 'probe-started']);
  release();
});

test('gateway smoke observation failures preserve production results and mark proof drift', async () => {
  const result = Object.freeze({ signedManifestEnvelopeBase64: 'ZXhhY3Q=' });
  const rawGateway = {
    verifyTransaction: async () => result,
    completeTransaction: async () => result,
    refreshEntitlement: async () => result,
    authorisePackDownload: async () => result,
  };
  let driftCount = 0;
  const synchronous = createGatewayRecorder(
    rawGateway,
    () => {},
    () => { throw new Error('synchronous proof failure'); },
    () => { driftCount += 1; },
  );
  assert.equal(await synchronous.authorisePackDownload({}), result);
  assert.equal(driftCount, 1);

  const failingMarker = createGatewayRecorder(
    rawGateway,
    () => {},
    () => { throw new Error('synchronous proof failure'); },
    () => { throw new Error('proof drift storage failure'); },
  );
  assert.equal(await failingMarker.authorisePackDownload({}), result);

  const asynchronous = createGatewayRecorder(
    rawGateway,
    () => {},
    async () => { throw new Error('asynchronous proof failure'); },
    () => { driftCount += 1; },
  );
  assert.equal(await asynchronous.authorisePackDownload({}), result);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(driftCount, 2);
});

test('B3 proof observation port is the exact two-method application boundary', () => {
  const port = Object.freeze({
    getLaunchCommand: async () => null,
    publishObservation: async () => undefined,
  });
  assert.equal(assertB3ProofObservationPort(port), port);
  assert.throws(
    () => assertB3ProofObservationPort({ ...port, readArbitraryPath() {} }),
    /observation port/i,
  );
  assert.throws(
    () => assertB3ProofObservationPort({ getLaunchCommand: port.getLaunchCommand }),
    /observation port/i,
  );
});

test('live-proof wrappers preserve validated StorePort and gateway values and errors', async () => {
  const gatewayValue = Object.freeze({ traceId: '018f1d7b-97e8-4a52-8cf2-783e5089c004' });
  const storeValue = Object.freeze({
    store: 'google',
    environment: 'sandbox',
    productId: 'full_ks2',
    outcome: 'cancelled',
    transactionRef: 'cancelled-without-retained-identity',
  });
  const storeError = new Error('same store failure');
  const records = [];
  const session = Object.freeze({
    async observeGatewayCall(operation, invoke) {
      const value = await invoke();
      records.push(`gateway:${operation}`);
      return value;
    },
    observeStoreResult(operation) { records.push(`store:${operation}`); },
  });
  const gateway = createB3ObservedGateway({
    verifyTransaction: async () => gatewayValue,
    completeTransaction: async () => gatewayValue,
    refreshEntitlement: async () => gatewayValue,
    authorisePackDownload: async () => gatewayValue,
  }, session);
  const store = createB3ObservedStore({
    queryProducts: async () => [],
    purchase: async () => storeValue,
    queryTransactions: async () => [],
    restore: async () => { throw storeError; },
    finishTransaction: async () => Object.freeze({ completion: 'finished' }),
    subscribeTransactionUpdates: async () => Object.freeze({ async remove() {} }),
  }, session);

  assert.equal(await gateway.verifyTransaction({}), gatewayValue);
  assert.equal(await store.purchase({}), storeValue);
  await assert.rejects(store.restore({}), (error) => error === storeError);
  assert.deepEqual(records, ['gateway:verify', 'store:purchase']);
});

test('observed StorePort retains only closed redacted outcomes after result validation', async () => {
  const records = [];
  const session = Object.freeze({
    async observeGatewayCall(_operation, invoke) { return invoke(); },
    observeStoreResult(operation, value) { records.push({ operation, value }); },
  });
  const purchased = Object.freeze({
    store: 'google',
    environment: 'sandbox',
    productId: 'full_ks2',
    outcome: 'purchased',
    transactionRef: 'GPA.1234-5678-9012-34567',
    opaqueProof: 'opaque-store-proof-that-must-not-be-retained',
  });
  const store = createB3ObservedStore(Object.freeze({
    async queryProducts() { return Object.freeze([GOOGLE_PRODUCT]); },
    async purchase() { return purchased; },
    async queryTransactions() { return Object.freeze([purchased]); },
    async restore() { return Object.freeze([]); },
    async finishTransaction() { return Object.freeze({ completion: 'finished' }); },
    async subscribeTransactionUpdates() { return Object.freeze({ async remove() {} }); },
  }), session);

  assert.equal(await store.purchase({ productId: 'full_ks2' }), purchased);
  assert.deepEqual(records, [{
    operation: 'purchase',
    value: { operation: 'purchase', outcome: 'purchased' },
  }]);
  assert.doesNotMatch(JSON.stringify(records), /GPA|opaque|proof|transactionRef/u);

  const invalidStore = createB3ObservedStore(Object.freeze({
    async queryProducts() { return Object.freeze([GOOGLE_PRODUCT]); },
    async purchase() { return Object.freeze({ outcome: 'purchased' }); },
    async queryTransactions() { return Object.freeze([]); },
    async restore() { return Object.freeze([]); },
    async finishTransaction() { return Object.freeze({ completion: 'finished' }); },
    async subscribeTransactionUpdates() { return Object.freeze({ async remove() {} }); },
  }), session);
  await assert.rejects(invalidStore.purchase({ productId: 'full_ks2' }), /Store transaction/i);
  assert.equal(records.length, 1);
});

test('proof observation failures never replace a validated 64-transaction StorePort result', async () => {
  const purchased = Object.freeze({
    store: 'google',
    environment: 'sandbox',
    productId: 'full_ks2',
    outcome: 'purchased',
    transactionRef: 'GPA.1234-5678-9012-34567',
    opaqueProof: 'opaque-store-proof',
  });
  const transactions = Object.freeze(Array.from({ length: 64 }, () => purchased));
  const observationFailure = new Error('proof observer failed');
  const store = createB3ObservedStore(Object.freeze({
    async queryProducts() { return Object.freeze([GOOGLE_PRODUCT]); },
    async purchase() { return purchased; },
    async queryTransactions() { return transactions; },
    async restore() { return Object.freeze([]); },
    async finishTransaction() { return Object.freeze({ completion: 'finished' }); },
    async subscribeTransactionUpdates() { return Object.freeze({ async remove() {} }); },
  }), Object.freeze({
    async observeGatewayCall(_operation, invoke) { return invoke(); },
    observeStoreResult() { throw observationFailure; },
  }));

  assert.equal(await store.queryTransactions({ productId: 'full_ks2' }), transactions);
});

test('gateway-completion hold publishes only after durable entitlement and learner state', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'ks2-b3-live-hold-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const connection = createNodeSqliteConnection(join(temporary, 'proof.sqlite'));
  await connection.open();
  t.after(() => connection.close());
  await configureAndMigrateDatabase(connection);
  await seedB2Learners(connection);
  await connection.execute(
    'INSERT INTO app_entitlements (entitlement_id, store, product_id, state, sealed_refresh_handle, refresh_handle_version, verified_at, refreshed_at, revocation_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)',
    ['full-ks2', 'apple', 'uk.eugnel.ks2spelling.fullks2', 'active', 'b3rh1.1.hidden', 1, 100, 100],
  );
  await connection.execute(
    'INSERT INTO transaction_journal (journal_id, store, product_id, store_transaction_id, observation_state, processing_state, opaque_proof, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ['journal', 'apple', 'uk.eugnel.ks2spelling.fullks2', '2000000000000001', 'purchased', 'store-completion-pending', 'hidden-proof', 90, 100],
  );
  await connection.execute(
    'INSERT INTO app_metadata (key, value_json, updated_at) VALUES (?, ?, ?)',
    [
      'b3-proof-installation-v1',
      '{"installationId":"018f1d7b-97e8-4a52-8cf2-783e5089c002"}',
      100,
    ],
  );
  const command = {
    schemaVersion: 1,
    captureId: '018f1d7b-97e8-4a52-8cf2-783e5089c001',
    platform: 'ios-physical',
    testedApplicationCommit: 'c'.repeat(40),
    applicationFingerprint: 'a'.repeat(64),
    expectedScenarioIndex: 3,
    expectedSequence: 4,
    previousObservationSha256: 'd'.repeat(64),
    installationMode: 'existing',
    actionCode: 'ARM_GATEWAY_COMPLETION_HOLD',
    challengeSha256: 'a'.repeat(64),
  };
  const published = [];
  const session = await createB3LiveProofSession({
    command,
    buildAuthority: {
      mode: 'B3SandboxProof', proofKind: 'physical-live', platform: 'ios',
      distribution: 'development', publicSandboxOrigin: 'https://b3-gateway.eugnel.uk',
      workerName: 'ks2-spelling-b3-sandbox', bundleId: 'uk.eugnel.ks2spelling',
      testedApplicationCommit: 'c'.repeat(40), applicationFingerprint: 'a'.repeat(64),
      versionName: '0.3.0-b3', buildNumber: '1',
    },
    connection,
    observationPort: Object.freeze({
      getLaunchCommand: async () => command,
      async publishObservation(value) { published.push(value); },
    }),
    clock: () => Date.parse('2026-07-15T10:00:00.000Z'),
    uuidFactory: () => '018f1d7b-97e8-4a52-8cf2-783e5089c002',
  });
  const gatewayValue = Object.freeze({
    traceId: '018f1d7b-97e8-4a52-8cf2-783e5089c004',
  });
  assert.equal(
    await session.observeGatewayCall('verify', async () => gatewayValue),
    gatewayValue,
  );
  session.observeStoreResult('purchase', {
    operation: 'purchase',
    outcome: 'purchased',
  });

  await connection.execute(
    'UPDATE learner_profiles SET nickname = ? WHERE learner_id = ?',
    ['Real child', 'learner-a'],
  );
  await assert.rejects(
    session.publish({
      phase: 'ARMED',
      nextActionCode: 'ARM_GATEWAY_COMPLETION_HOLD',
      completedTransitions: ['UNBOUND', 'ARMED'],
    }),
    /synthetic learner authority/i,
  );
  await connection.execute(
    'UPDATE learner_profiles SET nickname = ? WHERE learner_id = ?',
    ['Ada', 'learner-a'],
  );

  void session.failureInjector('before:gateway-completion');
  for (let index = 0; index < 20 && published.length === 0; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(published.length, 1);
  assert.equal(published[0].phase, 'HOLD_REACHED');
  assert.equal(published[0].proofProjection.entitlementState, 'active');
  assert.equal(published[0].proofProjection.refreshHandleLifecycle.present, true);
  assert.deepEqual(published[0].proofProjection.gatewayCalls, [{
    operation: 'verify', relation: 'transaction-verification',
    traceId: gatewayValue.traceId,
  }]);
  assert.equal(JSON.stringify(published[0]).includes('2000000000000001'), false);
  assert.equal(JSON.stringify(published[0]).includes('b3rh1.'), false);
});

test('fresh live-proof sessions continue the persisted gateway trace cursor', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'ks2-b3-live-gateway-cursor-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const connection = createNodeSqliteConnection(join(temporary, 'proof.sqlite'));
  await connection.open();
  t.after(() => connection.close());
  await configureAndMigrateDatabase(connection);
  await seedB2Learners(connection);
  const authority = {
    mode: 'B3SandboxProof', proofKind: 'physical-live', platform: 'ios',
    distribution: 'development', publicSandboxOrigin: 'https://b3-gateway.eugnel.uk',
    workerName: 'ks2-spelling-b3-sandbox', bundleId: 'uk.eugnel.ks2spelling',
    testedApplicationCommit: 'c'.repeat(40), applicationFingerprint: 'a'.repeat(64),
    versionName: '0.3.0-b3', buildNumber: '1',
  };
  const published = [];
  const makePort = (command) => Object.freeze({
    async getLaunchCommand() { return command; },
    async publishObservation(value) { published.push(value); },
  });
  const firstCommand = {
    schemaVersion: 1,
    captureId: '018f1d7b-97e8-4a52-8cf2-783e5089c001',
    platform: 'ios-physical',
    testedApplicationCommit: 'c'.repeat(40),
    applicationFingerprint: 'a'.repeat(64),
    expectedScenarioIndex: 4,
    expectedSequence: 1,
    previousObservationSha256: '0'.repeat(64),
    installationMode: 'existing',
    actionCode: 'ARM_CAPTURE',
    challengeSha256: 'a'.repeat(64),
  };
  const first = await createB3LiveProofSession({
    command: firstCommand,
    buildAuthority: authority,
    connection,
    observationPort: makePort(firstCommand),
    clock: () => Date.parse('2026-07-15T10:00:00.000Z'),
    uuidFactory: () => '018f1d7b-97e8-4a52-8cf2-783e5089c002',
  });
  await first.observeGatewayCall('verify', async () => ({
    traceId: '018f1d7b-97e8-4a52-8cf2-000000000001',
  }));
  await first.publish({
    phase: 'ARMED',
    nextActionCode: 'OBSERVE',
    completedTransitions: ['UNBOUND', 'ARMED'],
  });
  await first.observeGatewayCall('complete', async () => ({
    traceId: '018f1d7b-97e8-4a52-8cf2-000000000002',
  }));
  await first.publish({
    phase: 'WAITING_OPERATOR',
    nextActionCode: 'OBSERVE',
    completedTransitions: ['UNBOUND', 'ARMED', 'WAITING_OPERATOR'],
  });
  await assert.rejects(createB3LiveProofSession({
    command: firstCommand,
    buildAuthority: authority,
    connection,
    observationPort: makePort(firstCommand),
  }), /unacknowledged published observation/i);
  const secondCommand = {
    ...firstCommand,
    expectedSequence: 2,
    previousObservationSha256: published[1].observationSha256,
    actionCode: 'RELAUNCH',
    challengeSha256: 'b'.repeat(64),
  };
  const second = await createB3LiveProofSession({
    command: secondCommand,
    buildAuthority: authority,
    connection,
    observationPort: makePort(secondCommand),
    clock: () => Date.parse('2026-07-15T10:00:01.000Z'),
  });
  await second.observeGatewayCall('authorise', async () => ({
    traceId: '018f1d7b-97e8-4a52-8cf2-000000000003',
  }));
  await second.observeGatewayCall('refresh', async () => ({
    traceId: '018f1d7b-97e8-4a52-8cf2-000000000004',
  }));
  await second.publish({
    phase: 'RELAUNCH_RECOVERY',
    nextActionCode: 'OBSERVE',
    completedTransitions: ['RELAUNCH_RECOVERY'],
  });

  assert.deepEqual(
    published.map(({ proofProjection }) => proofProjection.gatewayCalls.map(
      ({ operation, relation }) => ({ operation, relation }),
    )),
    [
      [
        { operation: 'verify', relation: 'recovery-reverification' },
      ],
      [
        { operation: 'complete', relation: 'completion-of-prior-verify' },
      ],
      [
        { operation: 'authorise', relation: 'download-job-authorisation' },
        { operation: 'refresh', relation: 'post-recovery-handle-refresh' },
      ],
    ],
  );
  const nextScenarioCommand = {
    ...firstCommand,
    expectedScenarioIndex: 5,
    expectedSequence: 3,
    previousObservationSha256: published[2].observationSha256,
    actionCode: 'ARM_CAPTURE',
    challengeSha256: 'c'.repeat(64),
  };
  const nextScenario = await createB3LiveProofSession({
    command: nextScenarioCommand,
    buildAuthority: authority,
    connection,
    observationPort: makePort(nextScenarioCommand),
  });
  await nextScenario.observeGatewayCall('authorise', async () => ({
    traceId: '018f1d7b-97e8-4a52-8cf2-000000000001',
  }));
  await assert.rejects(nextScenario.publish({
    phase: 'ARMED',
    nextActionCode: 'INSTALL_PACK',
    completedTransitions: ['ARMED'],
  }), /gateway trace drifted/i);
  await assert.rejects(createB3LiveProofSession({
    command: nextScenarioCommand,
    buildAuthority: authority,
    connection,
    observationPort: makePort(nextScenarioCommand),
  }), /gateway.*drift|continuity/i);
});

test('fresh process fails closed when a successful gateway call was never published', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'ks2-b3-live-unpublished-call-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const connection = createNodeSqliteConnection(join(temporary, 'proof.sqlite'));
  await connection.open();
  t.after(() => connection.close());
  await configureAndMigrateDatabase(connection);
  await seedB2Learners(connection);
  const command = {
    schemaVersion: 1,
    captureId: '018f1d7b-97e8-4a52-8cf2-783e5089c001',
    platform: 'ios-physical',
    testedApplicationCommit: 'c'.repeat(40),
    applicationFingerprint: 'a'.repeat(64),
    expectedScenarioIndex: 4,
    expectedSequence: 1,
    previousObservationSha256: '0'.repeat(64),
    installationMode: 'existing',
    actionCode: 'ARM_CAPTURE',
    challengeSha256: 'a'.repeat(64),
  };
  const authority = {
    mode: 'B3SandboxProof', proofKind: 'physical-live', platform: 'ios',
    distribution: 'development', publicSandboxOrigin: 'https://b3-gateway.eugnel.uk',
    workerName: 'ks2-spelling-b3-sandbox', bundleId: 'uk.eugnel.ks2spelling',
    testedApplicationCommit: 'c'.repeat(40), applicationFingerprint: 'a'.repeat(64),
    versionName: '0.3.0-b3', buildNumber: '1',
  };
  const port = Object.freeze({
    async getLaunchCommand() { return command; },
    async publishObservation() {},
  });
  const first = await createB3LiveProofSession({
    command,
    buildAuthority: authority,
    connection,
    observationPort: port,
    uuidFactory: () => '018f1d7b-97e8-4a52-8cf2-783e5089c002',
  });
  await first.observeGatewayCall('verify', async () => ({
    traceId: '018f1d7b-97e8-4a52-8cf2-000000000001',
  }));

  await assert.rejects(createB3LiveProofSession({
    command: { ...command, expectedSequence: 2, previousObservationSha256: 'b'.repeat(64) },
    buildAuthority: authority,
    connection,
    observationPort: port,
  }), /unpublished|continuity|gateway/i);
  await assert.rejects(createB3LiveProofSession({
    command: {
      ...command,
      expectedScenarioIndex: 5,
      expectedSequence: 2,
      previousObservationSha256: 'b'.repeat(64),
    },
    buildAuthority: authority,
    connection,
    observationPort: port,
  }), /unpublished|continuity|gateway/i);
  await assert.rejects(createB3LiveProofSession({
    command: {
      ...command,
      captureId: '018f1d7b-97e8-4a52-8cf2-783e5089c099',
      expectedSequence: 1,
      previousObservationSha256: '0'.repeat(64),
    },
    buildAuthority: authority,
    connection,
    observationPort: port,
  }), /unpublished|continuity|capture/i);
});

test('pack-install crash resume reuses persisted smoke without rerunning probe or gateway trace', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'ks2-b3-smoke-resume-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const connection = createNodeSqliteConnection(join(temporary, 'proof.sqlite'));
  await connection.open();
  t.after(() => connection.close());
  await configureAndMigrateDatabase(connection);
  await seedB2Learners(connection);
  const manifestSha256 = 'a'.repeat(64);
  const archiveSha256 = 'b'.repeat(64);
  await connection.execute(
    'INSERT INTO app_entitlements (entitlement_id, store, product_id, state, sealed_refresh_handle, refresh_handle_version, verified_at, refreshed_at, revocation_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)',
    ['full-ks2', 'apple', 'uk.eugnel.ks2spelling.fullks2', 'active', 'b3rh1.1.hidden', 1, 100, 100],
  );
  await connection.execute(
    'INSERT INTO transaction_journal (journal_id, store, product_id, store_transaction_id, observation_state, processing_state, opaque_proof, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)',
    ['journal', 'apple', 'uk.eugnel.ks2spelling.fullks2', '2000000000000001', 'purchased', 'complete', 90, 100],
  );
  await connection.execute(
    'INSERT INTO pack_download_jobs (job_id, pack_id, version, manifest_sha256, archive_name, archive_sha256, expected_bytes, completed_bytes, etag, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ['job', 'b3-sandbox-proof', '1.0.0-b3.1', manifestSha256, 'b3-sandbox-proof.zip', archiveSha256, 10, 10, 'c'.repeat(32), 'ready', 100],
  );
  await connection.execute(
    'INSERT INTO installed_pack_versions (pack_id, version, manifest_sha256, path_token, activation_marker_sha256, state, installed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['b3-sandbox-proof', '1.0.0-b3.1', manifestSha256, 'installed/path', 'd'.repeat(64), 'ready', 100],
  );
  await connection.execute(
    'INSERT INTO active_pack_versions (pack_id, version, manifest_sha256, path_token, activated_at) VALUES (?, ?, ?, ?, ?)',
    ['b3-sandbox-proof', '1.0.0-b3.1', manifestSha256, 'installed/path', 100],
  );
  await connection.execute(
    'INSERT INTO app_metadata (key, value_json, updated_at) VALUES (?, ?, ?)',
    ['b3-proof-installation-v1', '{"installationId":"018f1d7b-97e8-4a52-8cf2-783e5089c002"}', 100],
  );
  const command = {
    schemaVersion: 1,
    captureId: '018f1d7b-97e8-4a52-8cf2-783e5089c001',
    platform: 'ios-physical',
    testedApplicationCommit: 'c'.repeat(40),
    applicationFingerprint: 'a'.repeat(64),
    expectedScenarioIndex: 5,
    expectedSequence: 2,
    previousObservationSha256: 'f'.repeat(64),
    installationMode: 'existing',
    actionCode: 'INSTALL_PACK',
    challengeSha256: 'a'.repeat(64),
  };
  const buildAuthority = {
    mode: 'B3SandboxProof', proofKind: 'physical-live', platform: 'ios',
    distribution: 'development', publicSandboxOrigin: 'https://b3-gateway.eugnel.uk',
    workerName: 'ks2-spelling-b3-sandbox', bundleId: 'uk.eugnel.ks2spelling',
    testedApplicationCommit: 'c'.repeat(40), applicationFingerprint: 'a'.repeat(64),
    versionName: '0.3.0-b3', buildNumber: '1',
  };
  const smokeAuthority = {
    schemaVersion: 1,
    deploymentVersionId: 'a8f32f60-16b9-4ca6-9b4a-f771dd5302f7',
    scriptAuthoritySha256: 'e'.repeat(64),
    signedEnvelopeSha256: manifestSha256,
    objects: [
      { role: 'signed-manifest', key: 'packs/b3-sandbox-proof/1.0.0-b3.1/signed-manifest.json', sha256: manifestSha256, size: 1_135, etag: '1'.repeat(32) },
      { role: 'archive', key: 'packs/b3-sandbox-proof/1.0.0-b3.1/b3-sandbox-proof.zip', sha256: archiveSha256, size: 10, etag: '2'.repeat(32) },
    ],
    accessBehaviour: { ttlSeconds: 600, valid: true, tamperedRejected: true, expiredRejected: true, canonicalEncodingRequired: true },
    byteServingBehaviour: { full200: true, partial206: true, conditional304: true, unsatisfied416: true, noRedirects: true, cacheControl: 'private, no-store' },
  };
  let probeCalls = 0;
  const first = await createB3LiveProofSession({
    command, buildAuthority, connection,
    observationPort: Object.freeze({
      async getLaunchCommand() { return command; },
      async publishObservation() { throw new Error('crashed before publication'); },
    }),
    gatewaySmokeProbe: async () => { probeCalls += 1; return smokeAuthority; },
    uuidFactory: () => '018f1d7b-97e8-4a52-8cf2-783e5089c002',
  });
  await first.observeGatewayCall('authorise', async () => ({
    traceId: '018f1d7b-97e8-4a52-8cf2-000000000001',
  }));
  first.observeDownloadAuthorisation({ exact: 'closure-only-authorisation' });
  for (let index = 0; index < 20; index += 1) {
    const rows = await connection.query(
      "SELECT key FROM app_metadata WHERE key IN ('b3-proof-gateway-cursor-v1', 'b3-proof-gateway-smoke-v1') ORDER BY key",
    );
    if (rows.length === 2) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(probeCalls, 1);

  const published = [];
  const resumed = await createB3LiveProofSession({
    command, buildAuthority, connection,
    observationPort: Object.freeze({
      async getLaunchCommand() { return command; },
      async publishObservation(value) { published.push(value); },
    }),
    gatewaySmokeProbe: async () => { probeCalls += 1; throw new Error('must not rerun'); },
  });
  let redownloadCalls = 0;
  await resumed.run({
    async start() {},
    async sync() {},
    async redownload() { redownloadCalls += 1; },
  });
  assert.equal(probeCalls, 1);
  assert.equal(redownloadCalls, 0);
  assert.equal(published.length, 1);
  assert.deepEqual(published[0].proofProjection.gatewayCalls, [{
    operation: 'authorise',
    relation: 'download-capability-authorisation',
    traceId: '018f1d7b-97e8-4a52-8cf2-000000000001',
  }]);
  assert.deepEqual(published[0].proofProjection.gatewaySmokeAuthority, smokeAuthority);
});

test('proof cursor failures preserve gateway values and errors, then fail publication closed', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'ks2-b3-proof-observer-failure-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const base = createNodeSqliteConnection(join(temporary, 'proof.sqlite'));
  await base.open();
  t.after(() => base.close());
  await configureAndMigrateDatabase(base);
  await seedB2Learners(base);
  let rejectCursorWrites = false;
  const cursorFailure = new Error('cursor storage unavailable');
  const connection = Object.freeze({
    query: (...args) => base.query(...args),
    execute(sql, values) {
      if (rejectCursorWrites && values?.[0] === 'b3-proof-gateway-cursor-v1') {
        return Promise.reject(cursorFailure);
      }
      return base.execute(sql, values);
    },
  });
  const command = {
    schemaVersion: 1,
    captureId: '018f1d7b-97e8-4a52-8cf2-783e5089c001',
    platform: 'ios-physical',
    testedApplicationCommit: 'c'.repeat(40),
    applicationFingerprint: 'a'.repeat(64),
    expectedScenarioIndex: 4,
    expectedSequence: 1,
    previousObservationSha256: '0'.repeat(64),
    installationMode: 'existing',
    actionCode: 'ARM_CAPTURE',
    challengeSha256: 'a'.repeat(64),
  };
  const published = [];
  const session = await createB3LiveProofSession({
    command,
    buildAuthority: {
      mode: 'B3SandboxProof', proofKind: 'physical-live', platform: 'ios',
      distribution: 'development', publicSandboxOrigin: 'https://b3-gateway.eugnel.uk',
      workerName: 'ks2-spelling-b3-sandbox', bundleId: 'uk.eugnel.ks2spelling',
      testedApplicationCommit: 'c'.repeat(40), applicationFingerprint: 'a'.repeat(64),
      versionName: '0.3.0-b3', buildNumber: '1',
    },
    connection,
    observationPort: Object.freeze({
      async getLaunchCommand() { return command; },
      async publishObservation(value) { published.push(value); },
    }),
    uuidFactory: () => '018f1d7b-97e8-4a52-8cf2-783e5089c002',
  });
  rejectCursorWrites = true;
  const gatewayValue = Object.freeze({
    traceId: '018f1d7b-97e8-4a52-8cf2-000000000001',
  });
  assert.equal(await session.observeGatewayCall('verify', async () => gatewayValue), gatewayValue);
  const gatewayFailure = new Error('same gateway failure');
  await assert.rejects(
    session.observeGatewayCall('complete', async () => { throw gatewayFailure; }),
    (error) => error === gatewayFailure,
  );
  await assert.rejects(session.publish({
    phase: 'ARMED',
    nextActionCode: 'RELAUNCH',
    completedTransitions: ['UNBOUND', 'ARMED'],
  }), /proof|gateway|cursor|drift/i);
  assert.equal(published.length, 0);
});

test('a clean cursor from another capture cannot be silently reset on the same installation', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'ks2-b3-capture-reset-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const connection = createNodeSqliteConnection(join(temporary, 'proof.sqlite'));
  await connection.open();
  t.after(() => connection.close());
  await configureAndMigrateDatabase(connection);
  await seedB2Learners(connection);
  await connection.execute(
    'INSERT INTO app_metadata (key, value_json, updated_at) VALUES (?, ?, ?)',
    [
      'b3-proof-installation-v1',
      '{"installationId":"018f1d7b-97e8-4a52-8cf2-783e5089c002"}',
      1,
    ],
  );
  await connection.execute(
    'INSERT INTO app_metadata (key, value_json, updated_at) VALUES (?, ?, ?)',
    [
      'b3-proof-gateway-cursor-v1',
      canonicaliseB3ProofValue({
        captureId: '018f1d7b-97e8-4a52-8cf2-783e5089c001',
        scenarioIndex: 0,
        offset: 0,
        pendingCalls: [],
        usedTraceIds: [],
        publishedObservationSha256: null,
        publishedSequence: null,
        drifted: false,
      }),
      1,
    ],
  );
  const command = {
    schemaVersion: 1,
    captureId: '018f1d7b-97e8-4a52-8cf2-783e5089c099',
    platform: 'ios-physical',
    testedApplicationCommit: 'c'.repeat(40),
    applicationFingerprint: 'a'.repeat(64),
    expectedScenarioIndex: 0,
    expectedSequence: 1,
    previousObservationSha256: '0'.repeat(64),
    installationMode: 'existing',
    actionCode: 'ARM_CAPTURE',
    challengeSha256: 'a'.repeat(64),
  };
  await assert.rejects(createB3LiveProofSession({
    command,
    buildAuthority: {
      mode: 'B3SandboxProof', proofKind: 'physical-live', platform: 'ios',
      distribution: 'development', publicSandboxOrigin: 'https://b3-gateway.eugnel.uk',
      workerName: 'ks2-spelling-b3-sandbox', bundleId: 'uk.eugnel.ks2spelling',
      testedApplicationCommit: 'c'.repeat(40), applicationFingerprint: 'a'.repeat(64),
      versionName: '0.3.0-b3', buildNumber: '1',
    },
    connection,
    observationPort: Object.freeze({
      async getLaunchCommand() { return command; },
      async publishObservation() {},
    }),
  }), /capture|continuity/i);
});

test('multiple distinct relevant store transaction identifiers fail closed', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'ks2-b3-transaction-authority-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const connection = createNodeSqliteConnection(join(temporary, 'proof.sqlite'));
  await connection.open();
  t.after(() => connection.close());
  await configureAndMigrateDatabase(connection);
  await seedB2Learners(connection);
  for (const [index, transactionId] of ['2000000000000001', '2000000000000002'].entries()) {
    await connection.execute(
      'INSERT INTO transaction_journal (journal_id, store, product_id, store_transaction_id, observation_state, processing_state, opaque_proof, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)',
      [`journal-${index}`, 'apple', 'uk.eugnel.ks2spelling.fullks2', transactionId, 'purchased', 'complete', index + 1, index + 1],
    );
  }
  const command = {
    schemaVersion: 1,
    captureId: '018f1d7b-97e8-4a52-8cf2-783e5089c001',
    platform: 'ios-physical',
    testedApplicationCommit: 'c'.repeat(40),
    applicationFingerprint: 'a'.repeat(64),
    expectedScenarioIndex: 0,
    expectedSequence: 1,
    previousObservationSha256: '0'.repeat(64),
    installationMode: 'existing',
    actionCode: 'ARM_CAPTURE',
    challengeSha256: 'a'.repeat(64),
  };
  const session = await createB3LiveProofSession({
    command,
    buildAuthority: {
      mode: 'B3SandboxProof', proofKind: 'physical-live', platform: 'ios',
      distribution: 'development', publicSandboxOrigin: 'https://b3-gateway.eugnel.uk',
      workerName: 'ks2-spelling-b3-sandbox', bundleId: 'uk.eugnel.ks2spelling',
      testedApplicationCommit: 'c'.repeat(40), applicationFingerprint: 'a'.repeat(64),
      versionName: '0.3.0-b3', buildNumber: '1',
    },
    connection,
    observationPort: Object.freeze({
      async getLaunchCommand() { return command; },
      async publishObservation() {},
    }),
    uuidFactory: () => '018f1d7b-97e8-4a52-8cf2-783e5089c002',
  });
  await assert.rejects(session.publish({
    phase: 'ARMED',
    nextActionCode: 'QUERY_PRODUCT',
    completedTransitions: ['UNBOUND', 'ARMED'],
  }), /transaction authority is ambiguous/i);
});

test('active pack authority rejects a missing exact ready download job', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'ks2-b3-live-pack-authority-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const connection = createNodeSqliteConnection(join(temporary, 'proof.sqlite'));
  await connection.open();
  t.after(() => connection.close());
  await configureAndMigrateDatabase(connection);
  await seedB2Learners(connection);
  await connection.execute(
    'INSERT INTO installed_pack_versions (pack_id, version, manifest_sha256, path_token, activation_marker_sha256, state, installed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['b3-sandbox-proof', '1.0.0-b3.1', 'a'.repeat(64), 'installed/path', 'b'.repeat(64), 'ready', 1],
  );
  await connection.execute(
    'INSERT INTO active_pack_versions (pack_id, version, manifest_sha256, path_token, activated_at) VALUES (?, ?, ?, ?, ?)',
    ['b3-sandbox-proof', '1.0.0-b3.1', 'a'.repeat(64), 'installed/path', 1],
  );
  const command = {
    schemaVersion: 1,
    captureId: '018f1d7b-97e8-4a52-8cf2-783e5089c001',
    platform: 'ios-physical',
    testedApplicationCommit: 'c'.repeat(40),
    applicationFingerprint: 'a'.repeat(64),
    expectedScenarioIndex: 5,
    expectedSequence: 1,
    previousObservationSha256: '0'.repeat(64),
    installationMode: 'existing',
    actionCode: 'ARM_CAPTURE',
    challengeSha256: 'a'.repeat(64),
  };
  const session = await createB3LiveProofSession({
    command,
    buildAuthority: {
      mode: 'B3SandboxProof', proofKind: 'physical-live', platform: 'ios',
      distribution: 'development', publicSandboxOrigin: 'https://b3-gateway.eugnel.uk',
      workerName: 'ks2-spelling-b3-sandbox', bundleId: 'uk.eugnel.ks2spelling',
      testedApplicationCommit: 'c'.repeat(40), applicationFingerprint: 'a'.repeat(64),
      versionName: '0.3.0-b3', buildNumber: '1',
    },
    connection,
    observationPort: Object.freeze({
      async getLaunchCommand() { return command; },
      async publishObservation() {},
    }),
    uuidFactory: () => '018f1d7b-97e8-4a52-8cf2-783e5089c002',
  });
  await assert.rejects(session.publish({
    phase: 'ARMED',
    nextActionCode: 'INSTALL_PACK',
    completedTransitions: ['UNBOUND', 'ARMED'],
  }), /active pack authority drifted/i);
});

test('Capacitor proof observation adapter validates commands and publishes canonical observations', async () => {
  const command = {
    schemaVersion: 1,
    captureId: '018f1d7b-97e8-4a52-8cf2-783e5089c001',
    platform: 'ios-physical',
    testedApplicationCommit: 'c'.repeat(40),
    applicationFingerprint: 'a'.repeat(64),
    expectedScenarioIndex: 0,
    expectedSequence: 1,
    previousObservationSha256: '0'.repeat(64),
    installationMode: 'existing',
    actionCode: 'ARM_CAPTURE',
    challengeSha256: 'a'.repeat(64),
  };
  const writes = [];
  const buildAuthority = {
    mode: 'B3SandboxProof', proofKind: 'physical-live', platform: 'ios',
    distribution: 'development', publicSandboxOrigin: 'https://b3-gateway.eugnel.uk',
    workerName: 'ks2-spelling-b3-sandbox', bundleId: 'uk.eugnel.ks2spelling',
    testedApplicationCommit: 'c'.repeat(40), applicationFingerprint: 'a'.repeat(64),
    versionName: '0.3.0-b3', buildNumber: '1',
  };
  const adapter = createCapacitorB3ProofObservation({
    buildAuthority,
    plugin: Object.freeze({
      async getLaunchCommand() {
        return { commandJson: canonicaliseB3ProofValue(command) };
      },
      async publishObservation(value) {
        writes.push(value);
        return { written: true };
      },
    }),
  });
  assert.deepEqual(await adapter.getLaunchCommand(), command);
  const observation = await createB3ProofObservation({
    command,
    buildAuthority,
    installationId: '018f1d7b-97e8-4a52-8cf2-783e5089c002',
    sequence: 1,
    scenario: 'product-query',
    phase: 'ARMED',
    nextActionCode: 'QUERY_PRODUCT',
    completedTransitions: ['UNBOUND', 'ARMED'],
    proofProjection: {
      challengeSha256: 'a'.repeat(64), scenarioOutcome: 'in-progress',
      entitlementState: 'none', packState: 'absent',
      storeCompletionObserved: false,
      storeEvents: [],
      storeAuthority: {
        environment: 'sandbox', productId: 'uk.eugnel.ks2spelling.fullks2',
        localisedPriceObserved: false, completionState: 'not-observed',
      },
      gatewayCalls: [],
      gatewaySmokeAuthority: null,
      syntheticLearners: { syntheticAuthorityMatched: true, positionalSnapshotSha256: ['a'.repeat(64), 'b'.repeat(64)] },
      transactionAuthority: {
        source: 'none', crossCheckedOnRefresh: false,
        domainSeparatedDigestSha256: null, rawProofCleared: false,
      },
      refreshHandleLifecycle: { present: false, positiveVersionObserved: false, rotated: false, deleted: false },
      entitlementAuthority: { id: null, state: 'none', domainSeparatedDigestSha256: null, refreshHandlePresent: false },
      packAuthority: { packId: null, manifestSha256: null, archiveSha256: null, installed: false },
      transportAuthority: {
        storeAdapter: 'concreteCapacitorStore', gatewayAdapter: 'concreteHttpGateway',
        serverUrl: null, nativeOriginAllowed: true, noRedirects: true,
      },
    },
    observedAt: '2026-07-15T10:00:00.000Z',
  });

  await adapter.publishObservation(observation);

  assert.deepEqual(writes, [{
    canonicalJson: canonicaliseB3ProofValue(observation),
  }]);
  const hostile = createCapacitorB3ProofObservation({
    buildAuthority,
    plugin: Object.freeze({
      async getLaunchCommand() { return { commandJson: '{"evidence":true}' }; },
      async publishObservation() { return { written: true }; },
    }),
  });
  await assert.rejects(hostile.getLaunchCommand(), /command|schema/i);
  for (const commandJson of [
    JSON.stringify(command),
    canonicaliseB3ProofValue(command).replace(
      '"actionCode":"ARM_CAPTURE"',
      '"actionCode":"ARM_CAPTURE","actionCode":"ARM_CAPTURE"',
    ),
  ]) {
    const nonCanonical = createCapacitorB3ProofObservation({
      buildAuthority,
      plugin: Object.freeze({
        async getLaunchCommand() { return { commandJson }; },
        async publishObservation() { return { written: true }; },
      }),
    });
    await assert.rejects(nonCanonical.getLaunchCommand(), /canonical|command/i);
  }
});

function createDelayedEntitlementConnection(filename, events = []) {
  const base = createNodeSqliteConnection(filename);
  let remainingMatches = 0;
  let releaseQuery = null;
  let queryStarted = null;

  const connection = Object.freeze({
    async open() { return base.open(); },
    async close() {
      events.push('connection-closed');
      return base.close();
    },
    async execute(sql, values) { return base.execute(sql, values); },
    async query(sql, values) {
      if (remainingMatches > 0 && /\bFROM app_entitlements\b/.test(sql)) {
        remainingMatches -= 1;
        if (remainingMatches === 0) {
          queryStarted?.();
          await new Promise((resolve) => { releaseQuery = resolve; });
        }
      }
      return base.query(sql, values);
    },
    async begin() { return base.begin(); },
    async commit() { return base.commit(); },
    async rollback() { return base.rollback(); },
    async isTransactionActive() { return base.isTransactionActive(); },
  });

  return Object.freeze({
    connection,
    arm(matchNumber = 2) {
      remainingMatches = matchNumber;
      return new Promise((resolve) => { queryStarted = resolve; });
    },
    release() {
      events.push('refresh-released');
      releaseQuery?.();
    },
  });
}

test('browser test composition migrates and reaches ready using deterministic B3 fakes', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'ks2-b3-composition-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const services = await createSelectedAppServices({
    buildMode: 'B3DeterministicTest',
    isNativePlatform: false,
    platform: 'web',
    b3Options: {
      connectionFactory: () => createNodeSqliteConnection(join(temporary, 'proof.sqlite')),
    },
  });
  t.after(() => services.dispose());

  const state = await services.controller.start();

  assert.equal(services.mode, 'b3-parent-proof');
  assert.equal(services.adapterKind, 'deterministic-fake');
  assert.equal(state.status, 'ready');
  assert.equal(state.displayPrice, '£4.99');
  assert.equal(state.packReady, false);
  assert.match(state.digests.manifest, /^[a-f0-9]{64}$/);
  assert.match(state.digests.archive, /^[a-f0-9]{64}$/);
  assert.equal(state.digests.install, null);
  assert.deepEqual(services.startupSequence, [
    'database-migrated',
    'packs-reconciled',
    'build-authority-selected',
    'commerce-adapters-composed',
    'transactions-subscribed-replayed',
    'refresh-handles-refreshed',
    'ready',
  ]);
});

test('native B3 authority rejects missing or fake proof before owned resources open', async () => {
  let connectionAttempts = 0;
  const connectionFactory = () => {
    connectionAttempts += 1;
    throw new Error('must not open');
  };
  const base = {
    isNativePlatform: true,
    platform: 'ios',
  };

  await assert.rejects(
    createB3AppServices({ runtime: Object.freeze(base), connectionFactory }),
    /embedded build authority/i,
  );
  await assert.rejects(
    createB3AppServices({
      runtime: Object.freeze({
        ...base,
        buildAuthority: Object.freeze({
          mode: 'B3SandboxProof',
          proofKind: 'fake-transcript',
          platform: 'ios',
          distribution: 'development',
          publicSandboxOrigin: 'https://b3-gateway.eugnel.uk',
          workerName: 'ks2-spelling-b3-sandbox',
          bundleId: 'uk.eugnel.ks2spelling',
          testedApplicationCommit: 'c'.repeat(40),
          applicationFingerprint: 'a'.repeat(64),
          versionName: '0.3.0-b3',
          buildNumber: '1',
        }),
      }),
      connectionFactory,
    }),
    /physical live proof/i,
  );
  assert.equal(connectionAttempts, 0);
});

test('runtime callers cannot force live browser composition or fake physical adapters', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'ks2-b3-mode-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  let databaseIndex = 0;
  const connectionFactory = () => createNodeSqliteConnection(
    join(temporary, `proof-${databaseIndex += 1}.sqlite`),
  );
  const liveAuthority = Object.freeze({
    mode: 'B3SandboxProof',
    proofKind: 'physical-live',
    platform: 'ios',
    distribution: 'development',
    publicSandboxOrigin: 'https://b3-gateway.eugnel.uk',
    workerName: 'ks2-spelling-b3-sandbox',
  });
  await assert.rejects(
    createB3AppServices({
      runtime: Object.freeze({
        isNativePlatform: false,
        platform: 'web',
        buildAuthority: liveAuthority,
      }),
      connectionFactory,
    }),
    /cannot accept native build authority/i,
  );
  await assert.rejects(
    createB3AppServices({
      runtime: Object.freeze({
        isNativePlatform: true,
        platform: 'ios',
        buildAuthority: liveAuthority,
      }),
      fakeStoreOptions: {},
      connectionFactory,
    }),
    /does not accept fake adapters/i,
  );
});

test('tracked B3SandboxProof build mode selects B3 services without a runtime or UI toggle', () => {
  assert.deepEqual(
    selectNativeAppComposition({ buildMode: 'B3SandboxProof', platform: 'ios' }),
    {
      serviceMode: 'b3',
      runtime: {
        isNativePlatform: true,
        platform: 'ios',
        buildAuthority: {
          mode: 'B3SandboxProof',
          proofKind: 'physical-live',
          platform: 'ios',
          distribution: 'development',
          publicSandboxOrigin: 'https://b3-gateway.eugnel.uk',
          workerName: 'ks2-spelling-b3-sandbox',
        },
      },
    },
  );
  assert.deepEqual(
    selectNativeAppComposition({ buildMode: 'production', platform: 'android' }),
    { serviceMode: 'b2', runtime: null },
  );
});

test('composed deterministic fakes complete purchase, signed download and install', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'ks2-b3-e2e-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const envelope = await readFile(
    new URL('fixtures/b3-signed-manifest.json', import.meta.url),
  );
  const signedManifestEnvelopeBase64 = envelope.toString('base64');
  const identity = {
    store: 'google', productId: 'full_ks2', environment: 'sandbox',
    applicationId: 'uk.eugnel.ks2spelling', entitlementId: 'full-ks2',
    state: 'active', storeTransactionId: 'GPA.1234-5678-9012-34567',
    sealedRefreshHandle: 'b3rh1.1.test-nonce.test-ciphertext',
    refreshHandleVersion: 1, workerVersionId: 'worker-test',
    workerScriptAuthoritySha256: 'a'.repeat(64),
  };
  const authorisation = {
    ...identity,
    packId: 'b3-sandbox-proof', version: '1.0.0-b3.1',
    signedManifestEnvelopeBase64,
    signedEnvelopeSha256: '39b6a788a3686d7cbf1fd4791bce45623af21ef53c60eabc03d955395856218a',
    objects: [
      { objectKind: 'manifest', sha256: '39b6a788a3686d7cbf1fd4791bce45623af21ef53c60eabc03d955395856218a', size: 1_135, etag: 'c76b2858b8345814279a1c92ae64e365' },
      { objectKind: 'archive', sha256: '4c2ca2eb4d4bb7ac3347b66e3483dcb6aa71b41958704733bfc471c970ce7664', size: 1_324, etag: '913d2b2485ca6cd31d467bd7228d7e75' },
    ],
    archiveCapability: {
      packId: 'b3-sandbox-proof', version: '1.0.0-b3.1',
      archiveName: 'b3-sandbox-proof.zip',
      sha256: '4c2ca2eb4d4bb7ac3347b66e3483dcb6aa71b41958704733bfc471c970ce7664',
      compressedBytes: 1_324, etag: '913d2b2485ca6cd31d467bd7228d7e75',
      capabilityUrl: 'https://b3-gateway.eugnel.uk/v1/packs/b3-sandbox-proof/1.0.0-b3.1/b3-sandbox-proof.zip?expires=1783987200&cap=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    },
  };
  const inspection = {
    archiveSha256: '4c2ca2eb4d4bb7ac3347b66e3483dcb6aa71b41958704733bfc471c970ce7664',
    manifestSha256: '39b6a788a3686d7cbf1fd4791bce45623af21ef53c60eabc03d955395856218a',
    extractedBytes: 1_082, fileCount: 2,
    stagingToken: 'staging/b3-sandbox-proof/1.0.0-b3.1',
  };
  const services = await createB3AppServices({
    runtime: Object.freeze({ isNativePlatform: false, platform: 'web' }),
    connectionFactory: () => createNodeSqliteConnection(join(temporary, 'proof.sqlite')),
    clock: () => 1_783_986_900_000,
    fakeStoreOptions: {
      purchaseOutcomes: [{
        store: 'google', environment: 'sandbox', productId: 'full_ks2',
        outcome: 'purchased', transactionRef: 'native-purchased',
        opaqueProof: 'sandbox-purchase-proof',
      }],
      transactionOutcomes: [[], [], [], [], [], []],
    },
    fakeGatewayOptions: {
      verifyOutcomes: [identity], completeOutcomes: [identity],
      authoriseOutcomes: [authorisation, authorisation],
    },
    fakePackTransferOptions: {
      freeByteOutcomes: [64 * 1024 * 1024],
      downloadOutcomes: [{
        status: 206, startByte: 0, endByteExclusive: 1_324,
        totalBytes: 1_324, bytesWritten: 1_324,
        etag: '913d2b2485ca6cd31d467bd7228d7e75',
      }],
      inspectOutcomes: [inspection, inspection],
      inventoryOutcomes: [[], []],
      sealOutcomes: [{
        installedPathToken: 'installed/b3-sandbox-proof/1.0.0-b3.1',
        activationMarkerSha256: 'd'.repeat(64),
      }],
    },
  });
  t.after(() => services.dispose());
  const transitions = [];
  services.controller.subscribe((state) => transitions.push(state.status));

  await services.controller.start();
  const installed = await services.controller.buy();

  assert.deepEqual(transitions, [
    'ready', 'purchasing', 'entitled', 'downloading', 'installed',
  ]);
  assert.equal(installed.packReady, true);
  assert.equal(installed.digests.install, 'd'.repeat(64));
});

test('store product outage returns calm failed state instead of tearing down local composition', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'ks2-b3-product-offline-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const outage = Object.assign(new Error('offline private detail'), {
    code: 'STORE_NATIVE_FAILURE',
  });
  const services = await createB3AppServices({
    runtime: Object.freeze({ isNativePlatform: false, platform: 'web' }),
    connectionFactory: () => createNodeSqliteConnection(join(temporary, 'proof.sqlite')),
    fakeStoreOptions: { productOutcomes: [outage] },
  });
  t.after(() => services.dispose());

  const state = await services.controller.start();

  assert.equal(state.status, 'failed');
  assert.equal(state.packReady, false);
  assert.equal(state.displayPrice, '');
  assert.doesNotMatch(JSON.stringify(state), /offline private detail|STORE_NATIVE_FAILURE/);
});

test('invalid approved-product response is a fatal composition contract failure', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'ks2-b3-product-invalid-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));

  await assert.rejects(
    createB3AppServices({
      runtime: Object.freeze({ isNativePlatform: false, platform: 'web' }),
      connectionFactory: () => createNodeSqliteConnection(join(temporary, 'proof.sqlite')),
      fakeStoreOptions: { productOutcomes: [[]] },
    }),
    /approved store product is unavailable/i,
  );
});

test('native store failure during transaction replay preserves a calm local shell', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'ks2-b3-store-replay-offline-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const outage = Object.assign(new Error('native transaction private detail'), {
    code: 'STORE_NATIVE_FAILURE',
  });
  const services = await createB3AppServices({
    runtime: Object.freeze({ isNativePlatform: false, platform: 'web' }),
    connectionFactory: () => createNodeSqliteConnection(join(temporary, 'proof.sqlite')),
    fakeStoreOptions: { transactionOutcomes: [outage, []] },
  });
  t.after(() => services.dispose());

  const state = await services.controller.start();

  assert.equal(state.status, 'failed');
  assert.equal(state.displayPrice, '£4.99');
  assert.doesNotMatch(
    JSON.stringify(state),
    /native transaction private detail|STORE_NATIVE_FAILURE/,
  );
});

test('resume retries product discovery before clearing the failed sync state', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'ks2-b3-product-resume-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const outage = Object.assign(new Error('native product private detail'), {
    code: 'STORE_NATIVE_FAILURE',
  });
  let resume;
  const services = await createB3AppServices({
    runtime: Object.freeze({ isNativePlatform: false, platform: 'web' }),
    connectionFactory: () => createNodeSqliteConnection(join(temporary, 'proof.sqlite')),
    fakeStoreOptions: {
      productOutcomes: [outage, [GOOGLE_PRODUCT]],
      transactionOutcomes: [[], [], [], []],
    },
    lifecycleFactory: () => Object.freeze({
      onResume(listener) {
        resume = listener;
        return Object.freeze({ async remove() {} });
      },
      async dispose() {},
    }),
  });
  t.after(() => services.dispose());

  assert.equal((await services.controller.start()).status, 'failed');
  await resume();
  const recovered = services.controller.getState();

  assert.equal(recovered.status, 'ready');
  assert.equal(recovered.displayPrice, '£4.99');
});

test('resume keeps an invalid approved-product response fatal', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'ks2-b3-product-resume-invalid-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const outage = Object.assign(new Error('native product private detail'), {
    code: 'STORE_NATIVE_FAILURE',
  });
  let resume;
  const services = await createB3AppServices({
    runtime: Object.freeze({ isNativePlatform: false, platform: 'web' }),
    connectionFactory: () => createNodeSqliteConnection(join(temporary, 'proof.sqlite')),
    fakeStoreOptions: {
      productOutcomes: [outage, []],
      transactionOutcomes: [[], [], [], []],
    },
    lifecycleFactory: () => Object.freeze({
      onResume(listener) {
        resume = listener;
        return Object.freeze({ async remove() {} });
      },
      async dispose() {},
    }),
  });
  t.after(() => services.dispose());
  await services.controller.start();

  await assert.rejects(resume(), /approved store product is unavailable/i);
});

test('native lifecycle may ignore a fatal resume promise without unhandled rejection', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'ks2-b3-resume-handled-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const outage = Object.assign(new Error('native product private detail'), {
    code: 'STORE_NATIVE_FAILURE',
  });
  const unhandled = [];
  const captureUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', captureUnhandled);
  t.after(() => process.off('unhandledRejection', captureUnhandled));
  let fireResume;
  const services = await createB3AppServices({
    runtime: Object.freeze({ isNativePlatform: false, platform: 'web' }),
    connectionFactory: () => createNodeSqliteConnection(join(temporary, 'proof.sqlite')),
    fakeStoreOptions: {
      productOutcomes: [outage, []],
      transactionOutcomes: [[], [], [], []],
    },
    lifecycleFactory: () => Object.freeze({
      onResume(listener) {
        fireResume = () => { listener(); };
        return Object.freeze({ async remove() {} });
      },
      async dispose() {},
    }),
  });
  t.after(() => services.dispose());
  await services.controller.start();

  fireResume();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(unhandled, []);
});

test('overlapping lifecycle resume events coalesce into one refresh operation', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'ks2-b3-resume-coalesced-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const delayed = createDelayedEntitlementConnection(join(temporary, 'proof.sqlite'));
  let resume;
  const services = await createB3AppServices({
    runtime: Object.freeze({ isNativePlatform: false, platform: 'web' }),
    connectionFactory: () => delayed.connection,
    fakeStoreOptions: {
      productOutcomes: [[GOOGLE_PRODUCT], [GOOGLE_PRODUCT]],
      transactionOutcomes: [[], [], [], []],
    },
    lifecycleFactory: () => Object.freeze({
      onResume(listener) {
        resume = listener;
        return Object.freeze({ async remove() {} });
      },
      async dispose() {},
    }),
  });
  t.after(() => services.dispose());
  await services.controller.start();

  const refreshStarted = delayed.arm();
  const first = resume();
  await refreshStarted;
  const second = resume();

  const coalesced = second === first;
  delayed.release();
  await Promise.all([first, second]);
  assert.equal(coalesced, true);
  assert.equal(services.controller.getState().status, 'ready');
});

test('dispose removes resume events and awaits delayed refresh before closing SQLite', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'ks2-b3-resume-dispose-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const events = [];
  const delayed = createDelayedEntitlementConnection(
    join(temporary, 'proof.sqlite'),
    events,
  );
  let resume;
  const services = await createB3AppServices({
    runtime: Object.freeze({ isNativePlatform: false, platform: 'web' }),
    connectionFactory: () => delayed.connection,
    fakeStoreOptions: {
      productOutcomes: [[GOOGLE_PRODUCT], [GOOGLE_PRODUCT]],
      transactionOutcomes: [[], [], [], []],
    },
    lifecycleFactory: () => Object.freeze({
      onResume(listener) {
        resume = listener;
        return Object.freeze({
          async remove() { events.push('resume-listener-removed'); },
        });
      },
      async dispose() { events.push('lifecycle-disposed'); },
    }),
  });
  await services.controller.start();

  const refreshStarted = delayed.arm();
  const activeResume = resume();
  await refreshStarted;
  let disposeFinished = false;
  const disposal = services.dispose().then(() => { disposeFinished = true; });
  await new Promise((resolve) => setImmediate(resolve));

  const finishedBeforeRelease = disposeFinished;
  const eventsBeforeRelease = [...events];
  delayed.release();
  await Promise.all([activeResume, disposal]);
  assert.equal(finishedBeforeRelease, false);
  assert.deepEqual(eventsBeforeRelease, ['resume-listener-removed']);
  assert.deepEqual(events, [
    'resume-listener-removed',
    'refresh-released',
    'lifecycle-disposed',
    'connection-closed',
  ]);
});

test('a failed delayed transaction update reaches the calm proof state', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'ks2-b3-update-offline-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const outage = Object.assign(new Error('gateway transaction private detail'), {
    code: 'GATEWAY_OFFLINE', status: null, retryable: true,
  });
  const services = await createB3AppServices({
    runtime: Object.freeze({ isNativePlatform: false, platform: 'web' }),
    connectionFactory: () => createNodeSqliteConnection(join(temporary, 'proof.sqlite')),
    fakeStoreOptions: {
      updateOutcomes: [{
        store: 'google', environment: 'sandbox', productId: 'full_ks2',
        outcome: 'purchased', transactionRef: 'native-update',
        opaqueProof: 'sandbox-update-proof',
      }],
      transactionOutcomes: [[], []],
    },
    fakeGatewayOptions: { verifyOutcomes: [outage, outage] },
  });
  t.after(() => services.dispose());

  const state = await services.controller.start();

  assert.equal(state.status, 'failed');
  assert.equal(state.packReady, false);
  assert.doesNotMatch(
    JSON.stringify(state),
    /gateway transaction private detail|GATEWAY_OFFLINE/,
  );
});

test('composed Buy and Restore publish verified revocation and lock pack access', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'ks2-b3-action-revocation-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const observation = Object.freeze({
    store: 'google', environment: 'sandbox', productId: 'full_ks2',
    outcome: 'revoked', transactionRef: 'native-revocation',
    opaqueProof: 'sandbox-revocation-proof',
  });
  const identity = Object.freeze({
    store: 'google', productId: 'full_ks2', environment: 'sandbox',
    applicationId: 'uk.eugnel.ks2spelling', entitlementId: 'full-ks2',
    state: 'revoked', storeTransactionId: 'GPA.1234-5678-9012-34567',
    sealedRefreshHandle: 'b3rh1.1.revoked-nonce.revoked-ciphertext',
    refreshHandleVersion: 1, workerVersionId: 'worker-test',
    workerScriptAuthoritySha256: 'a'.repeat(64),
  });

  for (const action of ['buy', 'restore']) {
    await t.test(action, async () => {
      const fakeStoreOptions = {
        transactionOutcomes: [[], [], [], []],
        ...(action === 'buy'
          ? { updateOutcomes: [observation] }
          : { restoreOutcomes: [[observation]] }),
      };
      const services = await createB3AppServices({
        runtime: Object.freeze({ isNativePlatform: false, platform: 'web' }),
        connectionFactory: () => createNodeSqliteConnection(
          join(temporary, `${action}.sqlite`),
        ),
        fakeStoreOptions,
        fakeGatewayOptions: { verifyOutcomes: [identity] },
      });
      t.after(() => services.dispose());
      await services.controller.start();

      const revoked = await services.controller[action]();

      assert.equal(revoked.status, 'revoked');
      assert.equal(revoked.packReady, false);
    });
  }
});
