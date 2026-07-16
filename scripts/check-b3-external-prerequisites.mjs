import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { runPinnedSystemGit } from './lib/pinned-system-git.mjs';
import { parseJsonWithoutDuplicateMembers } from '../src/domain/packs/signed-manifest-contract.js';

const DEFAULT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLOUDFLARE_GATES = Object.freeze([
  'cloudflareOAuth',
  'cloudflareWorker',
  'cloudflarePrivateR2',
  'cloudflareBindings',
  'cloudflareSecretNames',
]);
const SAFE_ENV_FILE_ARGS = Object.freeze(['--env-file', '/dev/null']);
const LOWERCASE_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INSPECTION_FAILURE_GATES = Symbol('inspectionFailureGates');
const MAXIMUM_OPERATOR_JSON_BYTES = 1024 * 1024;
export const B3_RUN_AUTHORITY_PLAN_COMMIT =
  '7f681f886ee1b627d574641a4a23add9d98796d2';
export const B3_RUN_AUTHORITY_MAX_LIFETIME_MS = 24 * 60 * 60 * 1_000;

export const B3_REQUIRED_EXTERNAL_GATES = Object.freeze([
  'appleAgreements',
  'appleProduct',
  'appleSandboxTesterContexts',
  'appleServerKeySecretName',
  'applePhysicalDevice',
  'appleSignedArtefact',
  'googleMerchant',
  'googleProduct',
  'googleServiceAccountSecretName',
  'googleInternalTrack',
  'googleLicenceTester',
  'googlePlayCertifiedDevice',
  'googlePlayAppSigningCertificateSha256',
  ...CLOUDFLARE_GATES,
  'remoteMutationApprovals',
]);

export const B3_REMOTE_MUTATION_SCOPES = Object.freeze([
  'cloudflare-deploy',
  'apple-signed-distribution',
  'apple-sandbox-history-refund',
  'google-test-track-refund-revoke',
]);

const REQUIRED_BINDING_NAMES = Object.freeze([
  'GATEWAY_RATE_LIMIT',
  'PACKS',
  'WORKER_VERSION_METADATA',
]);
const REQUIRED_BINDING_TYPES = Object.freeze({
  GATEWAY_RATE_LIMIT: 'ratelimit',
  PACKS: 'r2_bucket',
  WORKER_VERSION_METADATA: 'version_metadata',
});

const REQUIRED_SECRET_NAMES = Object.freeze([
  'APPLE_IAP_ISSUER_ID',
  'APPLE_IAP_KEY_ID',
  'APPLE_IAP_PRIVATE_KEY',
  'ENTITLEMENT_HANDLE_KEY_CURRENT',
  'ENTITLEMENT_HANDLE_KEY_PREVIOUS',
  'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON',
  'R2_CAPABILITY_HMAC_KEY',
]);

const IDENTIFIER_GATES = new Set([
  'appleAgreements',
  'appleProduct',
  'appleServerKeySecretName',
  'applePhysicalDevice',
  'appleSignedArtefact',
  'googleMerchant',
  'googleProduct',
  'googleServiceAccountSecretName',
  'googleInternalTrack',
  'googleLicenceTester',
  'googlePlayCertifiedDevice',
  'googlePlayAppSigningCertificateSha256',
  'cloudflareOAuth',
  'cloudflareWorker',
  'cloudflarePrivateR2',
]);

function hasExactKeys(value, expectedKeys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    isDeepStrictEqual(Object.keys(value).sort(), [...expectedKeys].sort())
  );
}

function isIdentifier(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  );
}

function isApprovedIdentifierRecord(value) {
  return (
    hasExactKeys(value, ['approved', 'identifier']) &&
    value.approved === true &&
    isIdentifier(value.identifier)
  );
}

function isExactStringSet(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((entry) => typeof entry === 'string') &&
    new Set(actual).size === actual.length &&
    isDeepStrictEqual([...actual].sort(), [...expected].sort())
  );
}

function isApprovedIdentifiersRecord(value, expectedIdentifiers) {
  return (
    hasExactKeys(value, ['approved', 'identifiers']) &&
    value.approved === true &&
    isExactStringSet(value.identifiers, expectedIdentifiers)
  );
}

function isSandboxContextsRecord(value) {
  return (
    hasExactKeys(value, ['approved', 'identifiers']) &&
    value.approved === true &&
    Array.isArray(value.identifiers) &&
    value.identifiers.length >= 2 &&
    value.identifiers.every(isIdentifier) &&
    new Set(value.identifiers).size === value.identifiers.length
  );
}

