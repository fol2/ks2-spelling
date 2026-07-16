import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  parseB3StrictJsonBytes,
  readApprovedB3PlayCertificate,
} from './check-b3-external-prerequisites.mjs';
import { createDefaultB3DistributionInspectors } from './lib/b3-distribution-inspectors.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const HASH = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;

function exactKeys(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());
}

function fail(message) {
  const error = new Error(message);
  error.code = 'b3_installed_distribution_invalid';
  throw error;
}

function assertApks(installedApks) {
  if (!Array.isArray(installedApks) || installedApks.length < 1) fail('Android pm path evidence is absent');
  let previous = '';
  installedApks.forEach((apk, index) => {
    if (!exactKeys(apk, ['order', 'kind', 'splitName', 'sha256']) || apk.order !== index || !HASH.test(apk.sha256) ||
        (index === 0 && (apk.kind !== 'base' || apk.splitName !== '')) ||
        (index > 0 && (apk.kind !== 'split' || !apk.splitName || apk.splitName.localeCompare(previous) <= 0))) {
      fail('Android pm path pull/hash order mismatch');
    }
    if (index > 0) previous = apk.splitName;
  });
}

export function verifyB3InstalledDistribution({
  expected,
  platform,
  artifactInspection,
  deviceInspection,
  approvedPlayCertificateSha256,
}) {
  if (!exactKeys(expected, ['schemaVersion', 'testedApplicationCommit', 'applicationFingerprint', 'versionName', 'iosBuildNumber', 'androidVersionCode']) ||
      expected.schemaVersion !== 1 || !COMMIT.test(expected.testedApplicationCommit ?? '') ||
      !HASH.test(expected.applicationFingerprint ?? '') || expected.versionName !== '0.3.0-b3' ||
      !/^[1-9][0-9]*$/u.test(expected.iosBuildNumber ?? '') ||
      !Number.isSafeInteger(expected.androidVersionCode) || expected.androidVersionCode <= 0) {
    fail('expected B3 distribution authority violates its closed schema');
  }
  if (platform === 'ios') {
    const artifactKeys = ['mode', 'signedIpaSha256', 'ipaEmbeddedAuthoritySha256', 'codeSigningCertificateSha256', 'embeddedCommit', 'embeddedFingerprint', 'versionName', 'build'];
    const deviceKeys = ['installedBundleId', 'installedVersion', 'installedBuild', 'installedEmbeddedAuthoritySha256', 'installedBuiltByDeveloper', 'sandboxReceiptSha256', 'sandboxReceiptEnvironment', 'sandboxReceiptCmsVerified'];
    if (!exactKeys(artifactInspection, artifactKeys) || !exactKeys(deviceInspection, deviceKeys)) fail('iOS independently inspected distribution violates its closed schema');
    if (artifactInspection.mode !== 'development' || ![artifactInspection.signedIpaSha256, artifactInspection.ipaEmbeddedAuthoritySha256, artifactInspection.codeSigningCertificateSha256, deviceInspection.installedEmbeddedAuthoritySha256, deviceInspection.sandboxReceiptSha256].every((value) => HASH.test(value)) ||
        artifactInspection.embeddedCommit !== expected.testedApplicationCommit || artifactInspection.embeddedFingerprint !== expected.applicationFingerprint || artifactInspection.versionName !== expected.versionName || artifactInspection.build !== expected.iosBuildNumber ||
        deviceInspection.installedBundleId !== 'uk.eugnel.ks2spelling' || deviceInspection.installedVersion !== expected.versionName || deviceInspection.installedBuild !== expected.iosBuildNumber || artifactInspection.ipaEmbeddedAuthoritySha256 !== deviceInspection.installedEmbeddedAuthoritySha256 || deviceInspection.installedBuiltByDeveloper !== true || deviceInspection.sandboxReceiptEnvironment !== 'sandbox' || deviceInspection.sandboxReceiptCmsVerified !== true) {
      fail('iOS developer app, embedded authority, independently extracted IPA certificate or installed distribution mismatch');
    }
    return Object.freeze({
      platform,
      ...structuredClone(artifactInspection),
      installedBundleId: deviceInspection.installedBundleId,
      installedVersion: deviceInspection.installedVersion,
      installedBuild: deviceInspection.installedBuild,
      installedEmbeddedAuthoritySha256: deviceInspection.installedEmbeddedAuthoritySha256,
      installedBuiltByDeveloper: deviceInspection.installedBuiltByDeveloper,
      sandboxReceiptVerified: true,
    });
  }
  if (platform !== 'android') fail('distribution platform is invalid');
  const artifactKeys = ['track', 'signedAabSha256', 'aabEmbeddedAuthoritySha256', 'embeddedCommit', 'embeddedFingerprint', 'versionName', 'versionCode'];
  const deviceKeys = ['installer', 'installedEmbeddedAuthoritySha256', 'installedSigningCertificateSha256', 'pmPathOrderVerified', 'installedApks'];
  if (!exactKeys(artifactInspection, artifactKeys) || !exactKeys(deviceInspection, deviceKeys) || !HASH.test(approvedPlayCertificateSha256 ?? '')) fail('Android independently inspected distribution or approved Play certificate violates its closed schema');
  if (artifactInspection.track !== 'play-internal' || ![artifactInspection.signedAabSha256, artifactInspection.aabEmbeddedAuthoritySha256, deviceInspection.installedEmbeddedAuthoritySha256].every((value) => HASH.test(value)) ||
      artifactInspection.embeddedCommit !== expected.testedApplicationCommit || artifactInspection.embeddedFingerprint !== expected.applicationFingerprint || artifactInspection.versionName !== expected.versionName || artifactInspection.versionCode !== expected.androidVersionCode ||
      deviceInspection.installer !== 'com.android.vending' || deviceInspection.installedSigningCertificateSha256 !== approvedPlayCertificateSha256 || artifactInspection.aabEmbeddedAuthoritySha256 !== deviceInspection.installedEmbeddedAuthoritySha256 || deviceInspection.pmPathOrderVerified !== true) {
    fail('Android embedded authority, approved Play certificate or installed distribution mismatch');
  }
  assertApks(deviceInspection.installedApks);
  return Object.freeze({
    platform,
    ...structuredClone(artifactInspection),
    playAppSigningCertificateSha256: approvedPlayCertificateSha256,
    installer: deviceInspection.installer,
    installedEmbeddedAuthoritySha256: deviceInspection.installedEmbeddedAuthoritySha256,
    pmPathOrderVerified: deviceInspection.pmPathOrderVerified,
    installedApks: structuredClone(deviceInspection.installedApks),
  });
}

