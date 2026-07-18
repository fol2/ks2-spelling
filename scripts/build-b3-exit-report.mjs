import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { fingerprintB3Application } from './fingerprint-b3-application.mjs';
import {
  B3_SYNTHETIC_LEARNER_AUTHORITY_SHA256,
  assertB3GatewayEquality,
  validateB3CloudflareEvidence,
  validateB3PlatformEvidence,
} from './lib/b3-evidence.mjs';
import {
  B3_FINAL_PROOF_OUTPUT_PATHS,
  publishB3FinalProofOutput,
} from './lib/b3-final-proof-output.mjs';
import { runPinnedSystemGit } from './lib/pinned-system-git.mjs';
import { validateB3ReportPngBytes } from './lib/b3-png.mjs';
import { isMain, redactText } from './lib/run-command.mjs';
import { verifyB2Authority } from './verify-b2-authority.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const EXIT_PATH = B3_FINAL_PROOF_OUTPUT_PATHS.at(-1);
const FIRST_FIVE_PATHS = B3_FINAL_PROOF_OUTPUT_PATHS.slice(0, -1);
const HASH = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const MAXIMUM_JSON_BYTES = 8 * 1024 * 1024;

const INPUT_PATHS = Object.freeze({
  proofPack: 'reports/b3/b3-proof-pack-build.json',
  nativeBuild: 'reports/b3/native-build.json',
  dependencyAudit: 'reports/b3/dependency-audit.json',
  deterministicProof: 'reports/b3/deterministic-proof.json',
  gatewayAuthority: 'config/b3-gateway-authority.json',
  packObjectAuthority: 'config/b3-pack-object-authority.json',
  storeProducts: 'config/store-products.json',
  syntheticLearners: 'config/b3-synthetic-learners.json',
  cloudflare: B3_FINAL_PROOF_OUTPUT_PATHS[0],
  iosReport: B3_FINAL_PROOF_OUTPUT_PATHS[1],
  iosScreenshot: B3_FINAL_PROOF_OUTPUT_PATHS[2],
  androidReport: B3_FINAL_PROOF_OUTPUT_PATHS[3],
  androidScreenshot: B3_FINAL_PROOF_OUTPUT_PATHS[4],
});

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function assert(condition, message) {
  if (!condition) fail('b3_exit_evidence_invalid', message);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function hashValue(value) {
  return sha256(Buffer.from(JSON.stringify(value)));
}

function serialise(report) {
  return Buffer.from(`${JSON.stringify(report)}\n`);
}

async function readBoundedInput(root, path, { json = true, maximumBytes = MAXIMUM_JSON_BYTES } = {}) {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(absoluteRoot, path);
  const fromRoot = relative(absoluteRoot, absolutePath);
  assert(
    fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`),
    `B3 exit input escaped the repository: ${path}`,
  );
  let before;
  try {
    before = await lstat(absolutePath);
  } catch {
    fail('b3_exit_input_missing', `Required B3 exit input is missing: ${path}`);
  }
  assert(
    before.isFile() && !before.isSymbolicLink() && (before.mode & 0o111) === 0 &&
      before.size > 0 && before.size <= maximumBytes,
    `Required B3 exit input is not a bounded non-executable regular file: ${path}`,
  );
  const bytes = await readFile(absolutePath);
  const after = await lstat(absolutePath);
  assert(
    after.isFile() && after.dev === before.dev && after.ino === before.ino &&
      after.size === before.size && after.mtimeMs === before.mtimeMs &&
      bytes.length === before.size,
    `Required B3 exit input changed while being read: ${path}`,
  );
  let value = null;
  if (json) {
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      fail('b3_exit_input_invalid', `Required B3 exit input is not JSON: ${path}`);
    }
  }
  return Object.freeze({ path, bytes, sha256: sha256(bytes), value });
}

function reference(input) {
  return Object.freeze({ path: input.path, sha256: input.sha256 });
}

function validateDeterministicInputs({ proofPack, nativeBuild, dependencyAudit, deterministicProof }) {
  assert(
    proofPack.value?.schemaVersion === 1 && proofPack.value.status === 'pass' &&
      proofPack.value.builderMode === 'verify-only' &&
      proofPack.value.environment === 'sandbox' &&
      proofPack.value.packId === 'b3-sandbox-proof' &&
      proofPack.value.version === '1.0.0-b3.1' &&
      HASH.test(proofPack.value.signedEnvelope?.sha256 ?? '') &&
      HASH.test(proofPack.value.archive?.sha256 ?? ''),
    'B3 proof-pack deterministic authority is invalid',
  );
  assert(
    nativeBuild.value?.schemaVersion === 1 && nativeBuild.value.status === 'pass' &&
      isDeepStrictEqual(nativeBuild.value.evidenceBoundary, {
        compiledCapability: true,
        liveStoreProof: false,
        liveCloudProof: false,
        physicalDeviceProof: false,
      }) && nativeBuild.value.publicFixtures?.signingFixturePackaged === false &&
      nativeBuild.value.publicFixtures?.signedEnvelopeSha256 ===
        proofPack.value.signedEnvelope.sha256 &&
      nativeBuild.value.publicFixtures?.archiveSha256 === proofPack.value.archive.sha256,
    'B3 native deterministic authority is invalid',
  );
  const truth = dependencyAudit.value?.b3Truth;
  assert(
    dependencyAudit.value?.schemaVersion === 2 &&
      dependencyAudit.value.mode === 'resolved-toolchain' &&
      truth?.childOrProgressPayloadSentToCommerceGateway === false &&
      truth?.appConfiguredAnalytics === false && truth?.appConfiguredAdvertising === false &&
      truth?.liveStoreProof === false && truth?.liveCloudProof === false &&
      truth?.disclosureStatus === 'Not a final store disclosure',
    'B3 dependency authority is invalid',
  );
  assert(
    deterministicProof.value?.schemaVersion === 1 &&
      deterministicProof.value.status === 'pass' &&
      deterministicProof.value.traceIdValid === true &&
      deterministicProof.value.traceIdsUnique === true &&
      isDeepStrictEqual(deterministicProof.value.evidenceBoundary, {
        deterministicFakes: true,
        liveStoreProof: false,
        liveCloudProof: false,
        physicalDeviceProof: false,
      }) &&
      isDeepStrictEqual(deterministicProof.value.scenarioMatrix?.privacyContinuity, {
        parentOnlyDiagnostic: true,
        childSalesCopy: false,
        safeStoreIdsOnly: true,
        sealedHandlesOnly: true,
        offlineInstalledPackReady: true,
      }),
    'B3 deterministic proof authority is invalid',
  );
}

function validateTrackedAuthorities({
  gatewayAuthority,
  packObjectAuthority,
  storeProducts,
  syntheticLearners,
  cloudflare,
  ios,
  android,
  deterministicProof,
}) {
  const gateway = gatewayAuthority.value;
  assert(
    gateway?.schemaVersion === 1 && gateway.environment === 'sandbox' &&
      gateway.cloudflareAccountId === cloudflare.worker.accountId &&
      gateway.workerName === cloudflare.worker.name &&
      gateway.publicSandboxOrigin === cloudflare.worker.publicSandboxOrigin &&
      gateway.privateR2BucketName === cloudflare.bucket.approvedIdentifier &&
      isDeepStrictEqual(gateway.distribution, {
        iosKind: 'development',
        androidTrack: 'internal',
        applicationId: 'uk.eugnel.ks2spelling',
      }),
    'Tracked B3 gateway authority differs from live evidence',
  );

  const pack = packObjectAuthority.value;
  assert(
    pack?.schemaVersion === 1 && pack.packId === 'b3-sandbox-proof' &&
      pack.version === '1.0.0-b3.1' &&
      pack.bucketName === cloudflare.bucket.approvedIdentifier &&
      Array.isArray(pack.objects) && pack.objects.length === 2,
    'Tracked B3 pack authority is invalid',
  );
  for (const liveObject of cloudflare.objects) {
    const tracked = pack.objects.find(({ role }) => role === liveObject.role);
    assert(
      tracked?.key === liveObject.key && tracked.sha256 === liveObject.sha256 &&
        tracked.bytes === liveObject.size && tracked.etag === liveObject.etag &&
        isDeepStrictEqual(tracked.metadata, liveObject.customMetadata),
      `Tracked B3 ${liveObject.role} object authority differs from live evidence`,
    );
  }

  const expectedProduct = {
    entitlementId: 'full-ks2',
    type: 'non-consumable',
    appleProductId: ios.store.productId,
    googleProductId: android.store.productId,
    packIds: ['b3-sandbox-proof'],
  };
  assert(
    storeProducts.value?.schemaVersion === 1 &&
      isDeepStrictEqual(storeProducts.value.products, [expectedProduct]),
    'Tracked B3 product authority differs from live store evidence',
  );
  assert(
    syntheticLearners.sha256 === B3_SYNTHETIC_LEARNER_AUTHORITY_SHA256 &&
      ios.syntheticLearnerAuthoritySha256 === syntheticLearners.sha256 &&
      android.syntheticLearnerAuthoritySha256 === syntheticLearners.sha256 &&
      deterministicProof.value.syntheticDigests?.syntheticLearnerAuthoritySha256 ===
        syntheticLearners.sha256 &&
      deterministicProof.value.syntheticDigests?.packObjectAuthoritySha256 ===
        packObjectAuthority.sha256 &&
      deterministicProof.value.syntheticDigests?.signedManifestSha256 ===
        cloudflare.signedEnvelopeSha256,
    'Tracked B3 synthetic or deterministic authority differs from live evidence',
  );
}

function platformSummary(reportInput, screenshotInput, value) {
  const ios = value.platform === 'ios-physical';
  return Object.freeze({
    platform: value.platform,
    report: reference(reportInput),
    screenshot: reference(screenshotInput),
    storeProductId: value.store.productId,
    scenarioAuthoritySha256: hashValue(value.transitions),
    observationChainAuthoritySha256: value.proofObservationChain.chainAuthoritySha256,
    syntheticLearnerAuthoritySha256: value.syntheticLearnerAuthoritySha256,
    distribution: ios ? Object.freeze({
      kind: value.distribution.kind,
      signedIpaSha256: value.distribution.signedIpaSha256,
      ipaEmbeddedAuthoritySha256: value.distribution.ipaEmbeddedAuthoritySha256,
      codeSigningCertificateSha256: value.distribution.codeSigningCertificateSha256,
    }) : Object.freeze({
      kind: value.distribution.kind,
      signedAabSha256: value.distribution.signedAabSha256,
      aabEmbeddedAuthoritySha256: value.distribution.aabEmbeddedAuthoritySha256,
      playAppSigningCertificateSha256:
        value.distribution.playAppSigningCertificateSha256,
    }),
  });
}

export async function buildB3ExitReport({
  root = ROOT,
  expectedApplicationCommit,
  expectedApplicationFingerprint,
  verifyAuthority = verifyB2Authority,
  fingerprintApplication = fingerprintB3Application,
} = {}) {
  assert(COMMIT.test(expectedApplicationCommit ?? ''), 'Expected application commit is malformed');
  assert(HASH.test(expectedApplicationFingerprint ?? ''), 'Expected application fingerprint is malformed');
  const absoluteRoot = resolve(root);
  const [
    b2Authority,
    fingerprint,
    proofPack,
    nativeBuild,
    dependencyAudit,
    deterministicProof,
    gatewayAuthority,
    packObjectAuthority,
    storeProducts,
    syntheticLearners,
    cloudflareInput,
    iosInput,
    iosScreenshot,
    androidInput,
    androidScreenshot,
  ] = await Promise.all([
    verifyAuthority({ root: absoluteRoot }),
    fingerprintApplication({ root: absoluteRoot }),
    readBoundedInput(absoluteRoot, INPUT_PATHS.proofPack),
    readBoundedInput(absoluteRoot, INPUT_PATHS.nativeBuild),
    readBoundedInput(absoluteRoot, INPUT_PATHS.dependencyAudit),
    readBoundedInput(absoluteRoot, INPUT_PATHS.deterministicProof),
    readBoundedInput(absoluteRoot, INPUT_PATHS.gatewayAuthority),
    readBoundedInput(absoluteRoot, INPUT_PATHS.packObjectAuthority),
    readBoundedInput(absoluteRoot, INPUT_PATHS.storeProducts),
    readBoundedInput(absoluteRoot, INPUT_PATHS.syntheticLearners),
    readBoundedInput(absoluteRoot, INPUT_PATHS.cloudflare),
    readBoundedInput(absoluteRoot, INPUT_PATHS.iosReport),
    readBoundedInput(absoluteRoot, INPUT_PATHS.iosScreenshot, {
      json: false,
      maximumBytes: 64 * 1024 * 1024,
    }),
    readBoundedInput(absoluteRoot, INPUT_PATHS.androidReport),
    readBoundedInput(absoluteRoot, INPUT_PATHS.androidScreenshot, {
      json: false,
      maximumBytes: 64 * 1024 * 1024,
    }),
  ]);
  assert(fingerprint?.sha256 === expectedApplicationFingerprint, 'Application fingerprint drifted');
  assert(
    COMMIT.test(b2Authority?.commit ?? '') && COMMIT.test(b2Authority?.tree ?? '') &&
      HASH.test(b2Authority?.exitReportSha256 ?? ''),
    'Frozen B2 authority is invalid',
  );
  validateDeterministicInputs({ proofPack, nativeBuild, dependencyAudit, deterministicProof });

  const cloudflare = validateB3CloudflareEvidence(cloudflareInput.value);
  const ios = validateB3PlatformEvidence(iosInput.value);
  const android = validateB3PlatformEvidence(androidInput.value);
  assert(ios.platform === 'ios-physical', 'iOS live evidence platform is invalid');
  assert(android.platform === 'android-play-physical', 'Android live evidence platform is invalid');
  for (const value of [cloudflare, ios, android]) {
    assert(
      value.testedApplicationCommit === expectedApplicationCommit &&
        value.applicationFingerprint === expectedApplicationFingerprint,
      'Live evidence application authority differs from the checkpoint',
    );
  }
  assertB3GatewayEquality(ios, cloudflare);
  assertB3GatewayEquality(android, cloudflare);

  const iosPng = validateB3ReportPngBytes(iosScreenshot.bytes, { label: 'B3 iOS screenshot' });
  const androidPng = validateB3ReportPngBytes(androidScreenshot.bytes, {
    label: 'B3 Android screenshot',
  });
  assert(iosPng.sha256 === ios.screenshotSha256, 'B3 iOS screenshot SHA-256 differs');
  assert(androidPng.sha256 === android.screenshotSha256, 'B3 Android screenshot SHA-256 differs');
  validateTrackedAuthorities({
    gatewayAuthority,
    packObjectAuthority,
    storeProducts,
    syntheticLearners,
    cloudflare,
    ios,
    android,
    deterministicProof,
  });
  assert(
    nativeBuild.value.publicFixtures.signedEnvelopeSha256 === cloudflare.signedEnvelopeSha256 &&
      nativeBuild.value.publicFixtures.archiveSha256 === cloudflare.objects[1].sha256 &&
      proofPack.value.signedEnvelope.sha256 === cloudflare.signedEnvelopeSha256 &&
      proofPack.value.archive.sha256 === cloudflare.objects[1].sha256,
    'Live pack bytes differ from deterministic proof authority',
  );

  return Object.freeze({
    schemaVersion: 1,
    status: 'pass',
    testedApplicationCommit: expectedApplicationCommit,
    applicationFingerprint: expectedApplicationFingerprint,
    b2Authority: Object.freeze({
      commit: b2Authority.commit,
      tree: b2Authority.tree,
      exitReport: Object.freeze({
        path: 'reports/b2/b2-exit-report.json',
        sha256: b2Authority.exitReportSha256,
      }),
    }),
    deterministicInputs: Object.freeze({
      proofPack: reference(proofPack),
      nativeBuild: reference(nativeBuild),
      dependencyAudit: reference(dependencyAudit),
      deterministicProof: reference(deterministicProof),
    }),
    trackedAuthorities: Object.freeze({
      gateway: reference(gatewayAuthority),
      packObjects: reference(packObjectAuthority),
      storeProducts: reference(storeProducts),
      syntheticLearners: reference(syntheticLearners),
    }),
    liveEvidence: Object.freeze({
      cloudflare: Object.freeze({
        report: reference(cloudflareInput),
        accountId: cloudflare.worker.accountId,
        workerName: cloudflare.worker.name,
        publicSandboxOrigin: cloudflare.worker.publicSandboxOrigin,
        deploymentVersionId: cloudflare.worker.deploymentVersionId,
        scriptAuthoritySha256: cloudflare.worker.scriptAuthoritySha256,
        signedEnvelopeSha256: cloudflare.signedEnvelopeSha256,
        manifestObjectSha256: cloudflare.objects[0].sha256,
        archiveObjectSha256: cloudflare.objects[1].sha256,
      }),
      ios: platformSummary(iosInput, iosScreenshot, ios),
      android: platformSummary(androidInput, androidScreenshot, android),
    }),
    claimBoundary: Object.freeze({
      scope: 'sandbox-test-only',
      localLearningAuthority: true,
      productionReady: false,
      productionContent: false,
    }),
  });
}

async function defaultRunGit(args, { root }) {
  return runPinnedSystemGit(args, { root, timeout: 5_000, maxBuffer: 1024 * 1024 });
}

async function invokeGit(runGit, root, args) {
  const result = await runGit(args, { root });
  assert(
    typeof result?.stdout === 'string' && String(result.stderr ?? '') === '' &&
      (result.exitCode === undefined || result.exitCode === 0),
    `Pinned Git command failed: ${args[0]}`,
  );
  return result.stdout;
}

function exactCommit(value, label) {
  const commit = value.trim();
  assert(COMMIT.test(commit) && !commit.includes('\n'), `${label} is malformed`);
  return commit;
}

function statusPaths(value) {
  if (value === '') return [];
  const lines = value.endsWith('\n') ? value.slice(0, -1).split('\n') : value.split('\n');
  return lines.map((line) => {
    assert(
      line.length >= 4 && /^(?:\?\?|[ MADRCU?!]{2}) /u.test(line) &&
        !line.includes(' -> ') && line[3] !== '"',
      'Git status contains an unsupported entry',
    );
    return line.slice(3);
  });
}

async function currentOutputPaths(root) {
  const present = [];
  for (const path of B3_FINAL_PROOF_OUTPUT_PATHS) {
    try {
      await lstat(resolve(root, path));
      present.push(path);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return present;
}

function exactPathSet(actual, expected, message) {
  assert(
    isDeepStrictEqual([...new Set(actual)].toSorted(), [...expected].toSorted()),
    message,
  );
}

export async function checkB3LiveEvidenceTopology({
  root = ROOT,
  operation,
  runGit = defaultRunGit,
} = {}) {
  assert(['write', 'check-ci'].includes(operation), 'B3 exit operation must be write or check-ci');
  const absoluteRoot = resolve(root);
  const head = exactCommit(
    await invokeGit(runGit, absoluteRoot, ['rev-parse', '--verify', 'HEAD']),
    'B3 checkpoint HEAD',
  );
  const status = statusPaths(await invokeGit(
    runGit,
    absoluteRoot,
    ['status', '--porcelain=v1', '--untracked-files=all'],
  ));
  const history = new Map();
  for (const path of B3_FINAL_PROOF_OUTPUT_PATHS) {
    const commits = (await invokeGit(
      runGit,
      absoluteRoot,
      ['log', '--all', '--format=%H', '--', path],
    )).trim().split('\n').filter(Boolean);
    assert(commits.every((commit) => COMMIT.test(commit)), `B3 evidence history is malformed: ${path}`);
    history.set(path, commits);
  }
  const current = await currentOutputPaths(absoluteRoot);

  if (operation === 'write') {
    assert(
      current.length === FIRST_FIVE_PATHS.length ||
        current.length === B3_FINAL_PROOF_OUTPUT_PATHS.length,
      'B3 write requires exactly five fresh outputs or an identical six-output rerun',
    );
    exactPathSet(
      current,
      current.length === FIRST_FIVE_PATHS.length
        ? FIRST_FIVE_PATHS
        : B3_FINAL_PROOF_OUTPUT_PATHS,
      'B3 write evidence topology is partial',
    );
    exactPathSet(status, current, 'B3 write contains unrelated dirty input');
    assert(
      [...history.values()].every((commits) => commits.length === 0),
      'B3 write evidence paths already exist in history',
    );
    return Object.freeze({ mode: 'write', testedApplicationCommit: head });
  }

  assert(status.length === 0, 'B3 CI evidence topology requires a clean worktree');
  if (current.length === 0) {
    assert(
      [...history.values()].every((commits) => commits.length === 0),
      'B3 live evidence was deleted after appearing in history',
    );
    return Object.freeze({ mode: 'pending', testedApplicationCommit: head });
  }
  assert(
    current.length === B3_FINAL_PROOF_OUTPUT_PATHS.length,
    'B3 live evidence topology is partial',
  );
  exactPathSet(current, B3_FINAL_PROOF_OUTPUT_PATHS, 'B3 live evidence topology is partial');
  const cloudflareInput = await readBoundedInput(absoluteRoot, INPUT_PATHS.cloudflare);
  const testedApplicationCommit = cloudflareInput.value?.testedApplicationCommit;
  assert(COMMIT.test(testedApplicationCommit ?? ''), 'B3 live evidence checkpoint commit is malformed');
  for (const [path, commits] of history) {
    assert(
      isDeepStrictEqual(commits, [head]),
      `B3 evidence history is not one complete successor: ${path}`,
    );
  }
  const parents = (await invokeGit(
    runGit,
    absoluteRoot,
    ['rev-list', '--parents', '-n', '1', 'HEAD'],
  )).trim().split(' ');
  assert(
    isDeepStrictEqual(parents, [head, testedApplicationCommit]),
    'B3 evidence successor does not directly follow the application checkpoint',
  );
  const changed = (await invokeGit(
    runGit,
    absoluteRoot,
    ['diff', '--name-only', '--no-renames', testedApplicationCommit, head, '--'],
  )).trim().split('\n').filter(Boolean);
  exactPathSet(changed, B3_FINAL_PROOF_OUTPUT_PATHS, 'B3 successor contains non-evidence changes');
  return Object.freeze({ mode: 'complete', testedApplicationCommit });
}

async function readLiveApplicationAuthority(root) {
  const input = await readBoundedInput(root, INPUT_PATHS.cloudflare);
  const commit = input.value?.testedApplicationCommit;
  const fingerprint = input.value?.applicationFingerprint;
  assert(COMMIT.test(commit ?? '') && HASH.test(fingerprint ?? ''), 'Live application authority is invalid');
  return Object.freeze({ commit, fingerprint });
}

async function checkCompleteReport(root, authority) {
  const report = await buildB3ExitReport({
    root,
    expectedApplicationCommit: authority.commit,
    expectedApplicationFingerprint: authority.fingerprint,
  });
  const expected = serialise(report);
  const actual = await readBoundedInput(root, EXIT_PATH, { json: false });
  assert(actual.bytes.equals(expected), 'B3 exit report bytes do not strictly regenerate');
  return report;
}

async function main() {
  const [mode, ...unexpected] = process.argv.slice(2);
  if (unexpected.length > 0 || !['--write', '--check-ci'].includes(mode)) {
    fail('b3_exit_usage', 'Usage: build-b3-exit-report.mjs --write | --check-ci');
  }
  const operation = mode === '--write' ? 'write' : 'check-ci';
  const topology = await checkB3LiveEvidenceTopology({ root: ROOT, operation });
  if (topology.mode === 'pending') {
    await verifyB2Authority({ root: ROOT });
    const fingerprint = await fingerprintB3Application({ root: ROOT });
    return Object.freeze({
      ok: true,
      mode: 'pending',
      testedApplicationCommit: topology.testedApplicationCommit,
      applicationFingerprint: fingerprint.sha256,
    });
  }
  const authority = await readLiveApplicationAuthority(ROOT);
  assert(
    authority.commit === topology.testedApplicationCommit,
    'Live application commit differs from the Git checkpoint',
  );
  const report = mode === '--write'
    ? await buildB3ExitReport({
        root: ROOT,
        expectedApplicationCommit: authority.commit,
        expectedApplicationFingerprint: authority.fingerprint,
      })
    : await checkCompleteReport(ROOT, authority);
  if (mode === '--write') {
    await publishB3FinalProofOutput({ root: ROOT, output: EXIT_PATH, bytes: serialise(report) });
  }
  return Object.freeze({
    ok: true,
    mode: mode === '--write' ? 'write' : 'complete',
    testedApplicationCommit: report.testedApplicationCommit,
    applicationFingerprint: report.applicationFingerprint,
  });
}

if (isMain(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(await main())}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error?.code ?? 'b3_exit_failed',
      message: redactText(error?.message ?? 'B3 exit verification failed'),
    })}\n`);
    process.exitCode = 1;
  }
}
