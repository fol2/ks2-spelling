import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parseJsonWithoutDuplicateMembers } from '../../src/domain/packs/signed-manifest-contract.js';
import { B3_ARCHIVE_KEY, B3_MANIFEST_KEY } from './b3-cloudflare-evidence.mjs';

const ACCOUNT_ID = '6d00cb4a0396c17ad6ba617bcbcaa45d';
const WORKER_NAME = 'ks2-spelling-b3-sandbox';
const BUCKET_NAME = 'ks2-spelling-b3-sandbox-packs';
const MAX_CHILD_OUTPUT_BYTES = 64 * 1024;
const MAX_WORKER_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_OBJECT_BYTES = 10 * 1024 * 1024;
const WRANGLER_VERSION = '4.110.0';
const LOWERCASE_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const APPROVED_DER_MODULE = Object.freeze({
  name: 'b52cb02fd567e0359fe8fa4d4c41037970fe01b0-AppleRootCA-G3.der',
  size: 583,
  sha256: '63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179',
});
const VERSIONED_CONTENT_SOURCE_CONTRACT =
  '/accounts/${accountId}/workers/scripts/${scriptName}/content/v2?version=${versionId}';
const REQUIRED_SECRET_NAMES = Object.freeze([
  'APPLE_IAP_ISSUER_ID', 'APPLE_IAP_KEY_ID', 'APPLE_IAP_PRIVATE_KEY',
  'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON', 'ENTITLEMENT_HANDLE_KEY_CURRENT',
  'ENTITLEMENT_HANDLE_KEY_PREVIOUS', 'R2_CAPABILITY_HMAC_KEY',
]);

function adapterError(message) {
  const error = new Error(message);
  error.code = 'b3_cloudflare_live_adapter_invalid';
  return error;
}

