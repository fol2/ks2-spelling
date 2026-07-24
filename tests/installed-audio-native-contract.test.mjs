import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);

test('installed audio is one private bounded native bridge on iOS and Android', async () => {
  const [ios, android, scene, activity, project] = await Promise.all([
    readFile(new URL('ios/App/App/InstalledAudioPlugin.swift', ROOT), 'utf8'),
    readFile(
      new URL(
        'android/app/src/main/java/uk/eugnel/ks2spelling/InstalledAudioPlugin.java',
        ROOT,
      ),
      'utf8',
    ),
    readFile(new URL('ios/App/App/SceneDelegate.swift', ROOT), 'utf8'),
    readFile(
      new URL('android/app/src/main/java/uk/eugnel/ks2spelling/MainActivity.java', ROOT),
      'utf8',
    ),
    readFile(new URL('ios/App/App.xcodeproj/project.pbxproj', ROOT), 'utf8'),
  ]);

  assert.match(ios, /jsName\s*=\s*"InstalledAudio"/u);
  assert.match(ios, /CAPPluginMethod\(name:\s*"readInstalledAudio"/u);
  assert.match(android, /@CapacitorPlugin\(name\s*=\s*"InstalledAudio"\)/u);
  assert.match(android, /void\s+readInstalledAudio\s*\(/u);
  assert.match(scene, /registerPluginInstance\(InstalledAudioPlugin\(\)\)/u);
  assert.match(activity, /registerPlugin\(InstalledAudioPlugin\.class\)/u);
  assert.match(project, /InstalledAudioPlugin\.swift in Sources/u);

  for (const source of [ios, android]) {
    assert.match(source, /packId/u);
    assert.match(source, /version/u);
    assert.match(source, /assetPath/u);
    assert.match(source, /sha256/u);
    assert.match(source, /byteSize/u);
    assert.match(source, /131_072/u);
    assert.match(source, /activation\.json/u);
    assert.match(source, /extracted/u);
    assert.match(source, /O_NOFOLLOW/u);
    assert.match(source, /base64/u);
    assert.doesNotMatch(
      source,
      /destinationPath|absolutePath|fileURL|https?:|URLSession|HttpURLConnection/u,
    );
  }
});
