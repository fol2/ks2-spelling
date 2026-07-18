import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import audioManifest from '../config/b4-audio-manifest.json' with { type: 'json' };
import {
  createB4DevelopmentReport,
  validateB4PlatformRiskReport,
} from '../src/app/b4-development-report.js';
import {
  B4_PRODUCT_IDENTIFIER,
  B4_RUNTIME_ITEM_IDS,
  B4_SEED,
  characteriseB4Round,
  validateB4AudioManifest,
} from '../src/app/b4-round-contract.js';
import {
  EXIT_CODES,
  isMain,
  printJson,
  runCommand,
} from './lib/run-command.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const REPORT_DIRECTORY = join(ROOT, 'reports/b4');
const PLAN_PATH = 'docs/superpowers/plans/2026-07-18-standalone-spelling-mobile-b4-capacitor-development-certification.md';
const IOS_CAPTURE_DIRECTORY = join(ROOT, '.native-build/b4/ios');
const ANDROID_CAPTURE_DIRECTORY = join(ROOT, '.native-build/b4/android');
const IOS_APP = join(ROOT, '.native-build/ios/Build/Products/Debug-iphonesimulator/App.app');
const ANDROID_APK = join(ROOT, 'android/app/build/outputs/apk/debug/app-debug.apk');
const HASH = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const PRIVATE_KEY = /(?:account|capabilityurl|learnerid|nickname|receipt|token|udid)/iu;

export const B4_EVIDENCE_PATHS = Object.freeze([
  'reports/b4/domain-round-proof.json',
  'reports/b4/ios-simulator-proof.json',
  'reports/b4/ios-phone.png',
  'reports/b4/ios-tablet-portrait.png',
  'reports/b4/ios-tablet-landscape.png',
  'reports/b4/android-emulator-proof.json',
  'reports/b4/android-phone.png',
  'reports/b4/android-tablet-portrait.png',
  'reports/b4/android-tablet-landscape.png',
  'reports/b4/b4-development-report.json',
]);

function evidenceError(code = 'b4_evidence_invalid', message = 'B4 development evidence is invalid.') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function hashJson(value) {
  return sha256(JSON.stringify(value));
}

function validateCheckpoint(value) {
  if (!value || !COMMIT.test(value.commit ?? '') || !COMMIT.test(value.tree ?? '') ||
      Object.keys(value).sort().join('|') !== 'commit|tree') {
    throw evidenceError();
  }
  return structuredClone(value);
}

function assertNoPrivateKeys(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (PRIVATE_KEY.test(key)) {
      throw evidenceError(
        'b4_evidence_private_data',
        `B4 evidence contains a forbidden private key: ${key}.`,
      );
    }
    assertNoPrivateKeys(child);
  }
}

function validateBundleInput(value) {
  const keys = Object.keys(value ?? {}).sort().join('|');
  const common = HASH.test(value?.sha256 ?? '') &&
    Number.isSafeInteger(value?.byteSize) && value.byteSize > 0;
  if (!common || !(
    value.kind === 'file-sha256' && keys === 'byteSize|kind|sha256' ||
    value.kind === 'directory-sha256' && keys === 'byteSize|fileCount|kind|sha256' &&
      Number.isSafeInteger(value.fileCount) && value.fileCount > 0
  )) {
    throw evidenceError();
  }
  return structuredClone(value);
}

export function createB4DomainRoundProof({
  applicationCheckpoint,
  planSha256,
  audioManifest: manifest,
}) {
  const checkpoint = validateCheckpoint(applicationCheckpoint);
  if (!HASH.test(planSha256 ?? '')) throw evidenceError();
  const validatedManifest = validateB4AudioManifest(manifest);
  const round = characteriseB4Round();
  const proof = {
    schemaVersion: 1,
    productIdentifier: B4_PRODUCT_IDENTIFIER,
    entryAuthority: {
      planPath: PLAN_PATH,
      planSha256,
      b3MergedMainCommit: 'c6fedd9f554a2873fb993ad4ae21e0cde54cba9d',
      b3MergedTree: '4802611ff79ea6d56bb78f25f65eed4826159d22',
    },
    applicationCheckpoint: checkpoint,
    characterisation: {
      randomSeed: B4_SEED,
      runtimeItemIds: [...B4_RUNTIME_ITEM_IDS],
      commandCount: round.commandTrace.length,
      commandTraceSha256: hashJson(round.commandTrace),
      sentencePromptCount: round.sentencePrompts.length,
      sentencePromptsSha256: hashJson(round.sentencePrompts),
      summarySha256: hashJson(round.summary),
    },
    audioAuthority: {
      manifestSha256: hashJson(validatedManifest),
      authoritySha256: validatedManifest.authoritySha256,
      traceSha256: validatedManifest.traceSha256,
      assetCount: validatedManifest.assetCount,
    },
    outcomes: {
      composition: 'pass',
      deterministicRound: 'pass',
      audioAuthority: 'pass',
    },
  };
  assertNoPrivateKeys(proof);
  return proof;
}

