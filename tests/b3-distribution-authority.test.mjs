import assert from 'node:assert/strict';
import { chmod, link, mkdir, mkdtemp, readFile, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildB3AndroidBundleCommand,
  buildB3DistributionAuthority,
  prepareB3Distribution,
  requestB3DistributionOperatorAction,
} from '../scripts/prepare-b3-distribution.mjs';
import {
  verifyB3InstalledDistribution,
  verifyB3InstalledDistributionWithInspectors,
} from '../scripts/verify-b3-installed-distribution.mjs';
import { assertCapacitorBuildAuthority } from '../src/platform/distribution/capacitor-build-authority.js';
import {
  b3EmbeddedAuthoritySha256,
  createDefaultB3DistributionInspectors,
  inspectB3SignedZip,
} from '../scripts/lib/b3-distribution-inspectors.mjs';
import { buildDeterministicZip, buildHostileZip } from './helpers/hostile-zip-builder.mjs';

const COMMIT = 'b'.repeat(40);
const HASH = 'a'.repeat(64);

function androidBuildConfigOutput() {
  return [
    "Class descriptor  : 'Luk/eugnel/ks2spelling/BuildConfig;'",
    "name          : 'APPLICATION_ID'", 'value         : "uk.eugnel.ks2spelling"',
    "name          : 'B3_MODE'", 'value         : "B3SandboxProof"',
    "name          : 'B3_PROOF_KIND'", 'value         : "physical-live"',
    "name          : 'B3_PLATFORM'", 'value         : "android"',
    "name          : 'B3_DISTRIBUTION'", 'value         : "play-internal"',
    "name          : 'B3_PUBLIC_SANDBOX_ORIGIN'", 'value         : "https://b3-gateway.eugnel.uk"',
    "name          : 'B3_WORKER_NAME'", 'value         : "ks2-spelling-b3-sandbox"',
    "name          : 'B3_APPLICATION_FINGERPRINT'", `value         : "${HASH}"`,
    "name          : 'B3_TESTED_APPLICATION_COMMIT'", `value         : "${COMMIT}"`,
    "name          : 'FLAVOR'", 'value         : "b3SandboxProof"',
    "name          : 'VERSION_CODE'", 'value         : 19',
    "name          : 'VERSION_NAME'", 'value         : "0.3.0-b3"',
  ].join('\n');
}

function androidDeviceRunner(materialisePull) {
  const apk = buildDeterministicZip([{ name: 'classes.dex', data: 'fake-dex' }]);
  return async (command, args) => {
    if (command.endsWith('/adb')) {
      if (args.includes('getprop')) return { exitCode: 0, stdout: '', stderr: '' };
      if (args.includes('pm')) return { exitCode: 0, stdout: 'package:/data/app/proof/base.apk\n', stderr: '' };
      if (args.includes('dumpsys')) {
        return { exitCode: 0, stdout: '  versionName=0.3.0-b3\n  versionCode=19 minSdk=23\n  installerPackageName=com.android.vending\n', stderr: '' };
      }
      if (args.includes('pull')) {
        await materialisePull(args.at(-1), apk);
        return { exitCode: 0, stdout: '', stderr: '' };
      }
    }
    if (command.endsWith('/apksigner')) {
      return { exitCode: 0, stdout: `Signer #1 certificate SHA-256 digest: ${'c'.repeat(64)}\n`, stderr: '' };
    }
    return { exitCode: 0, stdout: androidBuildConfigOutput(), stderr: '' };
  };
}

