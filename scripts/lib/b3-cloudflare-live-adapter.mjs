import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseJsonWithoutDuplicateMembers } from '../../src/domain/packs/signed-manifest-contract.js';

const WRANGLER_VERSION = '4.110.0';
const ACCOUNT_ID = '6d00cb4a0396c17ad6ba617bcbcaa45d';
const WORKER_NAME = 'ks2-spelling-b3-sandbox';
const BUCKET_NAME = 'ks2-spelling-b3-sandbox-packs';
const PLACEHOLDER = '0'.repeat(64);
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const MAX_MAIN_MODULE_BYTES = 2 * 1024 * 1024;
const MAX_DATA_MODULE_BYTES = 1024 * 1024;
const LOWERCASE_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const APPROVED_DER_MODULE = Object.freeze({
  name: 'b52cb02fd567e0359fe8fa4d4c41037970fe01b0-AppleRootCA-G3.der',
  size: 583,
  sha256: '63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179',
});
const VERSIONED_CONTENT_SOURCE_CONTRACT =
  '/accounts/${accountId}/workers/scripts/${scriptName}/content/v2?version=${versionId}';

function liveAdapterError(message) {
  const error = new Error(message);
  error.code = 'b3_cloudflare_live_adapter_invalid';
  return error;
}

async function assertRegularNonSymlink(path) {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw liveAdapterError(`pinned Wrangler ${WRANGLER_VERSION} is unavailable`);
  }
}

export async function validateB3PinnedWrangler({ root }) {
  const packagePath = resolve(root, 'gateway/node_modules/wrangler/package.json');
  const binPath = resolve(root, 'gateway/node_modules/wrangler/bin/wrangler.js');
  const lockPath = resolve(root, 'gateway/package-lock.json');
  const modulePath = resolve(root, 'gateway/node_modules/wrangler/wrangler-dist/cli.js');
  try {
    await Promise.all([
      assertRegularNonSymlink(packagePath),
      assertRegularNonSymlink(binPath),
      assertRegularNonSymlink(lockPath),
      assertRegularNonSymlink(modulePath),
    ]);
    const [packageDocument, lockDocument, wranglerSource] = await Promise.all([
      readFile(packagePath).then((bytes) => parseJsonWithoutDuplicateMembers(bytes, 'pinned Wrangler package')),
      readFile(lockPath).then((bytes) => parseJsonWithoutDuplicateMembers(bytes, 'pinned Wrangler lockfile')),
      readFile(modulePath, 'utf8'),
    ]);
    if (packageDocument?.version !== WRANGLER_VERSION ||
        lockDocument?.packages?.['node_modules/wrangler']?.version !== WRANGLER_VERSION ||
        wranglerSource.split(VERSIONED_CONTENT_SOURCE_CONTRACT).length - 1 !== 1) {
      throw liveAdapterError(`pinned Wrangler ${WRANGLER_VERSION} is unavailable`);
    }
  } catch (error) {
    if (error?.code === 'b3_cloudflare_live_adapter_invalid') throw error;
    throw liveAdapterError(`pinned Wrangler ${WRANGLER_VERSION} is unavailable`);
  }
  return Object.freeze({
    version: WRANGLER_VERSION,
    packagePath,
    binPath,
    lockPath,
    modulePath,
    versionedContentQueryContract: true,
  });
}

export function buildB3DerivedWranglerConfig({ accountId, mainModulePath, baseDirPath }) {
  if (accountId !== ACCOUNT_ID || typeof mainModulePath !== 'string' || mainModulePath.length === 0 ||
      typeof baseDirPath !== 'string' || baseDirPath.length === 0 ||
      mainModulePath !== resolve(baseDirPath, 'worker.mjs')) {
    throw liveAdapterError('derived Wrangler config authority is invalid');
  }
  return Object.freeze({
    name: WORKER_NAME,
    account_id: ACCOUNT_ID,
    main: mainModulePath,
    base_dir: baseDirPath,
    compatibility_date: '2026-07-12',
    compatibility_flags: ['nodejs_compat'],
    workers_dev: false,
    routes: [{ pattern: 'b3-gateway.eugnel.uk', custom_domain: true }],
    no_bundle: true,
    find_additional_modules: true,
    rules: [{ type: 'Data', globs: [APPROVED_DER_MODULE.name], fallthrough: false }],
    r2_buckets: [{ binding: 'PACKS', bucket_name: BUCKET_NAME, remote: true }],
    version_metadata: { binding: 'WORKER_VERSION_METADATA' },
    ratelimits: [{ name: 'GATEWAY_RATE_LIMIT', namespace_id: '1001', simple: { limit: 60, period: 60 } }],
  });
}

