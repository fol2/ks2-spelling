import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);

test('ParentAccess is one B4-isolated native biometric bridge on iOS and Android', async () => {
  const [ios, android, scene, activity, manifest, info, project] =
    await Promise.all([
      readFile(new URL('ios/App/App/ParentAccessPlugin.swift', ROOT), 'utf8'),
      readFile(
        new URL(
          'android/app/src/main/java/uk/eugnel/ks2spelling/ParentAccessPlugin.java',
          ROOT,
        ),
        'utf8',
      ),
      readFile(new URL('ios/App/App/SceneDelegate.swift', ROOT), 'utf8'),
      readFile(
        new URL('android/app/src/main/java/uk/eugnel/ks2spelling/MainActivity.java', ROOT),
        'utf8',
      ),
      readFile(new URL('android/app/src/main/AndroidManifest.xml', ROOT), 'utf8'),
      readFile(new URL('ios/App/App/Info.plist', ROOT), 'utf8'),
      readFile(new URL('ios/App/App.xcodeproj/project.pbxproj', ROOT), 'utf8'),
    ]);

  assert.match(ios, /jsName\s*=\s*"ParentAccess"/u);
  assert.match(ios, /LocalAuthentication/u);
  assert.match(ios, /deviceOwnerAuthenticationWithBiometrics/u);
  assert.doesNotMatch(ios, /deviceOwnerAuthentication(?!WithBiometrics)/u);
  assert.match(android, /@CapacitorPlugin\(name\s*=\s*"ParentAccess"\)/u);
  assert.match(android, /BiometricPrompt/u);
  assert.match(android, /BIOMETRIC_STRONG/u);
  assert.match(scene, /registerPluginInstance\(ParentAccessPlugin\(\)\)/u);
  assert.match(activity, /registerPlugin\(ParentAccessPlugin\.class\)/u);
  assert.match(project, /ParentAccessPlugin\.swift in Sources/u);
  assert.match(manifest, /android\.permission\.USE_BIOMETRIC/u);
  assert.doesNotMatch(
    manifest,
    /android:name="android\.permission\.USE_BIOMETRIC"\s+tools:node="remove"/u,
  );
  assert.match(info, /NSFaceIDUsageDescription/u);

  for (const source of [ios, android]) {
    assert.match(source, /getBiometricAvailability/u);
    assert.match(source, /authenticateBiometric/u);
    assert.match(source, /reason/u);
    assert.doesNotMatch(
      source,
      /learnerId|nickname|PIN|passcode|secret|https?:|URLSession|HttpURLConnection/u,
    );
  }
});
