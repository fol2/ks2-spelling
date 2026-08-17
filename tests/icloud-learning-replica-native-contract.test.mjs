import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);

test('ICloudLearningReplica is an owned private-database plugin with an Android no-op', async () => {
  const [ios, android, scene, activity, project, entitlements, pluginJs, services] =
    await Promise.all([
      readFile(new URL('ios/App/App/ICloudLearningReplicaPlugin.swift', ROOT), 'utf8'),
      readFile(
        new URL(
          'android/app/src/main/java/uk/eugnel/ks2spelling/ICloudLearningReplicaPlugin.java',
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
      readFile(new URL('ios/App/App.xcodeproj/project.pbxproj', ROOT), 'utf8'),
      readFile(new URL('ios/App/App/App.entitlements', ROOT), 'utf8'),
      readFile(
        new URL(
          'src/platform/sync/capacitor-icloud-learning-replica-plugin.js',
          ROOT,
        ),
        'utf8',
      ),
      readFile(new URL('src/app/create-product-app-services.js', ROOT), 'utf8'),
    ]);

  assert.match(ios, /jsName\s*=\s*"ICloudLearningReplica"/u);
  assert.match(ios, /CAPPluginMethod\(\s*name:\s*"getStatus"/u);
  assert.match(ios, /CAPPluginMethod\(\s*name:\s*"publish"/u);
  assert.match(ios, /CAPPluginMethod\(\s*name:\s*"pull"/u);
  assert.match(ios, /privateCloudDatabase/u);
  assert.doesNotMatch(ios, /publicCloudDatabase/u);
  assert.match(ios, /iCloud\.uk\.eugnel\.ks2spelling/u);
  assert.match(ios, /#available\(iOS 17\.0, \*\)[\s\S]*CKSyncEngine/u);
  assert.match(ios, /learning-replica/u);
  assert.match(ios, /LearnerProfile/u);
  assert.match(ios, /LearnerSnapshot/u);
  assert.match(ios, /CKAsset/u);

  const productPlugins = scene.match(
    /if !isOfflineB4Bundle\(\) \{[\s\S]*?\n        \}/u,
  );
  assert.ok(productPlugins, 'SceneDelegate registers product plugins behind !isOfflineB4Bundle()');
  assert.match(
    productPlugins[0],
    /registerPluginInstance\(ICloudLearningReplicaPlugin\(\)\)/u,
  );
  const sandboxProof = scene.match(/#if B3_SANDBOX_PROOF[\s\S]*?#endif/u);
  assert.ok(sandboxProof, 'SceneDelegate keeps the B3 sandbox-proof block');
  assert.doesNotMatch(
    sandboxProof[0],
    /ICloudLearningReplica/u,
    'ICloudLearningReplica must not live only under B3_SANDBOX_PROOF',
  );

  assert.match(
    android,
    /@CapacitorPlugin\(name\s*=\s*"ICloudLearningReplica"\)/u,
  );
  assert.match(android, /void\s+getStatus\s*\(/u);
  assert.match(android, /void\s+publish\s*\(/u);
  assert.match(android, /void\s+pull\s*\(/u);
  assert.match(android, /put\("available",\s*false\)/u);
  assert.match(android, /"unsupported"/u);
  assert.doesNotMatch(android, /CloudKit|CKRecord|publicCloudDatabase/u);

  assert.match(
    activity,
    /registerPlugin\(ICloudLearningReplicaPlugin\.class\)/u,
  );

  assert.match(project, /ICloudLearningReplicaPlugin\.swift in Sources/u);
  assert.match(project, /CODE_SIGN_ENTITLEMENTS = App\/App\.entitlements;/u);
  assert.match(project, /IPHONEOS_DEPLOYMENT_TARGET = 15\.0;/u);
  assert.doesNotMatch(project, /IPHONEOS_DEPLOYMENT_TARGET = 1[67]/u);

  const entitlementKeys = [...entitlements.matchAll(/<key>([^<]+)<\/key>/gu)].map(
    (match) => match[1],
  );
  assert.deepEqual(entitlementKeys, [
    'com.apple.developer.icloud-container-identifiers',
    'com.apple.developer.icloud-services',
  ]);
  assert.match(entitlements, /iCloud\.uk\.eugnel\.ks2spelling/u);
  assert.match(entitlements, /CloudKit/u);
  assert.doesNotMatch(
    entitlements,
    /icloud-documents|ubiquity-kvstore|aps-environment|keychain-access-groups/u,
  );

  assert.match(pluginJs, /registerPlugin\(\s*'ICloudLearningReplica'/u);
  assert.match(services, /createCapacitorICloudLearningReplica/u);
  assert.match(services, /startICloudLearningReplica/u);
  assert.match(services, /applyReplicaResult/u);
  assert.match(services, /learningReplica\.dispose/u);
});