export function createB3SterileCloudflareEnvironment(parentEnv, { accountId }) {
  if (accountId !== ACCOUNT_ID) throw liveAdapterError('sterile Cloudflare account authority is invalid');
  const environment = {};
  for (const name of ['HOME', 'PATH', 'TMPDIR']) {
    if (typeof parentEnv?.[name] === 'string' && parentEnv[name]) environment[name] = parentEnv[name];
  }
  return Object.freeze({
    ...environment,
    CI: '1',
    NO_COLOR: '1',
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
    CLOUDFLARE_SEND_METRICS: 'false',
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
    CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false',
    WRANGLER_HIDE_BANNER: 'true',
  });
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function boundedCommand(command, args, options) {
  return new Promise((accept) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let overflow = false;
    let timedOut = false;
    let settled = false;
    const terminateGroup = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminateGroup();
    }, options.timeoutMs ?? 30_000);
    const consume = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_COMMAND_OUTPUT_BYTES) {
        overflow = true;
        terminateGroup();
      } else {
        target.push(chunk);
      }
    };
    child.stdout.on('data', consume(stdout));
    child.stderr.on('data', consume(stderr));
    child.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      accept({ exitCode: 1, stdout: '', stderr: '', overflow, timedOut });
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      accept({
        exitCode: overflow || timedOut ? 1 : (code ?? 1),
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        overflow,
        timedOut,
      });
    });
    child.stdin.end(options.input ?? null);
  });
}

function assertCommandSucceeded(result, operation) {
  if (!result || result.exitCode !== 0 || result.overflow === true || result.timedOut === true ||
      Buffer.byteLength(result.stdout ?? '', 'utf8') + Buffer.byteLength(result.stderr ?? '', 'utf8') > MAX_COMMAND_OUTPUT_BYTES) {
    throw liveAdapterError(`pinned Wrangler ${operation} failed`);
  }
}

async function validateTrackedWranglerConfig(root) {
  const path = resolve(root, 'gateway/wrangler.jsonc');
  await assertRegularNonSymlink(path);
  const actual = parseJsonWithoutDuplicateMembers(await readFile(path), 'tracked Wrangler config');
  const expected = {
    $schema: 'node_modules/wrangler/config-schema.json',
    name: WORKER_NAME,
    main: 'src/handler.js',
    compatibility_date: '2026-07-12',
    compatibility_flags: ['nodejs_compat'],
    rules: [{ type: 'Data', globs: ['**/*.der'], fallthrough: true }],
    workers_dev: false,
    r2_buckets: [{ binding: 'PACKS', bucket_name: BUCKET_NAME }],
    version_metadata: { binding: 'WORKER_VERSION_METADATA' },
    ratelimits: [{ name: 'GATEWAY_RATE_LIMIT', namespace_id: '1001', simple: { limit: 60, period: 60 } }],
  };
  if (!isDeepStrictEqual(actual, expected)) throw liveAdapterError('tracked Wrangler config has drifted');
  return path;
}

async function createPrivateSession(root) {
  const parent = resolve(root, '.native-build/b3');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const [parentStats, canonicalParent] = await Promise.all([lstat(parent), realpath(parent)]);
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink() || canonicalParent !== parent) {
    throw liveAdapterError('private Cloudflare session root is invalid');
  }
  const session = await mkdtemp(join(parent, 'cloudflare-live-'));
  const sessionStats = await lstat(session);
  if (!sessionStats.isDirectory() || sessionStats.isSymbolicLink() || (sessionStats.mode & 0o777) !== 0o700) {
    throw liveAdapterError('private Cloudflare session is invalid');
  }
  return session;
}

