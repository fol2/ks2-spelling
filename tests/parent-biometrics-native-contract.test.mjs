import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);

test('ParentAccess is one B4-isolated native Parent authority on iOS and Android', async () => {
  const [ios, android, scene, activity, manifest, info, project, variables] =
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
      readFile(new URL('android/variables.gradle', ROOT), 'utf8'),
    ]);

  assert.match(ios, /jsName\s*=\s*"ParentAccess"/u);
  assert.match(ios, /LocalAuthentication/u);
  assert.match(ios, /deviceOwnerAuthenticationWithBiometrics/u);
  assert.match(ios, /\.deviceOwnerAuthentication[,\n]/u);
  assert.match(ios, /private var activeContext: LAContext\?/u);
  assert.match(android, /@CapacitorPlugin\(name\s*=\s*"ParentAccess"\)/u);
  assert.match(android, /BiometricPrompt/u);
  assert.match(android, /BIOMETRIC_STRONG/u);
  assert.match(android, /DEVICE_CREDENTIAL/u);
  assert.match(android, /Build\.VERSION_CODES\.R/u);
  assert.match(android, /setDeviceCredentialAllowed\(true\)/u);
  assert.match(android, /KeyguardManager/u);
  assert.match(android, /AtomicBoolean authenticationInFlight/u);
  assert.match(variables, /minSdkVersion\s*=\s*24/u);
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
    assert.match(source, /getDeviceOwnerAuthenticationAvailability/u);
    assert.match(source, /authenticateDeviceOwner/u);
    assert.match(source, /reason/u);
    assert.match(source, /120/u);
    assert.doesNotMatch(source, /URLSession|HttpURLConnection|https?:\/\//u);
  }

  // The only JavaScript-provided value either platform reads is the bounded
  // display reason. PINs, learner identifiers and entitlement data therefore
  // cannot cross this native bridge even if a caller tries to add fields.
  const iosInputs = [...ios.matchAll(/getString\("([^"]+)"\)/gu)]
    .map((match) => match[1]);
  const androidInputs = [...android.matchAll(/getString\("([^"]+)"\)/gu)]
    .map((match) => match[1]);
  assert.deepEqual(iosInputs, ['reason']);
  assert.deepEqual(androidInputs, ['reason']);
});