function hasExactKeys(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertHex(value, bytes, field) {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${bytes * 2}}$`, 'u').test(value)) {
    throw adapterError(`${field} is invalid`);
  }
}

function assertWorkerVersionId(value) {
  if (typeof value !== 'string' || !LOWERCASE_UUID_V4.test(value)) {
    throw adapterError('Worker version or main-module authority is invalid');
  }
}

function hasControlCharacters(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

async function readAuthority(root) {
  let gateway;
  let objectAuthority;
  try {
    [gateway, objectAuthority] = await Promise.all([
      readFile(resolve(root, 'config/b3-gateway-authority.json')).then(
        (bytes) => parseJsonWithoutDuplicateMembers(bytes, 'B3 gateway authority'),
      ),
      readFile(resolve(root, 'config/b3-pack-object-authority.json')).then(
        (bytes) => parseJsonWithoutDuplicateMembers(bytes, 'B3 object authority'),
      ),
    ]);
  } catch {
    throw adapterError('tracked object authority contains duplicate or invalid JSON');
  }
  const expectedKeys = new Map([
    ['archive', B3_ARCHIVE_KEY],
    ['signed-manifest', B3_MANIFEST_KEY],
  ]);
  if (!hasExactKeys(gateway, [
    'schemaVersion', 'environment', 'cloudflareAccountId', 'workerName', 'privateR2BucketName',
    'publicSandboxOrigin', 'allowedOrigins', 'distribution',
  ]) || gateway.schemaVersion !== 1 || gateway.environment !== 'sandbox' ||
      gateway.cloudflareAccountId !== ACCOUNT_ID || gateway.workerName !== WORKER_NAME ||
      gateway.privateR2BucketName !== BUCKET_NAME || gateway.publicSandboxOrigin !== 'https://b3-gateway.eugnel.uk' ||
      !isDeepStrictEqual(gateway.allowedOrigins, ['capacitor://localhost', 'http://localhost']) ||
      !isDeepStrictEqual(gateway.distribution, {
        applicationId: 'uk.eugnel.ks2spelling',
        iosKind: 'development',
        androidTrack: 'internal',
      }) || objectAuthority?.bucketName !== BUCKET_NAME ||
      !hasExactKeys(objectAuthority, ['schemaVersion', 'bucketName', 'packId', 'version', 'objects']) ||
      objectAuthority.schemaVersion !== 1 || objectAuthority.packId !== 'b3-sandbox-proof' ||
      objectAuthority.version !== '1.0.0-b3.1' || !Array.isArray(objectAuthority.objects) ||
      objectAuthority.objects.length !== 2) {
    throw adapterError('tracked Cloudflare authority is invalid');
  }
  for (const entry of objectAuthority.objects) {
    const metadataKeys = entry?.role === 'signed-manifest'
      ? ['b3-role', 'b3-sha256', 'b3-size', 'b3-envelope-sha256']
      : ['b3-role', 'b3-sha256', 'b3-size'];
    if (!hasExactKeys(entry, ['role', 'key', 'bytes', 'sha256', 'etag', 'metadata']) ||
        entry.key !== expectedKeys.get(entry.role) || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 ||
        typeof entry.etag !== 'string' || !/^[0-9a-f]{32}$/u.test(entry.etag) ||
        typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(entry.sha256) ||
        !hasExactKeys(entry.metadata, metadataKeys) || entry.metadata['b3-role'] !== entry.role ||
        entry.metadata['b3-sha256'] !== entry.sha256 || entry.metadata['b3-size'] !== String(entry.bytes) ||
        (entry.role === 'signed-manifest' && entry.metadata['b3-envelope-sha256'] !== entry.sha256)) {
      throw adapterError('tracked object authority is invalid');
    }
  }
  if (!isDeepStrictEqual(objectAuthority.objects.map((entry) => entry.role).sort(), ['archive', 'signed-manifest'])) {
    throw adapterError('tracked object authority is invalid');
  }
  return { gateway, objects: objectAuthority.objects };
}

async function assertPinnedWrangler(root) {
  const packagePath = resolve(root, 'gateway/node_modules/wrangler/package.json');
  const binPath = resolve(root, 'gateway/node_modules/wrangler/bin/wrangler.js');
  const modulePath = resolve(root, 'gateway/node_modules/wrangler/wrangler-dist/cli.js');
  const lockPath = resolve(root, 'gateway/package-lock.json');
  try {
    const [packageStats, binStats, moduleStats, lockStats, packageDocument, lockDocument, wranglerSource] = await Promise.all([
      lstat(packagePath), lstat(binPath), lstat(modulePath), lstat(lockPath),
      readFile(packagePath).then((bytes) => parseJsonWithoutDuplicateMembers(bytes, 'pinned Wrangler package')),
      readFile(lockPath).then((bytes) => parseJsonWithoutDuplicateMembers(bytes, 'pinned Wrangler lockfile')),
      readFile(modulePath, 'utf8'),
    ]);
    if ([packageStats, binStats, moduleStats, lockStats].some((stats) => !stats.isFile() || stats.isSymbolicLink()) ||
        packageDocument?.version !== WRANGLER_VERSION ||
        lockDocument?.packages?.['node_modules/wrangler']?.version !== WRANGLER_VERSION ||
        wranglerSource.split(VERSIONED_CONTENT_SOURCE_CONTRACT).length - 1 !== 1) {
      throw adapterError('pinned Wrangler authority is unavailable');
    }
  } catch (error) {
    if (error?.code === 'b3_cloudflare_live_adapter_invalid') throw error;
    throw adapterError('pinned Wrangler authority is unavailable');
  }
}

function assertCloudflareIdentity(document) {
  if (document.accountId !== ACCOUNT_ID) throw adapterError('Cloudflare account authority mismatch');
  if ('workerName' in document && document.workerName !== WORKER_NAME) {
    throw adapterError('Worker authority mismatch');
  }
  if ('bucketName' in document && document.bucketName !== BUCKET_NAME) {
    throw adapterError('R2 bucket authority mismatch');
  }
}

function findObjectAuthority(authority, role, key) {
  const entry = authority.objects.find((candidate) => candidate.role === role && candidate.key === key);
  if (!entry) throw adapterError('object authority rejected role or key');
  return entry;
}

function assertDerivedConfig(config, document) {
  const expected = {
    name: WORKER_NAME,
    account_id: ACCOUNT_ID,
    main: config?.main,
    base_dir: config?.base_dir,
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
  };
  if (typeof config?.main !== 'string' || typeof config?.base_dir !== 'string' ||
      config.main !== resolve(config.base_dir, 'worker.mjs') || !isDeepStrictEqual(config, expected) ||
      document.accountId !== config.account_id || document.bucketName !== config.r2_buckets[0].bucket_name) {
    throw adapterError('derived Wrangler config is not the closed B3 remote-binding config');
  }
}

function isWithin(root, candidate) {
  const path = relative(root, candidate);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function assertPrivateCanonicalFile(path, authorityRoot, label) {
  if (typeof path !== 'string' || path !== resolve(path)) {
    throw adapterError(`${label} path is not private canonical B3 authority`);
  }
  let stats;
  let canonicalPath;
  let canonicalAuthority;
  try {
    [stats, canonicalPath, canonicalAuthority] = await Promise.all([
      lstat(path),
      realpath(path),
      realpath(authorityRoot),
    ]);
  } catch {
    throw adapterError(`${label} path is not private canonical B3 authority`);
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 ||
      (stats.mode & 0o777) !== 0o600 || canonicalPath !== path ||
      (typeof process.getuid === 'function' && stats.uid !== process.getuid()) ||
      !isWithin(canonicalAuthority, canonicalPath)) {
    throw adapterError(`${label} path is not private canonical B3 authority`);
  }
}

async function assertIsolatedDeployBase(config, authorityRoot) {
  const path = config.base_dir;
  let stats;
  let canonicalPath;
  let canonicalAuthority;
  try {
    [stats, canonicalPath, canonicalAuthority] = await Promise.all([
      lstat(path), realpath(path), realpath(authorityRoot),
    ]);
  } catch {
    throw adapterError('isolated deploy base is unavailable');
  }
  if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o777) !== 0o700 ||
      canonicalPath !== path || !isWithin(canonicalAuthority, canonicalPath)) {
    throw adapterError('isolated deploy base is not private canonical authority');
  }
  const entries = await readdir(path, { withFileTypes: true });
  const expectedNames = [APPROVED_DER_MODULE.name, 'worker.mjs'].sort();
  if (entries.length !== expectedNames.length || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink()) ||
      !isDeepStrictEqual(entries.map((entry) => entry.name).sort(), expectedNames)) {
    throw adapterError('isolated deploy base contains unapproved modules');
  }
  const derPath = resolve(path, APPROVED_DER_MODULE.name);
  await assertPrivateCanonicalFile(config.main, authorityRoot, 'derived Worker main module');
  await assertPrivateCanonicalFile(derPath, authorityRoot, 'derived Worker data module');
  const derBytes = await readFile(derPath);
  if (derBytes.length !== APPROVED_DER_MODULE.size || sha256(derBytes) !== APPROVED_DER_MODULE.sha256) {
    throw adapterError('derived Worker data module differs from approved authority');
  }
}

async function defaultGetPlatformProxy(root, options) {
  const wranglerModule = await import(pathToFileURL(
    resolve(root, 'gateway/node_modules/wrangler/wrangler-dist/cli.js'),
  ).href);
  if (typeof wranglerModule.getPlatformProxy !== 'function') {
    throw adapterError('pinned Wrangler getPlatformProxy is unavailable');
  }
  return wranglerModule.getPlatformProxy(options);
}

function parseBoundedJson(text, label) {
  if (Buffer.byteLength(text, 'utf8') > MAX_CHILD_OUTPUT_BYTES) {
    throw adapterError(`${label} exceeded its bounded output`);
  }
  try {
    return parseJsonWithoutDuplicateMembers(Buffer.from(text, 'utf8'), label);
  } catch {
    throw adapterError(`${label} did not return valid JSON`);
  }
}

export function spawnBoundedOAuthCommand(command, args, options) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let rejected = false;
    let settled = false;
    const terminateGroup = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      rejected = true;
      terminateGroup();
    }, options.timeoutMs ?? 15_000);
    const consume = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_CHILD_OUTPUT_BYTES) {
        rejected = true;
        terminateGroup();
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', consume(stdout));
    child.stderr.on('data', consume(stderr));
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (rejected) return reject(adapterError('Wrangler OAuth output exceeded its bound'));
      if (code !== 0) return reject(adapterError('Wrangler OAuth authentication failed'));
      accept(Buffer.concat(stdout).toString('utf8'));
    });
  });
}

async function defaultReadOAuthCredential({ root, childEnv }) {
  const output = await spawnBoundedOAuthCommand(
    process.execPath,
    [resolve(root, 'gateway/node_modules/wrangler/bin/wrangler.js'), 'auth', 'token', '--json', '--env-file', '/dev/null'],
    { cwd: root, env: childEnv },
  );
  return parseBoundedJson(output, 'Wrangler OAuth authentication');
}

async function readResponseJson(response, label, call) {
  const text = (await readBoundedResponseBytes(response, MAX_CHILD_OUTPUT_BYTES, label, call)).toString('utf8');
  const body = parseBoundedJson(text, label);
  if (!response.ok || body?.success !== true) throw adapterError(`${label} request failed`);
  return body.result;
}

async function credentialledFetch(fetchImpl, url, requestOptions, label, call, deadlineMs) {
  const response = await call(
    () => fetchImpl(url, { ...requestOptions, signal: AbortSignal.timeout(deadlineMs) }),
    `${label} fetch`,
  );
  if (response?.redirected === true || (Number.isInteger(response?.status) && response.status >= 300 && response.status < 400)) {
    throw adapterError(`${label} redirect was rejected`);
  }
  return response;
}

function activeDeploymentSnapshot(result, expectedVersionId = undefined) {
  const deployment = Array.isArray(result?.deployments) ? result.deployments[0] : null;
  const active = deployment?.versions;
  if (typeof deployment?.id !== 'string' || !Array.isArray(active) || active.length !== 1 ||
      !LOWERCASE_UUID_V4.test(active[0]?.version_id ?? '') || active[0].percentage !== 100 ||
      (expectedVersionId !== undefined && active[0].version_id !== expectedVersionId)) {
    throw adapterError('active Worker deployment is not exact 100-percent version authority');
  }
  return Object.freeze({ deploymentId: deployment.id, versionId: active[0].version_id, percentage: 100 });
}

function versionRuntime(version, expectedVersionId) {
  const runtime = version?.resources?.script_runtime;
  if (!LOWERCASE_UUID_V4.test(version?.id ?? '') || version.id !== expectedVersionId ||
      typeof runtime?.compatibility_date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(runtime.compatibility_date) ||
      !Array.isArray(runtime.compatibility_flags) ||
      runtime.compatibility_flags.some((flag) => typeof flag !== 'string') ||
      new Set(runtime.compatibility_flags).size !== runtime.compatibility_flags.length) {
    throw adapterError('Worker version runtime authority is unavailable');
  }
  return Object.freeze({
    compatibilityDate: runtime.compatibility_date,
    compatibilityFlags: Object.freeze([...runtime.compatibility_flags]),
  });
}

async function readActiveDeployment(fetchImpl, base, requestOptions, call, deadlineMs, expectedVersionId = undefined) {
  return activeDeploymentSnapshot(
    await readResponseJson(
      await credentialledFetch(
        fetchImpl,
        `${base}/deployments`,
        requestOptions,
        'Cloudflare Deployments API',
        call,
        deadlineMs,
      ),
      'Cloudflare Deployments API',
      call,
    ),
    expectedVersionId,
  );
}

async function readBoundedResponseBytes(response, maximum, label, call) {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && (!/^\d+$/u.test(contentLength) || Number(contentLength) > maximum)) {
    throw adapterError(`${label} exceeded its bound`);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await call(() => reader.read(), `${label} body read`);
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        throw adapterError(`${label} exceeded its bound`);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    try {
      await call(() => reader.cancel(), `${label} body cancellation`);
    } catch {
      // Preserve the original fail-closed read or byte-bound error.
    }
    throw error;
  }
  return Buffer.concat(chunks, total);
}

function assertDataModules(dataModules) {
  if (!Array.isArray(dataModules) || dataModules.length > 16) {
    throw adapterError('Worker data-module authority is invalid');
  }
  const names = new Set();
  for (const module of dataModules) {
    if (!hasExactKeys(module, ['name', 'size', 'sha256']) ||
        typeof module.name !== 'string' || !/^[A-Za-z0-9._-]+\.der$/u.test(module.name) || names.has(module.name) ||
        !Number.isSafeInteger(module.size) || module.size <= 0 || module.size > MAX_OBJECT_BYTES) {
      throw adapterError('Worker data-module authority is invalid');
    }
    assertHex(module.sha256, 32, 'Worker data-module SHA-256');
    names.add(module.name);
  }
  return dataModules;
}

async function readWorkerMainModule(response, mainModuleName, dataModules, call) {
  if (!response.ok) throw adapterError('Cloudflare Script Content v2 request failed');
  const contentType = response.headers.get('content-type') ?? '';
  const expectedAggregate = MAX_WORKER_SOURCE_BYTES + dataModules.reduce((total, module) => total + module.size, 0) + 64 * 1024;
  const responseBytes = await readBoundedResponseBytes(response, expectedAggregate, 'Script Content v2 response', call);
  if (contentType.toLowerCase().startsWith('multipart/form-data')) {
    if (response.headers.get('cf-entrypoint') !== mainModuleName) {
      throw adapterError('Script Content v2 main-module metadata differs');
    }
    const boundedResponse = new Response(responseBytes, { headers: { 'content-type': contentType } });
    const form = await boundedResponse.formData();
    if (form.getAll(mainModuleName).length !== 1 ||
        dataModules.some((module) => form.getAll(module.name).length !== 1)) {
      throw adapterError('Script Content v2 contains duplicate or missing modules');
    }
    const expectedNames = new Set([mainModuleName, ...dataModules.map((module) => module.name)]);
    const actualNames = [...form.keys()];
    if (actualNames.length !== expectedNames.size || actualNames.some((name) => !expectedNames.has(name))) {
      throw adapterError('Script Content v2 contains an unapproved module');
    }
    const module = form.get(mainModuleName);
    if (!module || typeof module.arrayBuffer !== 'function') {
      throw adapterError('Script Content v2 main module is missing');
    }
    const bytes = Buffer.from(await module.arrayBuffer());
    if (bytes.length > MAX_WORKER_SOURCE_BYTES) throw adapterError('deployed Worker source exceeded its bound');
    for (const expected of dataModules) {
      const dataModule = form.get(expected.name);
      if (!dataModule || typeof dataModule.arrayBuffer !== 'function') {
        throw adapterError('Script Content v2 data module is missing');
      }
      const dataBytes = Buffer.from(await dataModule.arrayBuffer());
      if (dataBytes.length !== expected.size || sha256(dataBytes) !== expected.sha256) {
        throw adapterError('Script Content v2 data module differs');
      }
    }
    return bytes;
  }
  if (dataModules.length !== 0) throw adapterError('Script Content v2 omitted required data modules');
  if (responseBytes.length > MAX_WORKER_SOURCE_BYTES) throw adapterError('deployed Worker source exceeded its bound');
  return responseBytes;
}

async function verifyWorker(document, options) {
  if (!hasExactKeys(document, [
    'schemaVersion', 'operation', 'accountId', 'workerName', 'deploymentVersionId',
    'deployedSourceSha256', 'mainModuleName', 'dataModules',
  ]) || document.schemaVersion !== 1 || document.operation !== 'verify-worker') {
    throw adapterError('verify-worker document is not closed');
  }
  assertCloudflareIdentity(document);
  assertDataModules(document.dataModules);
  assertHex(document.deployedSourceSha256, 32, 'deployed source SHA-256');
  assertWorkerVersionId(document.deploymentVersionId);
  if (typeof document.mainModuleName !== 'string' || !/^[A-Za-z0-9._-]+$/u.test(document.mainModuleName)) {
    throw adapterError('Worker version or main-module authority is invalid');
  }
  await assertPinnedWrangler(options.root);
  const credential = await (options.readOAuthCredential ?? defaultReadOAuthCredential)({
    root: options.root,
    childEnv: options.childEnv,
  });
  if (!hasExactKeys(credential, ['type', 'token']) || credential.type !== 'oauth' ||
      typeof credential.token !== 'string' || credential.token.length === 0 || credential.token.length > 8192 ||
      hasControlCharacters(credential.token)) {
    throw adapterError('Wrangler did not supply an OAuth credential');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const deadlineMs = operationDeadline(options);
  const call = (operation, label) => withDeadline(Promise.resolve().then(operation), label, deadlineMs);
  const base = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${WORKER_NAME}`;
  const requestOptions = {
    method: 'GET',
    headers: { Authorization: `Bearer ${credential.token}` },
    redirect: 'error',
  };
  const initialDeployment = await readActiveDeployment(
    fetchImpl,
    base,
    requestOptions,
    call,
    deadlineMs,
    document.deploymentVersionId,
  );
  const version = await readResponseJson(
    await credentialledFetch(
      fetchImpl,
      `${base}/versions/${document.deploymentVersionId}`,
      requestOptions,
      'Cloudflare Versions API',
      call,
      deadlineMs,
    ),
    'Cloudflare Versions API',
    call,
  );
  if (version?.id !== document.deploymentVersionId) throw adapterError('Cloudflare version identity differs');
  versionRuntime(version, document.deploymentVersionId);
  const source = await readWorkerMainModule(
    await credentialledFetch(
      fetchImpl,
      `${base}/content/v2?version=${encodeURIComponent(document.deploymentVersionId)}`,
      requestOptions,
      'Cloudflare Script Content v2 API',
      call,
      deadlineMs,
    ),
    document.mainModuleName,
    document.dataModules,
    call,
  );
  if (sha256(source) !== document.deployedSourceSha256) {
    throw adapterError('deployed Worker bytes differ from the exact prebundled source');
  }
  const finalDeployment = await readActiveDeployment(
    fetchImpl,
    base,
    requestOptions,
    call,
    deadlineMs,
    document.deploymentVersionId,
  );
  if (!isDeepStrictEqual(finalDeployment, initialDeployment)) {
    throw adapterError('active Worker deployment changed during content readback');
  }
  return Object.freeze({
    deploymentVersionId: document.deploymentVersionId,
    deployedSourceSha256: document.deployedSourceSha256,
  });
}