async function readDryRunOutput(outdir, placeholder) {
  const entries = await readdir(outdir, { withFileTypes: true });
  if (entries.some((entry) => entry.isSymbolicLink() || !entry.isFile() ||
      (entry.name !== 'handler.js' && entry.name !== 'handler.js.map' && entry.name !== 'README.md' && !entry.name.endsWith('.der')))) {
    throw liveAdapterError('Wrangler dry-run output contains an unapproved entry');
  }
  const mainEntry = entries.find((entry) => entry.isFile() && entry.name === 'handler.js');
  if (!mainEntry) throw liveAdapterError('Wrangler dry-run main module is missing');
  const mainBytes = await readFile(resolve(outdir, mainEntry.name));
  if (mainBytes.length > MAX_MAIN_MODULE_BYTES) throw liveAdapterError('Wrangler dry-run main module exceeded its bound');
  let source = mainBytes.toString('utf8').replace(/\r\n?/gu, '\n');
  const generatedExpressions = source.match(/["']0["']\.repeat\(64\)/gu) ?? [];
  const literalOccurrences = source.split(placeholder).length - 1;
  if (literalOccurrences === 0 && generatedExpressions.length === 1) {
    source = source.replace(generatedExpressions[0], JSON.stringify(placeholder));
  } else if (generatedExpressions.length !== 0) {
    throw liveAdapterError('Wrangler dry-run authority expression is ambiguous');
  }
  if (source.split(placeholder).length - 1 !== 1) {
    throw liveAdapterError('Wrangler dry-run must contain exactly one authority placeholder');
  }
  const dataModules = [];
  for (const entry of entries.filter((candidate) => candidate.isFile() && candidate.name.endsWith('.der'))) {
    const bytes = await readFile(resolve(outdir, entry.name));
    if (bytes.length === 0 || bytes.length > MAX_DATA_MODULE_BYTES) {
      throw liveAdapterError('Wrangler dry-run data module exceeded its bound');
    }
    dataModules.push(Object.freeze({ name: entry.name, bytes, size: bytes.length, sha256: sha256(bytes) }));
  }
  dataModules.sort((left, right) => left.name.localeCompare(right.name));
  if (dataModules.length !== 1 || dataModules[0].name !== APPROVED_DER_MODULE.name ||
      dataModules[0].size !== APPROVED_DER_MODULE.size || dataModules[0].sha256 !== APPROVED_DER_MODULE.sha256) {
    throw liveAdapterError('Wrangler dry-run data-module discovery differs from approved B3 authority');
  }
  return { source, dataModules };
}

async function assertIsolatedDeployBase(baseDirPath) {
  const entries = await readdir(baseDirPath, { withFileTypes: true });
  const expected = [APPROVED_DER_MODULE.name, 'worker.mjs'];
  if (entries.length !== expected.length || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink()) ||
      !isDeepStrictEqual(entries.map((entry) => entry.name).sort(), expected.sort())) {
    throw liveAdapterError('isolated deploy base contains unapproved modules');
  }
  for (const entry of entries) {
    const stats = await lstat(resolve(baseDirPath, entry.name));
    if ((stats.mode & 0o777) !== 0o600 || stats.nlink !== 1) {
      throw liveAdapterError('isolated deploy module is not private authority');
    }
  }
}

async function assertPinnedNoBundleDiscovery(outdir, expectedSource, expectedDataModules) {
  const entries = await readdir(outdir, { withFileTypes: true });
  const allowedNames = new Set(['README.md', 'worker.mjs', ...expectedDataModules.map((module) => module.name)]);
  if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink() || !allowedNames.has(entry.name)) ||
      !entries.some((entry) => entry.name === 'worker.mjs') ||
      expectedDataModules.some((module) => !entries.some((entry) => entry.name === module.name))) {
    throw liveAdapterError('pinned no-bundle module discovery contains unapproved output');
  }
  const discoveredSource = (await readFile(resolve(outdir, 'worker.mjs'), 'utf8')).replace(/\r\n?/gu, '\n');
  if (discoveredSource !== expectedSource) {
    throw liveAdapterError('pinned no-bundle discovery transformed the main module');
  }
  for (const expected of expectedDataModules) {
    const bytes = await readFile(resolve(outdir, expected.name));
    if (bytes.length !== expected.size || sha256(bytes) !== expected.sha256) {
      throw liveAdapterError('pinned no-bundle discovery changed an approved data module');
    }
  }
}

