import { registerPlugin } from '@capacitor/core';

const BuildAuthorityPlugin = registerPlugin('BuildAuthority');
const COMMIT = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const B3_PUBLIC_SANDBOX_ORIGIN = ['https:', '', 'b3-gateway.eugnel.uk'].join('/');

export function assertCapacitorBuildAuthority(value, platform) {
  const keys = [
    'mode', 'proofKind', 'platform', 'distribution', 'publicSandboxOrigin', 'workerName',
    'testedApplicationCommit', 'applicationFingerprint', 'versionName', 'buildNumber', 'bundleId',
  ];
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Reflect.ownKeys(value).length !== keys.length || Reflect.ownKeys(value).some((key) => !keys.includes(key)) ||
      value.mode !== 'B3SandboxProof' || value.proofKind !== 'physical-live' || value.platform !== platform ||
      value.distribution !== (platform === 'ios' ? 'development' : 'play-internal') ||
      value.publicSandboxOrigin !== B3_PUBLIC_SANDBOX_ORIGIN || value.workerName !== 'ks2-spelling-b3-sandbox' ||
      value.bundleId !== 'uk.eugnel.ks2spelling' ||
      !COMMIT.test(value.testedApplicationCommit) || !HASH.test(value.applicationFingerprint) ||
      value.versionName !== '0.3.0-b3' ||
      (platform === 'ios' ? !/^\d+$/.test(value.buildNumber) : !Number.isSafeInteger(value.buildNumber)) ||
      Number(value.buildNumber) <= 0) {
    throw new TypeError('Embedded B3 build authority is invalid.');
  }
  return Object.freeze({ ...value });
}

export async function readCapacitorBuildAuthority(platform) {
  if (platform !== 'ios' && platform !== 'android') throw new TypeError('Native build-authority platform is invalid.');
  return assertCapacitorBuildAuthority(await BuildAuthorityPlugin.getAuthority(), platform);
}
