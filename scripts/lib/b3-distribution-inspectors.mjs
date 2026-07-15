import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';
import { inflateRawSync } from 'node:zlib';
import {
  parseB3StrictJsonBytes,
  readValidatedB3OperatorFile,
} from '../check-b3-external-prerequisites.mjs';

const execFileAsync = promisify(execFile);
const HASH = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const MAX_ARCHIVE_ENTRIES = 20_000;
const MAX_DEX_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_EXTRACTED_BYTES = 512 * 1024 * 1024;

function fail(message) {
  const error = new Error(message);
  error.code = 'b3_distribution_inspection_failed';
  throw error;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function uint16(bytes, offset) {
  if (offset < 0 || offset + 2 > bytes.length) fail('signed archive contains a truncated field');
  return bytes.readUInt16LE(offset);
}

function uint32(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.length) fail('signed archive contains a truncated field');
  return bytes.readUInt32LE(offset);
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (value ^ 0xffffffff) >>> 0;
}

function findEocd(bytes) {
  const minimum = Math.max(0, bytes.length - 65_557);
  const found = [];
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (uint32(bytes, offset) === 0x06054b50) found.push(offset);
  }
  if (found.length !== 1) fail('signed archive central-directory authority is ambiguous');
  return found[0];
}

function assertSafeArchiveName(name, directory) {
  if (!name || name.startsWith('/') || name.includes('\\') || name.includes('\0') || name.normalize('NFC') !== name) {
    fail('signed archive member path is unsafe');
  }
  const parts = name.split('/');
  if (directory) parts.pop();
  if (parts.some((part) => part === '' || part === '.' || part === '..')) fail('signed archive member path is unsafe');
}