function parseDeployOutput(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_COMMAND_OUTPUT_BYTES) {
    throw liveAdapterError('Wrangler deploy output is invalid');
  }
  const lines = text.trim().split('\n').filter(Boolean);
  if (lines.length !== 1) throw liveAdapterError('Wrangler deploy output is invalid');
  let document;
  try {
    document = parseJsonWithoutDuplicateMembers(Buffer.from(lines[0], 'utf8'), 'Wrangler deploy output');
  } catch {
    throw liveAdapterError('Wrangler deploy output is invalid');
  }
  const allowed = new Set([
    'type', 'version', 'worker_name', 'worker_tag', 'version_id', 'targets', 'wrangler_environment',
    'worker_name_overridden', 'timestamp',
  ]);
  if (Object.keys(document).some((key) => !allowed.has(key)) || document.type !== 'deploy' ||
      document.version !== 1 || document.worker_name !== WORKER_NAME || document.worker_name_overridden !== false ||
      typeof document.version_id !== 'string' || !LOWERCASE_UUID_V4.test(document.version_id)) {
    throw liveAdapterError('Wrangler deploy output is invalid');
  }
  return document.version_id;
}

function assertClosedChildResult(value) {
  if (value !== null && (typeof value !== 'object' || Array.isArray(value))) {
    throw liveAdapterError('Cloudflare OAuth child returned an invalid result');
  }
  return value;
}

function assertExactResultKeys(value, expectedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !isDeepStrictEqual(Object.keys(value).sort(), [...expectedKeys].sort())) {
    throw liveAdapterError(`${label} returned a non-closed result`);
  }
  return value;
}

export async function runB3CloudflareOAuthChild(document, { root, env, commandRunner = boundedCommand }) {
  const result = await commandRunner(
    process.execPath,
    [resolve(root, 'scripts/lib/b3-cloudflare-oauth-child.mjs')],
    { cwd: root, env, input: `${JSON.stringify(document)}\n`, timeoutMs: 180_000 },
  );
  assertCommandSucceeded(result, 'OAuth child');
  if (result.stderr !== '') throw liveAdapterError('Cloudflare OAuth child emitted unapproved stderr');
  let envelope;
  try {
    envelope = parseJsonWithoutDuplicateMembers(Buffer.from(result.stdout, 'utf8'), 'Cloudflare OAuth child output');
  } catch {
    throw liveAdapterError('Cloudflare OAuth child returned invalid JSON');
  }
  if (!isDeepStrictEqual(Object.keys(envelope ?? {}).sort(), ['ok', 'result']) || envelope.ok !== true) {
    throw liveAdapterError('Cloudflare OAuth child operation failed');
  }
  return assertClosedChildResult(envelope.result);
}