async function defaultInspectWorkerState({ root, childEnv }) {
  const { createCloudflareRemoteInspector, runOAuthSafeWrangler } = await import(
    '../check-b3-external-prerequisites.mjs'
  );
  const inspector = createCloudflareRemoteInspector({
    commandRunner: (args, context) => runOAuthSafeWrangler(args, {
      root,
      env: childEnv,
      accountId: context?.accountId,
    }),
  });
  return inspector({
    accountId: ACCOUNT_ID,
    workerName: WORKER_NAME,
    privateR2BucketName: BUCKET_NAME,
    bindingNames: ['GATEWAY_RATE_LIMIT', 'PACKS', 'WORKER_VERSION_METADATA'],
    secretNames: REQUIRED_SECRET_NAMES,
  });
}

function assertInspectedWorkerState(inspected) {
  const expectedBindingNames = ['GATEWAY_RATE_LIMIT', 'PACKS', 'WORKER_VERSION_METADATA'];
  if (inspected?.oauthAvailable !== true || inspected.accountId !== ACCOUNT_ID || inspected.workerName !== WORKER_NAME ||
      inspected.privateR2BucketName !== BUCKET_NAME || inspected.boundR2BucketName !== BUCKET_NAME ||
      !Array.isArray(inspected.bindingNames) ||
      !isDeepStrictEqual([...inspected.bindingNames].sort(), expectedBindingNames) ||
      !isDeepStrictEqual(inspected.bindingTypes, { GATEWAY_RATE_LIMIT: 'ratelimit', PACKS: 'r2_bucket', WORKER_VERSION_METADATA: 'version_metadata' }) ||
      !Array.isArray(inspected.versionSecretNames) || !Array.isArray(inspected.secretNames) ||
      !isDeepStrictEqual([...inspected.versionSecretNames].sort(), [...REQUIRED_SECRET_NAMES].sort()) ||
      !isDeepStrictEqual([...inspected.secretNames].sort(), [...REQUIRED_SECRET_NAMES].sort()) ||
      inspected.r2DevUrlPublicAccess !== false || inspected.hasCustomDomains !== false) {
    throw adapterError('remote Worker state differs from closed B3 authority');
  }
}

