import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const ORIGINAL_REQUIREMENT =
  '.package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", branch: "8.0.0"),';
const PATCHED_REQUIREMENT =
  '.package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.4.1"),';
const ORIGINAL_MANIFEST = `// swift-tools-version: 5.9
dependencies: [
    ${ORIGINAL_REQUIREMENT}
]
`;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

test('native preparation patches one exact known manifest and is idempotent', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ks2-native-prepare-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, 'node_modules/@capacitor-community/sqlite');
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({ name: '@capacitor-community/sqlite', version: '8.1.0' }),
  );
  await writeFile(join(packageRoot, 'Package.swift'), ORIGINAL_MANIFEST);
  const { prepareNativeDependencies } = await import(
    '../scripts/prepare-native-dependencies.mjs'
  );
  const options = {
    root,
    expectedOriginalSha256: sha256(ORIGINAL_MANIFEST),
    expectedPatchedSha256: sha256(
      ORIGINAL_MANIFEST.replace(ORIGINAL_REQUIREMENT, PATCHED_REQUIREMENT),
    ),
  };
  const first = await prepareNativeDependencies(options);
  assert.equal(first.changed, true);
  assert.equal(first.packageVersion, '8.1.0');
  assert.equal(first.capacitorRequirement.kind, 'exact');
  assert.equal(first.capacitorRequirement.version, '8.4.1');
  assert.equal(
    await readFile(join(packageRoot, 'Package.swift'), 'utf8'),
    ORIGINAL_MANIFEST.replace(ORIGINAL_REQUIREMENT, PATCHED_REQUIREMENT),
  );
  assert.deepEqual(await prepareNativeDependencies(options), {
    ...first,
    changed: false,
  });
});

test('native preparation fails closed on package or manifest drift', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ks2-native-prepare-drift-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, 'node_modules/@capacitor-community/sqlite');
  await mkdir(packageRoot, { recursive: true });
  const { prepareNativeDependencies } = await import(
    '../scripts/prepare-native-dependencies.mjs'
  );
  const manifestPath = join(packageRoot, 'Package.swift');
  const packagePath = join(packageRoot, 'package.json');
  await writeFile(packagePath, JSON.stringify({ version: '8.2.0' }));
  await writeFile(manifestPath, ORIGINAL_MANIFEST);
  await assert.rejects(
    () =>
      prepareNativeDependencies({
        root,
        expectedOriginalSha256: sha256(ORIGINAL_MANIFEST),
        expectedPatchedSha256: sha256(
          ORIGINAL_MANIFEST.replace(ORIGINAL_REQUIREMENT, PATCHED_REQUIREMENT),
        ),
      }),
    ({ code }) => code === 'native_dependency_upstream_drift',
  );
  await writeFile(
    packagePath,
    JSON.stringify({ name: '@capacitor-community/sqlite', version: '8.1.0' }),
  );
  await writeFile(manifestPath, `${ORIGINAL_MANIFEST}\n// unexpected upstream edit\n`);
  await assert.rejects(
    () =>
      prepareNativeDependencies({
        root,
        expectedOriginalSha256: sha256(ORIGINAL_MANIFEST),
        expectedPatchedSha256: sha256(
          ORIGINAL_MANIFEST.replace(ORIGINAL_REQUIREMENT, PATCHED_REQUIREMENT),
        ),
      }),
    ({ code }) => code === 'native_dependency_upstream_drift',
  );
});

test('native preparation rejects lock-integrity drift before mutating the manifest', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ks2-native-prepare-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, 'node_modules/@capacitor-community/sqlite');
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({ name: '@capacitor-community/sqlite', version: '8.1.0' }),
  );
  await writeFile(join(packageRoot, 'Package.swift'), ORIGINAL_MANIFEST);
  await writeFile(
    join(root, 'package-lock.json'),
    JSON.stringify({
      packages: {
        'node_modules/@capacitor-community/sqlite': {
          version: '8.1.0',
          integrity: 'sha512-unexpected',
        },
      },
    }),
  );
  const { prepareNativeDependencies } = await import(
    '../scripts/prepare-native-dependencies.mjs'
  );
  await assert.rejects(
    () =>
      prepareNativeDependencies({
        root,
        expectedOriginalSha256: sha256(ORIGINAL_MANIFEST),
        expectedPatchedSha256: sha256(
          ORIGINAL_MANIFEST.replace(ORIGINAL_REQUIREMENT, PATCHED_REQUIREMENT),
        ),
      }),
    ({ code }) => code === 'native_dependency_upstream_drift',
  );
  assert.equal(await readFile(join(packageRoot, 'Package.swift'), 'utf8'), ORIGINAL_MANIFEST);
});
