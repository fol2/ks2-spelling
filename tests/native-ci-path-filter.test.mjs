import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { detectNativeCiChanges } from '../scripts/detect-native-ci-changes.mjs';
import {
  NATIVE_CI_PATH_FILES,
  NATIVE_CI_PATH_PREFIXES,
  decideNativeCiSelection,
  pathSelectsNativeCi,
} from '../scripts/lib/native-ci-path-filter.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKFLOW_PATH = join(ROOT, '.github/workflows/ci.yml');

test('bundled web payload and native release inputs select both native CI jobs', async () => {
  const mustSelect = [
    'src/app/App.jsx',
    'public/sfx/tick.wav',
    'vite.config.js',
    'index.html',
    'vendor/ks2-mastery/shared/spelling/mobile/a3/command-repository.js',
    'content/starter-pack/audio/example.m4a',
    'docs/legal/privacy-notice.md',
    'package.json',
    'package-lock.json',
    'capacitor.config.json',
    'config/production/pack-signing-public-keys.json',
    'scripts/select-pack-signing-keyring.mjs',
    'scripts/verify-ios-release-artefacts.mjs',
    'ios/App/App/AppDelegate.swift',
    'android/app/build.gradle',
  ];
  for (const path of mustSelect) {
    assert.equal(pathSelectsNativeCi(path), true, `${path} must select native CI`);
  }

  const mustNotSelect = [
    'gateway/src/handler.js',
    'gateway/wrangler.jsonc',
    'docs/operations/merge-tier-gate.md',
    'README.md',
    'tests/ci-workflow-contract.test.mjs',
    'vite.design.config.js',
    'site/public/index.html',
  ];
  for (const path of mustNotSelect) {
    assert.equal(pathSelectsNativeCi(path), false, `${path} must not force native CI`);
  }
});

test('removing a bundled-source prefix turns the native path contract red', () => {
  const withoutSrc = NATIVE_CI_PATH_PREFIXES.filter((prefix) => prefix !== 'src/');
  assert.equal(pathSelectsNativeCi('src/main.jsx'), true);
  assert.equal(
    pathSelectsNativeCi('src/main.jsx', { prefixes: withoutSrc }),
    false,
  );

  const withoutPublic = NATIVE_CI_PATH_PREFIXES.filter((prefix) => prefix !== 'public/');
  assert.equal(
    pathSelectsNativeCi('public/sfx/tick.wav', { prefixes: withoutPublic }),
    false,
  );

  const withoutVite = NATIVE_CI_PATH_FILES.filter((file) => file !== 'vite.config.js');
  assert.equal(
    pathSelectsNativeCi('vite.config.js', { files: withoutVite }),
    false,
  );
});

test('native CI selection fails closed on unresolved base, empty diff and certification', () => {
  assert.deepEqual(decideNativeCiSelection({ certification: true }), {
    native: true,
    reason: 'certification',
  });
  assert.deepEqual(decideNativeCiSelection({ baseSha: null, changedPaths: ['README.md'] }), {
    native: true,
    reason: 'unresolved-base',
  });
  assert.deepEqual(
    decideNativeCiSelection({
      baseSha: '1111111111111111111111111111111111111111',
      changedPaths: null,
    }),
    { native: true, reason: 'unresolved-diff' },
  );
  assert.deepEqual(
    decideNativeCiSelection({
      baseSha: '1111111111111111111111111111111111111111',
      changedPaths: [],
    }),
    { native: true, reason: 'empty-diff' },
  );
  assert.deepEqual(
    decideNativeCiSelection({
      baseSha: '1111111111111111111111111111111111111111',
      changedPaths: ['README.md', 'docs/operations/merge-tier-gate.md'],
    }),
    { native: false, reason: 'no-native-input-changed' },
  );
  assert.deepEqual(
    decideNativeCiSelection({
      baseSha: '1111111111111111111111111111111111111111',
      changedPaths: ['src/app/App.jsx'],
    }),
    { native: true, reason: 'native-input-changed' },
  );
});

test('the detector writes native=true when git cannot resolve the candidate base', async () => {
  const decision = await detectNativeCiChanges({
    env: {
      MERGE_GROUP_BASE_SHA: '',
      PUSH_BEFORE_SHA: '0000000000000000000000000000000000000000',
      CERTIFICATION: '',
    },
    runGit: async () => {
      throw new Error('git should not run without a resolvable base');
    },
  });
  assert.deepEqual(decision, { native: true, reason: 'unresolved-base' });
});

test('both native CI jobs call the shared detector instead of an inline grep', async () => {
  const workflow = await readFile(WORKFLOW_PATH, 'utf8');
  const detector = [...workflow.matchAll(/node scripts\/detect-native-ci-changes\.mjs/gu)];
  assert.equal(detector.length, 2);
  assert.doesNotMatch(workflow, /grep -qE '/u);

  const android = workflow.slice(workflow.indexOf('  android-compile:'));
  const ios = workflow.slice(workflow.indexOf('  ios-compile:'));
  for (const job of [android, ios]) {
    assert.match(job, /id: filter/);
    assert.match(job, /MERGE_GROUP_BASE_SHA: \$\{\{ github\.event\.merge_group\.base_sha \}\}/);
    assert.match(job, /PUSH_BEFORE_SHA: \$\{\{ github\.event\.before \}\}/);
    assert.match(job, /CERTIFICATION: \$\{\{ inputs\.certification \}\}/);
    assert.match(
      job,
      /if: steps\.filter\.outputs\.native == 'true' \|\| github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'/,
    );
  }
});

test('native-release gate inputs still select native CI after a prefix mutation', () => {
  assert.equal(pathSelectsNativeCi('scripts/select-pack-signing-keyring.mjs'), true);
  assert.equal(
    pathSelectsNativeCi('scripts/select-pack-signing-keyring.mjs', {
      prefixes: NATIVE_CI_PATH_PREFIXES.filter((prefix) => prefix !== 'scripts/'),
    }),
    false,
  );
  assert.equal(pathSelectsNativeCi('config/production/pack-signing-public-keys.json'), true);
  assert.equal(
    pathSelectsNativeCi('config/production/pack-signing-public-keys.json', {
      prefixes: NATIVE_CI_PATH_PREFIXES.filter((prefix) => prefix !== 'config/'),
    }),
    false,
  );
});