async function inspectWorkerState(document, options, authority) {
  if (!hasExactKeys(document, [
    'schemaVersion', 'operation', 'accountId', 'workerName', 'bucketName', 'publicHostname',
    'deploymentVersionId', 'deployedSourceSha256', 'mainModuleName', 'dataModules',
  ]) || document.schemaVersion !== 1 || document.operation !== 'inspect-worker-state') {
    throw adapterError('inspect-worker-state document is not closed');
  }
  assertCloudflareIdentity(document);
  assertDataModules(document.dataModules);
  assertHex(document.deployedSourceSha256, 32, 'deployed source SHA-256');
  assertWorkerVersionId(document.deploymentVersionId);
  if (typeof document.mainModuleName !== 'string' || !/^[A-Za-z0-9._-]+$/u.test(document.mainModuleName)) {
    throw adapterError('Worker version or main-module authority is invalid');
  }
  let approvedOrigin;
  try {
    approvedOrigin = new URL(authority.gateway.publicSandboxOrigin);
  } catch {
    throw adapterError('tracked Worker route authority is invalid');
  }
  if (approvedOrigin.protocol !== 'https:' || approvedOrigin.pathname !== '/' || approvedOrigin.search !== '' ||
      approvedOrigin.hash !== '' || approvedOrigin.hostname !== document.publicHostname) {
    throw adapterError('tracked Worker route authority is invalid');
  }
  await assertPinnedWrangler(options.root);
  const credential = await (options.readOAuthCredential ?? defaultReadOAuthCredential)({
    root: options.root,
    childEnv: options.childEnv,
  });
  if (!hasExactKeys(credential, ['type', 'token']) || credential.type !== 'oauth' ||
      typeof credential.token !== 'string' || credential.token.length === 0 || credential.token.length > 8192 ||
      hasControlCharacters(credential.token)) {
    throw adapterError('Wrangler did not supply an OAuth credential');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const deadlineMs = operationDeadline(options);
  const call = (operation, label) => withDeadline(Promise.resolve().then(operation), label, deadlineMs);
  const base = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${WORKER_NAME}`;
  const requestOptions = {
    method: 'GET',
    headers: { Authorization: `Bearer ${credential.token}` },
    redirect: 'error',
  };
  const domainsUrl =
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/domains?service=${encodeURIComponent(WORKER_NAME)}`;
  const readDomains = async () => {
    const domains = await readResponseJson(
      await credentialledFetch(
        fetchImpl,
        domainsUrl,
        requestOptions,
        'Cloudflare Worker Domains API',
        call,
        deadlineMs,
      ),
      'Cloudflare Worker Domains API',
      call,
    );
    if (!Array.isArray(domains) || domains.length !== 1 || domains[0]?.hostname !== document.publicHostname ||
        domains[0]?.service !== WORKER_NAME || domains[0]?.environment !== 'production') {
      throw adapterError('active Worker custom-domain route authority differs');
    }
    return domains;
  };
  const initialDeployment = await readActiveDeployment(
    fetchImpl,
    base,
    requestOptions,
    call,
    deadlineMs,
    document.deploymentVersionId,
  );
  const version = await readResponseJson(
    await credentialledFetch(
      fetchImpl,
      `${base}/versions/${document.deploymentVersionId}`,
      requestOptions,
      'Cloudflare Versions API',
      call,
      deadlineMs,
    ),
    'Cloudflare Versions API',
    call,
  );
  const runtime = versionRuntime(version, document.deploymentVersionId);
  const source = await readWorkerMainModule(
    await credentialledFetch(
      fetchImpl,
      `${base}/content/v2?version=${encodeURIComponent(document.deploymentVersionId)}`,
      requestOptions,
      'Cloudflare Script Content v2 API',
      call,
      deadlineMs,
    ),
    document.mainModuleName,
    document.dataModules,
    call,
  );
  if (sha256(source) !== document.deployedSourceSha256) {
    throw adapterError('deployed Worker bytes differ from the exact prebundled source');
  }
  const domains = await readDomains();
  const inspected = await (options.inspectWorkerStateImpl ?? defaultInspectWorkerState)({
    root: options.root,
    childEnv: options.childEnv,
  });
  assertInspectedWorkerState(inspected);
  const middleDeployment = await readActiveDeployment(
    fetchImpl,
    base,
    requestOptions,
    call,
    deadlineMs,
    document.deploymentVersionId,
  );
  const finalVersion = await readResponseJson(
    await credentialledFetch(
      fetchImpl,
      `${base}/versions/${document.deploymentVersionId}`,
      requestOptions,
      'Cloudflare Versions API',
      call,
      deadlineMs,
    ),
    'Cloudflare Versions API',
    call,
  );
  const finalRuntime = versionRuntime(finalVersion, document.deploymentVersionId);
  const finalDomains = await readDomains();
  const finalInspected = await (options.inspectWorkerStateImpl ?? defaultInspectWorkerState)({
    root: options.root,
    childEnv: options.childEnv,
  });
  assertInspectedWorkerState(finalInspected);
  const finalDeployment = await readActiveDeployment(
    fetchImpl,
    base,
    requestOptions,
    call,
    deadlineMs,
    document.deploymentVersionId,
  );
  if (!isDeepStrictEqual(middleDeployment, initialDeployment) ||
      !isDeepStrictEqual(finalDeployment, initialDeployment)) {
    throw adapterError('active Worker deployment changed during state inspection');
  }
  if (!isDeepStrictEqual(finalRuntime, runtime)) {
    throw adapterError('active Worker runtime changed during state inspection');
  }
  if (!isDeepStrictEqual(finalDomains, domains)) {
    throw adapterError('active Worker custom-domain route changed during state inspection');
  }
  if (!isDeepStrictEqual(finalInspected, inspected)) {
    throw adapterError('remote Worker inspector state changed during state inspection');
  }
  return Object.freeze({
    deploymentVersionId: document.deploymentVersionId,
    deployedSourceSha256: document.deployedSourceSha256,
    accountId: ACCOUNT_ID,
    workerName: WORKER_NAME,
    publicSandboxOrigin: `https://${domains[0].hostname}`,
    bucketName: BUCKET_NAME,
    compatibilityDate: runtime.compatibilityDate,
    compatibilityFlags: [...runtime.compatibilityFlags],
    bindings: { r2: 'PACKS', rateLimit: 'GATEWAY_RATE_LIMIT', versionMetadata: 'WORKER_VERSION_METADATA' },
    requiredSecretNames: [...REQUIRED_SECRET_NAMES],
    bucketPrivate: true,
    r2DevPublicAccess: false,
    customDomains: [],
  });
}

function checksumHex(value) {
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString('hex');
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex');
  return null;
}

function operationDeadline(options, defaultDeadlineMs = 15_000) {
  const deadlineMs = options.deadlineMs ?? defaultDeadlineMs;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 30_000) {
    throw adapterError('remote operation deadline is invalid');
  }
  return deadlineMs;
}