function assertWorkerStateResult(result) {
  assertExactResultKeys(result, [
    'deploymentVersionId', 'deployedSourceSha256', 'accountId', 'workerName',
    'publicSandboxOrigin', 'bucketName', 'compatibilityDate', 'compatibilityFlags',
    'bindings', 'requiredSecretNames', 'bucketPrivate', 'r2DevPublicAccess', 'customDomains',
  ], 'Worker-state child');
  if (!LOWERCASE_UUID_V4.test(result.deploymentVersionId ?? '') ||
      !/^[0-9a-f]{64}$/u.test(result.deployedSourceSha256 ?? '') ||
      result.accountId !== ACCOUNT_ID || result.workerName !== WORKER_NAME ||
      result.publicSandboxOrigin !== 'https://b3-gateway.eugnel.uk' || result.bucketName !== BUCKET_NAME ||
      typeof result.compatibilityDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(result.compatibilityDate) ||
      !Array.isArray(result.compatibilityFlags) || result.compatibilityFlags.some((flag) => typeof flag !== 'string') ||
      !result.bindings || !Array.isArray(result.requiredSecretNames) || result.bucketPrivate !== true ||
      result.r2DevPublicAccess !== false || !Array.isArray(result.customDomains)) {
    throw liveAdapterError('Worker-state child result differs from closed authority');
  }
  return Object.freeze(structuredClone(result));
}

