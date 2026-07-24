import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const DEFAULT_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const FROZEN_B2_COMMIT = '39ef90a5a33efb41368272c4c6d4d002f04658b3';
const PLAN_PATH =
  'docs/superpowers/plans/2026-07-12-standalone-spelling-mobile-b3-sandbox-billing-signed-download-proof.md';
const B4_PLAN_PATH =
  'docs/superpowers/plans/2026-07-18-standalone-spelling-mobile-b4-capacitor-development-certification.md';
const C_SERIES_PLAN_PATH =
  'docs/superpowers/plans/2026-07-23-c-series-product-completion.md';
const PROTECTED_PATHS = Object.freeze([
  'scripts/build-b2-native-plugin-report.mjs',
  'scripts/lib/frozen-b2-git.mjs',
  'scripts/lib/pinned-system-git.mjs',
  'tests/b2-native-plugin-build-policy.test.mjs',
]);
const EXPECTED_PROTECTED_CURRENT_HASHES = Object.freeze({
  'scripts/build-b2-native-plugin-report.mjs':
    '0b2d437bececcd0abccdd302c7b941da3e1e4116f31751068cc5997968ffb723',
  'scripts/lib/frozen-b2-git.mjs':
    '5f689a86324b9e3a101487819335c82f1b980e5c13c1e911668b2cfb603372cc',
  'scripts/lib/pinned-system-git.mjs':
    'd07a03f20f9f19711b665f9f0610a9de190bbb1418677e5e307f249ee472b478',
  'tests/b2-native-plugin-build-policy.test.mjs':
    '7bc98e0cd2348a41107b4ca0ede2531b747aee34bfcf24e7eade7f4bd0c98419',
});

export const B3_PLANNED_PACKAGE_SCRIPT_ADDITIONS = Object.freeze({
  'verify:b2-authority': 'node scripts/verify-b2-authority.mjs',
  'check:b3-prerequisites': 'node scripts/check-b3-external-prerequisites.mjs',
  'build:b3-proof-pack': 'node scripts/build-b3-proof-pack.mjs',
  'prove:b3:ios-storekit-test': 'node scripts/prove-b3-ios-storekit-test.mjs',
  'report:b3-native': 'node scripts/build-b3-native-audit.mjs',
  'prove:b3:deterministic': 'node scripts/run-b3-deterministic-proof.mjs',
  'deploy:b3:sandbox': 'node scripts/deploy-b3-sandbox-gateway.mjs',
  'prove:b3:cloudflare': 'node scripts/prove-b3-cloudflare.mjs',
  'prove:b3:ios': 'node scripts/prove-b3-ios.mjs',
  'prove:b3:android': 'node scripts/prove-b3-android.mjs',
  'prepare:b3:distribution': 'node scripts/prepare-b3-distribution.mjs',
  'verify:b3:installed-distribution':
    'node scripts/verify-b3-installed-distribution.mjs',
  'verify:b3':
    'npm run verify:b2-authority && npm run verify:vendor && npm run test:upstream:a3 && npm test && npm run lint && npm run build && npm run native:sync:check && npm run test:ios && node scripts/test-ios-pack-inspector.mjs && npm run prove:b3:ios-storekit-test && npm run test:android && npm run certify:android && npm run test:android-resolved-policy && npm run report:b3-native && npm run prove:b3:deterministic && npm run audit:dependencies && node scripts/build-b3-exit-report.mjs --check-ci',
});

export const B4_PLANNED_PACKAGE_SCRIPT_ADDITIONS = Object.freeze({
  'build:b4-development': 'vite build --mode B4Development',
  'sync:b4-development': 'npm run build:b4-development && cap sync',
  'prove:b4:ios': 'node scripts/prove-b4-ios.mjs',
  'prove:b4:android': 'node scripts/prove-b4-android.mjs',
  'report:b4-development': 'node scripts/collect-b4-development-evidence.mjs',
  'report:b4-development:check':
    'node scripts/collect-b4-development-evidence.mjs --check',
});

export const C_SERIES_PLANNED_PACKAGE_SCRIPT_ADDITIONS = Object.freeze({
  'build:starter-pack': 'node scripts/build-starter-pack.mjs',
  'generate:starter-audio': 'node scripts/generate-starter-audio.mjs',
  'verify:starter-audio': 'node scripts/generate-starter-audio.mjs --check',
  'verify:starter-pack': 'node scripts/build-starter-pack.mjs',
  'verify:art': 'node scripts/verify-vendored-art.mjs',
});

// SDLC velocity tier (2026-07-22): the local fast-test daily loop and pre-push
// hook. Developer tooling, not certification steps — they add no CI surface and
// exclude test files by name only for speed. Registered here because the
// package-transition authority requires every package script to be pre-approved;
// values must stay byte-identical to package.json and provenance.
export const SDLC_DAILY_LOOP_PACKAGE_SCRIPT_ADDITIONS = Object.freeze({
  'test:fast':
    "node --test $(find tests -maxdepth 1 -name '*.test.mjs' ! -name '*.slow.test.mjs' ! -name 'native-wrapper-contract.test.mjs' ! -name 'b3-store-backed-live-capture.test.mjs' ! -name 'gateway-workerd-runtime.test.mjs')",
  'test:watch':
    "node --test --watch $(find tests -maxdepth 1 -name '*.test.mjs' ! -name '*.slow.test.mjs' ! -name 'native-wrapper-contract.test.mjs' ! -name 'b3-store-backed-live-capture.test.mjs' ! -name 'gateway-workerd-runtime.test.mjs')",
  'test:changed':
    `files=$(git diff --name-only --diff-filter=ACMR HEAD -- 'tests/*.test.mjs'); [ -n "$files" ] && node --test $files || echo 'no changed tests'`,
  'hooks:install': 'git config core.hooksPath scripts/git-hooks',
});