test('distribution preparation binds clean HEAD and fingerprint into authority and xcconfig only', async () => {
  const authority = buildB3DistributionAuthority({ commit: COMMIT, fingerprint: HASH, iosBuildNumber: '19', androidVersionCode: 19 });
  assert.deepEqual(authority, { schemaVersion: 1, testedApplicationCommit: COMMIT, applicationFingerprint: HASH, versionName: '0.3.0-b3', iosBuildNumber: '19', androidVersionCode: 19 });
  const root = await mkdtemp(join(tmpdir(), 'b3-distribution-'));
  await mkdir(join(root, '.native-build/b3'), { recursive: true });
  const written = await prepareB3Distribution({ root, authority, assertCleanHead: async () => COMMIT });
  assert.deepEqual([...written].sort(), [
    '.native-build/b3/distribution/android-build-command.txt',
    '.native-build/b3/distribution/b3-distribution.xcconfig',
    '.native-build/b3/distribution/build-authority.json',
  ]);
  assert.match(await readFile(join(root, '.native-build/b3/distribution/b3-distribution.xcconfig'), 'utf8'), /B3_APPLICATION_FINGERPRINT = a{64}/);
  const expectedCommand = `./gradlew :app:bundleB3SandboxProofRelease -Pb3Distribution=true -Pb3TestedApplicationCommit=${COMMIT} -Pb3ApplicationFingerprint=${HASH} -Pb3AndroidVersionCode=19 --no-daemon`;
  assert.equal(buildB3AndroidBundleCommand(authority), expectedCommand);
  assert.equal(await readFile(join(root, '.native-build/b3/distribution/android-build-command.txt'), 'utf8'), `${expectedCommand}\n`);
});

test('visible distribution action requires the exact environment scope before local authority validation', async () => {
  let gateCalls = 0;
  await assert.rejects(requestB3DistributionOperatorAction({
    platform: 'ios',
    env: { B3_REMOTE_MUTATION_SCOPE: 'google-test-track-refund-revoke', B3_REMOTE_RUN_TOKEN: HASH },
    localMutationGate: async () => { gateCalls += 1; },
  }), /scope/i);
  assert.equal(gateCalls, 0);
});

test('embedded authority digest binds the complete platform and deployment identity', () => {
  const authority = {
    mode: 'B3SandboxProof', proofKind: 'physical-live', platform: 'ios', distribution: 'development',
    publicSandboxOrigin: 'https://b3-gateway.eugnel.uk', workerName: 'ks2-spelling-b3-sandbox',
    bundleId: 'uk.eugnel.ks2spelling', commit: COMMIT, fingerprint: HASH,
    versionName: '0.3.0-b3', buildNumber: '19',
  };
  const digest = b3EmbeddedAuthoritySha256(authority);
  for (const [key, value] of [
    ['mode', 'WrongMode'], ['proofKind', 'deterministic'], ['platform', 'android'],
    ['distribution', 'app-store'], ['publicSandboxOrigin', 'https://wrong.example'],
    ['workerName', 'wrong-worker'], ['bundleId', 'wrong.bundle'],
  ]) {
    assert.notEqual(b3EmbeddedAuthoritySha256({ ...authority, [key]: value }), digest, key);
  }
});

test('signed archive inspection rejects aggregate extracted-size bombs before ditto', () => {
  const bomb = buildDeterministicZip([{
    name: 'Payload/KS2Spelling.app/large.bin', data: 'x',
    localFlags: 0x0808, centralFlags: 0x0808,
    localExtractedBytes: 600 * 1024 * 1024,
    centralExtractedBytes: 600 * 1024 * 1024,
  }]);
  assert.throws(() => inspectB3SignedZip(bomb), /extracted|ceiling|unbounded/i);
});

