import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  buildB3DerivedWranglerConfig,
  createDefaultB3CloudflarePrimitives,
  createB3SterileCloudflareEnvironment,
  runB3CloudflareOAuthChild,
  validateB3PinnedWrangler,
} from '../scripts/lib/b3-cloudflare-live-adapter.mjs';
import {
  executeB3CloudflareOAuthOperation,
  spawnBoundedOAuthCommand,
} from '../scripts/lib/b3-cloudflare-oauth-child.mjs';
import { defaultWranglerSpawn } from '../scripts/check-b3-external-prerequisites.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const ACCOUNT_ID = '6d00cb4a0396c17ad6ba617bcbcaa45d';
const WORKER_NAME = 'ks2-spelling-b3-sandbox';
const BUCKET_NAME = 'ks2-spelling-b3-sandbox-packs';
const APPROVED_DER_NAME = 'b52cb02fd567e0359fe8fa4d4c41037970fe01b0-AppleRootCA-G3.der';
const WORKER_VERSION_ID = '11111111-2222-4333-8444-555555555555';
const MULTIPART_VERSION_ID = '22222222-3333-4444-8555-666666666666';
const ACTIVE_VERSION_ID = '33333333-4444-4555-8666-777777777777';
const DRIFTING_VERSION_ID = '44444444-5555-4666-8777-888888888888';
const CLOSED_VERSION_ID = '55555555-6666-4777-8888-999999999999';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function authorityFixture(role) {
  const authority = JSON.parse(await readFile(resolve(ROOT, 'config/b3-pack-object-authority.json'), 'utf8'));
  const entry = authority.objects.find((candidate) => candidate.role === role);
  const bytes = await readFile(resolve(
    ROOT,
    role === 'archive'
      ? '.native-build/b3/pack/b3-sandbox-proof.zip'
      : '.native-build/b3/pack/signed-manifest.json',
  ));
  return { entry, bytes };
}