function withDeadline(promise, label, deadlineMs) {
  return new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(adapterError(`${label} exceeded its cooperative deadline`)), deadlineMs);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); accept(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function objectBytes(object, maximum, call) {
  if (object?.body && typeof object.body.getReader === 'function') {
    const reader = object.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await call(() => reader.read(), 'R2 body read');
        if (done) break;
        total += value.byteLength;
        if (total > maximum) {
          void call(() => reader.cancel(), 'R2 body cancellation').catch(() => {});
          throw adapterError('remote object exceeded its byte bound');
        }
        chunks.push(Buffer.from(value));
      }
    } catch (error) {
      void call(() => reader.cancel(), 'R2 body cancellation').catch(() => {});
      throw error;
    }
    return Buffer.concat(chunks, total);
  }
  if (!object || typeof object.arrayBuffer !== 'function' || object.size > maximum) {
    throw adapterError('remote object body is unavailable');
  }
  const bytes = Buffer.from(await call(() => object.arrayBuffer(), 'R2 arrayBuffer read'));
  if (bytes.length > maximum) throw adapterError('remote object exceeded its byte bound');
  return bytes;
}

async function proveRemoteObject(bucket, entry, call, initialHead = undefined) {
  const head = initialHead === undefined ? await call(() => bucket.head(entry.key), 'R2 head') : initialHead;
  if (head === null) return null;
  if (head.key !== entry.key || head.size !== entry.bytes || head.etag !== entry.etag ||
      checksumHex(head.checksums?.sha256) !== entry.sha256 ||
      !isDeepStrictEqual(head.customMetadata, entry.metadata)) {
    throw adapterError('remote object head differs from tracked checksum, ETag or metadata authority');
  }
  const object = await call(() => bucket.get(entry.key), 'R2 get');
  if (object === null) throw adapterError('remote object disappeared during exact readback');
  if (object.key !== entry.key || object.size !== entry.bytes || object.etag !== entry.etag ||
      checksumHex(object.checksums?.sha256) !== entry.sha256 ||
      !isDeepStrictEqual(object.customMetadata, entry.metadata)) {
    throw adapterError('remote object get differs from tracked checksum, ETag or metadata authority');
  }
  const bytes = await objectBytes(object, entry.bytes, call);
  const actualSha256 = sha256(bytes);
  if (actualSha256 !== entry.sha256 || bytes.length !== entry.bytes) {
    throw adapterError('remote object bytes differ from tracked byte, checksum, ETag or metadata authority');
  }
  return Object.freeze({
    key: entry.key,
    sha256: entry.sha256,
    size: entry.bytes,
    etag: entry.etag,
    customMetadata: structuredClone(entry.metadata),
  });
}

