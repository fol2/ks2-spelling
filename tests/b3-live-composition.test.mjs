import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createB3AppServices } from '../src/app/create-b3-app-services.js';
import {
  createSelectedAppServices,
  selectNativeAppComposition,
} from '../src/app/create-app-services.js';
import { createNodeSqliteConnection } from './helpers/node-sqlite-connection.mjs';

const GOOGLE_PRODUCT = Object.freeze({
  productId: 'full_ks2',
  displayName: 'Full KS2',
  description: 'The complete statutory spelling catalogue.',
  displayPrice: '£4.99',
  currencyCode: 'GBP',
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