export async function verifyB3InstalledDistributionWithInspectors({
  expected,
  platform,
  signedPath,
  artifactInspector,
  deviceInspector,
  approvedPlayCertificateSha256,
}) {
  if (typeof signedPath !== 'string' || signedPath.length === 0 || typeof artifactInspector !== 'function' || typeof deviceInspector !== 'function') {
    fail('independent signed-artifact and physical-device inspectors are required');
  }
  const artifactInspection = await artifactInspector({ platform, signedPath });
  const deviceInspection = await deviceInspector({ platform });
  return verifyB3InstalledDistribution({ expected, platform, artifactInspection, deviceInspection, approvedPlayCertificateSha256 });
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

async function main() {
  try {
    const platform = argument('--platform');
    const signedPath = argument(platform === 'ios' ? '--signed-ipa' : '--signed-aab');
    const expected = parseB3StrictJsonBytes(
      await readFile(resolve(ROOT, '.native-build/b3/distribution/build-authority.json')),
      'B3 distribution build authority',
    );
    const inspectors = createDefaultB3DistributionInspectors({ root: ROOT, env: process.env });
    const approvedPlayCertificateSha256 = platform === 'android'
      ? await readApprovedB3PlayCertificate({ approvalFile: process.env.B3_PREREQUISITES_FILE, root: ROOT })
      : undefined;
    const result = await verifyB3InstalledDistributionWithInspectors({
      expected,
      platform,
      signedPath,
      artifactInspector: inspectors.artifactInspector,
      deviceInspector: inspectors.deviceInspector,
      approvedPlayCertificateSha256,
    });
    const outputPath = resolve(ROOT, `.native-build/b3/distribution/${platform}-installed-authority.json`);
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    process.stdout.write(`${JSON.stringify({ ok: true, platform })}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error.code ?? 'b3_installed_distribution_failed', message: error.message })}\n`);
    return 6;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
