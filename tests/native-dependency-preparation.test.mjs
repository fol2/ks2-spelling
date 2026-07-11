import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const PACKAGE_NAME = '@capacitor-community/sqlite';
const PACKAGE_VERSION = '8.1.0';
const PACKAGE_INTEGRITY =
  'sha512-yhKZDAVPDPcM3QE6UGB3LXyV25a6Rve1SjZ1aUpTE0E2isnYTVM0PG9+JOI241f+NdsHzPTE7ESJiYSqKsKnuA==';
const ORIGINAL_REQUIREMENT =
  '.package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", branch: "8.0.0"),';
const PATCHED_REQUIREMENT =
  '.package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.4.1"),';
const ORIGINAL_MANIFEST = `// swift-tools-version: 5.9
dependencies: [
    ${ORIGINAL_REQUIREMENT}
]
`;
const PATCHED_MANIFEST = ORIGINAL_MANIFEST.replace(
  ORIGINAL_REQUIREMENT,
  PATCHED_REQUIREMENT,
);
const VALID_PACKAGE = JSON.stringify({ name: PACKAGE_NAME, version: PACKAGE_VERSION });
const VALID_LOCK = JSON.stringify({
  packages: {
    [`node_modules/${PACKAGE_NAME}`]: {
      version: PACKAGE_VERSION,
      integrity: PACKAGE_INTEGRITY,
    },
  },
});
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const preparationOptions = (root) => ({
  root,
  expectedOriginalSha256: sha256(ORIGINAL_MANIFEST),
  expectedPatchedSha256: sha256(PATCHED_MANIFEST),
});

async function createFixture(root, overrides = {}) {
  const packageRoot = join(root, 'node_modules/@capacitor-community/sqlite');
  await mkdir(packageRoot, { recursive: true });
  const paths = {
    manifest: join(packageRoot, 'Package.swift'),
    packageMetadata: join(packageRoot, 'package.json'),
    lock: join(root, 'package-lock.json'),
  };
  if (overrides.packageMetadata !== null) {
    await writeFile(
      paths.packageMetadata,
      overrides.packageMetadata ?? VALID_PACKAGE,
      'utf8',
    );
  }
  if (overrides.lock !== null) {
    await writeFile(paths.lock, overrides.lock ?? VALID_LOCK, 'utf8');
  }
  if (overrides.manifest !== null) {
    await writeFile(paths.manifest, overrides.manifest ?? ORIGINAL_MANIFEST, 'utf8');
  }
  return paths;
}

async function expectPreconditionFailure({ overrides, verifyMissingManifest = false }) {
  const root = await mkdtemp(join(tmpdir(), 'ks2-native-prepare-failure-'));
  const paths = await createFixture(root, overrides);
  const manifestBefore = existsSync(paths.manifest)
    ? await readFile(paths.manifest)
    : null;
  const { prepareNativeDependencies } = await import(
    '../scripts/prepare-native-dependencies.mjs'
  );
  await assert.rejects(
    () => prepareNativeDependencies(preparationOptions(root)),
    ({ code }) => code === 'native_dependency_upstream_drift',
  );
  if (verifyMissingManifest) {
    assert.equal(existsSync(paths.manifest), false);
  } else {
    assert.deepEqual(await readFile(paths.manifest), manifestBefore);
  }
  await rm(root, { recursive: true, force: true });
}

test('native preparation validates all inputs, patches once and is idempotent', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ks2-native-prepare-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = await createFixture(root);
  const { prepareNativeDependencies } = await import(
    '../scripts/prepare-native-dependencies.mjs'
  );
  const first = await prepareNativeDependencies(preparationOptions(root));
  assert.equal(first.changed, true);
  assert.equal(first.packageVersion, PACKAGE_VERSION);
  assert.deepEqual(first.capacitorRequirement, { kind: 'exact', version: '8.4.1' });
  assert.equal(await readFile(paths.manifest, 'utf8'), PATCHED_MANIFEST);
  assert.deepEqual(await prepareNativeDependencies(preparationOptions(root)), {
    ...first,
    changed: false,
  });
});

test('native preparation rejects a missing package manifest without creating it', async () => {
  await expectPreconditionFailure({
    overrides: { manifest: null },
    verifyMissingManifest: true,
  });
});

test('native preparation rejects missing or malformed package metadata before writing', async () => {
  await expectPreconditionFailure({ overrides: { packageMetadata: null } });
  await expectPreconditionFailure({ overrides: { packageMetadata: '{not-json' } });
  await expectPreconditionFailure({
    overrides: {
      packageMetadata: JSON.stringify({ name: PACKAGE_NAME, version: '8.2.0' }),
    },
  });
});

test('native preparation rejects missing or malformed lockfiles before writing', async () => {
  await expectPreconditionFailure({ overrides: { lock: null } });
  await expectPreconditionFailure({ overrides: { lock: '{not-json' } });
});

test('native preparation rejects wrong lock integrity before writing', async () => {
  await expectPreconditionFailure({
    overrides: {
      lock: JSON.stringify({
        packages: {
          [`node_modules/${PACKAGE_NAME}`]: {
            version: PACKAGE_VERSION,
            integrity: 'sha512-unexpected',
          },
        },
      }),
    },
  });
});

test('native preparation rejects manifest drift without normalising its bytes', async () => {
  await expectPreconditionFailure({
    overrides: { manifest: `${ORIGINAL_MANIFEST}// upstream drift\n` },
  });
});

test('native preparation normalises unreadable non-file inputs to upstream drift', async (t) => {
  for (const key of ['packageMetadata', 'lock', 'manifest']) {
    const root = await mkdtemp(join(tmpdir(), `ks2-native-prepare-unreadable-${key}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const paths = await createFixture(root, { [key]: null });
    await mkdir(paths[key]);
    const manifestBefore = key === 'manifest' ? null : await readFile(paths.manifest);
    const { prepareNativeDependencies } = await import(
      '../scripts/prepare-native-dependencies.mjs'
    );
    await assert.rejects(
      () => prepareNativeDependencies(preparationOptions(root)),
      ({ code }) => code === 'native_dependency_upstream_drift',
      key,
    );
    if (key === 'manifest') {
      assert.equal((await lstat(paths.manifest)).isDirectory(), true);
    } else {
      assert.deepEqual(await readFile(paths.manifest), manifestBefore);
    }
  }
});