function isScopesRecord(value) {
  return (
    hasExactKeys(value, ['approved', 'scopes']) &&
    value.approved === true &&
    isExactStringSet(value.scopes, B3_REMOTE_MUTATION_SCOPES)
  );
}

function isWithin(root, path) {
  const fromRoot = relative(root, path);
  return (
    fromRoot === '' ||
    (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
  );
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function operatorSnapshot(stats) {
  return Object.freeze({
    dev: stats.dev,
    ino: stats.ino,
    uid: stats.uid,
    gid: stats.gid,
    mode: stats.mode,
    nlink: stats.nlink,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  });
}

function assertSecureOperatorStats(stats) {
  if (
    !stats.isFile() ||
    (typeof process.getuid === 'function' && stats.uid !== BigInt(process.getuid())) ||
    (stats.mode & 0o077n) !== 0n ||
    stats.nlink !== 1n
  ) {
    throw new Error('operator file failed secure validation');
  }
}

export async function runSafeGitPolicyCommand(
  args,
  root,
  { execFileImpl, gitStatReader } = {},
) {
  return runPinnedSystemGit(args, {
    root,
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    execFileImpl,
    gitStatReader,
  });
}

async function defaultGitRunner(args, root) {
  try {
    await runSafeGitPolicyCommand(args, root);
    return 0;
  } catch (error) {
    return Number.isInteger(error.code) ? error.code : 128;
  }
}

async function validateOperatorPathPolicy({ requestedPath, root, gitRunner }) {
  const [absoluteRoot, canonicalPath] = await Promise.all([
    realpath(resolve(root)),
    realpath(requestedPath),
  ]);
  if (isWithin(absoluteRoot, canonicalPath)) {
    const relativePath = relative(absoluteRoot, canonicalPath).split(sep).join('/');
    if (
      (await gitRunner(['ls-files', '--error-unmatch', '--', relativePath], absoluteRoot)) === 0 ||
      (await gitRunner(['check-ignore', '-q', '--', relativePath], absoluteRoot)) !== 0
    ) {
      throw new Error('operator file failed secure validation');
    }
  }
  return canonicalPath;
}

export async function readValidatedB3OperatorFile({
  path,
  root = DEFAULT_ROOT,
  gitRunner = defaultGitRunner,
  afterPolicyHook,
  maximumBytes = MAXIMUM_OPERATOR_JSON_BYTES,
} = {}) {
  if (!isIdentifier(path) || typeof constants.O_NOFOLLOW !== 'number' ||
      !Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error('operator file failed secure validation');
  }
  const requestedPath = resolve(path);
  let handle;
  try {
    handle = await open(requestedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const initial = await handle.stat({ bigint: true });
    const initialPath = await lstat(requestedPath, { bigint: true });
    assertSecureOperatorStats(initial);
    if (initial.size <= 0n || initial.size > BigInt(maximumBytes)) {
      throw new Error('operator file failed secure validation');
    }
    if (
      initialPath.isSymbolicLink() ||
      !sameFile(initial, initialPath)
    ) {
      throw new Error('operator file failed secure validation');
    }
    const initialSnapshot = operatorSnapshot(initial);
    const canonicalPath = await validateOperatorPathPolicy({ requestedPath, root, gitRunner });

    await afterPolicyHook?.();
    const bytes = Buffer.allocUnsafe(Number(initial.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Error('operator file changed during validation');
      offset += bytesRead;
    }
    const trailing = Buffer.allocUnsafe(1);
    if ((await handle.read(trailing, 0, 1, bytes.length)).bytesRead !== 0) {
      throw new Error('operator file changed during validation');
    }
    const [finalHandle, finalPath] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(requestedPath, { bigint: true }),
    ]);
    let finalCanonicalPath;
    try {
      assertSecureOperatorStats(finalHandle);
      finalCanonicalPath = await validateOperatorPathPolicy({
        requestedPath,
        root,
        gitRunner,
      });
    } catch {
      throw new Error('operator file changed during validation');
    }
    if (
      finalPath.isSymbolicLink() ||
      !sameFile(initial, finalHandle) ||
      !sameFile(initial, finalPath) ||
      !isDeepStrictEqual(initialSnapshot, operatorSnapshot(finalHandle)) ||
      finalCanonicalPath !== canonicalPath
    ) {
      throw new Error('operator file changed during validation');
    }
    return { bytes, canonicalPath, snapshot: initialSnapshot };
  } catch (error) {
    if (error?.message === 'operator file changed during validation') throw error;
    throw new Error('operator file failed secure validation');
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function validateB3ApprovalFilePolicy({
  approvalFile,
  root = DEFAULT_ROOT,
  gitRunner = defaultGitRunner,
} = {}) {
  try {
    await readValidatedB3OperatorFile({ path: approvalFile, root, gitRunner });
    return true;
  } catch {
    return false;
  }
}

export async function validateB3RunAuthorityFilePolicy({
  root = DEFAULT_ROOT,
  gitRunner = defaultGitRunner,
} = {}) {
  try {
    await readValidatedB3RunAuthority({ root, gitRunner });
    return true;
  } catch {
    return false;
  }
}

async function readValidatedB3RunAuthority({ root, gitRunner }) {
  const canonicalRoot = await realpath(resolve(root));
  const expectedPath = resolve(canonicalRoot, '.native-build/b3/run-authority.json');
  const record = await readValidatedB3OperatorFile({
    path: resolve(root, '.native-build/b3/run-authority.json'),
    root,
    gitRunner,
  });
  if (record.canonicalPath !== expectedPath) {
    throw new Error('run authority is not at the exact canonical fixed path');
  }
  return record;
}

export function parseB3StrictJsonBytes(bytes, label = 'B3 operator JSON') {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 1024 * 1024) {
    throw new Error(`${label} has invalid byte length`);
  }
  return parseJsonWithoutDuplicateMembers(bytes, label);
}

export async function readValidatedB3OperatorJson({ path, label, root = DEFAULT_ROOT, gitRunner } = {}) {
  const record = await readValidatedB3OperatorFile({ path, root, gitRunner });
  return Object.freeze({ ...record, value: parseB3StrictJsonBytes(record.bytes, label) });
}

export async function validateB3LocalMutationAuthority({
  approvalFile,
  runToken,
  requestedScope,
  root = DEFAULT_ROOT,
  gitRunner = defaultGitRunner,
  clock = () => new Date(),
} = {}) {
  if (!B3_REMOTE_MUTATION_SCOPES.includes(requestedScope)) {
    throw new Error('requested B3 remote mutation scope is invalid');
  }
  const approvalRecord = await readValidatedB3OperatorJson({
    path: approvalFile,
    label: 'B3 prerequisite approval',
    root,
    gitRunner,
  });
  const runRecordRaw = await readValidatedB3RunAuthority({ root, gitRunner });
  const runAuthority = parseB3StrictJsonBytes(runRecordRaw.bytes, 'B3 run authority');
  const approval = approvalRecord.value;
  if (!hasExactKeys(approval, ['schemaVersion', 'gates']) || approval.schemaVersion !== 1 ||
      !hasExactKeys(approval.gates, B3_REQUIRED_EXTERNAL_GATES) ||
      !B3_REQUIRED_EXTERNAL_GATES.every((name) => validateLocalGate(name, approval.gates[name])) ||
      !approval.gates.remoteMutationApprovals.scopes.includes(requestedScope) ||
      !validRunToken(runAuthority, runToken, clock)) {
    throw new Error('B3 local mutation authority is invalid or expired');
  }
  const [finalApproval, finalRunRaw] = await Promise.all([
    readValidatedB3OperatorJson({ path: approvalFile, label: 'B3 prerequisite approval', root, gitRunner }),
    readValidatedB3RunAuthority({ root, gitRunner }),
  ]);
  const finalRun = parseB3StrictJsonBytes(finalRunRaw.bytes, 'B3 run authority');
  if (!approvalRecord.bytes.equals(finalApproval.bytes) ||
      !isDeepStrictEqual(approvalRecord.snapshot, finalApproval.snapshot) ||
      !runRecordRaw.bytes.equals(finalRunRaw.bytes) ||
      !isDeepStrictEqual(runRecordRaw.snapshot, finalRunRaw.snapshot) ||
      !isDeepStrictEqual(runAuthority, finalRun) || !validRunToken(finalRun, runToken, clock)) {
    throw new Error('B3 local mutation authority changed during validation');
  }
  return Object.freeze({
    status: 'pass',
    scope: requestedScope,
    approvedPlayCertificateSha256:
      approval.gates.googlePlayAppSigningCertificateSha256.identifier,
  });
}

export async function readApprovedB3PlayCertificate({ approvalFile, root = DEFAULT_ROOT, gitRunner } = {}) {
  const record = await readValidatedB3OperatorJson({
    path: approvalFile,
    label: 'B3 prerequisite approval',
    root,
    gitRunner,
  });
  const value = record.value?.gates?.googlePlayAppSigningCertificateSha256;
  if (!isApprovedIdentifierRecord(value) || !/^[0-9a-f]{64}$/u.test(value.identifier)) {
    throw new Error('approved Play App Signing certificate authority is invalid');
  }
  return value.identifier;
}

function validateLocalGate(name, value) {
  if (IDENTIFIER_GATES.has(name)) {
    if (!isApprovedIdentifierRecord(value)) return false;
    if (name === 'appleProduct') return value.identifier === 'uk.eugnel.ks2spelling.fullks2';
    if (name === 'googleProduct') return value.identifier === 'full_ks2';
    if (name === 'appleServerKeySecretName') return value.identifier === 'APPLE_IAP_PRIVATE_KEY';
    if (name === 'googleServiceAccountSecretName') {
      return value.identifier === 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON';
    }
    if (name === 'googlePlayAppSigningCertificateSha256') {
      return /^[0-9a-f]{64}$/u.test(value.identifier);
    }
    if (name === 'cloudflareOAuth') return /^[0-9a-f]{32}$/u.test(value.identifier);
    if (name === 'cloudflareWorker') return value.identifier === 'ks2-spelling-b3-sandbox';
    if (name === 'cloudflarePrivateR2') {
      return value.identifier === 'ks2-spelling-b3-sandbox-packs';
    }
    return true;
  }
  if (name === 'appleSandboxTesterContexts') return isSandboxContextsRecord(value);
  if (name === 'cloudflareBindings') {
    return isApprovedIdentifiersRecord(value, REQUIRED_BINDING_NAMES);
  }
  if (name === 'cloudflareSecretNames') {
    return isApprovedIdentifiersRecord(value, REQUIRED_SECRET_NAMES);
  }
  if (name === 'remoteMutationApprovals') return isScopesRecord(value);
  return false;
}

function block(gates) {
  return {
    status: 'blocked-external',
    gates: B3_REQUIRED_EXTERNAL_GATES.filter((gate) => gates.includes(gate)),
  };
}

function canonicalUtcMilliseconds(value) {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value ? null : parsed;
}

function validRunToken(runAuthority, runToken, clock) {
  if (
    !hasExactKeys(runAuthority, [
      'schemaVersion',
      'runToken',
      'issuedAt',
      'expiresAt',
      'planCommit',
    ]) ||
    runAuthority.schemaVersion !== 1 ||
    runAuthority.planCommit !== B3_RUN_AUTHORITY_PLAN_COMMIT ||
    !/^[0-9a-f]{64}$/u.test(runAuthority.runToken) ||
    !/^[0-9a-f]{64}$/u.test(runToken ?? '')
  ) {
    return false;
  }
  const issuedAt = canonicalUtcMilliseconds(runAuthority.issuedAt);
  const expiresAt = canonicalUtcMilliseconds(runAuthority.expiresAt);
  const now = clock();
  if (
    !issuedAt ||
    !expiresAt ||
    !(now instanceof Date) ||
    Number.isNaN(now.getTime()) ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > B3_RUN_AUTHORITY_MAX_LIFETIME_MS ||
    now < issuedAt ||
    now >= expiresAt
  ) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(runAuthority.runToken, 'hex'),
    Buffer.from(runToken, 'hex'),
  );
}

function validateRemoteState(remoteState, request) {
  if (
    !hasExactKeys(remoteState, [
      'oauthAvailable',
      'accountId',
      'workerName',
      'privateR2BucketName',
      'bindingNames',
      'bindingTypes',
      'boundR2BucketName',
      'versionSecretNames',
      'secretNames',
      'r2DevUrlPublicAccess',
      'hasCustomDomains',
    ])
  ) {
    return CLOUDFLARE_GATES;
  }
  const failures = [];
  if (remoteState.oauthAvailable !== true || remoteState.accountId !== request.accountId) {
    failures.push('cloudflareOAuth');
  }
  if (remoteState.workerName !== request.workerName) failures.push('cloudflareWorker');
  if (remoteState.privateR2BucketName !== request.privateR2BucketName) {
    failures.push('cloudflarePrivateR2');
  }
  if (!isExactStringSet(remoteState.bindingNames, request.bindingNames)) {
    failures.push('cloudflareBindings');
  }
  if (!isDeepStrictEqual(remoteState.bindingTypes, REQUIRED_BINDING_TYPES)) {
    if (!failures.includes('cloudflareBindings')) failures.push('cloudflareBindings');
  }
  if (remoteState.boundR2BucketName !== request.privateR2BucketName) {
    failures.push('cloudflarePrivateR2');
    if (!failures.includes('cloudflareBindings')) failures.push('cloudflareBindings');
  }
  if (
    !isExactStringSet(remoteState.versionSecretNames, request.secretNames) ||
    !isExactStringSet(remoteState.secretNames, request.secretNames) ||
    !isExactStringSet(remoteState.secretNames, remoteState.versionSecretNames)
  ) {
    failures.push('cloudflareSecretNames');
  }
  if (
    remoteState.r2DevUrlPublicAccess !== false ||
    remoteState.hasCustomDomains !== false
  ) {
    failures.push('cloudflarePrivateR2');
  }
  return failures;
}

function parseWranglerJson(result) {
  if (
    !result ||
    result.exitCode !== 0 ||
    typeof result.stdout !== 'string' ||
    result.stderr !== ''
  ) {
    throw new Error('Cloudflare OAuth inspection unavailable');
  }
  try {
    return parseB3StrictJsonBytes(Buffer.from(result.stdout, 'utf8'), 'Cloudflare OAuth inspection');
  } catch {
    throw new Error('Cloudflare OAuth inspection unavailable');
  }
}

function readWranglerText(result) {
  if (
    !result ||
    result.exitCode !== 0 ||
    typeof result.stdout !== 'string' ||
    result.stderr !== ''
  ) {
    throw new Error('Cloudflare OAuth inspection unavailable');
  }
  return result.stdout;
}

function privateR2InspectionError() {
  const error = new Error('Cloudflare OAuth inspection unavailable');
  error[INSPECTION_FAILURE_GATES] = Object.freeze(['cloudflarePrivateR2']);
  return error;
}

async function readR2PrivacySnapshot(run, request, accountContext) {
  const bucket = parseWranglerJson(
    await run(
      ['r2', 'bucket', 'info', request.privateR2BucketName, '--json'],
      accountContext,
    ),
  );
  const privateR2BucketName = bucket?.name ?? bucket?.bucket?.name;
  if (!isIdentifier(privateR2BucketName)) {
    throw new Error('Cloudflare OAuth inspection unavailable');
  }
  if (privateR2BucketName !== request.privateR2BucketName) throw privateR2InspectionError();

  const devUrlOutput = readWranglerText(
    await run(
      ['r2', 'bucket', 'dev-url', 'get', request.privateR2BucketName],
      accountContext,
    ),
  );
  let r2DevUrlPublicAccess;
  if (devUrlOutput === 'Public access via the r2.dev URL is disabled.\n') {
    r2DevUrlPublicAccess = false;
  } else {
    r2DevUrlPublicAccess = true;
  }

  const domainsOutput = readWranglerText(
    await run(
      ['r2', 'bucket', 'domain', 'list', request.privateR2BucketName],
      accountContext,
    ),
  );
  const domainsPrefix =
    `Listing custom domains connected to bucket '${request.privateR2BucketName}'...\n`;
  const noDomainsOutput =
    `${domainsPrefix}There are no custom domains connected to this bucket.\n`;
  let hasCustomDomains;
  if (domainsOutput === noDomainsOutput) {
    hasCustomDomains = false;
  } else if (domainsOutput.startsWith(domainsPrefix)) {
    hasCustomDomains = true;
  } else {
    throw new Error('Cloudflare OAuth inspection unavailable');
  }

  return Object.freeze({
    privateR2BucketName,
    r2DevUrlPublicAccess,
    hasCustomDomains,
  });
}

function assertPrivateR2Snapshot(snapshot) {
  if (snapshot.r2DevUrlPublicAccess || snapshot.hasCustomDomains) {
    throw privateR2InspectionError();
  }
}

async function readActiveDeployment(run, request, accountContext) {
  const deployment = parseWranglerJson(
    await run(
      ['deployments', 'status', '--name', request.workerName, '--json'],
      accountContext,
    ),
  );
  if (!deployment || typeof deployment !== 'object' || Array.isArray(deployment)) {
    throw new Error('Cloudflare OAuth inspection unavailable');
  }
  const deploymentId = deployment?.id ?? deployment?.deployment_id ?? deployment?.deploymentId;
  const versions = deployment?.versions;
  const activeVersion =
    Array.isArray(versions) &&
    versions.length === 1 &&
    versions[0]?.percentage === 100
      ? versions[0]
      : null;
  const versionId = activeVersion?.version_id ?? activeVersion?.versionId;
  if (!isIdentifier(deploymentId) || typeof versionId !== 'string' || !LOWERCASE_UUID_V4.test(versionId)) {
    throw new Error('Cloudflare OAuth inspection unavailable');
  }
  return Object.freeze({ deploymentId, versionId });
}

function objectArray(value, field) {
  const array = Array.isArray(value) ? value : value?.[field];
  if (!Array.isArray(array) || array.some((entry) => !entry || typeof entry !== 'object')) {
    throw new Error('Cloudflare OAuth inspection unavailable');
  }
  return array;
}

function exactUniqueNames(entries, { requiredType } = {}) {
  const names = [];
  for (const entry of entries) {
    if (
      !isIdentifier(entry.name) ||
      !isIdentifier(entry.type) ||
      (requiredType !== undefined && entry.type !== requiredType) ||
      names.includes(entry.name)
    ) {
      throw new Error('Cloudflare OAuth inspection unavailable');
    }
    names.push(entry.name);
  }
  return names;
}

function isEnvFileArgument(entry) {
  return (
    typeof entry === 'string' &&
    (entry === '--env-file' || entry.startsWith('--env-file='))
  );
}

function withSafeEnvFile(args) {
  if (
    !Array.isArray(args) ||
    args.some((entry) => typeof entry !== 'string') ||
    args.some(isEnvFileArgument) ||
    !['darwin', 'linux'].includes(process.platform)
  ) {
    throw new Error('Cloudflare OAuth inspection unavailable');
  }
  return [...args, ...SAFE_ENV_FILE_ARGS];
}

export function createCloudflareRemoteInspector({ commandRunner }) {
  if (typeof commandRunner !== 'function') {
    throw new TypeError('commandRunner must be a function');
  }
  return async (request) => {
    const run = (args, context) => commandRunner(withSafeEnvFile(args), context);
    const whoami = parseWranglerJson(await run(['whoami', '--json']));
    if (whoami?.authType !== 'OAuth Token') {
      throw new Error('Cloudflare OAuth inspection unavailable');
    }
    const accountIds = objectArray(whoami, 'accounts').map(
      (entry) => entry.id ?? entry.accountId ?? entry.account_id,
    );
    if (!accountIds.includes(request.accountId)) {
      throw new Error('Cloudflare OAuth inspection unavailable');
    }
    const accountContext = Object.freeze({ accountId: request.accountId });

    const initialDeployment = await readActiveDeployment(run, request, accountContext);

    const version = parseWranglerJson(
      await run(
        [
          'versions',
          'view',
          initialDeployment.versionId,
          '--name',
          request.workerName,
          '--json',
        ],
        accountContext,
      ),
    );
    const bindings = objectArray(version?.resources?.bindings ?? version?.bindings, 'bindings');
    exactUniqueNames(bindings);
    const ordinaryBindings = bindings
      .filter((entry) => entry.type !== 'secret_text')
      .sort((left, right) => left.name.localeCompare(right.name));
    const bindingNames = ordinaryBindings.map((entry) => entry.name);
    const bindingTypes = Object.fromEntries(
      ordinaryBindings.map((entry) => [entry.name, entry.type]),
    );
    const packsBinding = ordinaryBindings.find((entry) => entry.name === 'PACKS');
    if (
      packsBinding?.type !== 'r2_bucket' ||
      !isIdentifier(packsBinding.bucket_name)
    ) {
      throw new Error('Cloudflare OAuth inspection unavailable');
    }
    const boundR2BucketName = packsBinding.bucket_name;
    const versionSecretNames = bindings
      .filter((entry) => entry.type === 'secret_text')
      .map((entry) => entry.name)
      .sort();

    const initialPrivacy = await readR2PrivacySnapshot(run, request, accountContext);
    assertPrivateR2Snapshot(initialPrivacy);

    const secrets = objectArray(
      parseWranglerJson(
        await run(
          ['secret', 'list', '--name', request.workerName, '--format', 'json'],
          accountContext,
        ),
      ),
      'secrets',
    );
    const secretNames = exactUniqueNames(secrets, { requiredType: 'secret_text' }).sort();
    const finalDeployment = await readActiveDeployment(run, request, accountContext);
    if (!isDeepStrictEqual(finalDeployment, initialDeployment)) {
      throw new Error('Cloudflare OAuth inspection unavailable');
    }
    const finalPrivacy = await readR2PrivacySnapshot(run, request, accountContext);
    if (!isDeepStrictEqual(finalPrivacy, initialPrivacy)) {
      throw privateR2InspectionError();
    }
    assertPrivateR2Snapshot(finalPrivacy);

    return {
      oauthAvailable: true,
      accountId: request.accountId,
      workerName: request.workerName,
      privateR2BucketName: initialPrivacy.privateR2BucketName,
      bindingNames,
      bindingTypes,
      boundR2BucketName,
      versionSecretNames,
      secretNames,
      r2DevUrlPublicAccess: initialPrivacy.r2DevUrlPublicAccess,
      hasCustomDomains: initialPrivacy.hasCustomDomains,
    };
  };
}

export async function defaultWranglerSpawn(command, args, options) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio,
      windowsHide: options.windowsHide,
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const terminateGroup = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(terminateGroup, options.timeout);
    const append = (current, chunk) => {
      const next = current + chunk.toString('utf8');
      if (Buffer.byteLength(next) > options.maxBuffer) terminateGroup();
      return next;
    };
    child.stdout?.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({ exitCode, stdout, stderr });
    };
    child.on('error', () => finish(1));
    child.on('close', (code) => finish(code ?? 1));
  });
}

