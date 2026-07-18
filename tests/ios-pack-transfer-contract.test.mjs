import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);

test('iOS PackTransfer is a six-method Capacitor bridge with private owned roots', async () => {
  const source = await readFile(new URL('ios/App/App/PackTransferPlugin.swift', ROOT), 'utf8');
  const inspector = await readFile(
    new URL('ios/App/App/ZipCentralDirectoryInspector.swift', ROOT),
    'utf8',
  );
  assert.match(source, /jsName\s*=\s*"PackTransfer"/);
  for (const method of [
    'getFreeBytes', 'downloadRange', 'inspectAndExtract', 'sealAndInstall',
    'inventoryInstalledVersions', 'removeOwnedTemporaryState',
  ]) assert.match(source, new RegExp(`CAPPluginMethod\\(name: "${method}"`));
  assert.match(source, /applicationSupportDirectory/);
  assert.match(source, /KS2Spelling/);
  assert.match(source, /Packs/);
  assert.match(source, /staging/);
  assert.match(source, /installed/);
  assert.match(source, /isExcludedFromBackup/);
  assert.doesNotMatch(source, /\.documentDirectory|Documents/);
  assert.doesNotMatch(source, /destinationPath|destinationURL/);
  assert.match(inspector, /\^\[a-z0-9\]\[a-z0-9\._-\]\{0,63\}\$/);
});

test('iOS validates capability authority before constructing a URLRequest', async () => {
  const source = await readFile(new URL('ios/App/App/PackTransferPlugin.swift', ROOT), 'utf8');
  const flow = await readFile(new URL('ios/App/App/PackDownloadFlow.swift', ROOT), 'utf8');
  const inspector = await readFile(
    new URL('ios/App/App/ZipCentralDirectoryInspector.swift', ROOT),
    'utf8',
  );
  assert.match(inspector, /https:\/\/b3-gateway\.eugnel\.uk/);
  assert.match(inspector, /URLComponents/);
  assert.match(inspector, /percentEncodedQuery/);
  assert.match(inspector, /expires=.*&cap=/s);
  assert.match(flow, /URLRequest\(url:/);
  assert.ok(
    flow.indexOf('validateCapabilityURL') < flow.indexOf('URLRequest(url:'),
    'capability validation must happen before URLRequest construction',
  );
  assert.match(source, /willPerformHTTPRedirection/);
  assert.match(source, /completionHandler\(nil\)/);
  assert.match(flow, /Range/);
  assert.match(flow, /ETag/);
  assert.match(flow, /capacitor:\/\/localhost/);
  assert.match(flow, /forHTTPHeaderField: "Origin"/);
  assert.match(flow, /PACK_CAPABILITY_EXPIRED/);
  assert.match(flow, /PACK_RANGE_NOT_SATISFIABLE/);
  assert.match(source, /Darwin\.open/);
  assert.match(source, /ftruncate/);
  assert.match(source, /URLSessionDataDelegate/);
  assert.match(source, /body\.count \+ data\.count <= maximumBytes/);
  assert.match(source, /dataTask\.cancel\(\)/);
  assert.match(source, /lstat/);
  assert.match(source, /S_IFDIR/);
  assert.doesNotMatch(source, /withIntermediateDirectories:\s*true/);
});

test('iOS verifies signed bytes and inspects before ZIPFoundation extraction', async () => {
  const plugin = await readFile(new URL('ios/App/App/PackTransferPlugin.swift', ROOT), 'utf8');
  const sealer = await readFile(new URL('ios/App/App/PackInstallSealer.swift', ROOT), 'utf8');
  const inspector = await readFile(
    new URL('ios/App/App/ZipCentralDirectoryInspector.swift', ROOT),
    'utf8',
  );
  assert.match(plugin, /import CryptoKit/);
  assert.match(plugin, /import ZIPFoundation/);
  assert.match(plugin, /P256\.Signing\.PublicKey/);
  assert.match(plugin, /ECDSASignature\(derRepresentation:/);
  assert.match(plugin, /pack-signing-public-keys/);
  assert.ok(plugin.indexOf('ZipCentralDirectoryInspector.inspect') < plugin.indexOf('Archive(url:'));
  assert.match(sealer, /moveItem/);
  assert.match(sealer, /if try pathExists\(installed\)/);
  assert.match(sealer, /O_NOFOLLOW/);
  assert.match(plugin, /SHA256\.hash/);
  assert.match(inspector, /0x06054b50/);
  assert.match(inspector, /0x02014b50/);
  assert.match(inspector, /0x04034b50/);
  assert.match(inspector, /central.*local|local.*central/is);
});
