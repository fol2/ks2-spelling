import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  B3_PROOF_GATEWAY_CALLS,
  validateB3ProofObservation,
  validateB3ProofObservationForPublication,
} from '../src/app/b3-live-proof-protocol.js';
import { configureAndMigrateDatabase } from '../src/platform/database/migrate-database.js';
import { seedB2Learners } from '../src/platform/database/b2-seed.js';
import { B3_EVIDENCE_GATEWAY_CALLS } from '../scripts/lib/b3-evidence.mjs';
import { createNodeSqliteConnection } from './helpers/node-sqlite-connection.mjs';
import {
  ARCHIVE_ETAG,
  ARCHIVE_SHA,
  ENVELOPE_SHA,
  NOW,
  authorisation,
} from './helpers/range-fixture-server.mjs';

const execFileAsync = promisify(execFile);
const THIS_TEST = fileURLToPath(import.meta.url);

function childJsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function runPhysicalCompositionChild() {
  const input = JSON.parse(Buffer.from(process.env.B3_PHYSICAL_CHILD_INPUT, 'base64url'));
  let trace = input.traceStart ?? 0;
  let publishedObservation = null;
  const ios = input.command.platform === 'ios-physical';
  const store = ios ? 'apple' : 'google';
  const productId = ios ? 'uk.eugnel.ks2spelling.fullks2' : 'full_ks2';
  const transaction = Object.freeze({
    store,
    environment: 'sandbox',
    productId,
    outcome: 'purchased',
    transactionRef: ios ? '2000000000000001' : 'GPA.1234-5678-9012-34567',
    opaqueProof: ios ? 'opaque-apple-store-proof' : 'opaque-google-play-proof',
  });
  const product = Object.freeze({
    productId,
    displayName: 'Full KS2',
    description: 'The complete statutory spelling catalogue.',
    displayPrice: '£4.99',
    currencyCode: 'GBP',
  });
  const installedVersions = [];
  const methods = (names, rtype = 'promise') => names.map((name) => ({ name, rtype }));
  if (ios) globalThis.webkit = { messageHandlers: { bridge: {} } };
  else globalThis.androidBridge = {};
  globalThis.Capacitor = {
    PluginHeaders: [
      {
        name: 'Commerce',
        methods: [
          ...methods(['queryProducts', 'purchase', 'queryTransactions', 'restore', 'finishTransaction']),
          ...methods(['addListener', 'removeListener'], 'callback'),
        ],
      },
      {
        name: 'PackTransfer',
        methods: methods([
          'getFreeBytes', 'downloadRange', 'inspectAndExtract', 'sealAndInstall',
          'inventoryInstalledVersions', 'removeOwnedTemporaryState',
        ]),
      },
      {
        name: 'App',
        methods: methods(['addListener', 'removeListener'], 'callback'),
      },
    ],
    async nativePromise(plugin, method, options) {
      if (process.env.B3_PHYSICAL_CHILD_DEBUG === '1') {
        process.stderr.write(`${plugin}.${method}\n`);
      }
      if (plugin === 'Commerce') {
        if (method === 'queryProducts') return { products: [product] };
        if (method === 'queryTransactions') {
          if (input.storeState === 'revoked') {
            return { transactions: [{ ...transaction, outcome: 'revoked' }] };
          }
          return { transactions: input.storeState === 'approved' ? [transaction] : [] };
        }
        if (method === 'purchase') {
          if (input.purchaseOutcome === 'purchased') return transaction;
          if (input.purchaseOutcome === 'cancelled') {
            return {
              store, environment: 'sandbox', productId,
              outcome: 'cancelled', transactionRef: 'cancelled-without-authority',
            };
          }
          return {
            store, environment: 'sandbox', productId,
            outcome: 'pending', transactionRef: 'pending-native-purchase',
          };
        }
        if (method === 'restore') {
          return { transactions: input.restoreState === 'approved' ? [transaction] : [] };
        }
        if (method === 'finishTransaction') return { completion: 'finished' };
      }
      if (plugin === 'PackTransfer') {
        if (method === 'inventoryInstalledVersions') return { versions: installedVersions };
        if (method === 'removeOwnedTemporaryState') return { removed: true };
        if (method === 'getFreeBytes') return { freeBytes: 64 * 1_024 * 1_024 };
        if (method === 'downloadRange') {
          return {
            status: 206,
            startByte: options.startByte,
            endByteExclusive: options.endByteExclusive,
            totalBytes: 1_324,
            bytesWritten: options.endByteExclusive - options.startByte,
            etag: ARCHIVE_ETAG,
          };
        }
        if (method === 'inspectAndExtract') {
          return {
            archiveSha256: ARCHIVE_SHA,
            manifestSha256: ENVELOPE_SHA,
            extractedBytes: 1_082,
            fileCount: 2,
            stagingToken: 'staging/b3-sandbox-proof/1.0.0-b3.1',
          };
        }
        if (method === 'sealAndInstall') {
          installedVersions.splice(0, installedVersions.length, {
            packId: 'b3-sandbox-proof',
            version: '1.0.0-b3.1',
            manifestSha256: ENVELOPE_SHA,
            installedPathToken: 'installed/b3-sandbox-proof/1.0.0-b3.1',
            activationMarkerSha256: 'd'.repeat(64),
          });
          return {
            installedPathToken: 'installed/b3-sandbox-proof/1.0.0-b3.1',
            activationMarkerSha256: 'd'.repeat(64),
          };
        }
      }
      throw new Error(`Unexpected native promise ${plugin}.${method}`);
    },
    nativeCallback(_plugin, method) {
      return Promise.resolve(method === 'addListener' ? 'listener-id' : undefined);
    },
  };
  globalThis.fetch = async (url, options) => {
    assert.equal(options.redirect, 'error');
    const path = new URL(url).pathname;
    if (process.env.B3_PHYSICAL_CHILD_DEBUG === '1') process.stderr.write(`${path}\n`);
    const traceId = `00000000-0000-4000-8000-${String(trace += 1).padStart(12, '0')}`;
    const identity = {
      store,
      productId,
      environment: 'sandbox',
      applicationId: 'uk.eugnel.ks2spelling',
      entitlementId: 'full-ks2',
      state: input.refreshState === 'revoked' && path === '/v1/entitlements/refresh'
        ? 'revoked'
        : 'active',
      storeTransactionId: transaction.transactionRef,
      sealedRefreshHandle: 'b3rh1.1.nonce.ciphertext',
      refreshHandleVersion: 1,
      traceId,
      workerVersionId: 'a8f32f60-16b9-4ca6-9b4a-f771dd5302f7',
      workerScriptAuthoritySha256: 'a'.repeat(64),
    };
    if (path === '/v1/packs/authorise-download') {
      return childJsonResponse(authorisation(identity));
    }
    return childJsonResponse(identity);
  };

  const [{ createB3AppServices }, { createCapacitorB3ProofObservation },
    { createNodeSqliteConnection }, { canonicaliseB3ProofValue }] = await Promise.all([
    import('../src/app/create-b3-app-services.js'),
    import('../src/platform/proof/capacitor-b3-proof-observation.js'),
    import('./helpers/node-sqlite-connection.mjs'),
    import('../src/app/b3-live-proof-protocol.js'),
  ]);
  const proofObservationPort = createCapacitorB3ProofObservation({
    buildAuthority: input.buildAuthority,
    plugin: Object.freeze({
      async getLaunchCommand() {
        return { commandJson: canonicaliseB3ProofValue(input.command) };
      },
      async publishObservation({ canonicalJson }) {
        publishedObservation = JSON.parse(canonicalJson);
        if (input.streamObservation) {
          process.stdout.write(`${canonicalJson}\n`);
        }
        return { written: true };
      },
    }),
  });
  const services = await createB3AppServices({
    runtime: Object.freeze({
      isNativePlatform: true,
      platform: ios ? 'ios' : 'android',
      buildAuthority: input.buildAuthority,
    }),
    proofObservationPort,
    connectionFactory: () => createNodeSqliteConnection(input.sqlitePath),
    clock: () => input.now,
    deviceGatewaySmokeProbe: async (result) => ({
      schemaVersion: 1,
      deploymentVersionId: result.workerVersionId,
      scriptAuthoritySha256: result.workerScriptAuthoritySha256,
      signedEnvelopeSha256: result.signedEnvelopeSha256,
      objects: [
        {
          role: 'signed-manifest',
          key: 'packs/b3-sandbox-proof/1.0.0-b3.1/signed-manifest.json',
          sha256: result.objects[0].sha256,
          size: result.objects[0].size,
          etag: result.objects[0].etag,
        },
        {
          role: 'archive',
          key: 'packs/b3-sandbox-proof/1.0.0-b3.1/b3-sandbox-proof.zip',
          sha256: result.objects[1].sha256,
          size: result.objects[1].size,
          etag: result.objects[1].etag,
        },
      ],
      accessBehaviour: {
        ttlSeconds: 600, valid: true, tamperedRejected: true,
        expiredRejected: true, canonicalEncodingRequired: true,
      },
      byteServingBehaviour: {
        full200: true, partial206: true, conditional304: true,
        unsatisfied416: true, noRedirects: true, cacheControl: 'private, no-store',
      },
    }),
  });
  if (input.seedActiveAfterCreate) {
    const seedConnection = createNodeSqliteConnection(input.sqlitePath);
    await seedConnection.open();
    await seedConnection.execute(
      'INSERT INTO app_entitlements (entitlement_id, store, product_id, state, sealed_refresh_handle, refresh_handle_version, verified_at, refreshed_at, revocation_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)',
      ['full-ks2', store, productId, 'active', 'b3rh1.1.nonce.ciphertext', 1, input.now - 2, input.now - 1],
    );
    await seedConnection.execute(
      'INSERT INTO transaction_journal (journal_id, store, product_id, store_transaction_id, observation_state, processing_state, opaque_proof, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)',
      ['seeded-complete-journal', store, productId, transaction.transactionRef, 'purchased', 'complete', input.now - 2, input.now - 1],
    );
    await seedConnection.close();
  }
  try {
    await services.runLiveProofCommand();
  } finally {
    await services.dispose();
  }
  if (!input.streamObservation) process.stdout.write(JSON.stringify(publishedObservation));
}