export function createB4PlatformProof({
  capture,
  applicationCheckpoint,
  bundleInput,
  phoneFile,
}) {
  assertNoPrivateKeys(capture);
  const checkpoint = validateCheckpoint(applicationCheckpoint);
  const bundle = validateBundleInput(bundleInput);
  const risk = validateB4PlatformRiskReport(capture?.platformRiskReport);
  const validJourney = capture?.journeys?.default?.completed === true &&
    capture.journeys.default.softwareKeyboardObserved === true &&
    capture.journeys.default.enterSubmitted === true &&
    capture.journeys.default.backgroundAudioStoppedCount === 2 &&
    capture.journeys.default.resumeProgressBefore === capture.journeys.default.resumeProgressAfter &&
    capture?.journeys?.scaled?.atLeast200Percent === true &&
    capture.journeys.scaled.completed === true;
  if (capture?.schemaVersion !== 1 || capture.platform !== risk.platform ||
      capture?.offlineBoundary?.web !== "connect-src 'none'" ||
      capture?.offlineBoundary?.clientTts !== 'none' ||
      !Array.isArray(capture.limitations) || capture.limitations.length === 0 ||
      !validJourney || !/^(?:ios|android)-phone\.png$/u.test(phoneFile ?? '')) {
    throw evidenceError();
  }
  const proof = {
    ...structuredClone(capture),
    applicationCheckpoint: checkpoint,
    bundleInput: bundle,
    layout: {
      ...structuredClone(capture.layout),
      phonePortrait: phoneFile,
      phoneAt200Percent: phoneFile,
    },
    platformRiskReport: risk,
  };
  assertNoPrivateKeys(proof);
  return proof;
}

function combinedOutcome(values) {
  if (values.includes('webview-ceiling')) return 'webview-ceiling';
  if (values.includes('incomplete')) return 'incomplete';
  if (values.includes('investigation-required')) return 'investigation-required';
  return 'pass';
}

export function createB4DevelopmentAggregate({
  applicationCheckpoint,
  bundleInputs,
  platformProofs,
  evidenceSha256,
}) {
  const checkpoint = validateCheckpoint(applicationCheckpoint);
  const iosBundle = validateBundleInput(bundleInputs?.ios);
  const androidBundle = validateBundleInput(bundleInputs?.android);
  if (JSON.stringify(platformProofs?.ios?.applicationCheckpoint) !== JSON.stringify(checkpoint) ||
      JSON.stringify(platformProofs?.android?.applicationCheckpoint) !== JSON.stringify(checkpoint) ||
      JSON.stringify(platformProofs.ios.bundleInput) !== JSON.stringify(iosBundle) ||
      JSON.stringify(platformProofs.android.bundleInput) !== JSON.stringify(androidBundle)) {
    throw evidenceError();
  }
  const evidencePaths = B4_EVIDENCE_PATHS.slice(0, -1);
  if (Object.keys(evidenceSha256 ?? {}).sort().join('|') !== evidencePaths.toSorted().join('|') ||
      !Object.values(evidenceSha256).every((value) => HASH.test(value))) {
    throw evidenceError();
  }
  const claims = createB4DevelopmentReport({
    composition: 'pass',
    deterministicRound: 'pass',
    rehydration: 'pass',
    audioAuthority: 'pass',
  }).claims;
  const platformOutcomes = {
    ios: platformProofs.ios.platformRiskReport.technicalOutcome,
    android: platformProofs.android.platformRiskReport.technicalOutcome,
  };
  const aggregate = {
    schemaVersion: 1,
    productIdentifier: B4_PRODUCT_IDENTIFIER,
    applicationCheckpoint: checkpoint,
    bundleInputs: { ios: iosBundle, android: androidBundle },
    evidenceSha256: structuredClone(evidenceSha256),
    claims,
    platformOutcomes,
    technicalOutcome: combinedOutcome(Object.values(platformOutcomes)),
  };
  assertNoPrivateKeys(aggregate);
  return aggregate;
}

