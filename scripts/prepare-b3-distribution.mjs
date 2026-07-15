import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runSafeGitPolicyCommand,
  validateB3LocalMutationAuthority,
} from './check-b3-external-prerequisites.mjs';
import { fingerprintB3Application } from './fingerprint-b3-application.mjs';
import { assertB3RemoteMutationScope } from './lib/b3-cloudflare-evidence.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const COMMIT = /^[0-9a-f]{40}$/u;
const HASH = /^[0-9a-f]{64}$/u;

export function buildB3DistributionAuthority({ commit, fingerprint, iosBuildNumber, androidVersionCode }) {
  if (!COMMIT.test(commit) || !HASH.test(fingerprint) || !/^\d+$/u.test(iosBuildNumber) || Number(iosBuildNumber) <= 0 ||
      !Number.isSafeInteger(androidVersionCode) || androidVersionCode <= 0) {
    throw new Error('B3 distribution authority input is invalid');
  }
  return Object.freeze({
    schemaVersion: 1,
    testedApplicationCommit: commit,
    applicationFingerprint: fingerprint,
    versionName: '0.3.0-b3',
    iosBuildNumber,
    androidVersionCode,
  });
}

export function buildB3AndroidBundleCommand(authority) {
  const value = buildB3DistributionAuthority({
    commit: authority?.testedApplicationCommit,
    fingerprint: authority?.applicationFingerprint,
    iosBuildNumber: authority?.iosBuildNumber,
    androidVersionCode: authority?.androidVersionCode,
  });
  return `./gradlew :app:bundleB3SandboxProofRelease -Pb3Distribution=true -Pb3TestedApplicationCommit=${value.testedApplicationCommit} -Pb3ApplicationFingerprint=${value.applicationFingerprint} -Pb3AndroidVersionCode=${value.androidVersionCode} --no-daemon`;
}

export async function assertCleanB3Head(root = ROOT) {
  const [status, head] = await Promise.all([
    runSafeGitPolicyCommand(['status', '--porcelain=v1', '--untracked-files=all'], root),
    runSafeGitPolicyCommand(['rev-parse', '--verify', 'HEAD'], root),
  ]);
  if (status.stdout !== '') throw new Error('B3 distribution requires a clean HEAD');
  const commit = head.stdout.trim();
  if (!COMMIT.test(commit)) throw new Error('B3 distribution HEAD is invalid');
  return commit;
}

export async function prepareB3Distribution({ root = ROOT, authority, assertCleanHead = assertCleanB3Head } = {}) {
  const commit = await assertCleanHead(root);
  const resolved = authority ?? buildB3DistributionAuthority({
    commit,
    fingerprint: (await fingerprintB3Application({ root })).sha256,
    iosBuildNumber: process.env.B3_IOS_BUILD_NUMBER ?? '',
    androidVersionCode: Number(process.env.B3_ANDROID_VERSION_CODE),
  });
  if (resolved.testedApplicationCommit !== commit) throw new Error('B3 distribution authority does not match clean HEAD');
  const output = resolve(root, '.native-build/b3/distribution');
  await mkdir(output, { recursive: true, mode: 0o700 });
  const authorityPath = resolve(output, 'build-authority.json');
  const xcconfigPath = resolve(output, 'b3-distribution.xcconfig');
  const androidCommandPath = resolve(output, 'android-build-command.txt');
  const xcconfig = [
    `B3_TESTED_APPLICATION_COMMIT = ${resolved.testedApplicationCommit}`,
    `B3_APPLICATION_FINGERPRINT = ${resolved.applicationFingerprint}`,
    `B3_VERSION_NAME = ${resolved.versionName}`,
    `B3_IOS_BUILD_NUMBER = ${resolved.iosBuildNumber}`,
    '',
  ].join('\n');
  await writeFile(authorityPath, `${JSON.stringify(resolved, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await writeFile(xcconfigPath, xcconfig, { mode: 0o600, flag: 'wx' });
  await writeFile(androidCommandPath, `${buildB3AndroidBundleCommand(resolved)}\n`, { mode: 0o600, flag: 'wx' });
  return Object.freeze([
    '.native-build/b3/distribution/build-authority.json',
    '.native-build/b3/distribution/b3-distribution.xcconfig',
    '.native-build/b3/distribution/android-build-command.txt',
  ]);
}

export async function requestB3DistributionOperatorAction({
  platform,
  env = process.env,
  root = ROOT,
  localMutationGate = validateB3LocalMutationAuthority,
} = {}) {
  const expectedScope = platform === 'ios' ? 'apple-signed-distribution' :
    platform === 'android' ? 'google-test-track-refund-revoke' : null;
  if (!expectedScope) throw new Error('operator action platform must be ios or android');
  assertB3RemoteMutationScope({
    approvedScope: env.B3_REMOTE_MUTATION_SCOPE,
    runToken: env.B3_REMOTE_RUN_TOKEN,
    expectedScope,
  });
  await localMutationGate({
    approvalFile: env.B3_PREREQUISITES_FILE,
    runToken: env.B3_REMOTE_RUN_TOKEN,
    requestedScope: expectedScope,
    root,
  });
  const instruction = platform === 'ios'
    ? 'Archive the dedicated B3SandboxProof scheme in Xcode, export a development-signed IPA and install it on the approved physical iPhone.'
    : `Run the exact generated command from .native-build/b3/distribution/android-build-command.txt, upload that AAB to the approved Play internal track and install it through Google Play.`;
  return Object.freeze({ ok: false, code: 'b3_visible_operator_action_required', platform, instruction });
}

async function main() {
  try {
    const requestIndex = process.argv.indexOf('--request-operator-action');
    if (requestIndex !== -1) {
      const platform = process.argv[requestIndex + 1];
      process.stdout.write(`${JSON.stringify(await requestB3DistributionOperatorAction({ platform }))}\n`);
      return 7;
    }
    const written = await prepareB3Distribution();
    process.stdout.write(`${JSON.stringify({ ok: true, written })}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, code: 'b3_distribution_prepare_failed', message: error.message })}\n`);
    return 6;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
