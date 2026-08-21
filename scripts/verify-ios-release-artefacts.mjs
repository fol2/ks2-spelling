import { readdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXIT_CODES,
  printJson,
  resolveExecutable,
  runCommand,
} from './lib/run-command.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const PRODUCTION_ORIGIN = 'ks2-gateway.eugnel.uk';
const PRODUCTION_KEY = ['production', 'ks2', 'p256', '2026', '08'].join('-');
const SANDBOX_IDENTITIES = Object.freeze([
  'b3-gateway.eugnel.uk',
  'b3-test-p256-2026-07',
  'b3-sandbox-proof',
]);

export const IOS_RELEASE_ARTEFACTS = Object.freeze({
  production: '.native-build/release-artefacts/production/Build/Products/Release-iphonesimulator/App.app',
  sandbox: '.native-build/release-artefacts/sandbox/Build/Products/Sandbox-iphonesimulator/App.app',
});

export const IOS_RELEASE_BUILD_STEPS = Object.freeze([
  Object.freeze({ command: 'npm', args: Object.freeze(['run', 'build', '--', '--mode', 'sandbox']) }),
  Object.freeze({ command: 'npx', args: Object.freeze(['--no-install', 'cap', 'sync']) }),
  Object.freeze({
    command: 'xcodebuild',
    args: Object.freeze([
      '-quiet', '-project', 'ios/App/App.xcodeproj', '-scheme', 'Sandbox',
      '-configuration', 'Sandbox', '-destination', 'generic/platform=iOS Simulator',
      '-derivedDataPath', '.native-build/release-artefacts/sandbox',
      'CODE_SIGNING_ALLOWED=NO', 'build',
    ]),
  }),
  Object.freeze({ command: 'npm', args: Object.freeze(['run', 'build']) }),
  Object.freeze({ command: 'npx', args: Object.freeze(['--no-install', 'cap', 'sync']) }),
  Object.freeze({
    command: 'xcodebuild',
    args: Object.freeze([
      '-quiet', '-project', 'ios/App/App.xcodeproj', '-scheme', 'KS2Spelling',
      '-configuration', 'Release', '-destination', 'generic/platform=iOS Simulator',
      '-derivedDataPath', '.native-build/release-artefacts/production',
      'CODE_SIGNING_ALLOWED=NO', 'build',
    ]),
  }),
]);

async function readJavaScriptTree(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const chunks = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return readJavaScriptTree(path);
    if (entry.isFile() && entry.name.endsWith('.js')) return readFile(path, 'utf8');
    return '';
  }));
  return chunks.join('\n');
}

async function findIdentityFiles(directory, identity) {
  const entries = await readdir(directory, { withFileTypes: true });
  const matches = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return findIdentityFiles(path, identity);
    if (!entry.isFile()) return [];
    return (await readFile(path)).includes(Buffer.from(identity)) ? [path] : [];
  }));
  return matches.flat();
}

function requireIdentity(bytes, identity, label) {
  if (!bytes.includes(identity)) throw new Error(`${label} is missing ${identity}.`);
}

async function inspectApp(appPath, releaseChannel) {
  const javascript = await readJavaScriptTree(join(appPath, 'public'));
  const keyring = await readFile(join(appPath, 'pack-signing-public-keys.json'), 'utf8');

  if (releaseChannel === 'production') {
    for (const identity of SANDBOX_IDENTITIES) {
      const matches = await findIdentityFiles(appPath, identity);
      if (matches.length > 0) {
        throw new Error(
          `Production artefact contains forbidden identity ${identity}: ${matches.join(', ')}.`,
        );
      }
    }
    requireIdentity(javascript, PRODUCTION_ORIGIN, 'Production web payload');
    requireIdentity(keyring, PRODUCTION_KEY, 'Production keyring');
  } else if (releaseChannel === 'sandbox') {
    for (const identity of SANDBOX_IDENTITIES) {
      requireIdentity(`${javascript}\n${keyring}`, identity, 'Sandbox artefact');
    }
    requireIdentity(keyring, 'b3-test-p256-2026-07', 'Sandbox keyring');
    requireIdentity(keyring, 'b3-sandbox-proof', 'Sandbox keyring');
  } else {
    throw new TypeError('Release channel is invalid.');
  }

  return Object.freeze({ releaseChannel, appPath });
}

export async function verifyIosReleaseArtefactPair({ productionApp, sandboxApp }) {
  return Object.freeze({
    production: await inspectApp(productionApp, 'production'),
    sandbox: await inspectApp(sandboxApp, 'sandbox'),
  });
}

export async function buildAndVerifyIosReleaseArtefacts({ stream = true } = {}) {
  for (const executable of ['npm', 'npx', 'xcodebuild']) {
    if (!(await resolveExecutable(executable))) {
      throw new Error(`${executable} is unavailable.`);
    }
  }
  await rm(resolve(ROOT, '.native-build/release-artefacts'), { force: true, recursive: true });
  for (const step of IOS_RELEASE_BUILD_STEPS) {
    const result = await runCommand(step.command, step.args, { cwd: ROOT, stream });
    if (result.exitCode !== 0) {
      throw new Error(`${step.command} failed with ${result.exitCode}.`);
    }
  }
  return verifyIosReleaseArtefactPair({
    productionApp: resolve(ROOT, IOS_RELEASE_ARTEFACTS.production),
    sandboxApp: resolve(ROOT, IOS_RELEASE_ARTEFACTS.sandbox),
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    printJson({ ok: true, ...(await buildAndVerifyIosReleaseArtefacts()) });
  } catch (error) {
    printJson({ ok: false, message: error.message }, process.stderr);
    process.exitCode = EXIT_CODES.commandFailed;
  }
}