async function withRemoteBucket(document, options, operation) {
  const authorityRoot = resolve(options.root, '.native-build/b3');
  await assertPrivateCanonicalFile(document.configPath, authorityRoot, 'derived Wrangler config');
  const configText = await readFile(document.configPath, 'utf8');
  let config;
  try {
    config = parseJsonWithoutDuplicateMembers(Buffer.from(configText, 'utf8'), 'derived Wrangler config');
  } catch {
    throw adapterError('derived Wrangler config is not canonical JSON');
  }
  if (configText !== `${JSON.stringify(config, null, 2)}\n`) {
    throw adapterError('derived Wrangler config is not canonical JSON');
  }
  assertDerivedConfig(config, document);
  await assertIsolatedDeployBase(config, authorityRoot);
  await assertPinnedWrangler(options.root);
  const credential = await (options.readOAuthCredential ?? defaultReadOAuthCredential)({
    root: options.root,
    childEnv: options.childEnv,
  });
  if (!hasExactKeys(credential, ['type', 'token']) || credential.type !== 'oauth' ||
      typeof credential.token !== 'string' || credential.token.length === 0 || credential.token.length > 8192 ||
      hasControlCharacters(credential.token)) {
    throw adapterError('Wrangler did not supply an OAuth credential');
  }
  const proxyOptions = {
    configPath: document.configPath,
    envFiles: [],
    persist: false,
    remoteBindings: true,
  };
  const getPlatformProxyImpl = options.getPlatformProxyImpl ?? ((value) => defaultGetPlatformProxy(options.root, value));
  const deadlineMs = options.deadlineMs ?? 10_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > 30_000) {
    throw adapterError('remote-operation deadline is invalid');
  }
  const call = (operationCall, label) => withDeadline(Promise.resolve().then(operationCall), label, deadlineMs);
  const proxyPromise = Promise.resolve().then(() => getPlatformProxyImpl(proxyOptions));
  let proxy;
  try {
    proxy = await withDeadline(proxyPromise, 'getPlatformProxy', deadlineMs);
  } catch (error) {
    proxyPromise.then((lateProxy) => withDeadline(
      Promise.resolve().then(() => lateProxy?.dispose?.()),
      'late platform proxy disposal',
      deadlineMs,
    )).catch(() => {});
    throw error;
  }
  let result;
  let operationError;
  try {
    if (!proxy?.env?.PACKS || typeof proxy.dispose !== 'function') {
      throw adapterError('remote PACKS binding is unavailable');
    }
    result = await call(() => operation(proxy.env.PACKS, call), 'remote PACKS operation');
  } catch (error) {
    operationError = error;
  }
  try {
    await withDeadline(Promise.resolve().then(() => proxy?.dispose?.()), 'platform proxy disposal', deadlineMs);
  } catch (error) {
    if (!operationError) operationError = error;
  }
  if (operationError) throw operationError;
  return result;
}

