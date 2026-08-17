import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseRefreshHandleKeyring } from '../gateway/src/refresh-handle.js';
import { parseR2CapabilitySecret } from '../gateway/src/r2-capability.js';
import {
  DEFAULT_ASC_ISSUER_ID,
  DEFAULT_ASC_KEY_ID,
} from '../scripts/lib/app-store-connect.mjs';
import {
  CEREMONY_REQUIRED_OAUTH_SCOPES,
  GOOGLE_PLAY_SERVICE_ACCOUNT_PATH_ENV,
  assertCeremonyOauthScopes,
  createAutonomousWizardDeps,
  deriveCeremonySecretValues,
  mintEntitlementHandleKeyring,
  runAutonomousGatewayCeremony,
} from '../scripts/lib/gateway-ceremony-driver.mjs';
import {
  CLOUDFLARE_ACCOUNT_ID,
  GATEWAY_CEREMONY_EXECUTE_ENV,
  SANDBOX_CHANNEL,
  PRODUCTION_CHANNEL,
  ceremonyExitCode,
} from '../scripts/lib/gateway-ceremony-wizard.mjs';
import { GOOGLE_PLAY_SERVICE_ACCOUNT_SECRET_NAME } from '../scripts/lib/gateway-required-secret-names.mjs';
import { main, parseChannel } from '../scripts/autonomous-gateway-ceremony.mjs';

const ASC_PEM = '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n';
const PLAY_JSON = '{"type":"service_account","project_id":"fake"}\n';
const PLAY_PATH = '/keys/play-service-account.json';

// The exact scope list wrangler whoami reported on the driving machine on
// 2026-08-17 — the measured state the preflight must reject.
const MEASURED_TOKEN_SCOPES = Object.freeze([
  'account:read',
  'user:read',
  'workers:write',
  'workers_kv:write',
  'workers_routes:write',
  'workers_scripts:write',
  'workers_tail:read',
]);

function sandboxEnv(overrides = {}) {
  return {
    [GATEWAY_CEREMONY_EXECUTE_ENV]: 'owner',
    ASC_PRIVATE_KEY: ASC_PEM,
    [GOOGLE_PLAY_SERVICE_ACCOUNT_PATH_ENV]: PLAY_PATH,
    ...overrides,
  };
}

function fakeReadFile(path) {
  if (path === PLAY_PATH) return Promise.resolve(PLAY_JSON);
  return Promise.reject(new Error(`unexpected read: ${path}`));
}

function sequentialRandomBytes() {
  let fill = 0;
  return (size) => {
    fill += 1;
    return Buffer.alloc(size, fill);
  };
}

