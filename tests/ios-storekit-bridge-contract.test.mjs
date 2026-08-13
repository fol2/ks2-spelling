import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);

async function commerceSource() {
  return readFile(new URL('ios/App/App/CommercePlugin.swift', ROOT), 'utf8');
}

async function storeProductCatalogue() {
  return JSON.parse(
    await readFile(new URL('config/store-products.json', ROOT), 'utf8'),
  );
}

test('iOS Commerce exposes exactly the six StorePort operations and update event', async () => {
  const source = await commerceSource();
  assert.match(source, /jsName\s*=\s*"Commerce"/);
  for (const method of [
    'queryProducts',
    'purchase',
    'queryTransactions',
    'restore',
    'finishTransaction',
  ]) {
    assert.match(source, new RegExp(`CAPPluginMethod\\(name: "${method}"`));
  }
  assert.match(source, /notifyListeners\(\s*"transactionUpdated"/s);
  assert.doesNotMatch(source, /appAccountToken|SKPaymentQueue|appStoreReceiptURL|receipt-data/);
});

test('the iOS bridge carries no hard-coded product identifiers', async () => {
  const source = await commerceSource();
  const catalogue = await storeProductCatalogue();
  for (const product of catalogue.products) {
    assert.doesNotMatch(source, new RegExp(product.appleProductId.replaceAll('.', '\\.')));
    assert.doesNotMatch(source, new RegExp(product.googleProductId));
  }
  assert.match(source, /isAppleProductIdentity/);
  assert.match(source, /isGoogleProductIdentity/);
});

test('the StoreKit test configuration product set follows the catalogue', async () => {
  const catalogue = await storeProductCatalogue();
  const storeKit = JSON.parse(
    await readFile(new URL('ios/App/App/B3Sandbox.storekit', ROOT), 'utf8'),
  );
  const expectedTypes = { 'non-consumable': 'NonConsumable' };
  assert.deepEqual(
    storeKit.products
      .map((product) => ({ productID: product.productID, type: product.type }))
      .sort((left, right) => left.productID.localeCompare(right.productID)),
    catalogue.products
      .map((product) => ({
        productID: product.appleProductId,
        type: expectedTypes[product.type],
      }))
      .sort((left, right) => left.productID.localeCompare(right.productID)),
  );
  assert.deepEqual(storeKit.nonRenewingSubscriptions, []);
  assert.deepEqual(storeKit.subscriptionGroups, []);
  for (const product of storeKit.products) {
    assert.equal(product.familyShareable, false);
  }
});

test('StoreKit query, purchase and observations are closed and verified-only', async () => {
  const source = await commerceSource();
  for (const field of [
    'productId',
    'displayName',
    'description',
    'displayPrice',
    'currencyCode',
  ]) assert.match(source, new RegExp(`"${field}"`));
  for (const outcome of [
    'purchased',
    'pending',
    'cancelled',
    'revoked',
    'unverified',
  ]) assert.match(source, new RegExp(`"${outcome}"`));
  assert.match(source, /jwsRepresentation/);
  assert.match(source, /case \.verified/);
  assert.match(source, /case \.unverified/);
  assert.match(source, /revocationDate/);
  assert.match(source, /verifiedTransactions\[/);
  assert.match(source, /if let opaqueProof\s*\{\s*value\["opaqueProof"\]/s);
  assert.match(source, /outcome:\s*"unverified"[\s\S]*?opaqueProof:\s*nil/);
});

test('iOS accepts the closed cross-platform product list and filters to Apple authority', async () => {
  const source = await commerceSource();
  assert.match(source, /requestedAppleProductIds/);
  assert.match(source, /Set\(productIds\)\.count == productIds\.count/);
  assert.match(
    source,
    /isAppleProductIdentity\(candidate\) \|\| isGoogleProductIdentity\(candidate\)/,
  );
  assert.match(source, /productIds\.filter\(isAppleProductIdentity\)/);
});

test('launch replay and proactive query never authenticate while explicit restore syncs once', async () => {
  const source = await commerceSource();
  assert.match(source, /Transaction\.updates/);
  assert.match(source, /Transaction\.unfinished/);
  assert.match(source, /Transaction\.currentEntitlements/);

  const syncCalls = [...source.matchAll(/try await AppStore\.sync\(\)/g)];
  assert.equal(syncCalls.length, 1, 'only explicit restore may call AppStore.sync exactly once');
  const restoreStart = source.indexOf('func restore(');
  const finishStart = source.indexOf('func finishTransaction(');
  assert.ok(restoreStart >= 0 && finishStart > restoreStart);
  assert.ok(
    syncCalls[0].index > restoreStart && syncCalls[0].index < finishStart,
    'AppStore.sync must be scoped to explicit restore',
  );
});

test('finish is JS-authorised and re-verifies unfinished transactions before StoreKit finish', async () => {
  const source = await commerceSource();
  assert.match(source, /verifiedTransactions\[transactionRef\]/);
  assert.match(source, /Transaction\.unfinished/);
  assert.match(source, /await transaction\.finish\(\)/);
  assert.match(source, /completion.*finished/s);
  assert.match(source, /completion.*pending/s);

  const purchaseStart = source.indexOf('func purchase(');
  const finishStart = source.indexOf('func finishTransaction(');
  assert.ok(purchaseStart >= 0 && finishStart > purchaseStart);
  assert.doesNotMatch(
    source.slice(purchaseStart, finishStart),
    /\.finish\(\)/,
    'purchase must not finish before durable JavaScript acknowledgement',
  );
});

test('the StoreKit transcript is explicitly non-live and covers delayed approval and decline', async () => {
  const transcript = JSON.parse(
    await readFile(new URL('tests/fixtures/storekit-bridge-transcript.json', ROOT), 'utf8'),
  );
  assert.deepEqual(
    Object.keys(transcript),
    [
      'schemaVersion',
      'evidenceKind',
      'store',
      'environment',
      'productId',
      'physicalSandbox',
      'liveStore',
      'cases',
    ],
  );
  assert.equal(transcript.evidenceKind, 'xcode-storekit-test-non-live');
  // The transcript is frozen B3 evidence: it pins the product id it was
  // captured with, independent of the now catalogue-driven bridge.
  assert.equal(transcript.productId, 'uk.eugnel.ks2spelling.fullks2');
  assert.equal(transcript.physicalSandbox, false);
  assert.equal(transcript.liveStore, false);
  assert.deepEqual(
    transcript.cases.map(({ name, initialOutcome, storeKitTestAction, finalOutcome }) => ({
      name,
      initialOutcome,
      storeKitTestAction,
      finalOutcome,
    })),
    [
      {
        name: 'delayed-approve',
        initialOutcome: 'pending',
        storeKitTestAction: 'approveAskToBuyTransaction',
        finalOutcome: 'purchased',
      },
      {
        name: 'delayed-decline',
        initialOutcome: 'pending',
        storeKitTestAction: 'declineAskToBuyTransaction',
        finalOutcome: 'cancelled',
      },
    ],
  );
  assert.ok(transcript.cases.every(({ finishedByTest }) => finishedByTest === false));
});
