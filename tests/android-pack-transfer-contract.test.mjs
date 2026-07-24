import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);

test('Android PackTransfer is a registered six-method Java-only private bridge', async () => {
  const [plugin, inspector, activity] = await Promise.all([
    readFile(new URL('android/app/src/main/java/uk/eugnel/ks2spelling/PackTransferPlugin.java', ROOT), 'utf8'),
    readFile(new URL('android/app/src/main/java/uk/eugnel/ks2spelling/ZipCentralDirectoryInspector.java', ROOT), 'utf8'),
    readFile(new URL('android/app/src/main/java/uk/eugnel/ks2spelling/MainActivity.java', ROOT), 'utf8'),
  ]);
  assert.match(plugin, /@CapacitorPlugin\(name\s*=\s*"PackTransfer"\)/);
  for (const method of ['getFreeBytes', 'downloadRange', 'inspectAndExtract', 'sealAndInstall', 'inventoryInstalledVersions', 'removeOwnedTemporaryState']) {
    assert.match(plugin, new RegExp(`void\\s+${method}\\s*\\(`));
  }
  assert.match(activity, /registerPlugin\(PackTransferPlugin\.class\)/);
  assert.match(plugin, /getFilesDir\(\)/);
  assert.match(plugin, /ks2-spelling/);
  assert.match(plugin, /O_NOFOLLOW/);
  assert.doesNotMatch(plugin, /getExternal|Environment\.|Documents|destinationPath|destinationFile/);
  assert.match(inspector, /0x06054b50/);
  assert.match(inspector, /0x02014b50/);
  assert.match(inspector, /0x04034b50/);
  assert.doesNotMatch(`${plugin}\n${inspector}`, /kotlin|\.kt\b/i);
  assert.doesNotMatch(`${plugin}\n${inspector}`, /java\.nio\.file\.(?:Path|Files)/);
});

test('Android validates and bounds capability transport before opening a connection', async () => {
  const source = await readFile(new URL('android/app/src/main/java/uk/eugnel/ks2spelling/PackTransferPlugin.java', ROOT), 'utf8');
  assert.match(source, /https:\/\/b3-gateway\.eugnel\.uk/);
  assert.match(source, /HttpURLConnection/);
  assert.ok(source.indexOf('validateCapability') < source.indexOf('openConnection'), 'validation must precede transport');
  assert.match(source, /setInstanceFollowRedirects\(false\)/);
  assert.match(source, /setRequestProperty\("Origin",\s*"http:\/\/localhost"\)/);
  assert.match(source, /setRequestProperty\("Range"/);
  assert.match(source, /setRequestProperty\("Accept-Encoding",\s*"identity"\)/);
  assert.match(source, /PACK_CAPABILITY_EXPIRED/);
  assert.match(source, /PACK_RANGE_NOT_SATISFIABLE/);
  assert.match(source, /1_048_576/);
  assert.match(source, /Signature\.getInstance\("SHA256withECDSA"\)/);
  assert.match(source, /X509EncodedKeySpec/);
  assert.match(source, /ZipCentralDirectoryInspector\.inspect/);
  assert.match(source, /consumeVerifiedEntries\(\s*archiveBytes/);
  assert.doesNotMatch(source, /new ZipFile|ZipFile\s*;/);
  assert.ok(source.indexOf('ZipCentralDirectoryInspector.inspect') < source.indexOf('consumeVerifiedEntries'), 'owned byte inspector must approve the same bytes consumed by platform extraction');
});

test('Android freezes API-24 safety, memory-only capability logging and exact public key bytes', async () => {
  // loggingBehavior is owned by the committed root Capacitor config. The
  // android/assets copy is a gitignored `cap sync` artefact and is checked by
  // the merge-tier native:sync:check, not the PR fast lane.
  const [plugin, inspector, keyring, trackedKeyring, config] = await Promise.all([
    readFile(new URL('android/app/src/main/java/uk/eugnel/ks2spelling/PackTransferPlugin.java', ROOT), 'utf8'),
    readFile(new URL('android/app/src/main/java/uk/eugnel/ks2spelling/ZipCentralDirectoryInspector.java', ROOT), 'utf8'),
    readFile(new URL('android/app/src/main/assets/pack-signing-public-keys.json', ROOT)),
    readFile(new URL('config/pack-signing-public-keys.json', ROOT)),
    readFile(new URL('capacitor.config.json', ROOT), 'utf8'),
  ]);
  assert.deepEqual(keyring, trackedKeyring);
  assert.equal(JSON.parse(config).loggingBehavior, 'none');
  assert.doesNotMatch(`${plugin}\n${inspector}`, /java\.nio\.file\.(?:Path|Files)|List\.of\(|Set\.of\(|List\.copyOf\(/);
  assert.match(plugin, /android\.system\.Os/);
  assert.match(plugin, /O_NOFOLLOW/);
});