export function createDefaultB3CloudflarePrimitives({
  root,
  env = process.env,
  commandRunner = boundedCommand,
  childRunner,
  smokeRunner,
} = {}) {
  if (typeof root !== 'string' || root !== resolve(root)) throw liveAdapterError('repository root is required');
  const childEnv = createB3SterileCloudflareEnvironment(env, { accountId: ACCOUNT_ID });
  const executeChild = childRunner ?? ((document, context) => runB3CloudflareOAuthChild(document, { ...context, commandRunner }));
  let session;
  let dryRunState;
  let deploymentState;
  let verifiedDeploymentState;

  async function ensureSession() {
    if (!session) session = await createPrivateSession(root);
    return session;
  }

  async function dryRunBundle({ placeholder }) {
    if (placeholder !== PLACEHOLDER) throw liveAdapterError('dry-run placeholder authority is invalid');
    deploymentState = undefined;
    verifiedDeploymentState = undefined;
    const [{ binPath }, configPath, directory] = await Promise.all([
      validateB3PinnedWrangler({ root }),
      validateTrackedWranglerConfig(root),
      ensureSession(),
    ]);
    const outdir = resolve(directory, 'wrangler-dry-run');
    await rm(outdir, { recursive: true, force: true });
    const args = [binPath, 'deploy', '--config', configPath, '--dry-run', '--outdir', outdir, '--env-file', '/dev/null'];
    const result = await commandRunner(process.execPath, args, { cwd: root, env: childEnv, timeoutMs: 60_000 });
    assertCommandSucceeded(result, 'dry-run');
    const output = await readDryRunOutput(outdir, placeholder);
    const discoveryBasePath = resolve(directory, 'module-discovery-base');
    await mkdir(discoveryBasePath, { mode: 0o700 });
    const discoveryMainPath = resolve(discoveryBasePath, 'worker.mjs');
    await writeFile(discoveryMainPath, output.source, { mode: 0o600, flag: 'wx' });
    for (const module of output.dataModules) {
      await writeFile(resolve(discoveryBasePath, module.name), module.bytes, { mode: 0o600, flag: 'wx' });
    }
    await assertIsolatedDeployBase(discoveryBasePath);
    const discoveryConfigPath = resolve(directory, 'module-discovery-config.json');
    const discoveryConfig = buildB3DerivedWranglerConfig({
      accountId: ACCOUNT_ID,
      mainModulePath: discoveryMainPath,
      baseDirPath: discoveryBasePath,
    });
    await writeFile(discoveryConfigPath, `${JSON.stringify(discoveryConfig, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    const discoveryOutdir = resolve(directory, 'module-discovery-output');
    const discoveryResult = await commandRunner(process.execPath, [
      binPath, 'deploy', '--config', discoveryConfigPath, '--dry-run', '--no-bundle',
      '--outdir', discoveryOutdir, '--env-file', '/dev/null',
    ], { cwd: root, env: childEnv, timeoutMs: 60_000 });
    assertCommandSucceeded(discoveryResult, 'no-bundle module discovery');
    await assertPinnedNoBundleDiscovery(discoveryOutdir, output.source, output.dataModules);
    dryRunState = Object.freeze({
      ...output,
      verificationConfigPath: discoveryConfigPath,
      mainModuleName: basename(discoveryMainPath),
    });
    return Object.freeze({ source: output.source, normalised: true });
  }

  async function deployExactBundle({ source, scriptAuthoritySha256, deployedSourceSha256 }) {
    if (!dryRunState || typeof source !== 'string' || source !== dryRunState.source.replace(PLACEHOLDER, scriptAuthoritySha256) ||
        !/^[0-9a-f]{64}$/u.test(scriptAuthoritySha256) || sha256(Buffer.from(source, 'utf8')) !== deployedSourceSha256) {
      throw liveAdapterError('bound Worker source differs from deterministic dry-run authority');
    }
    const [{ binPath }, directory] = await Promise.all([validateB3PinnedWrangler({ root }), ensureSession()]);
    const deployBasePath = resolve(directory, 'deploy-base');
    await mkdir(deployBasePath, { mode: 0o700 });
    const mainModulePath = resolve(deployBasePath, 'worker.mjs');
    await writeFile(mainModulePath, source, { mode: 0o600, flag: 'wx' });
    for (const module of dryRunState.dataModules) {
      await writeFile(resolve(deployBasePath, module.name), module.bytes, { mode: 0o600, flag: 'wx' });
    }
    await assertIsolatedDeployBase(deployBasePath);
    const derivedConfigPath = resolve(directory, 'wrangler-derived.json');
    const derivedConfig = buildB3DerivedWranglerConfig({
      accountId: ACCOUNT_ID,
      mainModulePath,
      baseDirPath: deployBasePath,
    });
    await writeFile(derivedConfigPath, `${JSON.stringify(derivedConfig, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    const outdir = resolve(directory, 'wrangler-deploy');
    const outputPath = resolve(directory, 'wrangler-deploy-output.jsonl');
    const args = [
      binPath, 'deploy', '--config', derivedConfigPath, '--no-bundle', '--outdir', outdir,
      '--env-file', '/dev/null',
    ];
    const result = await commandRunner(process.execPath, args, {
      cwd: root,
      env: { ...childEnv, WRANGLER_OUTPUT_FILE_PATH: outputPath },
      timeoutMs: 120_000,
    });
    assertCommandSucceeded(result, 'exact deploy');
    const deploymentVersionId = parseDeployOutput(await readFile(outputPath, 'utf8'));
    deploymentState = Object.freeze({
      deploymentVersionId,
      deployedSourceSha256,
      derivedConfigPath,
      mainModuleName: basename(mainModulePath),
      dataModules: dryRunState.dataModules.map(({ name, size, sha256: digest }) => ({ name, size, sha256: digest })),
    });
    verifiedDeploymentState = undefined;
    return Object.freeze({ deploymentVersionId, deployedSourceSha256 });
  }

  async function inspectVersionApi({ deploymentVersionId, deployedSourceSha256, scriptAuthoritySha256 }) {
    if (!dryRunState || !LOWERCASE_UUID_V4.test(deploymentVersionId ?? '') ||
        !/^[0-9a-f]{64}$/u.test(deployedSourceSha256 ?? '') ||
        !/^[0-9a-f]{64}$/u.test(scriptAuthoritySha256 ?? '') ||
        sha256(Buffer.from(dryRunState.source.replace(PLACEHOLDER, scriptAuthoritySha256), 'utf8')) !== deployedSourceSha256) {
      throw liveAdapterError('deployment version is outside current adapter authority');
    }
    if (deploymentState && (deploymentVersionId !== deploymentState.deploymentVersionId ||
        deployedSourceSha256 !== deploymentState.deployedSourceSha256)) {
      throw liveAdapterError('deployment version is outside current adapter authority');
    }
    const candidate = deploymentState ?? Object.freeze({
      deploymentVersionId,
      deployedSourceSha256,
      derivedConfigPath: dryRunState.verificationConfigPath,
      mainModuleName: dryRunState.mainModuleName,
      dataModules: dryRunState.dataModules.map(({ name, size, sha256: digest }) => ({ name, size, sha256: digest })),
    });
    const result = await executeChild({
      schemaVersion: 1,
      operation: 'verify-worker',
      accountId: ACCOUNT_ID,
      workerName: WORKER_NAME,
      deploymentVersionId,
      deployedSourceSha256: candidate.deployedSourceSha256,
      mainModuleName: candidate.mainModuleName,
      dataModules: structuredClone(candidate.dataModules),
    }, { root, env: childEnv });
    assertExactResultKeys(result, ['deploymentVersionId', 'deployedSourceSha256'], 'Worker readback child');
    if (result.deploymentVersionId !== deploymentVersionId ||
        result.deployedSourceSha256 !== candidate.deployedSourceSha256) {
      throw liveAdapterError('Worker readback child differs from deployment authority');
    }
    verifiedDeploymentState = candidate;
    return Object.freeze(structuredClone(result));
  }

  async function inspectWorkerState() {
    if (!verifiedDeploymentState) throw liveAdapterError('verified deployment authority is unavailable');
    const result = assertWorkerStateResult(await executeChild({
      schemaVersion: 1,
      operation: 'inspect-worker-state',
      accountId: ACCOUNT_ID,
      workerName: WORKER_NAME,
      bucketName: BUCKET_NAME,
      publicHostname: 'b3-gateway.eugnel.uk',
      deploymentVersionId: verifiedDeploymentState.deploymentVersionId,
      deployedSourceSha256: verifiedDeploymentState.deployedSourceSha256,
      mainModuleName: verifiedDeploymentState.mainModuleName,
      dataModules: structuredClone(verifiedDeploymentState.dataModules),
    }, { root, env: childEnv }));
    if (result.deploymentVersionId !== verifiedDeploymentState.deploymentVersionId ||
        result.deployedSourceSha256 !== verifiedDeploymentState.deployedSourceSha256) {
      throw liveAdapterError('Worker-state child differs from verified deployment authority');
    }
    return result;
  }

  async function runObjectChild(operation, value) {
    const currentDeployment = verifiedDeploymentState ?? deploymentState;
    if (!currentDeployment) throw liveAdapterError('exact deployment authority is unavailable');
    const result = await executeChild({
      schemaVersion: 1,
      operation,
      accountId: ACCOUNT_ID,
      bucketName: BUCKET_NAME,
      role: value.role,
      key: value.key,
      configPath: currentDeployment.derivedConfigPath,
      ...(operation === 'upload-object' ? {
        bytesBase64: Buffer.from(value.bytes).toString('base64'),
        customMetadata: structuredClone(value.customMetadata),
        sha256: sha256(Buffer.from(value.bytes)),
      } : {}),
    }, { root, env: childEnv });
    if (result === null && operation === 'inspect-object') return null;
    assertExactResultKeys(result, ['key', 'sha256', 'size', 'etag', 'customMetadata'], 'R2 child');
    if (result.key !== value.key || !/^[0-9a-f]{64}$/u.test(result.sha256) ||
        !Number.isSafeInteger(result.size) || result.size <= 0 || typeof result.etag !== 'string' ||
        !result.customMetadata || typeof result.customMetadata !== 'object' || Array.isArray(result.customMetadata)) {
      throw liveAdapterError('R2 child result differs from closed object authority');
    }
    return Object.freeze(structuredClone(result));
  }

  return Object.freeze({
    dryRunBundle,
    deployExactBundle,
    inspectVersionApi,
    inspectWorkerState,
    inspectObject: (value) => runObjectChild('inspect-object', value),
    uploadObject: (value) => {
      if (value?.noOverwrite !== true) throw liveAdapterError('R2 upload must be create-only');
      return runObjectChild('upload-object', value);
    },
    smokeGateway: async (value) => {
      if (typeof smokeRunner !== 'function') {
        throw liveAdapterError('live gateway smoke input authority is unavailable');
      }
      return smokeRunner(structuredClone(value));
    },
  });
}