const PLANNED_PACKAGE_SCRIPT_ADDITIONS = Object.freeze({
  ...B3_PLANNED_PACKAGE_SCRIPT_ADDITIONS,
  ...B4_PLANNED_PACKAGE_SCRIPT_ADDITIONS,
  ...C_SERIES_PLANNED_PACKAGE_SCRIPT_ADDITIONS,
  ...SDLC_DAILY_LOOP_PACKAGE_SCRIPT_ADDITIONS,
});

function transitionError(message) {
  const error = new Error(message);
  error.code = 'b3_package_transition_invalid';
  return error;
}

function hasExactKeys(value, expectedKeys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    isDeepStrictEqual(Object.keys(value).sort(), [...expectedKeys].sort())
  );
}

async function readRegularFile(path, label) {
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    throw transitionError(`missing ${label}`);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw transitionError(`${label} is not a regular file`);
  }
  return readFile(path);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function verifyB3PackageTransitionAuthority({ root = DEFAULT_ROOT } = {}) {
  const bytes = await readRegularFile(
    resolve(root, 'provenance/b3-package-transition.json'),
    'B3 package transition authority',
  );
  let authority;
  try {
    authority = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw transitionError('B3 package transition authority is not valid JSON');
  }
  if (
    !hasExactKeys(authority, [
      'schemaVersion',
      'frozenB2Commit',
      'approvedPlanPath',
      'approvedB4PlanPath',
      'approvedCSeriesPlanPath',
      'allowedPackageScriptAdditions',
      'protectedCurrentFiles',
    ]) ||
    authority.schemaVersion !== 3 ||
    authority.frozenB2Commit !== FROZEN_B2_COMMIT ||
    authority.approvedPlanPath !== PLAN_PATH ||
    authority.approvedB4PlanPath !== B4_PLAN_PATH ||
    authority.approvedCSeriesPlanPath !== C_SERIES_PLAN_PATH ||
    !isDeepStrictEqual(
      authority.allowedPackageScriptAdditions,
      PLANNED_PACKAGE_SCRIPT_ADDITIONS,
    ) ||
    !Array.isArray(authority.protectedCurrentFiles) ||
    authority.protectedCurrentFiles.length !== PROTECTED_PATHS.length ||
    !isDeepStrictEqual(
      authority.protectedCurrentFiles.map((entry) => entry?.path),
      PROTECTED_PATHS,
    ) ||
    authority.protectedCurrentFiles.some(
      (entry) =>
        !hasExactKeys(entry, ['path', 'sha256']) || !/^[0-9a-f]{64}$/u.test(entry.sha256),
    )
  ) {
    throw transitionError('B3 package transition authority does not match its closed schema');
  }

  const declaredProtectedHashes = Object.fromEntries(
    authority.protectedCurrentFiles.map(({ path, sha256: value }) => [path, value]),
  );
  if (!isDeepStrictEqual(declaredProtectedHashes, EXPECTED_PROTECTED_CURRENT_HASHES)) {
    throw transitionError('independent protected hash authority mismatch');
  }

  for (const entry of authority.protectedCurrentFiles) {
    const actual = sha256(await readRegularFile(resolve(root, entry.path), entry.path));
    if (actual !== entry.sha256) {
      throw transitionError(`protected current file hash mismatch: ${entry.path}`);
    }
  }
  return structuredClone(authority);
}

export function assertB2PackageTransition(frozenPackage, currentPackage, authority) {
  if (
    !authority ||
    !isDeepStrictEqual(
      authority.allowedPackageScriptAdditions,
      PLANNED_PACKAGE_SCRIPT_ADDITIONS,
    ) ||
    !hasExactKeys(frozenPackage, Object.keys(currentPackage ?? {})) ||
    !hasExactKeys(currentPackage, Object.keys(frozenPackage ?? {})) ||
    typeof frozenPackage.scripts !== 'object' ||
    typeof currentPackage.scripts !== 'object'
  ) {
    throw transitionError('Package transition authority is invalid');
  }

  const currentWithoutScripts = structuredClone(currentPackage);
  const frozenWithoutScripts = structuredClone(frozenPackage);
  delete currentWithoutScripts.scripts;
  delete frozenWithoutScripts.scripts;
  if (!isDeepStrictEqual(currentWithoutScripts, frozenWithoutScripts)) {
    throw transitionError('Package drift is outside the approved B3 transition');
  }

  for (const [name, command] of Object.entries(frozenPackage.scripts)) {
    if (currentPackage.scripts[name] !== command) {
      throw transitionError(`Frozen package script drifted: ${name}`);
    }
  }
  for (const [name, command] of Object.entries(currentPackage.scripts)) {
    if (Object.hasOwn(frozenPackage.scripts, name)) continue;
    if (PLANNED_PACKAGE_SCRIPT_ADDITIONS[name] !== command) {
      throw transitionError(`Package script is not authorised by the approved plans: ${name}`);
    }
  }
}