export async function runOAuthSafeWrangler(
  args,
  {
    root = DEFAULT_ROOT,
    env = process.env,
    accountId,
    spawnRunner = defaultWranglerSpawn,
  } = {},
) {
  const wranglerPath = resolve(root, 'gateway/node_modules/wrangler/bin/wrangler.js');
  const wranglerPackagePath = resolve(root, 'gateway/node_modules/wrangler/package.json');
  try {
    const [scriptStats, packageStats] = await Promise.all([
      lstat(wranglerPath),
      lstat(wranglerPackagePath),
    ]);
    if (
      !scriptStats.isFile() ||
      scriptStats.isSymbolicLink() ||
      !packageStats.isFile() ||
      packageStats.isSymbolicLink()
    ) {
      throw new Error('local Wrangler unavailable');
    }
    const packageJson = parseB3StrictJsonBytes(await readFile(wranglerPackagePath), 'local Wrangler package');
    if (packageJson?.version !== '4.110.0') throw new Error('local Wrangler unavailable');
  } catch {
    return { exitCode: 1, stdout: '', stderr: '' };
  }

  const childEnv = {
    HOME: env.HOME,
    PATH: env.PATH,
    TMPDIR: env.TMPDIR,
    CI: '1',
    NO_COLOR: '1',
    CLOUDFLARE_SEND_METRICS: 'false',
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    CLOUDFLARE_AUTH_USE_KEYRING: 'false',
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
    CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false',
    WRANGLER_HIDE_BANNER: 'true',
  };
  if (accountId !== undefined) {
    if (!/^[0-9a-f]{32}$/u.test(accountId)) {
      return { exitCode: 1, stdout: '', stderr: '' };
    }
    childEnv.CLOUDFLARE_ACCOUNT_ID = accountId;
  }
  let safeArgs;
  try {
    const envFileArguments = args.filter(isEnvFileArgument);
    const hasExactSafeSuffix =
      envFileArguments.length === 1 &&
      envFileArguments[0] === '--env-file' &&
      args.at(-2) === SAFE_ENV_FILE_ARGS[0] &&
      args.at(-1) === SAFE_ENV_FILE_ARGS[1];
    safeArgs = hasExactSafeSuffix ? args : withSafeEnvFile(args);
  } catch {
    return { exitCode: 1, stdout: '', stderr: '' };
  }
  return spawnRunner(process.execPath, [wranglerPath, ...safeArgs], {
    cwd: root,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
}

export async function checkB3ExternalPrerequisites({
  approvalFile,
  runToken,
  remoteInspector,
  root = DEFAULT_ROOT,
  gitRunner,
  clock = () => new Date(),
} = {}) {
  let approvalRecord;
  try {
    approvalRecord = await readValidatedB3OperatorFile({
      path: approvalFile,
      root,
      gitRunner,
    });
  } catch {
    return block(B3_REQUIRED_EXTERNAL_GATES);
  }
  let approval;
  try {
    approval = parseB3StrictJsonBytes(approvalRecord.bytes, 'B3 prerequisite approval');
  } catch {
    return block(B3_REQUIRED_EXTERNAL_GATES);
  }
  if (!hasExactKeys(approval, ['schemaVersion', 'gates']) || approval.schemaVersion !== 1) {
    return block(B3_REQUIRED_EXTERNAL_GATES);
  }
  if (!hasExactKeys(approval.gates, B3_REQUIRED_EXTERNAL_GATES)) {
    return block(B3_REQUIRED_EXTERNAL_GATES);
  }

  const missing = B3_REQUIRED_EXTERNAL_GATES.filter(
    (name) => !validateLocalGate(name, approval.gates[name]),
  );
  let runAuthorityRecord = null;
  let runAuthority = null;
  try {
    runAuthorityRecord = await readValidatedB3RunAuthority({ root, gitRunner });
    runAuthority = parseB3StrictJsonBytes(runAuthorityRecord.bytes, 'B3 run authority');
  } catch {
    // The named gate below remains the only public diagnostic.
  }
  if (
    !validRunToken(runAuthority, runToken, clock) &&
    !missing.includes('remoteMutationApprovals')
  ) {
    missing.push('remoteMutationApprovals');
  }
  if (missing.length > 0) return block(missing);

  if (typeof remoteInspector !== 'function') return block(CLOUDFLARE_GATES);
  const request = Object.freeze({
    accountId: approval.gates.cloudflareOAuth.identifier,
    workerName: approval.gates.cloudflareWorker.identifier,
    privateR2BucketName: approval.gates.cloudflarePrivateR2.identifier,
    bindingNames: REQUIRED_BINDING_NAMES,
    secretNames: REQUIRED_SECRET_NAMES,
  });
  try {
    const inspected = await remoteInspector(request);
    let finalApprovalRecord;
    try {
      finalApprovalRecord = await readValidatedB3OperatorFile({
        path: approvalFile,
        root,
        gitRunner,
      });
    } catch {
      return block(B3_REQUIRED_EXTERNAL_GATES);
    }
    let finalApproval;
    try {
      finalApproval = parseB3StrictJsonBytes(finalApprovalRecord.bytes, 'B3 prerequisite approval');
    } catch {
      return block(B3_REQUIRED_EXTERNAL_GATES);
    }
    if (
      !hasExactKeys(finalApproval, ['schemaVersion', 'gates']) ||
      finalApproval.schemaVersion !== 1 ||
      !hasExactKeys(finalApproval.gates, B3_REQUIRED_EXTERNAL_GATES)
    ) {
      return block(B3_REQUIRED_EXTERNAL_GATES);
    }
    const finalMissing = B3_REQUIRED_EXTERNAL_GATES.filter(
      (name) => !validateLocalGate(name, finalApproval.gates[name]),
    );
    const changedGates = B3_REQUIRED_EXTERNAL_GATES.filter(
      (name) => !isDeepStrictEqual(approval.gates[name], finalApproval.gates[name]),
    );
    if (finalMissing.length > 0 || changedGates.length > 0) {
      return block([...finalMissing, ...changedGates]);
    }
    if (
      approvalRecord.canonicalPath !== finalApprovalRecord.canonicalPath ||
      !isDeepStrictEqual(approvalRecord.snapshot, finalApprovalRecord.snapshot) ||
      !approvalRecord.bytes.equals(finalApprovalRecord.bytes) ||
      !isDeepStrictEqual(approval, finalApproval)
    ) {
      return block(B3_REQUIRED_EXTERNAL_GATES);
    }
    let finalRunAuthorityRecord;
    try {
      finalRunAuthorityRecord = await readValidatedB3RunAuthority({ root, gitRunner });
    } catch {
      return block(['remoteMutationApprovals']);
    }
    let finalRunAuthority;
    try {
      finalRunAuthority = parseB3StrictJsonBytes(finalRunAuthorityRecord.bytes, 'B3 run authority');
    } catch {
      return block(['remoteMutationApprovals']);
    }
    if (
      !runAuthorityRecord.bytes.equals(finalRunAuthorityRecord.bytes) ||
      !isDeepStrictEqual(runAuthority, finalRunAuthority) ||
      !isDeepStrictEqual(runAuthorityRecord.snapshot, finalRunAuthorityRecord.snapshot) ||
      !validRunToken(finalRunAuthority, runToken, clock)
    ) {
      return block(['remoteMutationApprovals']);
    }
    const remoteFailures = validateRemoteState(inspected, request);
    return remoteFailures.length > 0
      ? block(remoteFailures)
      : { status: 'pass', gates: [...B3_REQUIRED_EXTERNAL_GATES] };
  } catch (error) {
    if (Array.isArray(error?.[INSPECTION_FAILURE_GATES])) {
      return block(error[INSPECTION_FAILURE_GATES]);
    }
    return block(CLOUDFLARE_GATES);
  }
}

export async function runB3PrerequisitesCli({
  env = process.env,
  root = DEFAULT_ROOT,
  stdout = process.stdout,
  remoteInspector,
  gitRunner,
  clock = () => new Date(),
} = {}) {
  const inspector =
    remoteInspector ??
    createCloudflareRemoteInspector({
      commandRunner: (args, context) =>
        runOAuthSafeWrangler(args, { root, env, accountId: context?.accountId }),
    });
  const result = await checkB3ExternalPrerequisites({
    approvalFile: env.B3_PREREQUISITES_FILE,
    runToken: env.B3_REMOTE_RUN_TOKEN,
    remoteInspector: inspector,
    root,
    gitRunner,
    clock,
  });
  stdout.write(`${JSON.stringify(result)}\n`);
  return result.status === 'pass' ? 0 : 6;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runB3PrerequisitesCli();
}
