import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);

test('LocalDataProtection enforces the fixed local database policy natively', async () => {
  const [ios, android, scene, activity, manifest, project] = await Promise.all([
    readFile(
      new URL('ios/App/App/LocalDataProtectionPlugin.swift', ROOT),
      'utf8',
    ),
    readFile(
      new URL(
        'android/app/src/main/java/uk/eugnel/ks2spelling/LocalDataProtectionPlugin.java',
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

  assert.match(ios, /jsName\s*=\s*"LocalDataProtection"/u);
  assert.match(
    ios,
    /CAPPluginMethod\(\s*name:\s*"applyDatabasePolicy"/u,
  );
  assert.match(ios, /FileProtectionType\.complete/u);
  assert.match(ios, /targetEnvironment\(simulator\)/u);
  assert.match(
    ios,
    /ios-simulator-protection-unobservable/u,
  );
  assert.match(ios, /return actual == nil \|\|/u);
  assert.match(ios, /isExcludedFromBackup/u);
  assert.match(ios, /CapacitorDatabase/u);
  assert.match(ios, /isSymbolicLink/u);
  assert.match(
    android,
    /@CapacitorPlugin\(name\s*=\s*"LocalDataProtection"\)/u,
  );
  assert.match(android, /void\s+applyDatabasePolicy\s*\(/u);
  assert.match(android, /ApplicationInfo\.FLAG_ALLOW_BACKUP/u);
  assert.match(android, /getDatabasePath/u);
  assert.match(android, /getCanonicalFile/u);
  assert.match(manifest, /android:allowBackup="false"/u);
  assert.match(
    scene,
    /registerPluginInstance\(LocalDataProtectionPlugin\(\)\)/u,
  );
  assert.match(
    activity,
    /registerPlugin\(LocalDataProtectionPlugin\.class\)/u,
  );
  assert.match(project, /LocalDataProtectionPlugin\.swift in Sources/u);

  for (const source of [ios, android]) {
    assert.match(source, /databaseName/u);
    assert.match(source, /automaticBackupDisabled/u);
    assert.match(source, /platformProtection/u);
    assert.doesNotMatch(
      source,
      /databasePath|learnerId|nickname|PIN|https?:|URLSession|HttpURLConnection/u,
    );
  }
});
