import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

async function write(root, path, content = path) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ks2-spelling-b2-fingerprint-'));
  for (const path of [
    '.npmrc',
    '.nvmrc',
    'capacitor.config.json',
    'index.html',
    'package-lock.json',
    'package.json',
    'vite.config.js',
    'config/dependency-policy.json',
    'config/maven-licence-policy.json',
    'config/mobile-identity.json',
    'config/third-party-notices-overrides.json',
    'provenance/ks2-mastery-gate-a.json',
    'src/main.jsx',
    'src/app/b2-proof-controller.js',
    'src/app/create-b2-app-services.js',
    'src/platform/database/capacitor-sqlite-connection.js',
    'src/platform/database/migrate-database.js',
    'src/platform/database/schema-v1.js',
    'src/platform/lifecycle/capacitor-app-lifecycle.js',
    'vendor/ks2-mastery/content/spelling.mobile-a1-kernel-manifest.json',
    'vendor/ks2-mastery/content/spelling.mobile-a2-contract-manifest.json',
    'vendor/ks2-mastery/content/spelling.mobile-a3-contract-manifest.json',
    'vendor/ks2-mastery/content/spelling.mobile-runtime-full.json',
    'vendor/ks2-mastery/content/spelling.mobile-runtime-starter.json',
    'vendor/ks2-mastery/shared/spelling/mobile/a3/command-repository.js',
    'scripts/lib/b2-evidence.mjs',
    'scripts/fingerprint-b2-application.mjs',
    'scripts/native-sync-check.mjs',
    'scripts/prepare-native-dependencies.mjs',
    'scripts/test-ios.mjs',
    'scripts/test-android.mjs',
    'scripts/verify-vendored-contract.mjs',
    'android/build.gradle',
    'android/settings.gradle',
    'android/app/build.gradle',
    'android/app/src/main/AndroidManifest.xml',
    'android/app/src/main/assets/capacitor.config.json',
    'android/app/src/main/assets/capacitor.plugins.json',
    'android/app/src/main/assets/public/index.html',
    'ios/App/App.xcodeproj/project.pbxproj',
    'ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved',
    'ios/App/App/AppDelegate.swift',
    'ios/App/App/Info.plist',
    'ios/App/App/capacitor.config.json',
    'ios/App/App/public/index.html',
  ]) await write(root, path);
  await write(
    root,
    'package.json',
    JSON.stringify({ scripts: {}, dependencies: {}, devDependencies: {} }),
  );
  await write(root, 'reports/b2/ios-simulator-proof.json', 'generated report');
  await write(root, 'reports/b2/ios-simulator-proof.png', 'generated screenshot');
  await write(root, '.native-build/ios/App.app/App', 'generated build');
  await write(root, '.superpowers/sdd/screenshots/progress.png', 'generated ledger image');
  await write(root, 'screenshots/manual.png', 'generated screenshot');
  return root;
}