// Driver-level fake of the pinned wrangler: captured calls include the
// driver's own preflight (whoami with scopes, the R2 probe) on top of the
// wizard's precondition reads; interactive calls land in runCommandImpl.
function fakeWranglerForDriver({ scopes = [...CEREMONY_REQUIRED_OAUTH_SCOPES], r2ProbeExit = 0 } = {}) {
  const captured = [];
  const commands = [];
  let deployed = false;
  let versionCounter = 0;
  const body = (args) => (args.at(-2) === '--env-file' ? args.slice(0, -2) : args);
  const runCapturedImpl = async (bin, args) => {
    const call = body(args);
    captured.push(call);
    if (call[0] === 'whoami') {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          loggedIn: true,
          authType: 'OAuth Token',
          accounts: [{ id: CLOUDFLARE_ACCOUNT_ID }],
          tokenPermissions: scopes,
        }),
        stderr: '',
      };
    }
    if (call[0] === 'r2' && call[1] === 'bucket' && call[2] === 'list') {
      return { exitCode: r2ProbeExit, stdout: '', stderr: '' };
    }
    if (call[0] === 'r2' && call[2] === 'dev-url') {
      return {
        exitCode: 0,
        stdout: 'Public access via the r2.dev URL is disabled.\n',
        stderr: '',
      };
    }
    if (call[0] === 'r2' && call[2] === 'domain') {
      return {
        exitCode: 0,
        stdout: `Listing custom domains connected to bucket '${call[4]}'...\n` +
          'There are no custom domains connected to this bucket.\n',
        stderr: '',
      };
    }
    if (call[0] === 'deployments') return { exitCode: 0, stdout: 'Current Deployment\n', stderr: '' };
    throw new Error(`unexpected captured wrangler call: ${call.join(' ')}`);
  };
  const runCommandImpl = async (bin, args, options = {}) => {
    const call = body(args);
    commands.push({ call, options });
    if (call[0] === 'versions' && call[1] === 'upload') {
      versionCounter += 1;
      await writeFile(
        options.env.WRANGLER_OUTPUT_FILE_PATH,
        `${JSON.stringify({
          type: 'version-upload',
          version_id: `00000000-0000-4000-8000-00000000000${versionCounter}`,
        })}\n`,
      );
    }
    if (call[0] === 'versions' && call[1] === 'deploy') deployed = true;
    return { exitCode: 0 };
  };
  const probeDns = async () =>
    deployed ? { cname: ['target.example'], a: [], aaaa: [] } : { cname: [], a: [], aaaa: [] };
  return { runCapturedImpl, runCommandImpl, probeDns, captured, commands };
}

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'ks2-ceremony-driver-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function driverOptions(root, fakes, overrides = {}) {
  const logged = [];
  return {
    root,
    args: ['--execute'],
    env: sandboxEnv(),
    channel: SANDBOX_CHANNEL,
    runCapturedImpl: fakes.runCapturedImpl,
    runCommandImpl: fakes.runCommandImpl,
    probeDns: fakes.probeDns,
    resolveBin: async (bin) => bin,
    readFileImpl: fakeReadFile,
    randomBytesImpl: sequentialRandomBytes(),
    log: (line) => logged.push(line),
    logged,
    ...overrides,
  };
}

test('the required OAuth scope set names the re-consent gap, not a phantom r2 scope', () => {
  assert.ok(CEREMONY_REQUIRED_OAUTH_SCOPES.includes('zone:read'));
  assert.ok(CEREMONY_REQUIRED_OAUTH_SCOPES.includes('ssl_certs:write'));
  // The pinned wrangler's OAuth flow has no r2 scope to grant; requiring one
  // would fail closed forever. R2 access is proven by the behavioural probe.
  assert.equal(
    CEREMONY_REQUIRED_OAUTH_SCOPES.some((scope) => scope.startsWith('r2')),
    false,
  );
});

test('the measured 2026-08-17 token fails the scope gate naming the two missing scopes', () => {
  assert.deepEqual(
    assertCeremonyOauthScopes([...CEREMONY_REQUIRED_OAUTH_SCOPES, 'workers_tail:read']),
    [...CEREMONY_REQUIRED_OAUTH_SCOPES, 'workers_tail:read'],
  );
  assert.throws(
    () => assertCeremonyOauthScopes(MEASURED_TOKEN_SCOPES),
    ({ code, message }) =>
      code === 'gateway_ceremony_scope_missing' &&
      message.includes('zone:read') &&
      message.includes('ssl_certs:write') &&
      message.includes('wrangler login'),
  );
  assert.throws(
    () => assertCeremonyOauthScopes(undefined),
    ({ code }) => code === 'gateway_ceremony_scope_missing',
  );
  assert.equal(ceremonyExitCode({ code: 'gateway_ceremony_scope_missing' }), 5);
  assert.equal(ceremonyExitCode({ code: 'gateway_ceremony_secret_derivation_failed' }), 5);
});

test('minted secrets satisfy the gateway parsers they are destined for', () => {
  const keyring = mintEntitlementHandleKeyring();
  const parsed = parseRefreshHandleKeyring({ ...keyring });
  assert.equal(parsed.current.version, 2);
  assert.equal(parsed.previous.version, 1);
  const capability = deriveCeremonySecretValues({
    channel: PRODUCTION_CHANNEL,
    env: { ASC_PRIVATE_KEY: ASC_PEM },
    readFileImpl: fakeReadFile,
  });
  return capability.then((values) => {
    assert.equal(parseR2CapabilitySecret(values.get('R2_CAPABILITY_HMAC_KEY')).byteLength, 32);
  });
});