function checksumBytes(hex) {
  const bytes = Buffer.from(hex, 'hex');
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function remoteObject(entry, bytes) {
  return {
    key: entry.key,
    size: entry.bytes,
    etag: entry.etag,
    customMetadata: structuredClone(entry.metadata),
    checksums: { sha256: checksumBytes(entry.sha256) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

function putResult(entry) {
  return {
    key: entry.key,
    size: entry.bytes,
    etag: entry.etag,
    customMetadata: structuredClone(entry.metadata),
    checksums: { sha256: checksumBytes(entry.sha256) },
  };
}

function activeDeploymentResponse(versionId) {
  return Response.json({
    success: true,
    result: {
      deployments: [{
        id: 'active-deployment-1',
        created_on: '2026-07-15T12:00:00.000Z',
        versions: [{ version_id: versionId, percentage: 100 }],
      }],
    },
  });
}

function versionResponse(versionId) {
  return Response.json({
    success: true,
    result: {
      id: versionId,
      resources: {
        script_runtime: {
          compatibility_date: '2026-07-12',
          compatibility_flags: ['nodejs_compat'],
        },
      },
    },
  });
}

async function derivedConfigFixture(directory) {
  const configPath = resolve(directory, 'wrangler-derived.json');
  const baseDirPath = resolve(directory, 'deploy-base');
  await mkdir(baseDirPath, { mode: 0o700 });
  const mainModulePath = resolve(baseDirPath, 'worker.mjs');
  await writeFile(mainModulePath, 'export default {}\n', { mode: 0o600, flag: 'wx' });
  await writeFile(
    resolve(baseDirPath, APPROVED_DER_NAME),
    await readFile(resolve(ROOT, 'gateway/config/apple-root-certificates/AppleRootCA-G3.der')),
    { mode: 0o600, flag: 'wx' },
  );
  await writeFile(configPath, `${JSON.stringify(buildB3DerivedWranglerConfig({
    accountId: ACCOUNT_ID,
    mainModulePath,
    baseDirPath,
  }), null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return configPath;
}

async function nativeTempDirectory(prefix) {
  const parent = resolve(ROOT, '.native-build/b3');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  return mkdtemp(join(parent, prefix));
}

function withinHostCeiling(promise, milliseconds = 1_000) {
  return Promise.race([
    promise,
    new Promise((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('test host ceiling exceeded')), milliseconds);
      timer.unref?.();
    }),
  ]);
}

async function waitForProcessExit(pid) {
  await withinHostCeiling(new Promise((accept) => {
    const check = () => {
      try {
        process.kill(pid, 0);
        setTimeout(check, 10);
      } catch {
        accept();
      }
    };
    check();
  }), 1_000);
}

test('pinned Wrangler validation requires exact regular 4.110.0 package and lock resolution', async () => {
  const pinned = await validateB3PinnedWrangler({ root: ROOT });
  assert.equal(pinned.version, '4.110.0');
  assert.equal(pinned.binPath, resolve(ROOT, 'gateway/node_modules/wrangler/bin/wrangler.js'));
  assert.equal(pinned.versionedContentQueryContract, true);

  const directory = await mkdtemp(join(tmpdir(), 'b3-wrangler-drift-'));
  try {
    await assert.rejects(
      validateB3PinnedWrangler({ root: directory }),
      /pinned Wrangler 4\.110\.0 is unavailable/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('derived config closes exact deployment and remote PACKS authority without secrets', () => {
  const config = buildB3DerivedWranglerConfig({
    accountId: ACCOUNT_ID,
    mainModulePath: '/private/b3/deploy-base/worker.mjs',
    baseDirPath: '/private/b3/deploy-base',
  });
  assert.deepEqual(config, {
    name: WORKER_NAME,
    account_id: ACCOUNT_ID,
    main: '/private/b3/deploy-base/worker.mjs',
    base_dir: '/private/b3/deploy-base',
    compatibility_date: '2026-07-12',
    compatibility_flags: ['nodejs_compat'],
    workers_dev: false,
    routes: [{ pattern: 'b3-gateway.eugnel.uk', custom_domain: true }],
    no_bundle: true,
    find_additional_modules: true,
    rules: [{ type: 'Data', globs: [APPROVED_DER_NAME], fallthrough: false }],
    r2_buckets: [{ binding: 'PACKS', bucket_name: BUCKET_NAME, remote: true }],
    version_metadata: { binding: 'WORKER_VERSION_METADATA' },
    ratelimits: [{ name: 'GATEWAY_RATE_LIMIT', namespace_id: '1001', simple: { limit: 60, period: 60 } }],
  });
  assert.doesNotMatch(JSON.stringify(config), /secret|token|\.env|vars/i);
});

test('sterile child environment removes unrelated credentials and process env inheritance', () => {
  const childEnv = createB3SterileCloudflareEnvironment({
    HOME: '/home/test',
    PATH: '/bin',
    TMPDIR: '/tmp',
    CLOUDFLARE_API_TOKEN: 'must-not-cross',
    AWS_SECRET_ACCESS_KEY: 'must-not-cross',
    OPENAI_API_KEY: 'must-not-cross',
  }, { accountId: ACCOUNT_ID });
  assert.deepEqual(childEnv, {
    HOME: '/home/test',
    PATH: '/bin',
    TMPDIR: '/tmp',
    CI: '1',
    NO_COLOR: '1',
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
    CLOUDFLARE_SEND_METRICS: 'false',
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
    CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false',
    WRANGLER_HIDE_BANNER: 'true',
  });
  assert.equal(JSON.stringify(childEnv).includes('must-not-cross'), false);
});

test('parent rejects unsafe child output and both Wrangler runners terminate complete process groups', async (t) => {
  await assert.rejects(runB3CloudflareOAuthChild({ operation: 'test' }, {
    root: ROOT,
    env: createB3SterileCloudflareEnvironment(process.env, { accountId: ACCOUNT_ID }),
    commandRunner: async () => ({
      exitCode: 0,
      stdout: `${JSON.stringify({ ok: true, result: {} })}\n`,
      stderr: 'unapproved diagnostic\n',
    }),
  }), /unapproved stderr/i);
  await assert.rejects(runB3CloudflareOAuthChild({ operation: 'test' }, {
    root: ROOT,
    env: createB3SterileCloudflareEnvironment(process.env, { accountId: ACCOUNT_ID }),
    commandRunner: async () => ({
      exitCode: 0,
      stdout: '{"ok":true,"result":{},"result":{"invented":true}}\n',
      stderr: '',
    }),
  }), /invalid JSON/i);

  if (process.platform === 'win32') t.skip('POSIX process-group termination contract');
  const directory = await mkdtemp(join(tmpdir(), 'b3-wrangler-process-group-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scriptPath = resolve(directory, 'spawn-grandchild.mjs');
  const oauthPidPath = resolve(directory, 'oauth-grandchild.pid');
  const inspectorPidPath = resolve(directory, 'inspector-grandchild.pid');
  await writeFile(scriptPath, [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    'writeFileSync(process.argv[2], String(child.pid));',
    'setInterval(() => {}, 1000);',
  ].join('\n'));

  await assert.rejects(withinHostCeiling(spawnBoundedOAuthCommand(
    process.execPath,
    [scriptPath, oauthPidPath],
    { cwd: directory, env: process.env, timeoutMs: 200 },
  ), 2_000), /exceeded.*bound/i);
  const oauthGrandchildPid = Number(await readFile(oauthPidPath, 'utf8'));
  await waitForProcessExit(oauthGrandchildPid);

  const inspectorResult = await withinHostCeiling(defaultWranglerSpawn(
    process.execPath,
    [scriptPath, inspectorPidPath],
    {
      cwd: directory,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 200,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    },
  ), 2_000);
  assert.equal(inspectorResult.exitCode, 1);
  const inspectorGrandchildPid = Number(await readFile(inspectorPidPath, 'utf8'));
  await waitForProcessExit(inspectorGrandchildPid);
});

test('OAuth child proves version and exact Script Content v2 main-module bytes without returning token', async () => {
  const source = Buffer.from('export default { fetch() { return new Response("ok"); } };\n');
  const versionId = WORKER_VERSION_ID;
  const calls = [];
  const result = await executeB3CloudflareOAuthOperation({
    schemaVersion: 1,
    operation: 'verify-worker',
    accountId: ACCOUNT_ID,
    workerName: WORKER_NAME,
    deploymentVersionId: versionId,
    deployedSourceSha256: sha256(source),
    mainModuleName: 'worker.mjs',
    dataModules: [],
  }, {
    root: ROOT,
    readOAuthCredential: async () => ({ type: 'oauth', token: 'child-only-token' }),
    fetchImpl: async (url, options) => {
      calls.push({
        url: String(url),
        authorization: options.headers.Authorization,
        method: options.method,
        redirect: options.redirect,
      });
      if (String(url).endsWith('/deployments')) return activeDeploymentResponse(versionId);
      if (String(url).endsWith(`/versions/${versionId}`)) {
        return versionResponse(versionId);
      }
      if (String(url).endsWith(`/content/v2?version=${versionId}`)) {
        return new Response(source, { headers: { 'content-type': 'application/javascript' } });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });
  assert.deepEqual(result, { deploymentVersionId: versionId, deployedSourceSha256: sha256(source) });
  assert.equal(JSON.stringify(result).includes('child-only-token'), false);
  assert.equal(calls.length, 4);
  assert.equal(calls.every((call) => call.authorization === 'Bearer child-only-token'), true);
  assert.equal(calls.every((call) => call.method === 'GET'), true);
  assert.equal(calls.every((call) => call.redirect === 'error'), true);
  assert.deepEqual(calls.map((call) => call.url), [
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/deployments`,
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/versions/${versionId}`,
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/content/v2?version=${versionId}`,
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/deployments`,
  ]);

  await assert.rejects(
    executeB3CloudflareOAuthOperation({
      schemaVersion: 1,
      operation: 'verify-worker',
      accountId: ACCOUNT_ID,
      workerName: WORKER_NAME,
      deploymentVersionId: versionId,
      deployedSourceSha256: '0'.repeat(64),
      mainModuleName: 'worker.mjs',
      dataModules: [],
    }, {
      root: ROOT,
      readOAuthCredential: async () => ({ type: 'oauth', token: 'child-only-token' }),
      fetchImpl: async (url) => String(url).endsWith('/deployments')
        ? activeDeploymentResponse(versionId)
        : String(url).endsWith(`/versions/${versionId}`)
          ? versionResponse(versionId)
        : String(url).endsWith(`/content/v2?version=${versionId}`)
          ? new Response(source, { headers: { 'content-type': 'application/javascript' } })
          : (() => { throw new Error(`unexpected URL ${url}`); })(),
    }),
    /deployed Worker bytes differ/i,
  );

  let contentCalls = 0;
  await assert.rejects(executeB3CloudflareOAuthOperation({
    schemaVersion: 1,
    operation: 'verify-worker',
    accountId: ACCOUNT_ID,
    workerName: WORKER_NAME,
    deploymentVersionId: versionId,
    deployedSourceSha256: sha256(source),
    mainModuleName: 'worker.mjs',
    dataModules: [],
  }, {
    root: ROOT,
    readOAuthCredential: async () => ({ type: 'oauth', token: 'child-only-token' }),
    fetchImpl: async (url) => {
      if (String(url).endsWith('/deployments')) return activeDeploymentResponse(versionId);
      if (String(url).endsWith(`/versions/${versionId}`)) {
        return versionResponse('wrong-version');
      }
      contentCalls += 1;
      return new Response(source);
    },
  }), /version identity differs/i);
  assert.equal(contentCalls, 0);

  let deploymentReads = 0;
  await assert.rejects(executeB3CloudflareOAuthOperation({
    schemaVersion: 1,
    operation: 'verify-worker',
    accountId: ACCOUNT_ID,
    workerName: WORKER_NAME,
    deploymentVersionId: versionId,
    deployedSourceSha256: sha256(source),
    mainModuleName: 'worker.mjs',
    dataModules: [],
  }, {
    root: ROOT,
    readOAuthCredential: async () => ({ type: 'oauth', token: 'child-only-token' }),
    fetchImpl: async (url) => {
      if (String(url).endsWith('/deployments')) {
        deploymentReads += 1;
        const response = activeDeploymentResponse(versionId);
        if (deploymentReads === 1) return response;
        const body = await response.json();
        body.result.deployments[0].id = 'deployment-switched-during-read';
        return Response.json(body);
      }
      if (String(url).endsWith(`/versions/${versionId}`)) return versionResponse(versionId);
      if (String(url).endsWith(`/content/v2?version=${versionId}`)) {
        return new Response(source, { headers: { 'content-type': 'application/javascript' } });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  }), /deployment changed during content readback/i);

  const rejectedVersion = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
  let credentialReads = 0;
  let fetchCalls = 0;
  let rejection;
  try {
    await executeB3CloudflareOAuthOperation({
    schemaVersion: 1,
    operation: 'verify-worker',
    accountId: ACCOUNT_ID,
    workerName: WORKER_NAME,
    deploymentVersionId: rejectedVersion,
    deployedSourceSha256: 'a'.repeat(64),
    mainModuleName: 'worker.mjs',
    dataModules: [],
  }, {
    root: ROOT,
    readOAuthCredential: async () => {
      credentialReads += 1;
      return { type: 'oauth', token: 'child-only-token' };
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('network must not be reached');
    },
    });
  } catch (error) {
    rejection = error;
  }
  assert.match(rejection?.message ?? '', /Worker version or main-module authority is invalid/i);
  assert.deepEqual({ credentialReads, fetchCalls }, { credentialReads: 0, fetchCalls: 0 });
  assert.equal(rejection.message.includes(rejectedVersion), false);
});

test('OAuth child rejects 301, 302, 307 and 308 at every authenticated API endpoint without following', async (t) => {
  const source = Buffer.from('export default {};\n');
  const endpointKinds = ['deployments', 'versions', 'content', 'domains'];
  for (const status of [301, 302, 307, 308]) {
    for (const endpointKind of endpointKinds) {
      await t.test(`${status} ${endpointKind}`, async () => {
        const calls = [];
        const isTarget = (url) => (
          (endpointKind === 'deployments' && url.endsWith('/deployments')) ||
          (endpointKind === 'versions' && url.endsWith(`/versions/${ACTIVE_VERSION_ID}`)) ||
          (endpointKind === 'content' && url.includes('/content/v2?version=')) ||
          (endpointKind === 'domains' && url.includes('/workers/domains?service='))
        );
        await assert.rejects(executeB3CloudflareOAuthOperation({
          schemaVersion: 1,
          operation: 'inspect-worker-state',
          accountId: ACCOUNT_ID,
          workerName: WORKER_NAME,
          bucketName: BUCKET_NAME,
          publicHostname: 'b3-gateway.eugnel.uk',
          deploymentVersionId: ACTIVE_VERSION_ID,
          deployedSourceSha256: sha256(source),
          mainModuleName: 'worker.mjs',
          dataModules: [],
        }, {
          root: ROOT,
          readOAuthCredential: async () => ({ type: 'oauth', token: 'matrix-secret-token' }),
          inspectWorkerStateImpl: async () => { throw new Error('inspector must not be reached'); },
          fetchImpl: async (url, options) => {
            const request = {
              url: String(url),
              method: options.method,
              redirect: options.redirect,
              authorization: options.headers.Authorization,
            };
            calls.push(request);
            if (isTarget(request.url)) {
              return new Response(null, {
                status,
                headers: { location: 'https://attacker.invalid/credential-capture' },
              });
            }
            if (request.url.endsWith('/deployments')) return activeDeploymentResponse(ACTIVE_VERSION_ID);
            if (request.url.endsWith(`/versions/${ACTIVE_VERSION_ID}`)) return versionResponse(ACTIVE_VERSION_ID);
            if (request.url.includes('/content/v2?version=')) {
              return new Response(source, { headers: { 'content-type': 'application/javascript' } });
            }
            throw new Error(`unexpected URL ${request.url}`);
          },
        }), /redirect/i);
        assert.equal(calls.filter((call) => isTarget(call.url)).length, 1);
        assert.equal(calls.some((call) => call.url.includes('attacker.invalid')), false);
        assert.equal(calls.every((call) => call.method === 'GET'), true);
        assert.equal(calls.every((call) => call.redirect === 'error'), true);
        assert.equal(calls.every((call) => call.authorization === 'Bearer matrix-secret-token'), true);
      });
    }
  }
});

test('OAuth child bounds multipart Content v2 and rejects duplicate, missing or unapproved modules', async () => {
  const source = Buffer.from('export default {};\n');
  const data = Buffer.from('der-data');
  const versionId = MULTIPART_VERSION_ID;
  const document = {
    schemaVersion: 1,
    operation: 'verify-worker',
    accountId: ACCOUNT_ID,
    workerName: WORKER_NAME,
    deploymentVersionId: versionId,
    deployedSourceSha256: sha256(source),
    mainModuleName: 'worker.mjs',
    dataModules: [{ name: 'root.der', size: data.length, sha256: sha256(data) }],
  };
  let duplicateFetchCalls = 0;
  await assert.rejects(executeB3CloudflareOAuthOperation({
    ...document,
    deploymentVersionId: WORKER_VERSION_ID,
    deployedSourceSha256: 'a'.repeat(64),
    dataModules: [],
  }, {
    root: ROOT,
    readOAuthCredential: async () => ({ type: 'oauth', token: 'child-only-token' }),
    fetchImpl: async () => {
      duplicateFetchCalls += 1;
      return new Response('{"success":true,"result":{},"result":{"deployments":[]}}', {
        headers: { 'content-type': 'application/json' },
      });
    },
  }), /did not return valid JSON/i);
  assert.equal(duplicateFetchCalls, 1);
  const contentResponse = (extra = false, entrypoint = 'worker.mjs') => {
    const form = new FormData();
    form.append('worker.mjs', new Blob([source]), 'worker.mjs');
    form.append('root.der', new Blob([data]), 'root.der');
    if (extra) form.append('third.der', new Blob([data]), 'third.der');
    const response = new Response(form);
    response.headers.set('cf-entrypoint', entrypoint);
    return response;
  };
  const result = await executeB3CloudflareOAuthOperation(document, {
    root: ROOT,
    readOAuthCredential: async () => ({ type: 'oauth', token: 'child-only-token' }),
    fetchImpl: async (url) => String(url).endsWith('/deployments')
      ? activeDeploymentResponse(versionId)
      : String(url).endsWith(`/versions/${versionId}`)
        ? versionResponse(versionId)
        : String(url).endsWith(`/content/v2?version=${versionId}`)
          ? contentResponse()
          : (() => { throw new Error(`unexpected URL ${url}`); })(),
  });
  assert.equal(result.deployedSourceSha256, sha256(source));
  await assert.rejects(executeB3CloudflareOAuthOperation(document, {
    root: ROOT,
    readOAuthCredential: async () => ({ type: 'oauth', token: 'child-only-token' }),
    fetchImpl: async (url) => String(url).endsWith('/deployments')
      ? activeDeploymentResponse(versionId)
      : String(url).endsWith(`/versions/${versionId}`)
        ? versionResponse(versionId)
        : String(url).endsWith(`/content/v2?version=${versionId}`)
          ? contentResponse(true)
          : (() => { throw new Error(`unexpected URL ${url}`); })(),
  }), /unapproved module/i);
  await assert.rejects(executeB3CloudflareOAuthOperation(document, {
    root: ROOT,
    readOAuthCredential: async () => ({ type: 'oauth', token: 'child-only-token' }),
    fetchImpl: async (url) => String(url).endsWith('/deployments')
      ? activeDeploymentResponse(versionId)
      : String(url).endsWith(`/versions/${versionId}`)
        ? versionResponse(versionId)
        : String(url).endsWith(`/content/v2?version=${versionId}`)
          ? contentResponse(false, 'wrong.mjs')
          : (() => { throw new Error(`unexpected URL ${url}`); })(),
  }), /main-module metadata differs/i);
  await assert.rejects(executeB3CloudflareOAuthOperation(document, {
    root: ROOT,
    readOAuthCredential: async () => ({ type: 'oauth', token: 'child-only-token' }),
    fetchImpl: async (url) => String(url).endsWith('/deployments')
      ? activeDeploymentResponse(versionId)
      : String(url).endsWith(`/versions/${versionId}`)
        ? versionResponse(versionId)
        : String(url).endsWith(`/content/v2?version=${versionId}`)
          ? new Response('small', { headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(20 * 1024 * 1024) } })
          : (() => { throw new Error(`unexpected URL ${url}`); })(),
  }), /exceeded its bound/i);
});

test('OAuth child derives closed worker runtime, active deployment and custom-domain route authority', async () => {
  const versionId = ACTIVE_VERSION_ID;
  const source = Buffer.from('export default {};\n');
  let deploymentReads = 0;
  let versionReads = 0;
  let domainReads = 0;
  let inspectorReads = 0;
  const result = await executeB3CloudflareOAuthOperation({
    schemaVersion: 1,
    operation: 'inspect-worker-state',
    accountId: ACCOUNT_ID,
    workerName: WORKER_NAME,
    bucketName: BUCKET_NAME,
    publicHostname: 'b3-gateway.eugnel.uk',
    deploymentVersionId: versionId,
    deployedSourceSha256: sha256(source),
    mainModuleName: 'worker.mjs',
    dataModules: [],
  }, {
    root: ROOT,
    readOAuthCredential: async () => ({ type: 'oauth', token: 'child-only-token' }),
    fetchImpl: async (url) => {
      if (String(url).endsWith('/deployments')) {
        deploymentReads += 1;
        return activeDeploymentResponse(versionId);
      }
      if (String(url).endsWith(`/versions/${versionId}`)) {
        versionReads += 1;
        return versionResponse(versionId);
      }
      if (String(url).endsWith(`/content/v2?version=${versionId}`)) {
        return new Response(source, { headers: { 'content-type': 'application/javascript' } });
      }
      if (String(url).endsWith(`/workers/domains?service=${WORKER_NAME}`)) {
        domainReads += 1;
        return Response.json({
          success: true,
          result: [{ hostname: 'b3-gateway.eugnel.uk', service: WORKER_NAME, environment: 'production' }],
        });
      }
      throw new Error(`unexpected URL ${url}`);
    },
    inspectWorkerStateImpl: async () => {
      inspectorReads += 1;
      return ({
      oauthAvailable: true,
      accountId: ACCOUNT_ID,
      workerName: WORKER_NAME,
      privateR2BucketName: BUCKET_NAME,
      bindingNames: ['GATEWAY_RATE_LIMIT', 'PACKS', 'WORKER_VERSION_METADATA'],
      bindingTypes: { GATEWAY_RATE_LIMIT: 'ratelimit', PACKS: 'r2_bucket', WORKER_VERSION_METADATA: 'version_metadata' },
      boundR2BucketName: BUCKET_NAME,
      versionSecretNames: ['APPLE_IAP_ISSUER_ID', 'APPLE_IAP_KEY_ID', 'APPLE_IAP_PRIVATE_KEY', 'ENTITLEMENT_HANDLE_KEY_CURRENT', 'ENTITLEMENT_HANDLE_KEY_PREVIOUS', 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON', 'R2_CAPABILITY_HMAC_KEY'],
      secretNames: ['APPLE_IAP_ISSUER_ID', 'APPLE_IAP_KEY_ID', 'APPLE_IAP_PRIVATE_KEY', 'ENTITLEMENT_HANDLE_KEY_CURRENT', 'ENTITLEMENT_HANDLE_KEY_PREVIOUS', 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON', 'R2_CAPABILITY_HMAC_KEY'],
      r2DevUrlPublicAccess: false,
      hasCustomDomains: false,
      });
    },
  });
  assert.deepEqual({ deploymentReads, versionReads, domainReads, inspectorReads }, {
    deploymentReads: 3,
    versionReads: 2,
    domainReads: 2,
    inspectorReads: 2,
  });
  assert.deepEqual(result, {
    deploymentVersionId: versionId,
    deployedSourceSha256: sha256(source),
    accountId: ACCOUNT_ID,
    workerName: WORKER_NAME,
    publicSandboxOrigin: 'https://b3-gateway.eugnel.uk',
    bucketName: BUCKET_NAME,
    compatibilityDate: '2026-07-12',
    compatibilityFlags: ['nodejs_compat'],
    bindings: { r2: 'PACKS', rateLimit: 'GATEWAY_RATE_LIMIT', versionMetadata: 'WORKER_VERSION_METADATA' },
    requiredSecretNames: ['APPLE_IAP_ISSUER_ID', 'APPLE_IAP_KEY_ID', 'APPLE_IAP_PRIVATE_KEY', 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON', 'ENTITLEMENT_HANDLE_KEY_CURRENT', 'ENTITLEMENT_HANDLE_KEY_PREVIOUS', 'R2_CAPABILITY_HMAC_KEY'],
    bucketPrivate: true,
    r2DevPublicAccess: false,
    customDomains: [],
  });
});

test('OAuth child rejects worker state when the bound version runtime changes during inspection', async () => {
  const versionId = DRIFTING_VERSION_ID;
  const source = Buffer.from('export default {};\n');
  let versionReads = 0;
  const inspected = {
    oauthAvailable: true,
    accountId: ACCOUNT_ID,
    workerName: WORKER_NAME,
    privateR2BucketName: BUCKET_NAME,
    bindingNames: ['GATEWAY_RATE_LIMIT', 'PACKS', 'WORKER_VERSION_METADATA'],
    bindingTypes: { GATEWAY_RATE_LIMIT: 'ratelimit', PACKS: 'r2_bucket', WORKER_VERSION_METADATA: 'version_metadata' },
    boundR2BucketName: BUCKET_NAME,
    versionSecretNames: ['APPLE_IAP_ISSUER_ID', 'APPLE_IAP_KEY_ID', 'APPLE_IAP_PRIVATE_KEY', 'ENTITLEMENT_HANDLE_KEY_CURRENT', 'ENTITLEMENT_HANDLE_KEY_PREVIOUS', 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON', 'R2_CAPABILITY_HMAC_KEY'],
    secretNames: ['APPLE_IAP_ISSUER_ID', 'APPLE_IAP_KEY_ID', 'APPLE_IAP_PRIVATE_KEY', 'ENTITLEMENT_HANDLE_KEY_CURRENT', 'ENTITLEMENT_HANDLE_KEY_PREVIOUS', 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON', 'R2_CAPABILITY_HMAC_KEY'],
    r2DevUrlPublicAccess: false,
    hasCustomDomains: false,
  };
  await assert.rejects(executeB3CloudflareOAuthOperation({
    schemaVersion: 1,
    operation: 'inspect-worker-state',
    accountId: ACCOUNT_ID,
    workerName: WORKER_NAME,
    bucketName: BUCKET_NAME,
    publicHostname: 'b3-gateway.eugnel.uk',
    deploymentVersionId: versionId,
    deployedSourceSha256: sha256(source),
    mainModuleName: 'worker.mjs',
    dataModules: [],
  }, {
    root: ROOT,
    readOAuthCredential: async () => ({ type: 'oauth', token: 'child-only-token' }),
    fetchImpl: async (url) => {
      if (String(url).endsWith('/deployments')) return activeDeploymentResponse(versionId);
      if (String(url).endsWith(`/versions/${versionId}`)) {
        versionReads += 1;
        const response = versionResponse(versionId);
        if (versionReads === 1) return response;
        const body = await response.json();
        body.result.resources.script_runtime.compatibility_flags = [];
        return Response.json(body);
      }
      if (String(url).endsWith(`/content/v2?version=${versionId}`)) return new Response(source);
      if (String(url).endsWith(`/workers/domains?service=${WORKER_NAME}`)) {
        return Response.json({
          success: true,
          result: [{ hostname: 'b3-gateway.eugnel.uk', service: WORKER_NAME, environment: 'production' }],
        });
      }
      throw new Error(`unexpected URL ${url}`);
    },
    inspectWorkerStateImpl: async () => structuredClone(inspected),
  }), /runtime.*changed|state.*changed/i);
});

test('OAuth child rejects a third R2 key before proxy creation', async () => {
  let proxyCalls = 0;
  await assert.rejects(
    executeB3CloudflareOAuthOperation({
      schemaVersion: 1,
      operation: 'inspect-object',
      accountId: ACCOUNT_ID,
      bucketName: BUCKET_NAME,
      role: 'archive',
      key: 'packs/third-object.zip',
      configPath: '/tmp/untrusted.json',
    }, {
      root: ROOT,
      getPlatformProxyImpl: async () => { proxyCalls += 1; },
    }),
    /object authority/i,
  );
  assert.equal(proxyCalls, 0);
});

test('OAuth child rejects duplicate tracked JSON and hard-coded key drift before authentication or proxy creation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'b3-duplicate-authority-'));
  try {
    await mkdir(resolve(directory, 'config'));
    await writeFile(
      resolve(directory, 'config/b3-gateway-authority.json'),
      await readFile(resolve(ROOT, 'config/b3-gateway-authority.json')),
    );
    const authority = await readFile(resolve(ROOT, 'config/b3-pack-object-authority.json'), 'utf8');
    await writeFile(
      resolve(directory, 'config/b3-pack-object-authority.json'),
      authority.replace('"bucketName":', `"bucketName": "${BUCKET_NAME}",\n  "bucketName":`),
    );
    const { entry } = await authorityFixture('archive');
    let authCalls = 0;
    let proxyCalls = 0;
    await assert.rejects(executeB3CloudflareOAuthOperation({
      schemaVersion: 1,
      operation: 'inspect-object',
      accountId: ACCOUNT_ID,
      bucketName: BUCKET_NAME,
      role: entry.role,
      key: entry.key,
      configPath: '/tmp/not-reached.json',
    }, {
      root: directory,
      readOAuthCredential: async () => { authCalls += 1; },
      getPlatformProxyImpl: async () => { proxyCalls += 1; },
    }), /duplicate|tracked object authority/i);
    assert.deepEqual({ authCalls, proxyCalls }, { authCalls: 0, proxyCalls: 0 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('sterile child CLI accepts only stdin and emits no input, key or credential material', () => {
  const result = spawnSync(process.execPath, [resolve(ROOT, 'scripts/lib/b3-cloudflare-oauth-child.mjs')], {
    cwd: ROOT,
    env: createB3SterileCloudflareEnvironment(process.env, { accountId: ACCOUNT_ID }),
    input: JSON.stringify({
      schemaVersion: 1,
      operation: 'inspect-object',
      accountId: ACCOUNT_ID,
      bucketName: BUCKET_NAME,
      role: 'archive',
      key: 'packs/private-third-key.zip',
      configPath: '/tmp/private-config.json',
    }),
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  assert.equal(result.status, 6);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), { ok: false, code: 'b3_cloudflare_live_adapter_invalid' });
  assert.equal(`${result.stdout}${result.stderr}`.includes('private-third-key'), false);
});

test('OAuth child inspects exact remote R2 bytes, SHA, ETag and metadata and always disposes', async () => {
  const directory = await nativeTempDirectory('test-r2-inspect-');
  try {
    const configPath = await derivedConfigFixture(directory);
    const { entry, bytes } = await authorityFixture('archive');
    let disposed = 0;
    const object = remoteObject(entry, bytes);
    const result = await executeB3CloudflareOAuthOperation({
      schemaVersion: 1,
      operation: 'inspect-object',
      accountId: ACCOUNT_ID,
      bucketName: BUCKET_NAME,
      role: entry.role,
      key: entry.key,
      configPath,
    }, {
      root: ROOT,
      readOAuthCredential: async () => ({ type: 'oauth', token: 'child-only-token' }),
      getPlatformProxyImpl: async (options) => {
        assert.deepEqual(options, { configPath, envFiles: [], persist: false, remoteBindings: true });
        return {
          env: { PACKS: { head: async () => object, get: async () => object, put: async () => null } },
          dispose: async () => { disposed += 1; },
        };
      },
    });
    assert.deepEqual(result, {
      key: entry.key,
      sha256: entry.sha256,
      size: entry.bytes,
      etag: entry.etag,
      customMetadata: entry.metadata,
    });
    assert.equal(disposed, 1);

    await assert.rejects(
      executeB3CloudflareOAuthOperation({
        schemaVersion: 1,
        operation: 'inspect-object',
        accountId: ACCOUNT_ID,
        bucketName: BUCKET_NAME,
        role: entry.role,
        key: entry.key,
        configPath,
      }, {
        root: ROOT,
        readOAuthCredential: async () => ({ type: 'oauth', token: 'child-only-token' }),
        getPlatformProxyImpl: async () => ({
          env: { PACKS: { head: async () => object, get: async () => remoteObject(entry, Buffer.from('drift')), put: async () => null } },
          dispose: async () => { disposed += 1; },
        }),
      }),
      /remote object bytes differ/i,
    );
    assert.equal(disposed, 2);

    const headMutations = [
      (head) => { head.etag = 'drifted-etag'; },
      (head) => { head.customMetadata = { ...head.customMetadata, 'b3-size': '999' }; },
      (head) => { head.checksums = { sha256: checksumBytes('f'.repeat(64)) }; },
    ];
    for (const mutate of headMutations) {
      const head = remoteObject(entry, bytes);
      mutate(head);
      let getCalls = 0;
      await assert.rejects(executeB3CloudflareOAuthOperation({
        schemaVersion: 1,
        operation: 'inspect-object',
        accountId: ACCOUNT_ID,
        bucketName: BUCKET_NAME,
        role: entry.role,
        key: entry.key,
        configPath,
      }, {
        root: ROOT,
        readOAuthCredential: async () => ({ type: 'oauth', token: 'child-only-token' }),
        getPlatformProxyImpl: async () => ({
          env: { PACKS: { head: async () => head, get: async () => { getCalls += 1; return object; } } },
          dispose: async () => { disposed += 1; },
        }),
      }), /remote object head differs/i);
      assert.equal(getCalls, 0);
    }
    assert.equal(disposed, 5);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('OAuth child uses create-only R2 put and accepts a precondition race only after exact readback', async () => {
  const directory = await nativeTempDirectory('test-r2-upload-');
  try {
    const configPath = await derivedConfigFixture(directory);
    const { entry, bytes } = await authorityFixture('signed-manifest');
    const exact = remoteObject(entry, bytes);
    let headCalls = 0;
    let putOptions;
    let disposed = 0;
    const result = await executeB3CloudflareOAuthOperation({
      schemaVersion: 1,
      operation: 'upload-object',
      accountId: ACCOUNT_ID,
      bucketName: BUCKET_NAME,
      role: entry.role,
      key: entry.key,
      configPath,
      bytesBase64: bytes.toString('base64'),
      customMetadata: entry.metadata,
      sha256: entry.sha256,
    }, {
      root: ROOT,
      readOAuthCredential: async () => ({ type: 'oauth', token: 'child-only-token' }),
      getPlatformProxyImpl: async () => ({
        env: { PACKS: {
          head: async () => { headCalls += 1; return headCalls === 1 ? null : exact; },
          get: async () => exact,
          put: async (_key, suppliedBytes, options) => {
            assert.equal(Buffer.from(suppliedBytes).equals(bytes), true);
            putOptions = options;
            return putResult(entry);
          },
        } },
        dispose: async () => { disposed += 1; },
      }),
    });
    assert.deepEqual(result, {
      key: entry.key,
      sha256: entry.sha256,
      size: entry.bytes,
      etag: entry.etag,
      customMetadata: entry.metadata,
    });
    assert.deepEqual(putOptions.onlyIf, { etagDoesNotMatch: '*' });
    assert.equal(putOptions.sha256, entry.sha256);
    assert.deepEqual(putOptions.customMetadata, entry.metadata);
    assert.equal(disposed, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('OAuth child rejects a successful R2 put result that differs from tracked object authority', async () => {
  const directory = await nativeTempDirectory('test-r2-put-result-');
  try {
    const configPath = await derivedConfigFixture(directory);
    const { entry, bytes } = await authorityFixture('archive');
    const exact = remoteObject(entry, bytes);
    let headCalls = 0;
    let getCalls = 0;
    let disposed = 0;
    await assert.rejects(executeB3CloudflareOAuthOperation({
      schemaVersion: 1,
      operation: 'upload-object',
      accountId: ACCOUNT_ID,
      bucketName: BUCKET_NAME,
      role: entry.role,
      key: entry.key,
      configPath,
      bytesBase64: bytes.toString('base64'),
      customMetadata: entry.metadata,
      sha256: entry.sha256,
    }, {
      root: ROOT,
      readOAuthCredential: async () => ({ type: 'oauth', token: 'child-only-token' }),
      getPlatformProxyImpl: async () => ({
        env: { PACKS: {
          head: async () => { headCalls += 1; return null; },
          get: async () => { getCalls += 1; return exact; },
          put: async () => ({ ...putResult(entry), etag: 'drifted-put-etag' }),
        } },
        dispose: async () => { disposed += 1; },
      }),
    }), /put result differs/i);
    assert.equal(headCalls, 1);
    assert.equal(getCalls, 0);
    assert.equal(disposed, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('OAuth child accepts only an exact 412 create race and still proves immediate head plus get', async () => {
  const directory = await nativeTempDirectory('test-r2-race-');
  try {
    const configPath = await derivedConfigFixture(directory);
    const { entry, bytes } = await authorityFixture('archive');
    const exact = remoteObject(entry, bytes);
    let heads = 0;
    let disposed = 0;
    const result = await executeB3CloudflareOAuthOperation({
      schemaVersion: 1,
      operation: 'upload-object',
      accountId: ACCOUNT_ID,
      bucketName: BUCKET_NAME,
      role: entry.role,
      key: entry.key,
      configPath,
      bytesBase64: bytes.toString('base64'),
      customMetadata: entry.metadata,
      sha256: entry.sha256,
    }, {
      root: ROOT,
      readOAuthCredential: async () => ({ type: 'oauth', token: 'child-only-token' }),
      getPlatformProxyImpl: async () => ({
        env: { PACKS: {
          head: async () => { heads += 1; return heads === 1 ? null : exact; },
          get: async () => exact,
          put: async () => { throw Object.assign(new Error('Precondition Failed'), { status: 412 }); },
        } },
        dispose: async () => { disposed += 1; },
      }),
    });
    assert.equal(result.sha256, entry.sha256);
    assert.equal(heads, 2);
    assert.equal(disposed, 1);

    await assert.rejects(
      executeB3CloudflareOAuthOperation({
        schemaVersion: 1,
        operation: 'upload-object',
        accountId: ACCOUNT_ID,
        bucketName: BUCKET_NAME,
        role: entry.role,
        key: entry.key,
        configPath,
        bytesBase64: bytes.toString('base64'),
        customMetadata: entry.metadata,
        sha256: entry.sha256,
      }, {
        root: ROOT,
        readOAuthCredential: async () => ({ type: 'oauth', token: 'child-only-token' }),
        getPlatformProxyImpl: async () => ({
          env: { PACKS: { head: async () => null, get: async () => exact, put: async () => { throw Object.assign(new Error('server error'), { status: 500 }); } } },
          dispose: async () => { disposed += 1; },
        }),
      }),
      /server error/i,
    );
    assert.equal(disposed, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('OAuth child enforces cooperative remote-operation deadlines and still disposes the proxy', async () => {
  const directory = await nativeTempDirectory('test-r2-deadline-');
  try {
    const workerDocument = {
      schemaVersion: 1,
      operation: 'verify-worker',
      accountId: ACCOUNT_ID,
      workerName: WORKER_NAME,
      deploymentVersionId: WORKER_VERSION_ID,
      deployedSourceSha256: 'a'.repeat(64),
      mainModuleName: 'worker.mjs',
      dataModules: [],
    };
    let fetchCalls = 0;
    await assert.rejects(withinHostCeiling(executeB3CloudflareOAuthOperation(workerDocument, {
      root: ROOT,
      deadlineMs: 10,
      readOAuthCredential: async () => ({ type: 'oauth', token: 'child-only-token' }),
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Promise(() => {});
      },
    })), /fetch.*deadline/i);
    assert.equal(fetchCalls, 1);

    let readCalls = 0;
    let cancelCalls = 0;
    await assert.rejects(withinHostCeiling(executeB3CloudflareOAuthOperation(workerDocument, {
      root: ROOT,
      deadlineMs: 10,
      readOAuthCredential: async () => ({ type: 'oauth', token: 'child-only-token' }),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        redirected: false,
        headers: new Headers(),
        body: {
          getReader: () => ({
            read: async () => {
              readCalls += 1;
              return new Promise(() => {});
            },
            cancel: async () => {
              cancelCalls += 1;
              return new Promise(() => {});
            },
          }),
        },
      }),
    })), /body read.*deadline/i);
    assert.deepEqual({ readCalls, cancelCalls }, { readCalls: 1, cancelCalls: 1 });

    const configPath = await derivedConfigFixture(directory);
    const { entry, bytes } = await authorityFixture('archive');
    const exact = remoteObject(entry, bytes);
    let disposed = 0;
    await assert.rejects(withinHostCeiling(executeB3CloudflareOAuthOperation({
      schemaVersion: 1,
      operation: 'inspect-object',
      accountId: ACCOUNT_ID,
      bucketName: BUCKET_NAME,
      role: entry.role,
      key: entry.key,
      configPath,
    }, {
      root: ROOT,
      deadlineMs: 10,
      readOAuthCredential: async () => ({ type: 'oauth', token: 'child-only-token' }),
      getPlatformProxyImpl: async () => ({
        env: { PACKS: {
          head: async () => new Promise(() => {}),
          get: async () => exact,
        } },
        dispose: async () => {
          disposed += 1;
          return new Promise(() => {});
        },
      }),
    })), /deadline/i);
    assert.equal(disposed, 1);

    let cancellationDisposed = 0;
    const rejectingBody = {
      ...exact,
      body: {
        getReader: () => ({
          read: async () => { throw new Error('stream failed'); },
          cancel: async () => new Promise(() => {}),
        }),
      },
    };
    await assert.rejects(withinHostCeiling(executeB3CloudflareOAuthOperation({
      schemaVersion: 1,
      operation: 'inspect-object',
      accountId: ACCOUNT_ID,
      bucketName: BUCKET_NAME,
      role: entry.role,
      key: entry.key,
      configPath,
    }, {
      root: ROOT,
      deadlineMs: 10,
      readOAuthCredential: async () => ({ type: 'oauth', token: 'child-only-token' }),
      getPlatformProxyImpl: async () => ({
        env: { PACKS: { head: async () => exact, get: async () => rejectingBody } },
        dispose: async () => { cancellationDisposed += 1; },
      }),
    })), /stream failed/i);
    assert.equal(cancellationDisposed, 1);

    let lateDisposed = 0;
    await assert.rejects(executeB3CloudflareOAuthOperation({
      schemaVersion: 1,
      operation: 'inspect-object',
      accountId: ACCOUNT_ID,
      bucketName: BUCKET_NAME,
      role: entry.role,
      key: entry.key,
      configPath,
    }, {
      root: ROOT,
      deadlineMs: 10,
      readOAuthCredential: async () => ({ type: 'oauth', token: 'child-only-token' }),
      getPlatformProxyImpl: async () => new Promise((accept) => setTimeout(() => accept({
        env: { PACKS: { head: async () => exact, get: async () => exact } },
        dispose: async () => { lateDisposed += 1; },
      }), 40)),
    }), /getPlatformProxy.*deadline/i);
    await new Promise((accept) => setTimeout(accept, 60));
    assert.equal(lateDisposed, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('OAuth child rejects derived config outside private canonical native-build authority before proxy creation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'b3-config-outside-'));
  try {
    const configPath = await derivedConfigFixture(directory);
    const { entry } = await authorityFixture('archive');
    let proxyCalls = 0;
    await assert.rejects(executeB3CloudflareOAuthOperation({
      schemaVersion: 1,
      operation: 'inspect-object',
      accountId: ACCOUNT_ID,
      bucketName: BUCKET_NAME,
      role: entry.role,
      key: entry.key,
      configPath,
    }, {
      root: ROOT,
      getPlatformProxyImpl: async () => { proxyCalls += 1; },
    }), /derived Wrangler config path is not private/i);
    assert.equal(proxyCalls, 0);

    await chmod(configPath, 0o644);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('OAuth child rejects remote-binding config drift and non-private mode before OAuth or proxy creation', async () => {
  const directory = await nativeTempDirectory('test-config-drift-');
  try {
    const configPath = await derivedConfigFixture(directory);
    const { entry } = await authorityFixture('archive');
    const document = {
      schemaVersion: 1,
      operation: 'inspect-object',
      accountId: ACCOUNT_ID,
      bucketName: BUCKET_NAME,
      role: entry.role,
      key: entry.key,
      configPath,
    };
    let authCalls = 0;
    let proxyCalls = 0;
    const options = {
      root: ROOT,
      readOAuthCredential: async () => { authCalls += 1; return { type: 'oauth', token: 'child-only-token' }; },
      getPlatformProxyImpl: async () => { proxyCalls += 1; },
    };
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.r2_buckets[0].remote = false;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await assert.rejects(executeB3CloudflareOAuthOperation(document, options), /closed B3 remote-binding config/i);
    assert.deepEqual({ authCalls, proxyCalls }, { authCalls: 0, proxyCalls: 0 });

    config.r2_buckets[0].remote = true;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await chmod(configPath, 0o644);
    await assert.rejects(executeB3CloudflareOAuthOperation(document, options), /path is not private/i);
    assert.deepEqual({ authCalls, proxyCalls }, { authCalls: 0, proxyCalls: 0 });

    await chmod(configPath, 0o600);
    let disposed = 0;
    await assert.rejects(executeB3CloudflareOAuthOperation(document, {
      root: ROOT,
      readOAuthCredential: async () => { authCalls += 1; return { type: 'oauth', token: 'child-only-token' }; },
      getPlatformProxyImpl: async () => {
        proxyCalls += 1;
        return { env: { PACKS_DRIFTED: {} }, dispose: async () => { disposed += 1; } };
      },
    }), /remote PACKS binding is unavailable/i);
    assert.deepEqual({ authCalls, proxyCalls, disposed }, { authCalls: 1, proxyCalls: 1, disposed: 1 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('default primitives use pinned dry-run, no-bundle deploy and closed child documents without inherited secrets', async () => {
  const calls = [];
  const childDocuments = [];
  const source = `const BUILD = '${'0'.repeat(64)}';\nexport default BUILD;\n`;
  const scriptAuthoritySha256 = 'a'.repeat(64);
  const boundSource = source.replace('0'.repeat(64), scriptAuthoritySha256);
  const deployedSha = sha256(Buffer.from(boundSource));
  const versionId = CLOSED_VERSION_ID;
  const { entry, bytes } = await authorityFixture('signed-manifest');
  const approvedDerBytes = await readFile(resolve(ROOT, 'gateway/config/apple-root-certificates/AppleRootCA-G3.der'));
  const commandRunner = async (command, args, options) => {
    calls.push({ command, args, options });
    assert.equal(command, process.execPath);
    assert.equal(options.env.CLOUDFLARE_API_TOKEN, undefined);
    assert.equal(args[0], resolve(ROOT, 'gateway/node_modules/wrangler/bin/wrangler.js'));
    if (args.includes('--dry-run')) {
      const outdir = args[args.indexOf('--outdir') + 1];
      await mkdir(outdir, { recursive: true, mode: 0o700 });
      const configPath = args[args.indexOf('--config') + 1];
      if (configPath === resolve(ROOT, 'gateway/wrangler.jsonc')) {
        await writeFile(resolve(outdir, 'handler.js'), source);
      } else {
        const config = JSON.parse(await readFile(configPath, 'utf8'));
        assert.equal(args.includes('--no-bundle'), true);
        assert.deepEqual((await readdir(config.base_dir)).sort(), [APPROVED_DER_NAME, 'worker.mjs'].sort());
        await writeFile(resolve(outdir, 'worker.mjs'), await readFile(config.main));
      }
      await writeFile(resolve(outdir, APPROVED_DER_NAME), approvedDerBytes);
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    assert.equal(args.includes('--no-bundle'), true);
    assert.equal(args.includes('--dry-run'), false);
    const configPath = args[args.indexOf('--config') + 1];
    assert.equal(configPath.startsWith(resolve(ROOT, '.native-build/b3/')), true);
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    assert.deepEqual((await readdir(config.base_dir)).sort(), [APPROVED_DER_NAME, 'worker.mjs'].sort());
    assert.deepEqual(config.rules, [{ type: 'Data', globs: [APPROVED_DER_NAME], fallthrough: false }]);
    assert.equal(config.main, resolve(config.base_dir, 'worker.mjs'));
    await writeFile(options.env.WRANGLER_OUTPUT_FILE_PATH, `${JSON.stringify({
      type: 'deploy',
      version: 1,
      worker_name: WORKER_NAME,
      version_id: versionId,
      worker_name_overridden: false,
    })}\n`, { flag: 'wx', mode: 0o600 });
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const childRunner = async (document, context) => {
    childDocuments.push(structuredClone(document));
    assert.deepEqual(Object.keys(context.env).sort(), [
      'CI', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_INCLUDE_PROCESS_ENV',
      'CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV', 'CLOUDFLARE_SEND_METRICS',
      'HOME', 'NO_COLOR', 'PATH', 'TMPDIR', 'WRANGLER_HIDE_BANNER',
    ].sort());
    if (document.operation === 'verify-worker') {
      return { deploymentVersionId: versionId, deployedSourceSha256: deployedSha };
    }
    if (document.operation === 'inspect-object') return null;
    if (document.operation === 'upload-object') return {
      key: entry.key,
      sha256: entry.sha256,
      size: entry.bytes,
      etag: entry.etag,
      customMetadata: entry.metadata,
    };
    if (document.operation === 'inspect-worker-state') return {
      deploymentVersionId: versionId,
      deployedSourceSha256: deployedSha,
      accountId: ACCOUNT_ID,
      workerName: WORKER_NAME,
      publicSandboxOrigin: 'https://b3-gateway.eugnel.uk',
      bucketName: BUCKET_NAME,
      compatibilityDate: '2026-07-12',
      compatibilityFlags: ['nodejs_compat'],
      bindings: { r2: 'PACKS', rateLimit: 'GATEWAY_RATE_LIMIT', versionMetadata: 'WORKER_VERSION_METADATA' },
      requiredSecretNames: ['APPLE_IAP_ISSUER_ID', 'APPLE_IAP_KEY_ID', 'APPLE_IAP_PRIVATE_KEY', 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON', 'ENTITLEMENT_HANDLE_KEY_CURRENT', 'ENTITLEMENT_HANDLE_KEY_PREVIOUS', 'R2_CAPABILITY_HMAC_KEY'],
      bucketPrivate: true,
      r2DevPublicAccess: false,
      customDomains: [],
    };
    throw new Error('unexpected child operation');
  };
  const primitives = createDefaultB3CloudflarePrimitives({
    root: ROOT,
    env: { HOME: '/home/test', PATH: '/bin', TMPDIR: '/tmp', CLOUDFLARE_API_TOKEN: 'must-not-cross' },
    commandRunner,
    childRunner,
    smokeRunner: async (request) => ({ request }),
  });
  const dryRun = await primitives.dryRunBundle({ placeholder: '0'.repeat(64) });
  assert.deepEqual(dryRun, { source, normalised: true });
  const deployment = await primitives.deployExactBundle({
    source: boundSource,
    scriptAuthoritySha256,
    deployedSourceSha256: deployedSha,
  });
  assert.deepEqual(deployment, { deploymentVersionId: versionId, deployedSourceSha256: deployedSha });
  assert.deepEqual(await primitives.inspectVersionApi({
    deploymentVersionId: versionId,
    deployedSourceSha256: deployedSha,
    scriptAuthoritySha256,
  }), {
    deploymentVersionId: versionId,
    deployedSourceSha256: deployedSha,
  });
  const workerState = await primitives.inspectWorkerState();
  const stateDocument = childDocuments.find((document) => document.operation === 'inspect-worker-state');
  assert.equal(stateDocument.deploymentVersionId, versionId);
  assert.equal(stateDocument.deployedSourceSha256, deployedSha);
  assert.equal(stateDocument.mainModuleName, 'worker.mjs');
  assert.deepEqual(stateDocument.dataModules, [{
    name: APPROVED_DER_NAME,
    size: 583,
    sha256: '63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179',
  }]);
  assert.equal(workerState.bucketPrivate, true);
  assert.equal(workerState.r2DevPublicAccess, false);
  assert.equal(await primitives.inspectObject({ role: entry.role, key: entry.key }), null);
  await primitives.uploadObject({
    role: entry.role,
    key: entry.key,
    bytes,
    customMetadata: entry.metadata,
    noOverwrite: true,
  });
  assert.deepEqual((await primitives.smokeGateway({ value: true })).request, { value: true });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].args.includes('--dry-run'), true);
  assert.equal(calls[0].args.includes('--env-file'), true);
  assert.equal(calls[1].args.includes('--dry-run'), true);
  assert.equal(calls[1].args.includes('--no-bundle'), true);
  assert.equal(calls[2].args.includes('--dry-run'), false);
  assert.equal(calls[2].args.includes('--no-bundle'), true);
  assert.equal(childDocuments.map((document) => document.operation).join(','), 'verify-worker,inspect-worker-state,inspect-object,upload-object');
  assert.equal(JSON.stringify(childDocuments).includes('must-not-cross'), false);
});