if (process.argv.includes('--b3-physical-child')) {
  await runPhysicalCompositionChild();
  process.exit(0);
}

async function runPhysicalProcess(input) {
  const { stdout } = await execFileAsync(process.execPath, [THIS_TEST, '--b3-physical-child'], {
    env: {
      ...process.env,
      B3_PHYSICAL_CHILD_INPUT: Buffer.from(JSON.stringify(input)).toString('base64url'),
    },
    maxBuffer: 2 * 1_024 * 1_024,
  });
  return JSON.parse(stdout);
}

function launchHeldPhysicalProcess(input) {
  const child = spawn(process.execPath, [THIS_TEST, '--b3-physical-child'], {
    env: {
      ...process.env,
      B3_PHYSICAL_CHILD_INPUT: Buffer.from(JSON.stringify({
        ...input,
        streamObservation: true,
      })).toString('base64url'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => {
    resolve({ code, signal });
  }));
  const observation = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      try {
        resolve(JSON.parse(stdout.slice(0, newline)));
      } catch (error) {
        reject(error);
      }
    });
    child.once('exit', (code, signal) => {
      if (stdout.indexOf('\n') < 0) {
        reject(new Error(`Held physical child exited before observation (${code ?? signal}): ${stderr}`));
      }
    });
  });
  return Object.freeze({
    child,
    observation,
    async forceStopAfterValidatedHold(delayMilliseconds = 5_000) {
      await new Promise((resolve) => setTimeout(resolve, delayMilliseconds));
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    },
    async terminateNow() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    },
  });
}