function assertObjectDocument(document, operation) {
  const shared = ['schemaVersion', 'operation', 'accountId', 'bucketName', 'role', 'key', 'configPath'];
  const expected = operation === 'upload-object'
    ? [...shared, 'bytesBase64', 'customMetadata', 'sha256']
    : shared;
  if (!hasExactKeys(document, expected) || document.schemaVersion !== 1 || document.operation !== operation ||
      typeof document.configPath !== 'string' || document.configPath.length === 0) {
    throw adapterError(`${operation} document is not closed`);
  }
  assertCloudflareIdentity(document);
}

async function inspectObject(document, options, authority) {
  assertObjectDocument(document, 'inspect-object');
  const entry = findObjectAuthority(authority, document.role, document.key);
  return withRemoteBucket(document, options, (bucket, call) => proveRemoteObject(bucket, entry, call));
}

async function uploadObject(document, options, authority) {
  assertObjectDocument(document, 'upload-object');
  const entry = findObjectAuthority(authority, document.role, document.key);
  assertHex(document.sha256, 32, 'object SHA-256');
  let bytes;
  try {
    bytes = Buffer.from(document.bytesBase64, 'base64');
  } catch {
    throw adapterError('object bytes are not valid base64');
  }
  if (bytes.toString('base64') !== document.bytesBase64 || bytes.length !== entry.bytes ||
      sha256(bytes) !== entry.sha256 || document.sha256 !== entry.sha256 ||
      !isDeepStrictEqual(document.customMetadata, entry.metadata)) {
    throw adapterError('upload bytes or metadata differ from tracked object authority');
  }
  return withRemoteBucket(document, options, async (bucket, call) => {
    const existing = await call(() => bucket.head(entry.key), 'R2 precondition head');
    if (existing !== null) return proveRemoteObject(bucket, entry, call, existing);
    let putResult;
    let preconditionRace = false;
    try {
      putResult = await call(() => bucket.put(entry.key, bytes, {
        onlyIf: { etagDoesNotMatch: '*' },
        sha256: entry.sha256,
        customMetadata: structuredClone(entry.metadata),
      }), 'R2 create-only put');
    } catch (error) {
      if (error?.status !== 412 && error?.statusCode !== 412) throw error;
      preconditionRace = true;
    }
    if (!preconditionRace && putResult === undefined) {
      throw adapterError('R2 put result differs from tracked checksum, ETag or metadata authority');
    }
    if (putResult !== null && putResult !== undefined &&
        (putResult.key !== entry.key || putResult.size !== entry.bytes || putResult.etag !== entry.etag ||
         checksumHex(putResult.checksums?.sha256) !== entry.sha256 ||
         !isDeepStrictEqual(putResult.customMetadata, entry.metadata))) {
      throw adapterError('R2 put result differs from tracked checksum, ETag or metadata authority');
    }
    const immediate = await call(() => bucket.head(entry.key), 'R2 consistency head');
    if (immediate === null) throw adapterError('create-only upload is absent after immediate readback');
    return proveRemoteObject(bucket, entry, call, immediate);
  });
}