test('installed distribution verifier rejects certificate drift and independently observed authority mismatch', () => {
  const expected = buildB3DistributionAuthority({ commit: COMMIT, fingerprint: HASH, iosBuildNumber: '19', androidVersionCode: 19 });
  const artifactInspection = {
    mode: 'development', signedIpaSha256: HASH,
    ipaEmbeddedAuthoritySha256: HASH, codeSigningCertificateSha256: HASH,
    embeddedCommit: COMMIT, embeddedFingerprint: HASH, versionName: '0.3.0-b3', build: '19',
  };
  const deviceInspection = {
    installedBundleId: 'uk.eugnel.ks2spelling', installedVersion: '0.3.0-b3', installedBuild: '19',
    installedEmbeddedAuthoritySha256: HASH, installedBuiltByDeveloper: true, sandboxReceiptSha256: 'd'.repeat(64),
    sandboxReceiptEnvironment: 'sandbox', sandboxReceiptCmsVerified: true,
  };
  const verified = verifyB3InstalledDistribution({ expected, platform: 'ios', artifactInspection, deviceInspection });
  assert.equal(verified.platform, 'ios');
  assert.equal(verified.installedBuiltByDeveloper, true);
  assert.equal(Object.hasOwn(verified, 'developmentIdentityVerified'), false);
  assert.throws(() => verifyB3InstalledDistribution({ expected: { ...expected, token: 'forbidden' }, platform: 'ios', artifactInspection, deviceInspection }), /closed schema/i);
  assert.throws(() => verifyB3InstalledDistribution({ expected, platform: 'ios', artifactInspection, deviceInspection: { ...deviceInspection, installedEmbeddedAuthoritySha256: 'c'.repeat(64) } }), /embedded authority/i);
  assert.throws(() => verifyB3InstalledDistribution({ expected, platform: 'ios', artifactInspection, deviceInspection: { ...deviceInspection, installedBuiltByDeveloper: false } }), /developer app|installed distribution/i);
  const { installedBuiltByDeveloper: _omitted, ...missingDeveloperAuthority } = deviceInspection;
  assert.throws(() => verifyB3InstalledDistribution({ expected, platform: 'ios', artifactInspection, deviceInspection: missingDeveloperAuthority }), /closed schema|developer app/i);
  assert.throws(() => verifyB3InstalledDistribution({ expected, platform: 'ios', artifactInspection, deviceInspection: { ...deviceInspection, developmentIdentityVerified: true } }), /closed schema|developer app/i);
  assert.throws(() => verifyB3InstalledDistribution({ expected, platform: 'ios', artifactInspection: { ...artifactInspection, signingCertificateSha256: HASH }, deviceInspection }), /closed schema/i);
});

test('distribution verifier consumes independent artifact and physical-device inspectors', async () => {
  const expected = buildB3DistributionAuthority({ commit: COMMIT, fingerprint: HASH, iosBuildNumber: '19', androidVersionCode: 19 });
  let artifactCalls = 0;
  let deviceCalls = 0;
  const result = await verifyB3InstalledDistributionWithInspectors({
    expected, platform: 'android', signedPath: '/operator/proof.aab',
    artifactInspector: async () => {
      artifactCalls += 1;
      return { track: 'play-internal', signedAabSha256: HASH, aabEmbeddedAuthoritySha256: HASH, embeddedCommit: COMMIT, embeddedFingerprint: HASH, versionName: '0.3.0-b3', versionCode: 19 };
    },
    deviceInspector: async () => {
      deviceCalls += 1;
      return { installer: 'com.android.vending', installedEmbeddedAuthoritySha256: HASH, installedSigningCertificateSha256: 'c'.repeat(64), pmPathOrderVerified: true, installedApks: [{ order: 0, kind: 'base', splitName: '', sha256: HASH }] };
    },
    approvedPlayCertificateSha256: 'c'.repeat(64),
  });
  assert.equal(result.playAppSigningCertificateSha256, 'c'.repeat(64));
  assert.equal(artifactCalls, 1);
  assert.equal(deviceCalls, 1);
  await assert.rejects(
    verifyB3InstalledDistributionWithInspectors({ expected, platform: 'ios', signedPath: '/operator/proof.ipa' }),
    /inspectors are required/i,
  );
});