test('fresh Android app processes recover an approved pending purchase through shared SQLite', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-b3-real-process-trace-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sqlitePath = join(directory, 'physical.sqlite');
  const seedConnection = createNodeSqliteConnection(sqlitePath);
  await seedConnection.open();
  await configureAndMigrateDatabase(seedConnection);
  await seedB2Learners(seedConnection);
  await seedConnection.execute(
    'INSERT INTO app_metadata (key, value_json, updated_at) VALUES (?, ?, ?)',
    [
      'b3-proof-installation-v1',
      '{"installationId":"018f1d7b-97e8-4a52-8cf2-783e5089c002"}',
      1,
    ],
  );
  await seedConnection.close();
  const buildAuthority = Object.freeze({
    mode: 'B3SandboxProof',
    proofKind: 'physical-live',
    platform: 'android',
    distribution: 'play-internal',
    publicSandboxOrigin: 'https://b3-gateway.eugnel.uk',
    workerName: 'ks2-spelling-b3-sandbox',
    bundleId: 'uk.eugnel.ks2spelling',
    testedApplicationCommit: 'c'.repeat(40),
    applicationFingerprint: 'a'.repeat(64),
    versionName: '0.3.0-b3',
    buildNumber: 1,
  });
  const command = (overrides) => ({
    schemaVersion: 1,
    captureId: '018f1d7b-97e8-4a52-8cf2-783e5089c001',
    platform: 'android-play-physical',
    testedApplicationCommit: 'c'.repeat(40),
    applicationFingerprint: 'a'.repeat(64),
    expectedScenarioIndex: 3,
    expectedSequence: 5,
    previousObservationSha256: 'd'.repeat(64),
    installationMode: 'existing',
    actionCode: 'ARM_CAPTURE',
    challengeSha256: 'a'.repeat(64),
    ...overrides,
  });

  const armCommand = command({});
  const armed = await runPhysicalProcess({
    command: armCommand,
    buildAuthority,
    sqlitePath,
    storeState: 'none',
    now: Date.parse('2026-07-15T10:00:00.000Z'),
  });
  const pendingCommand = command({
    expectedSequence: 6,
    previousObservationSha256: armed.observationSha256,
    actionCode: 'INITIATE_PURCHASE',
    challengeSha256: 'b'.repeat(64),
  });
  const pending = await runPhysicalProcess({
    command: pendingCommand,
    buildAuthority,
    sqlitePath,
    storeState: 'none',
    now: Date.parse('2026-07-15T10:00:01.000Z'),
  });
  assert.equal((await validateB3ProofObservation(pending, {
    command: pendingCommand,
    buildAuthority,
    previousObservation: armed,
  })).nextActionCode, 'APPROVE_PENDING_PURCHASE');

  const holdCommand = command({
    expectedScenarioIndex: 4,
    expectedSequence: 7,
    previousObservationSha256: pending.observationSha256,
    actionCode: 'ARM_GATEWAY_COMPLETION_HOLD',
    challengeSha256: 'c'.repeat(64),
  });
  const heldProcess = launchHeldPhysicalProcess({
    command: holdCommand,
    buildAuthority,
    sqlitePath,
    storeState: 'approved',
    now: Date.parse('2026-07-15T10:00:02.000Z'),
    traceStart: 0,
  });
  t.after(() => heldProcess.terminateNow());
  const held = await heldProcess.observation;
  assert.deepEqual({
    phase: held.phase,
    firstTransition: held.completedTransitions[0],
    storeEvents: held.proofProjection.storeEvents,
    entitlementState: held.proofProjection.entitlementState,
    storeCompletionObserved: held.proofProjection.storeCompletionObserved,
    rawProofCleared: held.proofProjection.transactionAuthority.rawProofCleared,
  }, {
    phase: 'HOLD_REACHED',
    firstTransition: 'ARMED',
    storeEvents: [
      { operation: 'queryTransactions', outcome: 'purchased' },
    ],
    entitlementState: 'active',
    storeCompletionObserved: false,
    rawProofCleared: false,
  });
  const validatedHold = await validateB3ProofObservation(held, {
    command: holdCommand,
    buildAuthority,
    previousObservation: pending,
  });
  assert.equal(validatedHold.phase, 'HOLD_REACHED');
  assert.equal(validatedHold.proofProjection.entitlementState, 'active');
  assert.equal(validatedHold.proofProjection.storeCompletionObserved, false);
  assert.deepEqual(validatedHold.proofProjection.storeAuthority, {
    environment: 'sandbox',
    productId: 'full_ks2',
    localisedPriceObserved: false,
    completionState: 'not-observed',
  });
  assert.equal(validatedHold.proofProjection.transactionAuthority.rawProofCleared, false);
  assert.deepEqual(
    validatedHold.proofProjection.gatewayCalls.map(({ operation, relation }) => ({ operation, relation })),
    [{ operation: 'verify', relation: 'transaction-verification' }],
  );
  await heldProcess.forceStopAfterValidatedHold();

  const recoveryCommand = command({
    expectedScenarioIndex: 4,
    expectedSequence: 8,
    previousObservationSha256: held.observationSha256,
    actionCode: 'RELAUNCH',
    challengeSha256: 'd'.repeat(64),
  });
  const recovered = await runPhysicalProcess({
    command: recoveryCommand,
    buildAuthority,
    sqlitePath,
    storeState: 'approved',
    now: Date.parse('2026-07-15T10:00:08.000Z'),
    traceStart: 1,
  });
  const validated = await validateB3ProofObservation(recovered, {
    command: recoveryCommand,
    buildAuthority,
    previousObservation: held,
  });
  assert.equal(validated.proofProjection.scenarioOutcome, 'acknowledged-recovered');
  assert.equal(validated.proofProjection.entitlementAuthority.id, 'full-ks2');
  assert.equal(validated.proofProjection.transactionAuthority.rawProofCleared, true);
  assert.deepEqual(validated.proofProjection.storeAuthority, {
    environment: 'sandbox',
    productId: 'full_ks2',
    localisedPriceObserved: true,
    completionState: 'acknowledged',
  });
  assert.equal(validated.proofProjection.transportAuthority.storeAdapter, 'concreteCapacitorStore');
  assert.ok(validated.proofProjection.storeEvents.some((event) =>
    event.operation === 'finishTransaction' && event.outcome === 'finished'));
  assert.deepEqual(
    validated.proofProjection.gatewayCalls.map(({ operation, relation }) => ({ operation, relation })),
    [
      { operation: 'verify', relation: 'recovery-reverification' },
      { operation: 'complete', relation: 'completion-of-prior-verify' },
      { operation: 'authorise', relation: 'download-job-authorisation' },
      { operation: 'refresh', relation: 'post-recovery-handle-refresh' },
    ],
  );
});