test('B2 fingerprint includes every behavioural input and excludes evidence outputs', async () => {
  const { fingerprintB2Application } = await import(
    '../scripts/fingerprint-b2-application.mjs'
  );
  const root = await fixture();
  try {
    const first = await fingerprintB2Application({ root });
    assert.deepEqual(first, await fingerprintB2Application({ root }));
    const paths = first.files.map(({ path }) => path);
    for (const required of [
      'package-lock.json',
      'src/platform/database/schema-v1.js',
      'vendor/ks2-mastery/content/spelling.mobile-runtime-full.json',
      'scripts/lib/b2-evidence.mjs',
      'scripts/fingerprint-b2-application.mjs',
      'android/app/src/main/assets/public/index.html',
      'ios/App/App/public/index.html',
    ]) assert.ok(paths.includes(required), `required fingerprint input omitted: ${required}`);
    assert.equal(paths.some((path) => path.startsWith('reports/')), false);
    assert.equal(paths.some((path) => path.startsWith('.native-build/')), false);
    assert.equal(paths.some((path) => path.startsWith('.superpowers/')), false);
    assert.equal(paths.some((path) => path.startsWith('screenshots/')), false);

    await write(root, 'scripts/test-ios.mjs', 'changed behaviour');
    const changed = await fingerprintB2Application({ root });
    assert.notEqual(changed.sha256, first.sha256);
    await write(root, 'reports/b2/ios-simulator-proof.json', 'changed evidence');
    assert.equal((await fingerprintB2Application({ root })).sha256, changed.sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('B2 fingerprint fails closed when a behavioural root or authority anchor disappears', async () => {
  const { fingerprintB2Application } = await import(
    '../scripts/fingerprint-b2-application.mjs'
  );
  for (const path of [
    'src',
    'src/platform/database/schema-v1.js',
    'vendor',
    'vendor/ks2-mastery/content/spelling.mobile-runtime-full.json',
    'config',
    'config/mobile-identity.json',
    'provenance',
    'provenance/ks2-mastery-gate-a.json',
    'android',
    'android/app/src/main/assets/public/index.html',
    'ios',
    'ios/App/App/public/index.html',
    'scripts',
    'scripts/lib/b2-evidence.mjs',
  ]) {
    const root = await fixture();
    try {
      await rm(join(root, path), { recursive: true, force: true });
      await assert.rejects(
        fingerprintB2Application({ root }),
        ({ code }) => code === 'b2_required_input_missing',
        path,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('B2 fingerprint rejects symlinks, unsafe paths, collisions and unknown roots', async () => {
  const {
    assertSafeB2FingerprintPaths,
    fingerprintB2Application,
  } = await import('../scripts/fingerprint-b2-application.mjs');
  const root = await fixture();
  try {
    await symlink(join(root, 'index.html'), join(root, 'src/symlink.js'));
    await assert.rejects(
      fingerprintB2Application({ root }),
      ({ code }) => code === 'b2_unsafe_input',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  assert.throws(
    () => assertSafeB2FingerprintPaths(['src/App.js', 'src/app.js']),
    ({ code }) => code === 'b2_path_collision',
  );
  assert.throws(
    () => assertSafeB2FingerprintPaths(['src/cafe\u0301.js', 'src/caf\u00e9.js']),
    ({ code }) => code === 'b2_path_collision',
  );
  for (const path of [
    '../escape',
    '/absolute',
    'C:/absolute',
    'src\\windows.js',
    'src/../escape',
  ]) {
    assert.throws(
      () => assertSafeB2FingerprintPaths([path]),
      ({ code }) => code === 'b2_unsafe_path',
      path,
    );
  }

  const unknownRoot = await fixture();
  try {
    await write(unknownRoot, 'unknown-runtime/input.js');
    await assert.rejects(
      fingerprintB2Application({ root: unknownRoot }),
      ({ code }) => code === 'b2_unregistered_root_input',
    );
  } finally {
    await rm(unknownRoot, { recursive: true, force: true });
  }
});

test('future proof wrappers become mandatory only when their package command exists', async () => {
  const { fingerprintB2Application } = await import(
    '../scripts/fingerprint-b2-application.mjs'
  );
  for (const [scriptName, command, path] of [
    ['prove:b2:ios', 'node scripts/prove-b2-ios.mjs', 'scripts/prove-b2-ios.mjs'],
    [
      'prove:b2:android',
      'node scripts/prove-b2-android.mjs',
      'scripts/prove-b2-android.mjs',
    ],
  ]) {
    const root = await fixture();
    try {
      await write(
        root,
        'package.json',
        JSON.stringify({
          scripts: { [scriptName]: command },
          dependencies: {},
          devDependencies: {},
        }),
      );
      await assert.rejects(
        fingerprintB2Application({ root }),
        ({ code }) => code === 'b2_required_input_missing',
      );
      await write(root, path);
      await assert.doesNotReject(fingerprintB2Application({ root }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('B2 fingerprint fails closed on a missing required input', async () => {
  const { fingerprintB2Application } = await import(
    '../scripts/fingerprint-b2-application.mjs'
  );
  const root = await fixture();
  try {
    await rm(join(root, 'package-lock.json'));
    await assert.rejects(
      fingerprintB2Application({ root }),
      ({ code }) => code === 'b2_required_input_missing',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