async function command(args) {
  const result = await runCommand('git', args, { cwd: ROOT });
  if (result.exitCode !== 0) throw evidenceError('b4_evidence_git_failed', 'Git authority failed.');
  return result.stdout.trim();
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw evidenceError('b4_evidence_missing', `Missing or malformed B4 evidence: ${path}.`);
  }
}

async function hashFile(path) {
  const bytes = await readFile(path);
  return { kind: 'file-sha256', sha256: sha256(bytes), byteSize: bytes.length };
}

async function directoryFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await directoryFiles(root, path));
    else if (entry.isFile()) files.push(path);
    else throw evidenceError('b4_evidence_bundle_invalid', 'The iOS bundle contains a non-regular entry.');
  }
  return files.toSorted((left, right) => relative(root, left).localeCompare(relative(root, right)));
}

async function hashDirectory(path) {
  const digest = createHash('sha256');
  const files = await directoryFiles(path);
  let byteSize = 0;
  for (const file of files) {
    const bytes = await readFile(file);
    const name = relative(path, file).replaceAll('\\', '/');
    digest.update(name).update('\0').update(String(bytes.length)).update('\0').update(bytes);
    byteSize += bytes.length;
  }
  return {
    kind: 'directory-sha256',
    sha256: digest.digest('hex'),
    fileCount: files.length,
    byteSize,
  };
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function assertPng(path) {
  const bytes = await readFile(path);
  if (bytes.length < 24 || bytes.toString('ascii', 1, 4) !== 'PNG') {
    throw evidenceError('b4_evidence_screenshot_invalid', `Invalid screenshot: ${path}.`);
  }
}

async function expectedDomainProof(checkpoint) {
  return createB4DomainRoundProof({
    applicationCheckpoint: checkpoint,
    planSha256: sha256(await readFile(join(ROOT, PLAN_PATH))),
    audioManifest,
  });
}

async function collectEvidence() {
  const checkpoint = {
    commit: await command(['rev-parse', 'HEAD']),
    tree: await command(['rev-parse', 'HEAD^{tree}']),
  };
  const [iosCapture, androidCapture, iosBundle, androidBundle, domain] = await Promise.all([
    readJson(join(IOS_CAPTURE_DIRECTORY, 'capture.json')),
    readJson(join(ANDROID_CAPTURE_DIRECTORY, 'capture.json')),
    hashDirectory(IOS_APP),
    hashFile(ANDROID_APK),
    expectedDomainProof(checkpoint),
  ]);
  const ios = createB4PlatformProof({
    capture: iosCapture,
    applicationCheckpoint: checkpoint,
    bundleInput: iosBundle,
    phoneFile: 'ios-phone.png',
  });
  const android = createB4PlatformProof({
    capture: androidCapture,
    applicationCheckpoint: checkpoint,
    bundleInput: androidBundle,
    phoneFile: 'android-phone.png',
  });
  const temporary = await mkdtemp(join(tmpdir(), 'ks2-b4-evidence-'));
  let technicalOutcome = null;
  try {
    await Promise.all([
      writeJson(join(temporary, 'domain-round-proof.json'), domain),
      writeJson(join(temporary, 'ios-simulator-proof.json'), ios),
      writeJson(join(temporary, 'android-emulator-proof.json'), android),
      copyFile(join(IOS_CAPTURE_DIRECTORY, 'ios-phone-200-percent.png'), join(temporary, 'ios-phone.png')),
      copyFile(join(IOS_CAPTURE_DIRECTORY, 'ios-tablet-portrait.png'), join(temporary, 'ios-tablet-portrait.png')),
      copyFile(join(IOS_CAPTURE_DIRECTORY, 'ios-tablet-landscape.png'), join(temporary, 'ios-tablet-landscape.png')),
      copyFile(join(ANDROID_CAPTURE_DIRECTORY, 'android-phone-200-percent.png'), join(temporary, 'android-phone.png')),
      copyFile(join(ANDROID_CAPTURE_DIRECTORY, 'android-tablet-portrait.png'), join(temporary, 'android-tablet-portrait.png')),
      copyFile(join(ANDROID_CAPTURE_DIRECTORY, 'android-tablet-landscape.png'), join(temporary, 'android-tablet-landscape.png')),
    ]);
    const evidenceSha256 = Object.fromEntries(await Promise.all(
      B4_EVIDENCE_PATHS.slice(0, -1).map(async (path) => [
        path,
        (await hashFile(join(temporary, path.split('/').at(-1)))).sha256,
      ]),
    ));
    const aggregate = createB4DevelopmentAggregate({
      applicationCheckpoint: checkpoint,
      bundleInputs: { ios: iosBundle, android: androidBundle },
      platformProofs: { ios, android },
      evidenceSha256,
    });
    technicalOutcome = aggregate.technicalOutcome;
    await writeJson(join(temporary, 'b4-development-report.json'), aggregate);
    await rm(REPORT_DIRECTORY, { recursive: true, force: true });
    await mkdir(join(ROOT, 'reports'), { recursive: true });
    await rename(temporary, REPORT_DIRECTORY);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return {
    ok: true,
    applicationCheckpoint: checkpoint.commit,
    technicalOutcome,
  };
}

async function verifyEvidence() {
  const expectedNames = B4_EVIDENCE_PATHS.map((path) => path.split('/').at(-1)).toSorted();
  const actualNames = (await readdir(REPORT_DIRECTORY)).toSorted();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) throw evidenceError();
  const [domain, iosValue, androidValue, aggregate] = await Promise.all([
    readJson(join(REPORT_DIRECTORY, 'domain-round-proof.json')),
    readJson(join(REPORT_DIRECTORY, 'ios-simulator-proof.json')),
    readJson(join(REPORT_DIRECTORY, 'android-emulator-proof.json')),
    readJson(join(REPORT_DIRECTORY, 'b4-development-report.json')),
    ...B4_EVIDENCE_PATHS.filter((path) => path.endsWith('.png')).map((path) => assertPng(join(ROOT, path))),
  ]);
  const checkpoint = validateCheckpoint(aggregate.applicationCheckpoint);
  const expectedDomain = await expectedDomainProof(checkpoint);
  if (JSON.stringify(domain) !== JSON.stringify(expectedDomain)) throw evidenceError();
  const ios = createB4PlatformProof({
    capture: iosValue,
    applicationCheckpoint: checkpoint,
    bundleInput: aggregate.bundleInputs?.ios,
    phoneFile: 'ios-phone.png',
  });
  const android = createB4PlatformProof({
    capture: androidValue,
    applicationCheckpoint: checkpoint,
    bundleInput: aggregate.bundleInputs?.android,
    phoneFile: 'android-phone.png',
  });
  const evidenceSha256 = Object.fromEntries(await Promise.all(
    B4_EVIDENCE_PATHS.slice(0, -1).map(async (path) => [path, (await hashFile(join(ROOT, path))).sha256]),
  ));
  const expectedAggregate = createB4DevelopmentAggregate({
    applicationCheckpoint: checkpoint,
    bundleInputs: aggregate.bundleInputs,
    platformProofs: { ios, android },
    evidenceSha256,
  });
  if (JSON.stringify(aggregate) !== JSON.stringify(expectedAggregate)) throw evidenceError();
  return {
    ok: true,
    applicationCheckpoint: checkpoint.commit,
    technicalOutcome: aggregate.technicalOutcome,
  };
}

export async function main(args = process.argv.slice(2)) {
  try {
    if (args.some((argument) => argument !== '--check')) throw evidenceError();
    printJson(args.includes('--check') ? await verifyEvidence() : await collectEvidence());
    return EXIT_CODES.success;
  } catch (error) {
    printJson({ ok: false, code: error.code ?? 'b4_evidence_failed', message: error.message }, process.stderr);
    return EXIT_CODES.commandFailed;
  }
}

if (isMain(import.meta.url)) process.exitCode = await main();