test('fresh iOS app processes hold and recover the real createB3AppServices factory flow', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-b3-real-ios-process-trace-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sqlitePath = join(directory, 'physical.sqlite');
  const seedConnection = createNodeSqliteConnection(sqlitePath);
  await seedConnection.open();
  await configureAndMigrateDatabase(seedConnection);
  await seedB2Learners(seedConnection);
  await seedConnection.execute(
    'INSERT INTO app_metadata (key, value_json, updated_at) VALUES (?, ?, ?)',
    [
      'b3-proof-installation-v1',
      '{"installationId":"018f1d7b-97e8-4a52-8cf2-783e5089c002"}',
      1,
    ],
  );
  await seedConnection.close();
  const buildAuthority = Object.freeze({
    mode: 'B3SandboxProof',
    proofKind: 'physical-live',
    platform: 'ios',
    distribution: 'development',
    publicSandboxOrigin: 'https://b3-gateway.eugnel.uk',
    workerName: 'ks2-spelling-b3-sandbox',
    bundleId: 'uk.eugnel.ks2spelling',
    testedApplicationCommit: 'c'.repeat(40),
    applicationFingerprint: 'a'.repeat(64),
    versionName: '0.3.0-b3',
    buildNumber: '1',
  });
  const command = (overrides) => ({
    schemaVersion: 1,
    captureId: '018f1d7b-97e8-4a52-8cf2-783e5089c011',
    platform: 'ios-physical',
    testedApplicationCommit: 'c'.repeat(40),
    applicationFingerprint: 'a'.repeat(64),
    expectedScenarioIndex: 3,
    expectedSequence: 5,
    previousObservationSha256: 'd'.repeat(64),
    installationMode: 'existing',
    actionCode: 'ARM_GATEWAY_COMPLETION_HOLD',
    challengeSha256: 'a'.repeat(64),
    ...overrides,
  });
  const holdCommand = command({});
  const heldProcess = launchHeldPhysicalProcess({
    command: holdCommand,
    buildAuthority,
    sqlitePath,
    storeState: 'none',
    purchaseOutcome: 'purchased',
    now: Date.parse('2026-07-15T11:00:00.000Z'),
    traceStart: 100,
  });
  t.after(() => heldProcess.terminateNow());
  const held = await heldProcess.observation;
  const validatedHold = await validateB3ProofObservationForPublication(held, {
    command: holdCommand,
    buildAuthority,
  });
  assert.equal(validatedHold.phase, 'HOLD_REACHED');
  assert.equal(validatedHold.proofProjection.entitlementState, 'active');
  assert.equal(validatedHold.proofProjection.storeCompletionObserved, false);
  assert.deepEqual(
    validatedHold.proofProjection.gatewayCalls.map(({ operation, relation }) => ({ operation, relation })),
    [{ operation: 'verify', relation: 'transaction-verification' }],
  );
  await heldProcess.forceStopAfterValidatedHold();

  const recoveryCommand = command({
    expectedScenarioIndex: 4,
    expectedSequence: 6,
    previousObservationSha256: held.observationSha256,
    actionCode: 'RELAUNCH',
    challengeSha256: 'b'.repeat(64),
  });
  const recovered = await runPhysicalProcess({
    command: recoveryCommand,
    buildAuthority,
    sqlitePath,
    storeState: 'approved',
    now: Date.parse('2026-07-15T11:00:06.000Z'),
    traceStart: 101,
  });
  const validatedRecovery = await validateB3ProofObservation(recovered, {
    command: recoveryCommand,
    buildAuthority,
    previousObservation: held,
  });
  assert.equal(validatedRecovery.proofProjection.scenarioOutcome, 'finished-recovered');
  assert.equal(validatedRecovery.proofProjection.transactionAuthority.rawProofCleared, true);
  assert.deepEqual(validatedRecovery.proofProjection.storeAuthority, {
    environment: 'sandbox',
    productId: 'uk.eugnel.ks2spelling.fullks2',
    localisedPriceObserved: true,
    completionState: 'finished',
  });
  assert.deepEqual(
    validatedRecovery.proofProjection.gatewayCalls.map(({ operation, relation }) => ({ operation, relation })),
    [
      { operation: 'verify', relation: 'recovery-reverification' },
      { operation: 'complete', relation: 'completion-of-prior-verify' },
      { operation: 'authorise', relation: 'download-job-authorisation' },
      { operation: 'refresh', relation: 'post-recovery-handle-refresh' },
    ],
  );
});