export function inspectB3SignedZip(bytes, { extract = () => false } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.length > 512 * 1024 * 1024) fail('signed archive byte length is invalid');
  const end = findEocd(bytes);
  const count = uint16(bytes, end + 10);
  const centralSize = uint32(bytes, end + 12);
  const centralOffset = uint32(bytes, end + 16);
  if (uint16(bytes, end + 4) !== 0 || uint16(bytes, end + 6) !== 0 || uint16(bytes, end + 8) !== count ||
      count === 0 || count > MAX_ARCHIVE_ENTRIES || uint16(bytes, end + 20) !== 0 ||
      end + 22 !== bytes.length || centralOffset + centralSize !== end) {
    fail('signed archive bounds are unsupported or malformed');
  }
  const names = new Set();
  const foldedNames = new Set();
  const ranges = [];
  const extracted = new Map();
  let cursor = centralOffset;
  let totalExtractedBytes = 0;
  for (let index = 0; index < count; index += 1) {
    if (uint32(bytes, cursor) !== 0x02014b50) fail('signed archive central entry is malformed');
    const creator = uint16(bytes, cursor + 4) >>> 8;
    const flags = uint16(bytes, cursor + 8);
    const method = uint16(bytes, cursor + 10);
    const expectedCrc = uint32(bytes, cursor + 16);
    const compressedSize = uint32(bytes, cursor + 20);
    const extractedSize = uint32(bytes, cursor + 24);
    totalExtractedBytes += extractedSize;
    if (!Number.isSafeInteger(totalExtractedBytes) || totalExtractedBytes > MAX_TOTAL_EXTRACTED_BYTES) {
      fail('signed archive aggregate extracted-size ceiling exceeded');
    }
    const nameLength = uint16(bytes, cursor + 28);
    const extraLength = uint16(bytes, cursor + 30);
    const commentLength = uint16(bytes, cursor + 32);
    const localOffset = uint32(bytes, cursor + 42);
    const externalAttributes = uint32(bytes, cursor + 38);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    const next = nameEnd + extraLength + commentLength;
    if (next > end || nameLength === 0 || commentLength !== 0 || compressedSize === 0xffffffff ||
        extractedSize === 0xffffffff || localOffset === 0xffffffff || (flags & ~(0x080e)) !== 0 ||
        (method !== 0 && method !== 8)) fail('signed archive entry is unsupported or unbounded');
    const nameBytes = bytes.subarray(nameStart, nameEnd);
    const name = nameBytes.toString('utf8');
    if (!Buffer.from(name, 'utf8').equals(nameBytes)) fail('signed archive member name is not UTF-8');
    const directory = name.endsWith('/');
    assertSafeArchiveName(name, directory);
    const folded = name.toLocaleLowerCase('en-GB');
    if (names.has(name) || foldedNames.has(folded)) fail('signed archive member authority is duplicated');
    names.add(name);
    foldedNames.add(folded);
    if (creator === 3) {
      const fileType = (externalAttributes >>> 16) & 0o170000;
      if (fileType !== 0 && fileType !== 0o100000 && !(directory && fileType === 0o040000)) {
        fail('signed archive contains a non-regular member');
      }
    }
    if (uint32(bytes, localOffset) !== 0x04034b50 || uint16(bytes, localOffset + 6) !== flags ||
        uint16(bytes, localOffset + 8) !== method) fail('signed archive local entry authority differs');
    const localNameLength = uint16(bytes, localOffset + 26);
    const localExtraLength = uint16(bytes, localOffset + 28);
    const localNameStart = localOffset + 30;
    const dataStart = localNameStart + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (localNameLength !== nameLength || !bytes.subarray(localNameStart, localNameStart + localNameLength).equals(nameBytes) ||
        dataEnd > centralOffset || ((flags & 0x8) === 0 &&
          (uint32(bytes, localOffset + 14) !== expectedCrc || uint32(bytes, localOffset + 18) !== compressedSize || uint32(bytes, localOffset + 22) !== extractedSize))) {
      fail('signed archive local member is malformed');
    }
    ranges.push([localOffset, dataEnd]);
    if (!directory && extract(name)) {
      if (extractedSize > MAX_DEX_BYTES) fail('signed archive selected member exceeds the extraction ceiling');
      const compressed = bytes.subarray(dataStart, dataEnd);
      let content;
      try {
        content = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: MAX_DEX_BYTES });
      } catch {
        fail('signed archive selected member cannot be inflated');
      }
      if (content.length !== extractedSize || crc32(content) !== expectedCrc) fail('signed archive selected member digest is invalid');
      extracted.set(name, content);
    }
    cursor = next;
  }
  if (cursor !== end) fail('signed archive central-directory length differs');
  ranges.sort((left, right) => left[0] - right[0]);
  if (ranges.some((range, index) => index > 0 && range[0] < ranges[index - 1][1])) fail('signed archive local members overlap');
  return Object.freeze({ names: Object.freeze([...names]), extracted });
}

export function b3EmbeddedAuthoritySha256({
  mode, proofKind, platform, distribution, publicSandboxOrigin, workerName, bundleId,
  commit, fingerprint, versionName, buildNumber,
}) {
  if (!COMMIT.test(commit) || !HASH.test(fingerprint) || versionName !== '0.3.0-b3' ||
      !Number.isSafeInteger(Number(buildNumber)) || Number(buildNumber) <= 0 ||
      [mode, proofKind, platform, distribution, publicSandboxOrigin, workerName, bundleId]
        .some((value) => typeof value !== 'string' || value.length === 0)) {
    fail('embedded build authority fields are invalid');
  }
  return sha256(Buffer.from(JSON.stringify({
    mode, proofKind, platform, distribution, publicSandboxOrigin, workerName, bundleId,
    testedApplicationCommit: commit, applicationFingerprint: fingerprint,
    versionName, buildNumber: String(buildNumber),
  }), 'utf8'));
}

