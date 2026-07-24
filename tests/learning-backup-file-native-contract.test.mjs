import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);

test('LearningBackupFile is a bounded B4-isolated native document bridge', async () => {
  const [ios, android, scene, activity, manifest, project] = await Promise.all([
    readFile(
      new URL('ios/App/App/LearningBackupFilePlugin.swift', ROOT),
      'utf8',
    ),
    readFile(
      new URL(
        'android/app/src/main/java/uk/eugnel/ks2spelling/LearningBackupFilePlugin.java',
        ROOT,
      ),
      'utf8',
    ),
    readFile(new URL('ios/App/App/SceneDelegate.swift', ROOT), 'utf8'),
    readFile(
      new URL(
        'android/app/src/main/java/uk/eugnel/ks2spelling/MainActivity.java',
        ROOT,
      ),
      'utf8',
    ),
    readFile(
      new URL('android/app/src/main/AndroidManifest.xml', ROOT),
      'utf8',
    ),
    readFile(new URL('ios/App/App.xcodeproj/project.pbxproj', ROOT), 'utf8'),
  ]);

  assert.match(ios, /jsName\s*=\s*"LearningBackupFile"/u);
  assert.match(ios, /CAPPluginMethod\(name:\s*"presentExport"/u);
  assert.match(ios, /CAPPluginMethod\(name:\s*"pickImport"/u);
  assert.match(ios, /UIActivityViewController/u);
  assert.match(ios, /UIDocumentPickerViewController/u);
  assert.match(ios, /UTType\.json/u);
  assert.match(ios, /SHA256/u);
  assert.match(android, /@CapacitorPlugin\(name\s*=\s*"LearningBackupFile"\)/u);
  assert.match(android, /void\s+presentExport\s*\(/u);
  assert.match(android, /void\s+pickImport\s*\(/u);
  assert.match(android, /Intent\.ACTION_SEND/u);
  assert.match(android, /Intent\.ACTION_OPEN_DOCUMENT/u);
  assert.match(android, /FileProvider/u);
  assert.match(android, /MessageDigest/u);
  assert.match(scene, /registerPluginInstance\(LearningBackupFilePlugin\(\)\)/u);
  assert.match(
    activity,
    /registerPlugin\(LearningBackupFilePlugin\.class\)/u,
  );
  assert.match(project, /LearningBackupFilePlugin\.swift in Sources/u);

  for (const source of [ios, android]) {
    assert.match(source, /5\s*\*\s*1024\s*\*\s*1024/u);
    assert.match(source, /fileName/u);
    assert.match(source, /bytesBase64/u);
    assert.match(source, /sha256/u);
    assert.match(source, /maximumBytes/u);
    assert.match(source, /cancelled/u);
    assert.doesNotMatch(
      source,
      /learnerId|nickname|Parent PIN|entitlement|purchase|https?:|URLSession|HttpURLConnection/u,
    );
  }

  assert.doesNotMatch(
    manifest,
    /READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|MANAGE_EXTERNAL_STORAGE/u,
  );
});