test('fresh real-factory processes derive every remaining iOS and Android scenario segment', async (t) => {
  const cases = [
    { scenarioIndex: 0, actionCode: 'QUERY_PRODUCT', storeState: 'none' },
    { scenarioIndex: 1, actionCode: 'CANCEL_PURCHASE', storeState: 'none', purchaseOutcome: 'cancelled' },
    { scenarioIndex: 2, actionCode: 'INITIATE_PURCHASE', storeState: 'none' },
    { scenarioIndex: 5, actionCode: 'INSTALL_PACK', storeState: 'none', seedActiveAfterCreate: true },
    { scenarioIndex: 6, actionCode: 'REBIND_FRESH_INSTALL', storeState: 'approved', freshReinstall: true },
    { scenarioIndex: 7, actionCode: 'REDOWNLOAD_PACK', storeState: 'none', seedActiveAfterCreate: true },
    { scenarioIndex: 8, actionCode: 'OBSERVE_REVOCATION', storeState: 'revoked', seedActiveBeforeCreate: true, refreshState: 'revoked' },
  ];
  for (const platform of ['ios-physical', 'android-play-physical']) {
    const ios = platform === 'ios-physical';
    const buildAuthority = Object.freeze({
      mode: 'B3SandboxProof',
      proofKind: 'physical-live',
      platform: ios ? 'ios' : 'android',
      distribution: ios ? 'development' : 'play-internal',
      publicSandboxOrigin: 'https://b3-gateway.eugnel.uk',
      workerName: 'ks2-spelling-b3-sandbox',
      bundleId: 'uk.eugnel.ks2spelling',
      testedApplicationCommit: 'c'.repeat(40),
      applicationFingerprint: 'a'.repeat(64),
      versionName: '0.3.0-b3',
      buildNumber: ios ? '1' : 1,
    });
    for (const [caseIndex, scenarioCase] of cases.entries()) {
      const directory = await mkdtemp(join(
        tmpdir(),
        `ks2-b3-${ios ? 'ios' : 'android'}-factory-segment-`,
      ));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const sqlitePath = join(directory, 'physical.sqlite');
      const seedConnection = createNodeSqliteConnection(sqlitePath);
      await seedConnection.open();
      await configureAndMigrateDatabase(seedConnection);
      await seedB2Learners(seedConnection);
      if (!scenarioCase.freshReinstall) {
        await seedConnection.execute(
          'INSERT INTO app_metadata (key, value_json, updated_at) VALUES (?, ?, ?)',
          [
            'b3-proof-installation-v1',
            '{"installationId":"018f1d7b-97e8-4a52-8cf2-783e5089c002"}',
            1,
          ],
        );
      }
      if (scenarioCase.seedActiveBeforeCreate) {
        const store = ios ? 'apple' : 'google';
        const productId = ios ? 'uk.eugnel.ks2spelling.fullks2' : 'full_ks2';
        const transactionId = ios ? '2000000000000001' : 'GPA.1234-5678-9012-34567';
        await seedConnection.execute(
          'INSERT INTO app_entitlements (entitlement_id, store, product_id, state, sealed_refresh_handle, refresh_handle_version, verified_at, refreshed_at, revocation_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)',
          ['full-ks2', store, productId, 'active', 'b3rh1.1.nonce.ciphertext', 1, 1, 2],
        );
        await seedConnection.execute(
          'INSERT INTO transaction_journal (journal_id, store, product_id, store_transaction_id, observation_state, processing_state, opaque_proof, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)',
          ['seeded-complete-journal', store, productId, transactionId, 'purchased', 'complete', 1, 2],
        );
      }
      await seedConnection.close();
      const command = {
        schemaVersion: 1,
        captureId: `018f1d7b-97e8-4a52-8cf2-${String(200 + caseIndex + (ios ? 0 : 20)).padStart(12, '0')}`,
        platform,
        testedApplicationCommit: 'c'.repeat(40),
        applicationFingerprint: 'a'.repeat(64),
        expectedScenarioIndex: scenarioCase.scenarioIndex,
        expectedSequence: scenarioCase.scenarioIndex + 2,
        previousObservationSha256: 'd'.repeat(64),
        installationMode: scenarioCase.freshReinstall ? 'fresh-reinstall' : 'existing',
        actionCode: scenarioCase.actionCode,
        challengeSha256: 'a'.repeat(64),
      };
      let observation;
      try {
        observation = await runPhysicalProcess({
          command,
          buildAuthority,
          sqlitePath,
          storeState: scenarioCase.storeState,
          purchaseOutcome: scenarioCase.purchaseOutcome,
          restoreState: scenarioCase.freshReinstall ? 'approved' : 'none',
          seedActiveAfterCreate: scenarioCase.seedActiveAfterCreate,
          refreshState: scenarioCase.refreshState,
          now: NOW + caseIndex * 1_000,
          traceStart: 200 + caseIndex * 10 + (ios ? 0 : 100),
        });
      } catch (error) {
        const diagnosticConnection = createNodeSqliteConnection(sqlitePath);
        await diagnosticConnection.open();
        const diagnostics = {
          entitlements: await diagnosticConnection.query(
            'SELECT entitlement_id, state, sealed_refresh_handle FROM app_entitlements',
          ),
          journals: await diagnosticConnection.query(
            'SELECT journal_id, processing_state, opaque_proof FROM transaction_journal',
          ),
          jobs: await diagnosticConnection.query(
            'SELECT pack_id, version, state FROM pack_download_jobs',
          ),
          active: await diagnosticConnection.query(
            'SELECT pack_id, version FROM active_pack_versions',
          ),
        };
        await diagnosticConnection.close();
        throw new Error(`${platform} scenario ${scenarioCase.scenarioIndex} factory failed`, {
          cause: new Error(JSON.stringify(diagnostics), { cause: error }),
        });
      }
      const validated = await validateB3ProofObservationForPublication(observation, {
        command,
        buildAuthority,
      });
      const scenario = Object.keys(B3_PROOF_GATEWAY_CALLS[platform])[scenarioCase.scenarioIndex];
      assert.equal(validated.scenario, scenario);
      assert.deepEqual(
        validated.proofProjection.gatewayCalls.map(({ operation, relation }) => ({ operation, relation })),
        B3_PROOF_GATEWAY_CALLS[platform][scenario],
        `${platform} ${scenario} must come from the real application factory`,
      );
    }
  }
});

test('host evidence vectors independently equal the frozen app production vectors', async () => {
  assert.deepEqual(B3_EVIDENCE_GATEWAY_CALLS, B3_PROOF_GATEWAY_CALLS);
  const verifierSource = await readFile(
    new URL('../scripts/lib/b3-evidence.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(verifierSource, /import[\s\S]{0,160}B3_PROOF_GATEWAY_CALLS/u);
});

test('physical B3 composition cannot select a replay or cached fake gateway', async () => {
  let opened = false;
  const { createB3AppServices } = await import('../src/app/create-b3-app-services.js');
  await assert.rejects(createB3AppServices({
    runtime: Object.freeze({
      isNativePlatform: true,
      platform: 'ios',
      buildAuthority: Object.freeze({
        mode: 'B3SandboxProof',
        proofKind: 'physical-live',
        platform: 'ios',
        distribution: 'development',
        publicSandboxOrigin: 'https://b3-gateway.eugnel.uk',
        workerName: 'ks2-spelling-b3-sandbox',
      }),
    }),
    fakeGatewayOptions: { verifyOutcomes: [] },
    connectionFactory() {
      opened = true;
      throw new Error('must not open');
    },
  }), /does not accept fake adapters/i);
  assert.equal(opened, false);
});