test('Capacitor build authority is closed and binds the installed platform identity', () => {
  const value = {
    mode: 'B3SandboxProof', proofKind: 'physical-live', platform: 'ios',
    distribution: 'development', publicSandboxOrigin: 'https://b3-gateway.eugnel.uk',
    workerName: 'ks2-spelling-b3-sandbox', testedApplicationCommit: COMMIT,
    applicationFingerprint: HASH, versionName: '0.3.0-b3', buildNumber: '19', bundleId: 'uk.eugnel.ks2spelling',
  };
  assert.deepEqual(assertCapacitorBuildAuthority(value, 'ios'), value);
  assert.throws(() => assertCapacitorBuildAuthority({ ...value, privateKey: 'forbidden' }, 'ios'), /invalid/i);
  assert.throws(() => assertCapacitorBuildAuthority({ ...value, distribution: 'app-store' }, 'ios'), /invalid/i);
});

test('native projects register BuildAuthority and keep generated authority in ignored output', async () => {
  const root = new URL('../', import.meta.url);
  const [swift, appDelegate, project, scheme, b3Scheme, loader, java, activity, gradle] = await Promise.all([
    readFile(new URL('ios/App/App/BuildAuthorityPlugin.swift', root), 'utf8'),
    readFile(new URL('ios/App/App/AppDelegate.swift', root), 'utf8'),
    readFile(new URL('ios/App/App.xcodeproj/project.pbxproj', root), 'utf8'),
    readFile(new URL('ios/App/App.xcodeproj/xcshareddata/xcschemes/KS2Spelling.xcscheme', root), 'utf8'),
    readFile(new URL('ios/App/App.xcodeproj/xcshareddata/xcschemes/B3SandboxProof.xcscheme', root), 'utf8'),
    readFile(new URL('ios/b3-distribution-loader.xcconfig', root), 'utf8'),
    readFile(new URL('android/app/src/main/java/uk/eugnel/ks2spelling/BuildAuthorityPlugin.java', root), 'utf8'),
    readFile(new URL('android/app/src/main/java/uk/eugnel/ks2spelling/MainActivity.java', root), 'utf8'),
    readFile(new URL('android/app/build.gradle', root), 'utf8'),
  ]);
  assert.match(swift, /CAPBridgedPlugin/);
  assert.match(appDelegate, /registerPluginInstance\(BuildAuthorityPlugin\(\)\)/);
  assert.match(project, /BuildAuthorityPlugin\.swift in Sources/);
  assert.match(project, /name = B3SandboxProof/);
  assert.match(scheme, /<ArchiveAction\s+buildConfiguration = "Release"/u);
  assert.doesNotMatch(scheme, /buildConfiguration = "B3SandboxProof"/u);
  assert.match(b3Scheme, /<ArchiveAction\s+buildConfiguration = "B3SandboxProof"/u);
  assert.match(loader, /\.native-build\/b3\/distribution\/b3-distribution\.xcconfig/);
  assert.match(java, /@CapacitorPlugin\(name = "BuildAuthority"\)/);
  assert.match(activity, /registerPlugin\(BuildAuthorityPlugin\.class\)/);
  assert.match(activity, /BuildConfig\.B3_SANDBOX_PROOF/u);
  assert.match(gradle, /bundleB3SandboxProofRelease|b3SandboxProof/);
  assert.doesNotMatch([swift, java, gradle].join('\n'), /signingConfigs|Keychain|privateKey|PRIVATE_KEY/);
});