test('sandbox derivation covers the historical seven; production never reads the Play source', async () => {
  const sandboxReads = [];
  const sandbox = await deriveCeremonySecretValues({
    channel: SANDBOX_CHANNEL,
    env: sandboxEnv(),
    readFileImpl: (path) => {
      sandboxReads.push(path);
      return fakeReadFile(path);
    },
  });
  assert.deepEqual([...sandbox.keys()], [...SANDBOX_CHANNEL.requiredSecretNames]);
  assert.equal(sandbox.get(GOOGLE_PLAY_SERVICE_ACCOUNT_SECRET_NAME), PLAY_JSON);
  assert.equal(sandbox.get('APPLE_IAP_ISSUER_ID'), DEFAULT_ASC_ISSUER_ID);
  assert.equal(sandbox.get('APPLE_IAP_KEY_ID'), DEFAULT_ASC_KEY_ID);
  assert.deepEqual(sandboxReads, [PLAY_PATH]);

  const productionReads = [];
  const production = await deriveCeremonySecretValues({
    channel: PRODUCTION_CHANNEL,
    env: sandboxEnv(),
    readFileImpl: (path) => {
      productionReads.push(path);
      return fakeReadFile(path);
    },
  });
  assert.deepEqual([...production.keys()], [...PRODUCTION_CHANNEL.requiredSecretNames]);
  assert.equal(production.has(GOOGLE_PLAY_SERVICE_ACCOUNT_SECRET_NAME), false);
  assert.deepEqual(productionReads, []);
});

test('secret derivation fails closed on every missing or invalid source', async () => {
  await assert.rejects(
    deriveCeremonySecretValues({
      channel: SANDBOX_CHANNEL,
      env: { [GOOGLE_PLAY_SERVICE_ACCOUNT_PATH_ENV]: PLAY_PATH },
      home: '/nowhere',
      readFileImpl: () => Promise.reject(new Error('missing')),
    }),
    ({ code, message }) =>
      code === 'gateway_ceremony_secret_derivation_failed' && message.includes('.p8'),
  );
  await assert.rejects(
    deriveCeremonySecretValues({
      channel: SANDBOX_CHANNEL,
      env: { ASC_PRIVATE_KEY: ASC_PEM },
      readFileImpl: fakeReadFile,
    }),
    ({ code, message }) =>
      code === 'gateway_ceremony_secret_derivation_failed' &&
      message.includes(GOOGLE_PLAY_SERVICE_ACCOUNT_PATH_ENV),
  );
  await assert.rejects(
    deriveCeremonySecretValues({
      channel: SANDBOX_CHANNEL,
      env: sandboxEnv(),
      readFileImpl: (path) =>
        path === PLAY_PATH ? Promise.resolve('not json') : fakeReadFile(path),
    }),
    ({ code, message }) =>
      code === 'gateway_ceremony_secret_derivation_failed' && message.includes('valid JSON'),
  );
});

test('secret put receives its value on piped stdin; other steps stream', async () => {
  const calls = [];
  const deps = createAutonomousWizardDeps({
    secretValues: new Map([['R2_CAPABILITY_HMAC_KEY', 'derived-value']]),
    log: () => {},
    runCommandImpl: async (bin, args, options) => {
      calls.push({ args, options });
      return { exitCode: 0 };
    },
  });
  assert.equal(await deps.confirm('anything?'), true);
  await deps.runInteractive('wrangler', ['secret', 'put', 'R2_CAPABILITY_HMAC_KEY', '--name', 'w']);
  await deps.runInteractive('wrangler', ['versions', 'upload']);
  assert.equal(calls[0].options.input, 'derived-value');
  assert.equal(calls[0].options.stream, undefined);
  assert.equal(calls[0].args.includes('derived-value'), false);
  assert.equal(calls[1].options.input, undefined);
  assert.equal(calls[1].options.stream, true);

  const underivable = await deps.runInteractive('wrangler', ['secret', 'put', 'UNKNOWN']);
  assert.equal(underivable.exitCode, 1);
});

