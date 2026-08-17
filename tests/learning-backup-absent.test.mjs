import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function repoPath(...parts) {
  return join(ROOT, ...parts);
}

async function readUtf8(...parts) {
  return readFile(repoPath(...parts), 'utf8');
}

test('v1 must not ship the learning-backup file path, UI or native plugin', async () => {
  const deletedPaths = [
    'src/app/parent-backup-service.js',
    'src/domain/security/learning-backup-contract.js',
    'src/platform/backup/capacitor-learning-backup-file-plugin.js',
    'src/platform/backup/capacitor-learning-backup-files.js',
    'src/platform/database/sqlite-learning-backup-repository.js',
    'ios/App/App/LearningBackupFilePlugin.swift',
    'android/app/src/main/java/uk/eugnel/ks2spelling/LearningBackupFilePlugin.java',
    'android/app/src/main/res/xml/file_paths.xml',
    'scripts/dev/make-all-mega-backup.mjs',
  ];
  for (const relative of deletedPaths) {
    assert.equal(
      existsSync(repoPath(relative)),
      false,
      `${relative} must stay deleted`,
    );
  }

  const [
    productApp,
    services,
    failure,
    scene,
    activity,
    project,
    manifest,
    notice,
    listing,
    concepts,
    policy,
    screenshots,
  ] = await Promise.all([
    readUtf8('src/app/ProductApp.jsx'),
    readUtf8('src/app/create-product-app-services.js'),
    readUtf8('src/app/product-failure-services.js'),
    readUtf8('ios/App/App/SceneDelegate.swift'),
    readUtf8(
      'android/app/src/main/java/uk/eugnel/ks2spelling/MainActivity.java',
    ),
    readUtf8('ios/App/App.xcodeproj/project.pbxproj'),
    readUtf8('android/app/src/main/AndroidManifest.xml'),
    readUtf8('docs/legal/privacy-notice.md'),
    readUtf8('docs/product/store-listing.md'),
    readUtf8('CONCEPTS.md'),
    readUtf8('config/dependency-policy.json'),
    readUtf8('design/app-store-screenshots/README.md'),
  ]);

  const productSources = [productApp, services, failure];
  for (const source of productSources) {
    assert.doesNotMatch(source, /parentBackup|LearningBackup|exportBackup|importBackup/);
    assert.doesNotMatch(source, /Export learning backup|Import learning backup/);
  }
  assert.doesNotMatch(productApp, /Learning backup/);
  assert.doesNotMatch(scene, /LearningBackupFilePlugin/);
  assert.doesNotMatch(activity, /LearningBackupFilePlugin/);
  assert.doesNotMatch(project, /LearningBackupFilePlugin/);
  assert.doesNotMatch(manifest, /FileProvider|file_paths|learning.backups/);
  assert.match(notice, /Nothing is retained off the device\./);
  assert.doesNotMatch(notice, /A Parent may explicitly export a learning backup/);
  assert.doesNotMatch(notice, /backup copies previously exported elsewhere/);
  assert.doesNotMatch(listing, /\bbackups\b/);
  assert.doesNotMatch(screenshots, /\bbackups\b/);
  assert.doesNotMatch(concepts, /### Learning backup/);
  assert.match(concepts, /### iCloud learning replica/);
  assert.doesNotMatch(policy, /LearningBackupFile|app-owned-learning-backup-file-bridge/);
});