test('default Android artefact inspector safely extracts AAB DEX through pinned tooling', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-inspector-root-'));
  const operator = await mkdtemp(join(tmpdir(), 'b3-inspector-operator-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(operator, { recursive: true, force: true })]));
  const aab = join(operator, 'proof.aab');
  await writeFile(aab, buildDeterministicZip([
    { name: 'base/dex/classes.dex', data: 'fake-dex' },
    { name: 'base/assets/legitimate-pack.bin', data: Buffer.alloc(2 * 1024 * 1024, 7) },
  ]), { mode: 0o600 });
  const buildConfig = [
    "Class descriptor  : 'Luk/eugnel/ks2spelling/BuildConfig;'",
    "name          : 'APPLICATION_ID'", 'value         : "uk.eugnel.ks2spelling"',
    "name          : 'B3_MODE'", 'value         : "B3SandboxProof"',
    "name          : 'B3_PROOF_KIND'", 'value         : "physical-live"',
    "name          : 'B3_PLATFORM'", 'value         : "android"',
    "name          : 'B3_DISTRIBUTION'", 'value         : "play-internal"',
    "name          : 'B3_PUBLIC_SANDBOX_ORIGIN'", 'value         : "https://b3-gateway.eugnel.uk"',
    "name          : 'B3_WORKER_NAME'", 'value         : "ks2-spelling-b3-sandbox"',
    "name          : 'B3_APPLICATION_FINGERPRINT'", `value         : "${HASH}"`,
    "name          : 'B3_TESTED_APPLICATION_COMMIT'", `value         : "${COMMIT}"`,
    "name          : 'FLAVOR'", 'value         : "b3SandboxProof"',
    "name          : 'VERSION_CODE'", 'value         : 19',
    "name          : 'VERSION_NAME'", 'value         : "0.3.0-b3"',
  ].join('\n');
  const commands = [];
  const inspectors = createDefaultB3DistributionInspectors({
    root,
    commandRunner: async (command, args) => {
      commands.push([command, ...args]);
      if (command.endsWith('jarsigner')) {
        assert.deepEqual(args.slice(0, 4), ['-verify', '-strict', '-certs', '-verbose']);
        return { exitCode: 0, stdout: 'jar verified.\n', stderr: '' };
      }
      assert.deepEqual(args.slice(0, 2), ['-e', '-n']);
      assert.match(args[2], /classes-000\.dex$/u);
      return { exitCode: 0, stdout: buildConfig, stderr: '' };
    },
  });
  const inspected = await inspectors.artifactInspector({ platform: 'android', signedPath: aab });
  assert.equal(inspected.versionCode, 19);
  assert.equal(inspected.embeddedCommit, COMMIT);
  assert.equal(commands.filter(([command]) => command.endsWith('jarsigner')).length, 1);
  assert.equal(commands.filter(([command]) => command.endsWith('dexdump')).length, 1);

  await chmod(aab, 0o644);
  await assert.rejects(inspectors.artifactInspector({ platform: 'android', signedPath: aab }), /secure validation/i);
  await chmod(aab, 0o600);
  const alias = join(operator, 'proof-link.aab');
  await symlink(aab, alias);
  await assert.rejects(inspectors.artifactInspector({ platform: 'android', signedPath: alias }), /secure validation/i);
  assert.equal(commands.length, 2);

  await chmod(aab, 0o600);
  await writeFile(aab, buildHostileZip('traversal-path'));
  await assert.rejects(inspectors.artifactInspector({ platform: 'android', signedPath: aab }), /archive member path|signed archive/i);
  await assert.rejects(inspectors.artifactInspector({ platform: 'windows', signedPath: aab }), /platform is invalid/i);
  assert.equal(commands.length, 2);
});

test('default Android artefact inspector rejects an unsigned AAB before DEX inspection', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-unsigned-root-'));
  const operator = await mkdtemp(join(tmpdir(), 'b3-unsigned-operator-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(operator, { recursive: true, force: true })]));
  const aab = join(operator, 'unsigned.aab');
  await writeFile(aab, buildDeterministicZip([{ name: 'base/dex/classes.dex', data: 'fake-dex' }]), { mode: 0o600 });
  let dexCalls = 0;
  const inspectors = createDefaultB3DistributionInspectors({
    root,
    commandRunner: async (command) => {
      if (command.endsWith('jarsigner')) return { exitCode: 1, stdout: '', stderr: 'unsigned jar' };
      dexCalls += 1;
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });
  await assert.rejects(inspectors.artifactInspector({ platform: 'android', signedPath: aab }), /jarsigner|signature|command failed/i);
  assert.equal(dexCalls, 0);
});

test('default iOS device inspector derives sandbox receipt proof outside app JSON', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-ios-inspector-root-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authority = {
    mode: 'B3SandboxProof', proofKind: 'physical-live', platform: 'ios', distribution: 'development',
    publicSandboxOrigin: 'https://b3-gateway.eugnel.uk', workerName: 'ks2-spelling-b3-sandbox',
    testedApplicationCommit: COMMIT, applicationFingerprint: HASH,
    versionName: '0.3.0-b3', buildNumber: '19', bundleId: 'uk.eugnel.ks2spelling',
  };
  const commands = [];
  let builtByDeveloper = true;
  const inspectors = createDefaultB3DistributionInspectors({
    root,
    env: { B3_IOS_PHYSICAL_DEVICE_ID: 'physical-ios-device' },
    commandRunner: async (command, args) => {
      commands.push([command, ...args]);
      const jsonIndex = args.indexOf('--json-output');
      const destinationIndex = args.indexOf('--destination');
      const sourceIndex = args.indexOf('--source');
      if (args.includes('info') && args.includes('apps')) {
        await writeFile(args[jsonIndex + 1], JSON.stringify({ result: { apps: [{
          bundleIdentifier: 'uk.eugnel.ks2spelling', version: '0.3.0-b3', buildVersion: '19',
          ...(builtByDeveloper === undefined ? {} : { builtByDeveloper }),
        }] } }));
      } else if (sourceIndex !== -1 && args[sourceIndex + 1].endsWith('b3-build-authority.json')) {
        await writeFile(args[destinationIndex + 1], JSON.stringify(authority));
      } else if (sourceIndex !== -1 && args[sourceIndex + 1].endsWith('b3-sandbox-receipt')) {
        await writeFile(args[destinationIndex + 1], Buffer.alloc(128, 7));
      }
      return { exitCode: 0, stdout: command.endsWith('openssl') ? '  12:d=2  hl=2 l=7 prim: UTF8STRING :Sandbox\n' : '', stderr: '' };
    },
  });
  const result = await inspectors.deviceInspector({ platform: 'ios' });
  assert.equal(result.sandboxReceiptEnvironment, 'sandbox');
  assert.equal(result.sandboxReceiptCmsVerified, true);
  assert.equal(result.installedEmbeddedAuthoritySha256.length, 64);
  assert.equal(result.installedBuiltByDeveloper, true);
  assert.ok(commands.some((args) => args.includes('cms') && args.includes('9')));
  assert.ok(commands.some((args) => args.includes('asn1parse')));
  assert.equal(Object.hasOwn(result, 'developmentIdentityVerified'), false);
  assert.equal(Object.hasOwn(result, 'sandboxReceiptVerified'), false);
  for (const invalidDeveloperAuthority of [false, undefined]) {
    builtByDeveloper = invalidDeveloperAuthority;
    await assert.rejects(inspectors.deviceInspector({ platform: 'ios' }), /developer app/i);
  }
});

test('default iOS device inspector rejects a hard-linked copied authority', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-ios-hard-link-root-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authority = {
    mode: 'B3SandboxProof', proofKind: 'physical-live', platform: 'ios', distribution: 'development',
    publicSandboxOrigin: 'https://b3-gateway.eugnel.uk', workerName: 'ks2-spelling-b3-sandbox',
    testedApplicationCommit: COMMIT, applicationFingerprint: HASH,
    versionName: '0.3.0-b3', buildNumber: '19', bundleId: 'uk.eugnel.ks2spelling',
  };
  const inspectors = createDefaultB3DistributionInspectors({
    root,
    env: { B3_IOS_PHYSICAL_DEVICE_ID: 'physical-ios-device' },
    commandRunner: async (_command, args) => {
      const jsonIndex = args.indexOf('--json-output');
      const destinationIndex = args.indexOf('--destination');
      const sourceIndex = args.indexOf('--source');
      if (args.includes('info') && args.includes('apps')) {
        await writeFile(args[jsonIndex + 1], JSON.stringify({ result: { apps: [{ bundleIdentifier: 'uk.eugnel.ks2spelling', version: '0.3.0-b3', buildVersion: '19', builtByDeveloper: true }] } }));
      } else if (sourceIndex !== -1 && args[sourceIndex + 1].endsWith('b3-build-authority.json')) {
        const destination = args[destinationIndex + 1];
        await writeFile(destination, JSON.stringify(authority));
        await link(destination, `${destination}.hostile-alias`);
      } else if (sourceIndex !== -1 && args[sourceIndex + 1].endsWith('b3-sandbox-receipt')) {
        await writeFile(args[destinationIndex + 1], Buffer.alloc(128, 7));
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });

  await assert.rejects(
    inspectors.deviceInspector({ platform: 'ios' }),
    /file copy|hard-link|file policy|unsafe/i,
  );
});

test('default iOS device inspector rejects linked, oversized and swapped copied receipts', async (t) => {
  const authority = {
    mode: 'B3SandboxProof', proofKind: 'physical-live', platform: 'ios', distribution: 'development',
    publicSandboxOrigin: 'https://b3-gateway.eugnel.uk', workerName: 'ks2-spelling-b3-sandbox',
    testedApplicationCommit: COMMIT, applicationFingerprint: HASH,
    versionName: '0.3.0-b3', buildNumber: '19', bundleId: 'uk.eugnel.ks2spelling',
  };
  const makeRunner = (materialiseReceipt) => async (_command, args) => {
    const jsonIndex = args.indexOf('--json-output');
    const destinationIndex = args.indexOf('--destination');
    const sourceIndex = args.indexOf('--source');
    if (args.includes('info') && args.includes('apps')) {
      await writeFile(args[jsonIndex + 1], JSON.stringify({ result: { apps: [{ bundleIdentifier: 'uk.eugnel.ks2spelling', version: '0.3.0-b3', buildVersion: '19', builtByDeveloper: true }] } }));
    } else if (sourceIndex !== -1 && args[sourceIndex + 1].endsWith('b3-build-authority.json')) {
      await writeFile(args[destinationIndex + 1], JSON.stringify(authority));
    } else if (sourceIndex !== -1 && args[sourceIndex + 1].endsWith('b3-sandbox-receipt')) {
      await materialiseReceipt(args[destinationIndex + 1]);
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };

  for (const [name, materialiseReceipt] of [
    ['symbolic-link', async (destination) => {
      const target = `${destination}.target`;
      await writeFile(target, Buffer.alloc(128, 7));
      await symlink(target, destination);
    }],
    ['oversized', async (destination) => {
      await writeFile(destination, Buffer.from('x'));
      await truncate(destination, (1024 * 1024) + 1);
    }],
  ]) {
    await t.test(name, async (subtest) => {
      const root = await mkdtemp(join(tmpdir(), `b3-ios-receipt-${name}-`));
      subtest.after(() => rm(root, { recursive: true, force: true }));
      const inspectors = createDefaultB3DistributionInspectors({
        root,
        env: { B3_IOS_PHYSICAL_DEVICE_ID: 'physical-ios-device' },
        commandRunner: makeRunner(materialiseReceipt),
      });
      await assert.rejects(
        inspectors.deviceInspector({ platform: 'ios' }),
        /b3-sandbox-receipt.*file policy|file copy produced an unsafe result/i,
      );
    });
  }

  await t.test('pathname swap after open', async (subtest) => {
    const root = await mkdtemp(join(tmpdir(), 'b3-ios-receipt-swap-'));
    subtest.after(() => rm(root, { recursive: true, force: true }));
    let swapped = false;
    const inspectors = createDefaultB3DistributionInspectors({
      root,
      env: { B3_IOS_PHYSICAL_DEVICE_ID: 'physical-ios-device' },
      commandRunner: makeRunner((destination) => writeFile(destination, Buffer.alloc(128, 7))),
      afterExternalFileOpenHook: async ({ label, path }) => {
        if (label !== 'physical-device b3-sandbox-receipt') return;
        swapped = true;
        const original = `${path}.opened-original`;
        const replacement = `${path}.replacement`;
        await rename(path, original);
        await writeFile(replacement, Buffer.alloc(128, 8));
        await symlink(replacement, path);
      },
    });
    await assert.rejects(
      inspectors.deviceInspector({ platform: 'ios' }),
      /b3-sandbox-receipt.*changed/i,
    );
    assert.equal(swapped, true);
  });
});

test('default Android device inspector rejects linked, oversized and swapped pulled APKs', async (t) => {
  for (const [name, materialisePull] of [
    ['symbolic-link', async (destination, apk) => {
      const target = `${destination}.target`;
      await writeFile(target, apk);
      await symlink(target, destination);
    }],
    ['hard-link', async (destination, apk) => {
      await writeFile(destination, apk);
      await link(destination, `${destination}.hostile-alias`);
    }],
    ['oversized', async (destination) => {
      await writeFile(destination, Buffer.from('x'));
      await truncate(destination, (512 * 1024 * 1024) + 1);
    }],
  ]) {
    await t.test(name, async (subtest) => {
      const root = await mkdtemp(join(tmpdir(), `b3-android-${name}-`));
      subtest.after(() => rm(root, { recursive: true, force: true }));
      const inspectors = createDefaultB3DistributionInspectors({
        root,
        env: {
          B3_ANDROID_PHYSICAL_DEVICE_ID: 'physical-android-device',
          B3_ADB_PATH: '/test/adb',
        },
        commandRunner: androidDeviceRunner(materialisePull),
      });
      await assert.rejects(
        inspectors.deviceInspector({ platform: 'android' }),
        /pulled Android APK.*file policy/i,
      );
    });
  }

  await t.test('pathname swap after open', async (subtest) => {
    const root = await mkdtemp(join(tmpdir(), 'b3-android-swap-'));
    subtest.after(() => rm(root, { recursive: true, force: true }));
    let swapped = false;
    const inspectors = createDefaultB3DistributionInspectors({
      root,
      env: {
        B3_ANDROID_PHYSICAL_DEVICE_ID: 'physical-android-device',
        B3_ADB_PATH: '/test/adb',
      },
      commandRunner: androidDeviceRunner((destination, apk) => writeFile(destination, apk)),
      afterExternalFileOpenHook: async ({ label, path }) => {
        if (label !== 'pulled Android APK 0') return;
        swapped = true;
        const original = `${path}.opened-original`;
        const replacement = `${path}.replacement`;
        await rename(path, original);
        await writeFile(replacement, buildDeterministicZip([{ name: 'classes.dex', data: 'replacement' }]));
        await symlink(replacement, path);
      },
    });
    await assert.rejects(
      inspectors.deviceInspector({ platform: 'android' }),
      /pulled Android APK.*changed/i,
    );
    assert.equal(swapped, true);
  });
});

test('default Android device inspector accepts a bounded stable Play-installed APK', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-android-stable-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inspectors = createDefaultB3DistributionInspectors({
    root,
    env: {
      B3_ANDROID_PHYSICAL_DEVICE_ID: 'physical-android-device',
      B3_ADB_PATH: '/test/adb',
    },
    commandRunner: androidDeviceRunner((destination, apk) => writeFile(destination, apk)),
  });

  const result = await inspectors.deviceInspector({ platform: 'android' });
  assert.equal(result.installer, 'com.android.vending');
  assert.deepEqual(result.installedApks.map(({ order, kind, splitName }) => ({ order, kind, splitName })), [
    { order: 0, kind: 'base', splitName: '' },
  ]);
  assert.equal(result.installedSigningCertificateSha256, 'c'.repeat(64));
});
