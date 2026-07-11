import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { EXIT_CODES, isMain, printJson } from './lib/run-command.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const PACKAGE_NAME = '@capacitor-community/sqlite';
const PACKAGE_VERSION = '8.1.0';
const PACKAGE_INTEGRITY =
  'sha512-yhKZDAVPDPcM3QE6UGB3LXyV25a6Rve1SjZ1aUpTE0E2isnYTVM0PG9+JOI241f+NdsHzPTE7ESJiYSqKsKnuA==';
const MANIFEST_PATH = 'node_modules/@capacitor-community/sqlite/Package.swift';
const ORIGINAL_REQUIREMENT =
  '.package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", branch: "8.0.0"),';
const PATCHED_REQUIREMENT =
  '.package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.4.1"),';
const ORIGINAL_MANIFEST_SHA256 =
  'c780ccf6fbbe68ea98bf5a8c72e3a0ec662f9ecf09ef2fd7abf2a3b892228c8d';
const PATCHED_MANIFEST_SHA256 =
  '068d8e721cb8fe42129db23ba79f753da0f1064720fb0ee57300b8ef3f4959e7';

export const NATIVE_DEPENDENCY_PATCH = Object.freeze({
  packageName: PACKAGE_NAME,
  packageVersion: PACKAGE_VERSION,
  packageIntegrity: PACKAGE_INTEGRITY,
  manifestPath: MANIFEST_PATH,
  upstreamManifestSha256: ORIGINAL_MANIFEST_SHA256,
  preparedManifestSha256: PATCHED_MANIFEST_SHA256,
  upstreamRequirement: ORIGINAL_REQUIREMENT,
  preparedRequirement: PATCHED_REQUIREMENT,
  capacitorRequirement: Object.freeze({ kind: 'exact', version: '8.4.1' }),
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function driftError(message) {
  const error = new Error(message);
  error.code = 'native_dependency_upstream_drift';
  return error;
}

export async function prepareNativeDependencies(options = {}) {
  const root = options.root ?? ROOT;
  const expectedOriginalSha256 =
    options.expectedOriginalSha256 ?? ORIGINAL_MANIFEST_SHA256;
  const expectedPatchedSha256 =
    options.expectedPatchedSha256 ?? PATCHED_MANIFEST_SHA256;
  const packageRoot = join(root, 'node_modules/@capacitor-community/sqlite');
  const packageJson = JSON.parse(
    await readFile(join(packageRoot, 'package.json'), 'utf8'),
  );
  if (packageJson.name !== PACKAGE_NAME || packageJson.version !== PACKAGE_VERSION) {
    throw driftError(
      `Expected ${PACKAGE_NAME}@${PACKAGE_VERSION}; found ${packageJson.name}@${packageJson.version}`,
    );
  }

  try {
    const packageLock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
    const lockEntry = packageLock.packages?.[`node_modules/${PACKAGE_NAME}`];
    if (
      lockEntry?.version !== PACKAGE_VERSION ||
      lockEntry?.integrity !== PACKAGE_INTEGRITY
    ) {
      throw driftError('SQLite package-lock identity or integrity drifted');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const manifestPath = join(root, MANIFEST_PATH);
  const manifest = await readFile(manifestPath, 'utf8');
  const actualSha256 = sha256(manifest);
  let changed = false;
  if (actualSha256 === expectedOriginalSha256) {
    const occurrences = manifest.split(ORIGINAL_REQUIREMENT).length - 1;
    if (occurrences !== 1) {
      throw driftError(`Expected one known Capacitor SPM requirement; found ${occurrences}`);
    }
    const prepared = manifest.replace(ORIGINAL_REQUIREMENT, PATCHED_REQUIREMENT);
    if (sha256(prepared) !== expectedPatchedSha256) {
      throw driftError('Prepared SQLite Package.swift does not match the audited hash');
    }
    await writeFile(manifestPath, prepared, 'utf8');
    changed = true;
  } else if (actualSha256 !== expectedPatchedSha256) {
    throw driftError(
      `SQLite Package.swift drifted: ${actualSha256} is neither audited input nor output`,
    );
  }

  return {
    packageName: PACKAGE_NAME,
    packageVersion: PACKAGE_VERSION,
    packageIntegrity: PACKAGE_INTEGRITY,
    manifestPath: MANIFEST_PATH,
    upstreamManifestSha256: expectedOriginalSha256,
    preparedManifestSha256: expectedPatchedSha256,
    capacitorRequirement: { kind: 'exact', version: '8.4.1' },
    changed,
  };
}

export async function main() {
  try {
    printJson({ ok: true, ...(await prepareNativeDependencies()) });
    return EXIT_CODES.success;
  } catch (error) {
    printJson(
      {
        ok: false,
        code: error.code ?? 'native_dependency_preparation_failed',
        message: error.message,
      },
      process.stderr,
    );
    return EXIT_CODES.stateMismatch;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