async function defaultCommandRunner(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      encoding: 'utf8',
      timeout: options.timeoutMs ?? 30_000,
      maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
      env: options.env,
      windowsHide: true,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { exitCode: Number.isInteger(error.code) ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

async function run(runner, command, args, options) {
  const result = await runner(command, args, options);
  if (!result || result.exitCode !== 0 || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') {
    fail(`read-only distribution command failed: ${basename(command)}`);
  }
  return result.stdout.trim();
}

function parseBuildConfig(output) {
  const marker = "Class descriptor  : 'Luk/eugnel/ks2spelling/BuildConfig;'";
  const start = output.indexOf(marker);
  if (start === -1 || output.indexOf(marker, start + marker.length) !== -1) fail('Android BuildConfig class authority is absent or duplicated');
  const next = output.indexOf('\nClass #', start + marker.length);
  const block = output.slice(start, next === -1 ? undefined : next);
  const field = (name) => {
    const match = new RegExp(`name\\s+: '${name}'[\\s\\S]*?value\\s+: ("[^"]*"|-?[0-9]+|0x[0-9a-f]+)`, 'u').exec(block)?.[1];
    return match?.startsWith('"') ? match.slice(1, -1) : match;
  };
  const integer = field('VERSION_CODE');
  const value = {
    applicationId: field('APPLICATION_ID'),
    mode: field('B3_MODE'),
    proofKind: field('B3_PROOF_KIND'),
    platform: field('B3_PLATFORM'),
    distribution: field('B3_DISTRIBUTION'),
    publicSandboxOrigin: field('B3_PUBLIC_SANDBOX_ORIGIN'),
    workerName: field('B3_WORKER_NAME'),
    commit: field('B3_TESTED_APPLICATION_COMMIT'),
    fingerprint: field('B3_APPLICATION_FINGERPRINT'),
    flavour: field('FLAVOR'),
    versionName: field('VERSION_NAME'),
    versionCode: integer?.startsWith('0x') ? Number.parseInt(integer.slice(2), 16) : Number(integer),
  };
  if (value.applicationId !== 'uk.eugnel.ks2spelling' || value.flavour !== 'b3SandboxProof' ||
      value.mode !== 'B3SandboxProof' || value.proofKind !== 'physical-live' || value.platform !== 'android' ||
      value.distribution !== 'play-internal' || value.publicSandboxOrigin !== 'https://b3-gateway.eugnel.uk' ||
      value.workerName !== 'ks2-spelling-b3-sandbox' ||
      !COMMIT.test(value.commit ?? '') || !HASH.test(value.fingerprint ?? '') ||
      value.versionName !== '0.3.0-b3' || !Number.isSafeInteger(value.versionCode) || value.versionCode <= 0) {
    fail('Android BuildConfig authority is missing or malformed');
  }
  return value;
}

function iosApplicationPrefix(entries) {
  const appPrefixes = new Set(entries.flatMap((entry) => {
    const match = /^(Payload\/[^/]+\.app)\//u.exec(entry);
    return match ? [match[1]] : [];
  }));
  if (appPrefixes.size !== 1) fail('signed IPA must contain exactly one application bundle');
  return [...appPrefixes][0];
}

async function inspectIosArtifact({ bytes, copyPath, temporary, runner }) {
  const appPrefix = iosApplicationPrefix(inspectB3SignedZip(bytes).names);
  const extraction = resolve(temporary, 'extracted');
  await mkdir(extraction, { mode: 0o700 });
  await run(runner, '/usr/bin/ditto', ['-x', '-k', copyPath, extraction]);
  const app = resolve(extraction, appPrefix);
  const plist = resolve(app, 'Info.plist');
  const plistValue = (key) => run(runner, '/usr/bin/plutil', ['-extract', key, 'raw', plist]);
  const [mode, proofKind, distribution, publicSandboxOrigin, workerName, commit, fingerprint, versionName, build, bundleId] = await Promise.all([
    plistValue('B3Mode'), plistValue('B3ProofKind'), plistValue('B3Distribution'),
    plistValue('B3PublicSandboxOrigin'), plistValue('B3WorkerName'),
    plistValue('B3TestedApplicationCommit'), plistValue('B3ApplicationFingerprint'),
    plistValue('CFBundleShortVersionString'), plistValue('CFBundleVersion'), plistValue('CFBundleIdentifier'),
  ]);
  await run(runner, '/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  await run(runner, '/usr/bin/codesign', ['-d', '--extract-certificates', resolve(temporary, 'codesign'), app], { cwd: temporary });
  const certificate = await readFile(resolve(temporary, 'codesign0'));
  const profile = resolve(app, 'embedded.mobileprovision');
  const profilePlist = resolve(temporary, 'profile.plist');
  await run(runner, '/usr/bin/security', ['cms', '-D', '-i', profile, '-o', profilePlist]);
  const development = await run(runner, '/usr/bin/plutil', ['-extract', 'Entitlements.get-task-allow', 'raw', profilePlist]);
  if (development !== 'true') fail('iOS IPA is not development signed');
  return {
    mode: 'development',
    signedIpaSha256: sha256(bytes),
    ipaEmbeddedAuthoritySha256: b3EmbeddedAuthoritySha256({
      mode, proofKind, platform: 'ios', distribution, publicSandboxOrigin, workerName, bundleId,
      commit, fingerprint, versionName, buildNumber: build,
    }),
    codeSigningCertificateSha256: sha256(certificate),
    embeddedCommit: commit,
    embeddedFingerprint: fingerprint,
    versionName,
    build,
  };
}

async function inspectAndroidDexAuthority({ bytes, temporary, runner }) {
  const archive = inspectB3SignedZip(bytes, { extract: (name) => /^base\/dex\/classes(?:\d+)?\.dex$/u.test(name) || /^classes(?:\d+)?\.dex$/u.test(name) });
  if (archive.extracted.size === 0) fail('Android signed archive contains no inspectable DEX');
  const dexdump = resolve(homedir(), 'Library/Android/sdk/build-tools/36.0.0/dexdump');
  const found = [];
  let index = 0;
  for (const dex of archive.extracted.values()) {
    const path = resolve(temporary, `classes-${String(index).padStart(3, '0')}.dex`);
    await writeFile(path, dex, { mode: 0o600, flag: 'wx' });
    const output = await run(runner, dexdump, ['-e', '-n', path], { timeoutMs: 60_000, maxBuffer: 64 * 1024 * 1024 });
    if (output.includes("Class descriptor  : 'Luk/eugnel/ks2spelling/BuildConfig;'")) found.push(parseBuildConfig(output));
    index += 1;
  }
  if (found.length !== 1) fail('Android BuildConfig authority is absent or duplicated across DEX members');
  return found[0];
}

async function inspectAndroidArtifact({ bytes, copyPath, temporary, runner }) {
  inspectB3SignedZip(bytes);
  const signatureOutput = await run(runner, '/usr/bin/jarsigner', ['-verify', '-strict', '-certs', '-verbose', copyPath], { timeoutMs: 60_000 });
  if (!/jar verified\./iu.test(signatureOutput)) fail('Android AAB JAR signature was not verified');
  const authority = await inspectAndroidDexAuthority({ bytes, temporary, runner });
  return {
    track: 'play-internal',
    signedAabSha256: sha256(bytes),
    aabEmbeddedAuthoritySha256: b3EmbeddedAuthoritySha256({
      mode: authority.mode, proofKind: authority.proofKind, platform: authority.platform,
      distribution: authority.distribution, publicSandboxOrigin: authority.publicSandboxOrigin,
      workerName: authority.workerName, bundleId: authority.applicationId, commit: authority.commit,
      fingerprint: authority.fingerprint, versionName: authority.versionName, buildNumber: authority.versionCode,
    }),
    embeddedCommit: authority.commit,
    embeddedFingerprint: authority.fingerprint,
    versionName: authority.versionName,
    versionCode: authority.versionCode,
  };
}

function extractIosAppRecord(value) {
  const candidates = [];
  const visit = (entry) => {
    if (!entry || typeof entry !== 'object') return;
    if (!Array.isArray(entry) && (entry.bundleIdentifier === 'uk.eugnel.ks2spelling' || entry.bundleID === 'uk.eugnel.ks2spelling')) candidates.push(entry);
    for (const child of Object.values(entry)) visit(child);
  };
  visit(value);
  if (candidates.length !== 1) fail('physical iOS installed application record is ambiguous');
  return candidates[0];
}

function hasExactKeys(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    expected.length === Object.keys(value).length && expected.every((key) => Object.hasOwn(value, key));
}

async function readCopiedDeviceFile(destination, expectedName) {
  const metadata = await lstat(destination);
  if (metadata.isFile() && !metadata.isSymbolicLink()) return readFile(destination);
  if (!metadata.isDirectory()) fail('physical-device file copy produced an unsafe result');
  const names = await readdir(destination);
  if (names.length !== 1 || names[0] !== expectedName) fail('physical-device file copy result is ambiguous');
  const path = resolve(destination, expectedName);
  const file = await lstat(path);
  if (!file.isFile() || file.isSymbolicLink()) fail('physical-device file copy produced an unsafe result');
  return readFile(path);
}

async function copyIosApplicationSupportFile({ device, source, destination, jsonOutput, runner }) {
  await run(runner, '/usr/bin/xcrun', [
    'devicectl', 'device', 'copy', 'from', '--device', device,
    '--domain-type', 'appDataContainer', '--domain-identifier', 'uk.eugnel.ks2spelling',
    '--source', `Library/Application Support/${source}`, '--destination', destination,
    '--json-output', jsonOutput,
  ]);
  return readCopiedDeviceFile(destination, source);
}

async function inspectIosDevice({ root, env, runner }) {
  const device = env.B3_IOS_PHYSICAL_DEVICE_ID;
  if (!device) fail('B3_IOS_PHYSICAL_DEVICE_ID is required');
  await mkdir(resolve(root, '.native-build/b3/distribution'), { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(resolve(root, '.native-build/b3/distribution/ios-device-'));
  try {
    const appsJson = resolve(temporary, 'apps.json');
    await run(runner, '/usr/bin/xcrun', ['devicectl', 'device', 'info', 'apps', '--device', device, '--bundle-id', 'uk.eugnel.ks2spelling', '--json-output', appsJson]);
    const appRecord = extractIosAppRecord(parseB3StrictJsonBytes(await readFile(appsJson), 'devicectl application inventory'));
    const authorityBytes = await copyIosApplicationSupportFile({
      device, source: 'b3-build-authority.json', destination: resolve(temporary, 'authority-copy'),
      jsonOutput: resolve(temporary, 'authority-copy.json'), runner,
    });
    const authority = parseB3StrictJsonBytes(authorityBytes, 'installed iOS build authority');
    const authorityKeys = ['mode', 'proofKind', 'platform', 'distribution', 'publicSandboxOrigin', 'workerName', 'testedApplicationCommit', 'applicationFingerprint', 'versionName', 'buildNumber', 'bundleId'];
    if (!hasExactKeys(authority, authorityKeys) || authority.mode !== 'B3SandboxProof' || authority.proofKind !== 'physical-live' ||
        authority.platform !== 'ios' || authority.distribution !== 'development' ||
        authority.publicSandboxOrigin !== 'https://b3-gateway.eugnel.uk' || authority.workerName !== 'ks2-spelling-b3-sandbox' ||
        authority.bundleId !== 'uk.eugnel.ks2spelling' || authority.versionName !== '0.3.0-b3' ||
        !COMMIT.test(authority.testedApplicationCommit) || !HASH.test(authority.applicationFingerprint) || !/^[1-9][0-9]*$/u.test(authority.buildNumber)) {
      fail('installed iOS authority is invalid');
    }
    const appVersion = appRecord.version ?? appRecord.shortVersion ?? appRecord.CFBundleShortVersionString;
    const appBuild = String(appRecord.buildVersion ?? appRecord.versionIdentifier ?? appRecord.CFBundleVersion ?? '');
    if (appVersion !== authority.versionName || appBuild !== authority.buildNumber) fail('devicectl and installed iOS authority differ');
    const receiptPath = resolve(temporary, 'sandbox-receipt');
    const receipt = await copyIosApplicationSupportFile({
      device, source: 'b3-sandbox-receipt', destination: receiptPath,
      jsonOutput: resolve(temporary, 'receipt-copy.json'), runner,
    });
    if (receipt.length < 128 || receipt.length > 1024 * 1024) fail('physical iOS sandbox receipt has an invalid byte length');
    const receiptPayload = resolve(temporary, 'receipt-payload.der');
    await run(runner, '/usr/bin/security', ['cms', '-D', '-u', '9', '-i', receiptPath, '-o', receiptPayload]);
    const receiptStructure = await run(runner, '/usr/bin/openssl', ['asn1parse', '-inform', 'DER', '-in', receiptPayload, '-i']);
    if (!/UTF8STRING\s*:Sandbox(?:\s|$)/u.test(receiptStructure)) fail('physical iOS receipt is not a validated sandbox receipt');
    return {
      installedBundleId: authority.bundleId,
      installedVersion: authority.versionName,
      installedBuild: authority.buildNumber,
      installedEmbeddedAuthoritySha256: b3EmbeddedAuthoritySha256({
        ...authority,
        commit: authority.testedApplicationCommit,
        fingerprint: authority.applicationFingerprint,
      }),
      sandboxReceiptSha256: sha256(receipt),
      sandboxReceiptEnvironment: 'sandbox',
      sandboxReceiptCmsVerified: true,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function parsePmPaths(output) {
  const paths = output.split(/\r?\n/u).filter(Boolean).map((line) => line.startsWith('package:') ? line.slice(8) : '');
  if (paths.some((path) => !path.startsWith('/')) || paths.length < 1) fail('Android pm path output is invalid');
  const base = paths.filter((path) => path.endsWith('/base.apk'));
  const splits = paths.filter((path) => !path.endsWith('/base.apk')).sort();
  if (base.length !== 1 || new Set(paths).size !== paths.length) fail('Android pm path authority is ambiguous');
  return [base[0], ...splits];
}

function parseDumpsys(output) {
  const versionName = /^\s*versionName=(\S+)$/mu.exec(output)?.[1];
  const versionCode = Number(/^\s*versionCode=(\d+)/mu.exec(output)?.[1]);
  const installer = /installerPackageName=(\S+)/u.exec(output)?.[1] ?? /Installer package name:\s*(\S+)/u.exec(output)?.[1];
  if (versionName !== '0.3.0-b3' || !Number.isSafeInteger(versionCode) || versionCode <= 0 || installer !== 'com.android.vending') fail('installed Android package authority is incomplete');
  return { versionName, versionCode, installer };
}

function parseApksignerCertificate(output) {
  const certificates = [...output.matchAll(/^Signer #\d+ certificate SHA-256 digest:\s*([0-9a-f]{64})$/gmu)].map((match) => match[1]);
  if (certificates.length !== 1) fail('installed base APK signing certificate authority is absent or ambiguous');
  return certificates[0];
}

async function inspectAndroidDevice({ root, env, runner }) {
  const serial = env.B3_ANDROID_PHYSICAL_DEVICE_ID;
  if (!serial) fail('B3_ANDROID_PHYSICAL_DEVICE_ID is required');
  const adb = env.B3_ADB_PATH ?? resolve(homedir(), 'Library/Android/sdk/platform-tools/adb');
  const apksigner = resolve(homedir(), 'Library/Android/sdk/build-tools/36.0.0/apksigner');
  const prefix = ['-s', serial];
  const emulator = await run(runner, adb, [...prefix, 'shell', 'getprop', 'ro.kernel.qemu']);
  if (emulator === '1') fail('Android Emulator cannot satisfy physical proof');
  const paths = parsePmPaths(await run(runner, adb, [...prefix, 'shell', 'pm', 'path', 'uk.eugnel.ks2spelling']));
  const dumpsys = parseDumpsys(await run(runner, adb, [...prefix, 'shell', 'dumpsys', 'package', 'uk.eugnel.ks2spelling']));
  await mkdir(resolve(root, '.native-build/b3/distribution'), { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(resolve(root, '.native-build/b3/distribution/android-device-'));
  try {
    const installedApks = [];
    let baseBytes;
    for (let index = 0; index < paths.length; index += 1) {
      const destination = resolve(temporary, index === 0 ? 'base.apk' : `split-${String(index).padStart(3, '0')}.apk`);
      await run(runner, adb, [...prefix, 'pull', paths[index], destination]);
      const splitName = index === 0 ? '' : basename(paths[index], '.apk');
      const apkBytes = await readFile(destination);
      if (index === 0) baseBytes = apkBytes;
      installedApks.push({ order: index, kind: index === 0 ? 'base' : 'split', splitName, sha256: sha256(apkBytes) });
    }
    const basePath = resolve(temporary, 'base.apk');
    const certificate = parseApksignerCertificate(await run(runner, apksigner, ['verify', '--verbose', '--print-certs', basePath]));
    const buildConfig = await inspectAndroidDexAuthority({ bytes: baseBytes, temporary, runner });
    if (buildConfig.versionName !== dumpsys.versionName || buildConfig.versionCode !== dumpsys.versionCode) fail('pulled base APK and package manager authority differ');
    return {
      installer: dumpsys.installer,
      installedEmbeddedAuthoritySha256: b3EmbeddedAuthoritySha256({
        mode: buildConfig.mode, proofKind: buildConfig.proofKind, platform: buildConfig.platform,
        distribution: buildConfig.distribution, publicSandboxOrigin: buildConfig.publicSandboxOrigin,
        workerName: buildConfig.workerName, bundleId: buildConfig.applicationId, commit: buildConfig.commit,
        fingerprint: buildConfig.fingerprint, versionName: buildConfig.versionName, buildNumber: buildConfig.versionCode,
      }),
      installedSigningCertificateSha256: certificate,
      pmPathOrderVerified: true,
      installedApks,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export function createDefaultB3DistributionInspectors({ root, env = process.env, commandRunner = defaultCommandRunner } = {}) {
  return Object.freeze({
    async artifactInspector({ platform, signedPath }) {
      if (platform !== 'ios' && platform !== 'android') fail('distribution platform is invalid');
      const record = await readValidatedB3OperatorFile({ path: signedPath, root });
      const outputRoot = resolve(root, '.native-build/b3/distribution');
      await mkdir(outputRoot, { recursive: true, mode: 0o700 });
      const temporary = await mkdtemp(resolve(outputRoot, `${platform}-artifact-`));
      try {
        const copyPath = resolve(temporary, platform === 'ios' ? 'signed.ipa' : 'signed.aab');
        await writeFile(copyPath, record.bytes, { mode: 0o600, flag: 'wx' });
        await chmod(copyPath, 0o600);
        return await (platform === 'ios'
          ? inspectIosArtifact({ bytes: record.bytes, copyPath, temporary, runner: commandRunner })
          : inspectAndroidArtifact({ bytes: record.bytes, copyPath, temporary, runner: commandRunner }));
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    },
    deviceInspector({ platform }) {
      if (platform !== 'ios' && platform !== 'android') fail('distribution platform is invalid');
      return platform === 'ios'
        ? inspectIosDevice({ root, env, runner: commandRunner })
        : inspectAndroidDevice({ root, env, runner: commandRunner });
    },
  });
}