export async function executeB3CloudflareOAuthOperation(document, options = {}) {
  if (!options.root) throw adapterError('repository root is required');
  if (document?.operation === 'verify-worker') return verifyWorker(document, options);
  const authority = await readAuthority(options.root);
  if (document?.operation === 'inspect-worker-state') {
    return inspectWorkerState(document, options, authority);
  }
  if (document?.operation === 'inspect-object') {
    assertObjectDocument(document, 'inspect-object');
    findObjectAuthority(authority, document.role, document.key);
    return inspectObject(document, options, authority);
  }
  if (document?.operation === 'upload-object') {
    assertObjectDocument(document, 'upload-object');
    findObjectAuthority(authority, document.role, document.key);
    return uploadObject(document, options, authority);
  }
  throw adapterError('Cloudflare OAuth child operation is not approved');
}

async function readClosedStdin(stream) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > MAX_CHILD_OUTPUT_BYTES) throw adapterError('Cloudflare OAuth child input exceeded its bound');
    chunks.push(chunk);
  }
  return parseBoundedJson(Buffer.concat(chunks, total).toString('utf8'), 'Cloudflare OAuth child input');
}

async function main() {
  const writeStdout = process.stdout.write.bind(process.stdout);
  const writeStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    const document = await readClosedStdin(process.stdin);
    const result = await executeB3CloudflareOAuthOperation(document, {
      root: process.cwd(),
      childEnv: process.env,
    });
    process.stdout.write = writeStdout;
    process.stderr.write = writeStderr;
    writeStdout(`${JSON.stringify({ ok: true, result })}\n`);
    return 0;
  } catch {
    process.stdout.write = writeStdout;
    process.stderr.write = writeStderr;
    writeStderr(`${JSON.stringify({ ok: false, code: 'b3_cloudflare_live_adapter_invalid' })}\n`);
    return 6;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
