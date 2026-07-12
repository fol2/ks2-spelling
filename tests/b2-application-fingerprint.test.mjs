import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    'config/mobile-identity.json',
    'provenance/ks2-mastery-gate-a.json',
    'src/platform/database/schema-v1.js',
    'vendor/ks2-mastery/runtime.js',
    'scripts/lib/b2-evidence.mjs',
    'scripts/prove-b2-ios.mjs',
    'scripts/prove-b2-android.mjs',
    'android/app/build.gradle',
    'android/app/src/main/assets/capacitor.config.json',
    'android/app/src/main/assets/public/index.html',
    'ios/App/App.xcodeproj/project.pbxproj',
    'ios/App/App/public/index.html',
  ]) await write(root, path);
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
      'vendor/ks2-mastery/runtime.js',
      'scripts/lib/b2-evidence.mjs',
      'scripts/prove-b2-ios.mjs',
      'scripts/prove-b2-android.mjs',
      'android/app/src/main/assets/public/index.html',
      'ios/App/App/public/index.html',
    ]) assert.ok(paths.includes(required), `required fingerprint input omitted: ${required}`);
    assert.equal(paths.some((path) => path.startsWith('reports/')), false);
    assert.equal(paths.some((path) => path.startsWith('.native-build/')), false);
    assert.equal(paths.some((path) => path.startsWith('.superpowers/')), false);
    assert.equal(paths.some((path) => path.startsWith('screenshots/')), false);

    await write(root, 'scripts/prove-b2-ios.mjs', 'changed behaviour');
    const changed = await fingerprintB2Application({ root });
    assert.notEqual(changed.sha256, first.sha256);
    await write(root, 'reports/b2/ios-simulator-proof.json', 'changed evidence');
    assert.equal((await fingerprintB2Application({ root })).sha256, changed.sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
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
