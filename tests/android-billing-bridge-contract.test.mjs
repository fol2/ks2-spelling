import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const APP_BUILD = join(ROOT, 'android/app/build.gradle');
const APP_LOCK = join(ROOT, 'android/gradle/dependency-locks/app.lockfile');
const VERIFICATION_METADATA = join(
  ROOT,
  'android/gradle/verification-metadata.xml',
);
const COMMERCE_PLUGIN = join(
  ROOT,
  'android/app/src/main/java/uk/eugnel/ks2spelling/CommercePlugin.java',
);

test('Android uses only the exact Play Billing 9.1.0 Java artefact', async () => {
  const [build, lock, verification] = await Promise.all([
    readFile(APP_BUILD, 'utf8'),
    readFile(APP_LOCK, 'utf8'),
    readFile(VERIFICATION_METADATA, 'utf8'),
  ]);

  const dependencyDeclarations = [
    ...build.matchAll(/com\.android\.billingclient:([^:'"\s]+):([^'"\s]+)/g),
  ];
  assert.deepEqual(
    dependencyDeclarations.map((match) => [match[1], match[2]]),
    [['billing', '9.1.0']],
  );
  assert.doesNotMatch(build, /billing-ktx|org\.jetbrains\.kotlin|kotlin-stdlib/i);
  assert.doesNotMatch(
    build,
    /com\.android\.billingclient:[^\s'"]+:[^\s'"]*(?:\+|\[|\]|\(|\)|,)/,
  );
  assert.match(lock, /^com\.android\.billingclient:billing:9\.1\.0=/m);
  assert.match(
    verification,
    /<component group="com\.android\.billingclient" name="billing" version="9\.1\.0">/,
  );
  assert.doesNotMatch(lock, /^com\.android\.billingclient:billing-ktx:/m);
});

test('the app-owned Commerce bridge configures reconnection and one-time pending purchases', async () => {
  const source = await readFile(COMMERCE_PLUGIN, 'utf8');

  assert.match(source, /@CapacitorPlugin\(name\s*=\s*"Commerce"\)/);
  assert.match(source, /implements[^{]*PurchasesUpdatedListener[^{]*BillingClientStateListener/);
  assert.match(source, /BillingClient\.newBuilder\(getContext\(\)\)/);
  assert.match(source, /\.setListener\(this\)/);
  assert.match(
    source,
    /\.enablePendingPurchases\(\s*PendingPurchasesParams\.newBuilder\(\)\s*\.enableOneTimeProducts\(\)\s*\.build\(\)\s*\)/s,
  );
  assert.match(source, /\.enableAutoServiceReconnection\(\)/);
  assert.doesNotMatch(source, /enablePendingPurchases\(\s*\)/);
  assert.match(source, /onBillingSetupFinished[\s\S]*?queryPurchasesAsync\(/);
  assert.match(source, /handleOnResume[\s\S]*?queryPurchasesAsync\(/);
  assert.doesNotMatch(source, /Map<String,\s*ProductDetails>|productDetailsById/);
  assert.match(
    source,
    /private void launchPurchase\([^]*?getBridge\(\)\.executeOnMainThread\(/,
    'BillingClient.launchBillingFlow must be dispatched to the Android UI thread',
  );
  const mainThreadLaunch = source.match(
    /private void launchPurchaseOnMainThread\([^]*?\n\s*}\n(?=\n\s*(?:@|private|protected|static|final|public))/,
  )?.[0] ?? '';
  assert.match(mainThreadLaunch, /billingClient\.launchBillingFlow\(/);
  const withReady = source.match(
    /private void withReady\([^]*?\n\s*}\n(?=\n\s*(?:@|private|protected|static|final|public))/,
  )?.[0] ?? '';
  assert.match(withReady, /synchronized \(stateLock\)[\s\S]*?billingClient\.isReady\(\)/);
  assert.match(withReady, /if \(runNow\)[\s\S]*?action\.run\(\)/);
  assert.doesNotMatch(
    withReady,
    /billingClient\.isReady\(\)[\s\S]*?synchronized \(stateLock\)/,
    'readiness must be decided while holding stateLock so setup cannot drain before enqueue',
  );
});

test('the bridge preserves server-owned acknowledgement and closed StorePort parity', async () => {
  const source = await readFile(COMMERCE_PLUGIN, 'utf8');

  for (const method of [
    'queryProducts',
    'purchase',
    'queryTransactions',
    'restore',
    'finishTransaction',
  ]) {
    assert.match(source, new RegExp(`@PluginMethod[\\s\\S]{0,80}void ${method}\\(`));
  }
  assert.match(source, /implements[^{]*PurchasesUpdatedListener/);
  assert.match(source, /notifyListeners\(\s*"transactionUpdated"/);
  assert.match(source, /Purchase\.PurchaseState\.PENDING[\s\S]*?"pending"/);
  assert.match(source, /Purchase\.PurchaseState\.PURCHASED[\s\S]*?"purchased"/);
  assert.match(source, /BillingClient\.BillingResponseCode\.USER_CANCELED[\s\S]*?"cancelled"/);
  assert.match(source, /normalisePurchaseSnapshot\(/);
  assert.match(source, /purchase\.getPurchaseToken\(\)/);
  assert.match(source, /proof\s*=\s*token/);
  assert.match(source, /put\(\s*"opaqueProof"\s*,\s*opaqueProof\s*\)/);
  assert.doesNotMatch(source, /put\(\s*"opaqueProof"[^\n]*(?:orderId|getOrderId)/);
  assert.doesNotMatch(source, /setObfuscatedAccountId|obfuscatedAccountId/i);
  assert.doesNotMatch(source, /acknowledgePurchase|AcknowledgePurchaseParams/);

  const finish = source.match(
    /@PluginMethod\s+public void finishTransaction\([^]*?\n\s*}\n(?=\n\s*(?:@|private|protected|static|final|public))/,
  )?.[0] ?? '';
  assert.match(finish, /queryPurchasesForCompletion\(/);
  const completionQuery = source.match(
    /private void queryPurchasesForCompletion\([^]*?\n\s*}\n(?=\n\s*(?:@|private|protected|static|final|public))/,
  )?.[0] ?? '';
  assert.match(completionQuery, /queryPurchasesAsync\(/);
  assert.match(completionQuery, /isAcknowledged\(\)/);
  assert.match(source, /STORE_COMPLETION_PENDING/);
  assert.match(completionQuery, /"completion"\s*,\s*"finished"/);
});
