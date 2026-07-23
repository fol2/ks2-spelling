import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSafeGitPolicyCommand } from './check-b3-external-prerequisites.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

export const B3_FINGERPRINT_EXCLUDED_PREFIXES = Object.freeze([
  '.git/',
  '.native-build/',
  'node_modules/',
  'gateway/node_modules/',
  'reports/',
  'screenshots/',
  'coverage/',
  'dist/',
  'gateway/.wrangler/',
  'gateway/.wrangler-dry-run/',
  'android/.gradle/',
  'android/app/build/',
  'ios/DerivedData/',
]);

const INCLUDED_FILES = new Set([
  'package.json', 'package-lock.json', 'gateway/package.json', 'gateway/package-lock.json',
  'gateway/wrangler.jsonc', 'capacitor.config.ts', 'vite.config.js', 'index.html',
  'tests/fixtures/b3-signed-manifest.json',
  'tests/fixtures/keys/b3-sandbox-proof-manifest-signature.der',
  'tests/fixtures/storekit-bridge-transcript.json',
  'tests/helpers/hostile-zip-builder.mjs',
  'tests/helpers/b3-evidence-fixtures.mjs',
]);
const INCLUDED_PREFIXES = Object.freeze([
  'src/', 'gateway/src/', 'gateway/config/', 'config/', 'scripts/', 'ios/', 'android/',
  'tests/fixtures/b3-pack-source/', 'tests/fixtures/b3-hostile-zips/',
]);
const SECRET_BASENAME = /^(?:\.env(?:\..*)?|.*\.(?:jks|keystore|p12|mobileprovision|pem|key))$/iu;

function normalise(path) {
  return path.split(sep).join('/').replace(/^\.\//u, '');
}

export function isB3FingerprintInput(path) {
  const candidate = normalise(path);
  if (!candidate || candidate.startsWith('/') || candidate.split('/').includes('..')) return false;
  if (B3_FINGERPRINT_EXCLUDED_PREFIXES.some((prefix) => candidate === prefix.slice(0, -1) || candidate.startsWith(prefix))) return false;
  if (SECRET_BASENAME.test(candidate.split('/').at(-1))) return false;
  return INCLUDED_FILES.has(candidate) || INCLUDED_PREFIXES.some((prefix) => candidate.startsWith(prefix));
}

async function trackedFiles(root) {
  const result = await runSafeGitPolicyCommand(['ls-files', '-z'], root);
  return result.stdout.split('\0').filter(Boolean);
}

async function readFingerprintFile(root, path) {
  const absoluteRoot = await realpath(root);
  const absolutePath = resolve(absoluteRoot, path);
  const fromRoot = relative(absoluteRoot, absolutePath);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error('B3 fingerprint input escaped the repository');
  }
  const stats = await lstat(absolutePath);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`B3 fingerprint input is not a regular file: ${path}`);
  return readFile(absolutePath);
}

export const B3_FINGERPRINT_REQUIRED_INPUTS = Object.freeze([
  'package-lock.json',
  'gateway/package-lock.json',
  'gateway/wrangler.jsonc',
  'gateway/src/handler.js',
  'config/b3-pack-object-authority.json',
  'config/b3-synthetic-learners.json',
  'scripts/build-b3-proof-pack.mjs',
  'scripts/deploy-b3-sandbox-gateway.mjs',
  'scripts/prove-b3-ios.mjs',
  'scripts/prove-b3-android.mjs',
  'ios/App/App.xcodeproj/project.pbxproj',
  'ios/App/App/SceneDelegate.swift',
  'android/app/build.gradle',
  'tests/fixtures/b3-signed-manifest.json',
  'tests/fixtures/keys/b3-sandbox-proof-manifest-signature.der',
  'tests/fixtures/storekit-bridge-transcript.json',
  'tests/helpers/hostile-zip-builder.mjs',
  'tests/helpers/b3-evidence-fixtures.mjs',
]);

export function assertRequiredB3FingerprintInputs(files) {
  const available = new Set(files);
  const missing = B3_FINGERPRINT_REQUIRED_INPUTS.filter((path) => !available.has(path));
  if (missing.length > 0) throw new Error(`B3 fingerprint required input missing: ${missing.join(', ')}`);
  return true;
}

export async function fingerprintB3Application({ root = ROOT, files, requireAnchors = files === undefined } = {}) {
  const candidates = files ?? await trackedFiles(root);
  const selected = [...new Set(candidates.map(normalise).filter(isB3FingerprintInput))].sort();
  if (selected.length === 0) throw new Error('B3 fingerprint has no application inputs');
  if (requireAnchors) assertRequiredB3FingerprintInputs(selected);
  const digest = createHash('sha256');
  for (const path of selected) {
    const bytes = await readFingerprintFile(root, path);
    digest.update(Buffer.from(path, 'utf8'));
    digest.update(Buffer.from([0]));
    digest.update(Buffer.from(String(bytes.length), 'ascii'));
    digest.update(Buffer.from([0]));
    digest.update(bytes);
    digest.update(Buffer.from([0]));
  }
  return Object.freeze({ schemaVersion: 1, sha256: digest.digest('hex'), files: Object.freeze(selected) });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(await fingerprintB3Application())}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, code: 'b3_application_fingerprint_failed', message: error.message })}\n`);
    process.exitCode = 1;
  }
}