test('the autonomous sitting 1 runs end to end without a prompt and without leaking a value', async (t) => {
  const root = await temporaryRoot(t);
  const fakes = fakeWranglerForDriver();
  const options = driverOptions(root, fakes);
  const evidence = await runAutonomousGatewayCeremony(options);

  assert.equal(evidence.ok, true);
  assert.equal(evidence.driver, 'autonomous');
  assert.equal(evidence.secretProvisioning, 'derived-non-interactive');
  assert.deepEqual([...evidence.secretNames], [...SANDBOX_CHANNEL.requiredSecretNames]);

  const secretPuts = fakes.commands.filter(({ call }) => call[0] === 'secret' && call[1] === 'put');
  assert.equal(secretPuts.length, 7);
  for (const { call, options: commandOptions } of secretPuts) {
    assert.equal(typeof commandOptions.input, 'string');
    assert.ok(commandOptions.input.length > 0);
    assert.equal(call.includes(commandOptions.input), false);
  }
  const playPut = secretPuts.find(({ call }) => call[2] === GOOGLE_PLAY_SERVICE_ACCOUNT_SECRET_NAME);
  assert.equal(playPut.options.input, PLAY_JSON);

  // Confirmations were auto-granted and logged; no derived value reached a log line.
  assert.ok(options.logged.some((line) => line.startsWith('auto-confirmed: ')));
  const derivedValues = secretPuts.map(({ options: commandOptions }) => commandOptions.input);
  for (const line of options.logged) {
    for (const value of derivedValues) {
      assert.equal(line.includes(value), false);
    }
  }

  // The driver preflight ran before the wizard's own reads.
  assert.deepEqual(fakes.captured[0][0], 'whoami');
  assert.deepEqual(fakes.captured[1].slice(0, 3), ['r2', 'bucket', 'list']);
});

test('a token without the re-consent scopes aborts before any mutation', async (t) => {
  const root = await temporaryRoot(t);
  const fakes = fakeWranglerForDriver({ scopes: [...MEASURED_TOKEN_SCOPES] });
  await assert.rejects(
    runAutonomousGatewayCeremony(driverOptions(root, fakes)),
    ({ code }) => code === 'gateway_ceremony_scope_missing',
  );
  assert.equal(fakes.commands.length, 0);
});

test('a failing R2 probe aborts before any mutation', async (t) => {
  const root = await temporaryRoot(t);
  const fakes = fakeWranglerForDriver({ r2ProbeExit: 1 });
  await assert.rejects(
    runAutonomousGatewayCeremony(driverOptions(root, fakes)),
    ({ code, message }) => code === 'gateway_ceremony_scope_missing' && message.includes('R2'),
  );
  assert.equal(fakes.commands.length, 0);
});

test('dry-run returns the wizard plan and contacts nothing', async () => {
  const untouchable = async () => {
    throw new Error('dry-run must not spawn anything');
  };
  const result = await runAutonomousGatewayCeremony({
    root: '/repo',
    channel: SANDBOX_CHANNEL,
    args: [],
    env: {},
    runCapturedImpl: untouchable,
    runCommandImpl: untouchable,
    probeDns: untouchable,
    resolveBin: untouchable,
  });
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.plan.workerName, 'ks2-spelling-b3-sandbox');
});

test('CLI plumbing: channel selection is mandatory and explicit', async () => {
  assert.equal(parseChannel(['--channel', 'sandbox']), SANDBOX_CHANNEL);
  assert.equal(parseChannel(['--channel=production']), PRODUCTION_CHANNEL);
  assert.equal(parseChannel(['--channel', 'staging']), null);
  assert.equal(parseChannel(['--execute']), null);
  assert.equal(await main(['--execute'], {}), 2);
});
