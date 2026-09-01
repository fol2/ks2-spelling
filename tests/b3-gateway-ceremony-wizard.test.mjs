import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CLOUDFLARE_ACCOUNT_ID,
  GATEWAY_CEREMONY_EXECUTE_ENV,
  PRODUCTION_CHANNEL,
  SANDBOX_CHANNEL,
  assertProductionKeyringReady,
  buildCeremonyPlan,
  buildCeremonyWranglerConfig,
  ceremonyExitCode,
  runGatewayCeremonyWizard,
  validateCeremonyDirectory,
} from '../scripts/lib/gateway-ceremony-wizard.mjs';
import {
  GOOGLE_PLAY_SERVICE_ACCOUNT_SECRET_NAME,
  PRODUCTION_IOS_REQUIRED_SECRET_NAMES,
} from '../scripts/lib/gateway-required-secret-names.mjs';
import { main as sandboxMain } from '../scripts/sandbox-gateway-bootstrap-wizard.mjs';
import {
  main as productionMain,
  parseCeremonyDir,
} from '../scripts/production-gateway-ceremony-wizard.mjs';

const OWNER_ENV = Object.freeze({
  [GATEWAY_CEREMONY_EXECUTE_ENV]: 'owner',
  HOME: '/owner',
  PATH: '/usr/bin',
});
const PRODUCTION_KEY_ID = 'production-p256-2026-09';

function fakeWrangler({ secretListNames = [...PRODUCTION_IOS_REQUIRED_SECRET_NAMES], devUrlDisabled = true } = {}) {
  const interactives = [];
  const captureds = [];
  let deployed = false;
  let versionCounter = 0;
  const stripSafeArgs = (args) => {
    assert.deepEqual(args.slice(-2), ['--env-file', '/dev/null']);
    return args.slice(0, -2);
  };
  const runCaptured = async (bin, args) => {
    captureds.push(args);
    const body = stripSafeArgs(args);
    if (body[0] === 'whoami') {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ authType: 'OAuth Token', accounts: [{ id: CLOUDFLARE_ACCOUNT_ID }] }),
        stderr: '',
      };
    }
    if (body[0] === 'r2' && body[1] === 'bucket' && body[2] === 'create') {
      return {
        exitCode: 0,
        stdout: `Creating bucket: ${body[3]}\n`,
        stderr: '',
      };
    }
    if (body[0] === 'r2' && body[2] === 'dev-url') {
      return {
        exitCode: 0,
        stdout: devUrlDisabled
          ? 'Public access via the r2.dev URL is disabled.\n'
          : 'Public access is enabled at https://pub.example.r2.dev.\n',
        stderr: '',
      };
    }
    if (body[0] === 'r2' && body[2] === 'domain') {
      return {
        exitCode: 0,
        stdout: `Listing custom domains connected to bucket '${body[4]}'...\n` +
          'There are no custom domains connected to this bucket.\n',
        stderr: '',
      };
    }
    if (body[0] === 'secret' && body[1] === 'list') {
      return {
        exitCode: 0,
        stdout: JSON.stringify(secretListNames.map((name) => ({ name, type: 'secret_text' }))),
        stderr: '',
      };
    }
    if (body[0] === 'deployments') return { exitCode: 0, stdout: 'Current Deployment\n', stderr: '' };
    throw new Error(`unexpected captured wrangler call: ${body.join(' ')}`);
  };
  const runInteractive = async (bin, args, options) => {
    interactives.push(args);
    const body = stripSafeArgs(args);
    if (body[0] === 'versions' && body[1] === 'upload') {
      versionCounter += 1;
      await writeFile(
        options.env.WRANGLER_OUTPUT_FILE_PATH,
        `${JSON.stringify({
          type: 'version-upload',
          version_id: `00000000-0000-4000-8000-00000000000${versionCounter}`,
        })}\n`,
      );
    }
    if (body[0] === 'versions' && body[1] === 'deploy') deployed = true;
    return { exitCode: 0 };
  };
  const probeDns = async () =>
    deployed ? { cname: ['target.example'], a: [], aaaa: [] } : { cname: [], a: [], aaaa: [] };
  return { runCaptured, runInteractive, probeDns, interactives, captureds };
}

function executeOptions(root, fakes, overrides = {}) {
  return {
    root,
    args: ['--execute'],
    env: OWNER_ENV,
    confirm: async () => true,
    resolveBin: async (bin) => bin,
    log: () => {},
    ...fakes,
    ...overrides,
  };
}

async function productionFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ks2-gateway-ceremony-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archiveBytes = Buffer.from('production archive bytes');
  const pack = {
    packId: 'full-ks2-shard-01',
    version: '1.0.0',
    requiredEntitlementId: 'full-ks2',
    archiveName: 'full-ks2-shard-01-1.0.0.zip',
    archiveSha256: createHash('sha256').update(archiveBytes).digest('hex'),
    archiveBytes: archiveBytes.length,
  };
  await mkdir(join(root, 'config'), { recursive: true });
  await writeFile(
    join(root, 'config/downloadable-pack-authorities.json'),
    JSON.stringify({ schemaVersion: 1, packs: [pack] }),
  );
  await writeFile(
    join(root, 'config/pack-signing-public-keys.json'),
    JSON.stringify({
      schemaVersion: 1,
      keys: [{
        keyId: PRODUCTION_KEY_ID,
        algorithm: 'ECDSA_P256_SHA256_DER',
        testOnly: false,
        notBefore: '2026-09-01T00:00:00Z',
        notAfter: '2036-09-01T00:00:00Z',
        allowedEnvironments: ['production'],
        allowedPackIds: [pack.packId],
      }],
    }),
  );
  const ceremonyDir = join(root, 'ceremony');
  const objectDir = join(ceremonyDir, 'packs/full-ks2-shard-01/1.0.0');
  await mkdir(objectDir, { recursive: true });
  await writeFile(join(objectDir, pack.archiveName), archiveBytes);
  await writeFile(join(objectDir, 'signed-manifest.json'), JSON.stringify({ keyId: PRODUCTION_KEY_ID }));
  return { root, ceremonyDir, pack };
}

test('channel authorities keep the two identity families apart', () => {
  assert.equal(SANDBOX_CHANNEL.workerName, 'ks2-spelling-b3-sandbox');
  assert.equal(SANDBOX_CHANNEL.hostname, 'b3-gateway.eugnel.uk');
  assert.equal(SANDBOX_CHANNEL.rateLimitNamespaceId, '1001');
  assert.equal(PRODUCTION_CHANNEL.workerName, 'ks2-spelling-production');
  assert.equal(PRODUCTION_CHANNEL.hostname, 'ks2-gateway.eugnel.uk');
  assert.equal(PRODUCTION_CHANNEL.bucketName, 'ks2-spelling-production-packs');
  assert.notEqual(PRODUCTION_CHANNEL.rateLimitNamespaceId, SANDBOX_CHANNEL.rateLimitNamespaceId);
  assert.equal(PRODUCTION_CHANNEL.rateLimitNamespaceId, '2001');
  assert.equal(SANDBOX_CHANNEL.requiredSecretNames.length, 7);
  assert.deepEqual(
    [...PRODUCTION_CHANNEL.requiredSecretNames],
    [...PRODUCTION_IOS_REQUIRED_SECRET_NAMES],
  );
});

test('the generated wrangler configs differ in identity family and production entry', () => {
  const root = '/repo';
  const sandbox = buildCeremonyWranglerConfig(SANDBOX_CHANNEL, { root });
  const production = buildCeremonyWranglerConfig(PRODUCTION_CHANNEL, { root });
  for (const config of [sandbox, production]) {
    assert.equal(config.workers_dev, false);
    assert.equal(config.observability.logs.invocation_logs, false);
    assert.equal(config.observability.logs.enabled, true);
    assert.equal(config.routes[0].custom_domain, true);
  }
  assert.equal(sandbox.routes[0].pattern, 'b3-gateway.eugnel.uk');
  assert.equal(production.routes[0].pattern, 'ks2-gateway.eugnel.uk');
  assert.equal(production.ratelimits[0].namespace_id, '2001');
  assert.deepEqual(production.ratelimits[0].simple, sandbox.ratelimits[0].simple);
  const identityFree = (config) => {
    const { name: _n, routes: _r, r2_buckets: _b, ratelimits: _l, main: _m, ...rest } = config;
    return rest;
  };
  assert.deepEqual(identityFree(production), identityFree(sandbox));
  assert.match(sandbox.main, /gateway\/src\/handler\.js$/u);
  assert.match(production.main, /gateway\/src\/handler-production\.js$/u);
  assert.notEqual(sandbox.main, production.main);
});

test('the production plan collects exactly the six iOS names and never the Play secret', () => {
  const plan = buildCeremonyPlan(PRODUCTION_CHANNEL, { root: '/repo' });
  assert.deepEqual(plan.secretNames, [...PRODUCTION_IOS_REQUIRED_SECRET_NAMES]);
  const secretsStep = plan.steps.find((step) => step.id === 'secrets');
  assert.equal(secretsStep.commands.length, 6);
  for (const command of secretsStep.commands) {
    assert.equal(command.includes(GOOGLE_PLAY_SERVICE_ACCOUNT_SECRET_NAME), false);
  }
  const ids = plan.steps.map((step) => step.id);
  for (const id of ['key-ceremony', 'keyring-check', 'r2-create', 'r2-upload', 'secret-gate',
    'observe-custom-domain', 'rollback-drill', 'observability-confirmation']) {
    assert.ok(ids.includes(id), id);
  }
  assert.throws(
    () => buildCeremonyPlan(
      {
        ...PRODUCTION_CHANNEL,
        requiredSecretNames: [
          ...PRODUCTION_IOS_REQUIRED_SECRET_NAMES,
          GOOGLE_PLAY_SERVICE_ACCOUNT_SECRET_NAME,
        ],
      },
      { root: '/repo' },
    ),
    ({ code }) => code === 'gateway_ceremony_plan_invalid',
  );
});

test('the sandbox plan keeps the historical seven sandbox secrets and no key ceremony', () => {
  const plan = buildCeremonyPlan(SANDBOX_CHANNEL, { root: '/repo' });
  assert.equal(plan.secretNames.length, 7);
  assert.ok(plan.secretNames.includes(GOOGLE_PLAY_SERVICE_ACCOUNT_SECRET_NAME));
  assert.equal(plan.steps.some((step) => step.id === 'key-ceremony'), false);
  assert.equal(plan.rateLimitNamespaceId, '1001');
});

test('dry-run emits the plan and contacts nothing', async () => {
  const untouchable = async () => {
    throw new Error('dry-run must not spawn anything');
  };
  const result = await runGatewayCeremonyWizard({
    root: '/repo',
    channel: SANDBOX_CHANNEL,
    args: [],
    env: {},
    runCaptured: untouchable,
    runInteractive: untouchable,
    probeDns: untouchable,
    resolveBin: untouchable,
  });
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.plan.workerName, 'ks2-spelling-b3-sandbox');
});

test('--execute refuses without the owner env gate', async (t) => {
  await assert.rejects(
    runGatewayCeremonyWizard({ root: '/repo', channel: SANDBOX_CHANNEL, args: ['--execute'], env: {} }),
    ({ code }) => code === 'gateway_ceremony_execute_refused',
  );
  const root = await mkdtemp(join(tmpdir(), 'ks2-gateway-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await sandboxMain(['--execute'], { root, env: {} }), 2);
  assert.equal(await productionMain(['--execute'], { root, env: {} }), 2);
});

test('sitting 1 executes the decided order with wrangler owning every secret prompt', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ks2-gateway-sitting1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fakes = fakeWrangler();
  const evidence = await runGatewayCeremonyWizard({
    channel: SANDBOX_CHANNEL,
    ...executeOptions(root, fakes),
  });
  assert.equal(evidence.ok, true);
  assert.equal(evidence.sitting, 1);
  const bodies = fakes.interactives.map((args) => args.slice(0, -2));
  assert.deepEqual(
    bodies.slice(0, 7),
    [...SANDBOX_CHANNEL.requiredSecretNames].map((name) =>
      ['secret', 'put', name, '--name', 'ks2-spelling-b3-sandbox']),
  );
  assert.deepEqual(bodies.slice(7).map((body) => body.slice(0, 2)), [
    ['versions', 'upload'],
    ['versions', 'deploy'],
    ['versions', 'upload'],
    ['versions', 'deploy'],
    ['rollback', evidence.versionIds.initial],
  ]);
  assert.notEqual(evidence.versionIds.drill, evidence.versionIds.initial);
  assert.equal(evidence.customDomain.afterVersionsUpload, false);
  assert.equal(evidence.customDomain.afterVersionsDeploy, true);
  assert.equal(bodies.some((body) => body[0] === 'triggers'), false);
  assert.equal(evidence.rollbackDrill.rolledBackTo, evidence.versionIds.initial);
});

test('sitting 1 aborts before any mutation when the owner declines', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ks2-gateway-decline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fakes = fakeWrangler();
  await assert.rejects(
    runGatewayCeremonyWizard({
      channel: SANDBOX_CHANNEL,
      ...executeOptions(root, fakes, { confirm: async () => false }),
    }),
    ({ code }) => code === 'gateway_ceremony_aborted',
  );
  assert.equal(fakes.interactives.length, 0);
});

test('read-only preconditions fail closed before any prompt', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ks2-gateway-preconditions-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const apiToken = fakeWrangler();
  const oauthOnly = apiToken.runCaptured;
  apiToken.runCaptured = async (bin, args) =>
    args[0] === 'whoami'
      ? { exitCode: 0, stdout: JSON.stringify({ authType: 'API Token', accounts: [] }), stderr: '' }
      : oauthOnly(bin, args);
  await assert.rejects(
    runGatewayCeremonyWizard({ channel: SANDBOX_CHANNEL, ...executeOptions(root, apiToken) }),
    ({ code, message }) =>
      code === 'gateway_ceremony_precondition_failed' && message.includes('OAuth'),
  );

  const occupied = fakeWrangler();
  await assert.rejects(
    runGatewayCeremonyWizard({
      channel: SANDBOX_CHANNEL,
      ...executeOptions(root, occupied, {
        probeDns: async () => ({ cname: ['existing.example'], a: [], aaaa: [] }),
      }),
    }),
    ({ code, message }) =>
      code === 'gateway_ceremony_precondition_failed' && message.includes('DNS records'),
  );

  const publicBucket = fakeWrangler({ devUrlDisabled: false });
  await assert.rejects(
    runGatewayCeremonyWizard({ channel: SANDBOX_CHANNEL, ...executeOptions(root, publicBucket) }),
    ({ code, message }) =>
      code === 'gateway_ceremony_precondition_failed' && message.includes('r2.dev'),
  );
  assert.equal(apiToken.interactives.length + occupied.interactives.length +
    publicBucket.interactives.length, 0);
});

test('sitting 2 validates ceremony outputs, uploads, and enforces the six-name secret gate', async (t) => {
  const { root, ceremonyDir, pack } = await productionFixture(t);
  const fakes = fakeWrangler();
  const evidence = await runGatewayCeremonyWizard({
    channel: PRODUCTION_CHANNEL,
    ceremonyDir,
    ...executeOptions(root, fakes),
  });
  assert.equal(evidence.productionKeyId, PRODUCTION_KEY_ID);
  assert.equal(evidence.uploadedObjects, 2);
  assert.equal(evidence.secretListGate, 'passed');
  const bodies = fakes.interactives.map((args) => args.slice(0, -2));
  assert.deepEqual(bodies[0], [
    'r2', 'object', 'put',
    `ks2-spelling-production-packs/packs/${pack.packId}/${pack.version}/${pack.archiveName}`,
    '--file', join(ceremonyDir, `packs/${pack.packId}/${pack.version}/${pack.archiveName}`),
    '--content-type', 'application/zip', '--remote',
  ]);
  // Wrangler object commands default to local simulation (writes to .wrangler/state),
  // so an upload without --remote is a silent no-op against the real bucket.
  assert.ok(
    bodies[0].includes('--remote'),
    'r2 object put must include --remote to upload to the real Cloudflare R2 bucket, not local simulation',
  );
  const secretPuts = bodies.filter((body) => body[0] === 'secret' && body[1] === 'put');
  assert.deepEqual(
    secretPuts.map((body) => body[2]),
    [...PRODUCTION_IOS_REQUIRED_SECRET_NAMES],
  );
  assert.equal(
    secretPuts.some((body) => body[2] === GOOGLE_PLAY_SERVICE_ACCOUNT_SECRET_NAME),
    false,
  );
});

test('sitting 2 bucket create is missing when bucket already exists', async (t) => {
  const { root, ceremonyDir } = await productionFixture(t);
  const fakes = fakeWrangler();
  let createCalls = 0;
  const captureRunInteractive = async (bin, args, options) => {
    const body = args.slice(0, -2);
    if (body[0] === 'r2' && body[1] === 'bucket' && body[2] === 'create') {
      createCalls += 1;
    }
    return fakes.runInteractive(bin, args, options);
  };
  const evidence = await runGatewayCeremonyWizard({
    channel: PRODUCTION_CHANNEL,
    ceremonyDir,
    ...executeOptions(root, {
      ...fakes,
      runInteractive: captureRunInteractive,
    }),
  });
  assert.equal(evidence.ok, true);
  assert.equal(createCalls, 0);
  assert.equal(evidence.uploadedObjects, 2);
});

test('the sitting 2 secret gate fails when the Play secret is present on the Worker', async (t) => {
  const { root, ceremonyDir } = await productionFixture(t);
  const fakes = fakeWrangler({
    secretListNames: [
      ...PRODUCTION_IOS_REQUIRED_SECRET_NAMES,
      GOOGLE_PLAY_SERVICE_ACCOUNT_SECRET_NAME,
    ],
  });
  await assert.rejects(
    runGatewayCeremonyWizard({
      channel: PRODUCTION_CHANNEL,
      ceremonyDir,
      ...executeOptions(root, fakes),
    }),
    ({ code }) => code === 'gateway_ceremony_secret_gate_failed',
  );
});

test('keyring readiness and ceremony directory validation fail closed', async (t) => {
  const { root, ceremonyDir, pack } = await productionFixture(t);
  const packIds = [pack.packId];
  assert.throws(
    () => assertProductionKeyringReady(
      { keys: [{ keyId: 'test', testOnly: true, allowedEnvironments: ['test', 'sandbox'] }] },
      { packIds },
    ),
    ({ code }) => code === 'gateway_ceremony_keyring_not_ready',
  );
  assert.throws(
    () => assertProductionKeyringReady(
      {
        keys: [{
          keyId: 'expired', testOnly: false, allowedEnvironments: ['production'],
          allowedPackIds: packIds, notAfter: '2020-01-01T00:00:00Z',
        }],
      },
      { packIds },
    ),
    ({ code }) => code === 'gateway_ceremony_keyring_not_ready',
  );
  assert.throws(
    () => assertProductionKeyringReady(
      {
        keys: [{
          keyId: 'partial', testOnly: false, allowedEnvironments: ['production'],
          allowedPackIds: [], notAfter: '2036-01-01T00:00:00Z',
        }],
      },
      { packIds },
    ),
    ({ code }) => code === 'gateway_ceremony_keyring_not_ready',
  );

  await assert.rejects(
    validateCeremonyDirectory({ root, ceremonyDir: undefined, productionKeyId: PRODUCTION_KEY_ID }),
    ({ code }) => code === 'gateway_ceremony_dir_invalid',
  );
  await assert.rejects(
    validateCeremonyDirectory({ root, ceremonyDir, productionKeyId: 'some-other-key' }),
    ({ code, message }) => code === 'gateway_ceremony_dir_invalid' && message.includes('signed by'),
  );
  const archivePath = join(ceremonyDir, `packs/${pack.packId}/${pack.version}/${pack.archiveName}`);
  await writeFile(archivePath, Buffer.from('tampered bytes'));
  await assert.rejects(
    validateCeremonyDirectory({ root, ceremonyDir, productionKeyId: PRODUCTION_KEY_ID }),
    ({ code, message }) => code === 'gateway_ceremony_dir_invalid' && message.includes('sha256'),
  );
});

test('CLI plumbing: ceremony dir flag forms and exit-code mapping', () => {
  assert.equal(parseCeremonyDir(['--execute', '--ceremony-dir', '/tmp/x']), '/tmp/x');
  assert.equal(parseCeremonyDir(['--ceremony-dir=/tmp/y']), '/tmp/y');
  assert.equal(parseCeremonyDir(['--execute']), undefined);
  assert.equal(ceremonyExitCode({ code: 'gateway_ceremony_execute_refused' }), 2);
  assert.equal(ceremonyExitCode({ code: 'gateway_ceremony_wrangler_missing' }), 3);
  assert.equal(ceremonyExitCode({ code: 'gateway_ceremony_aborted' }), 5);
  assert.equal(ceremonyExitCode({ code: 'gateway_ceremony_precondition_failed' }), 5);
  assert.equal(ceremonyExitCode({ code: 'gateway_ceremony_secret_gate_failed' }), 5);
  assert.equal(ceremonyExitCode(new Error('unknown')), 4);
});

test('wizard child env is sterile: pinned CI, NO_COLOR, WRANGLER_HIDE_BANNER', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ks2-gateway-wizard-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fakes = fakeWrangler();
  let capturedEnv;
  const captureRunInteractive = async (bin, args, options) => {
    if (!capturedEnv) capturedEnv = options?.env;
    return fakes.runInteractive(bin, args, options);
  };
  await runGatewayCeremonyWizard({
    channel: SANDBOX_CHANNEL,
    ...executeOptions(root, { ...fakes, runInteractive: captureRunInteractive }),
  });
  assert.ok(capturedEnv, 'interactive was called');
  assert.equal(capturedEnv.CI, '1');
  assert.equal(capturedEnv.NO_COLOR, '1');
  assert.equal(capturedEnv.WRANGLER_HIDE_BANNER, 'true');
  assert.equal(capturedEnv.CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ACCOUNT_ID);
  assert.equal(capturedEnv.WRANGLER_SEND_METRICS, 'false');
});

test('sitting 2 bucket create is re-entrant: probes existence and skips if present', async (t) => {
  const { root, ceremonyDir } = await productionFixture(t);
  const fakes = fakeWrangler();
  let devUrlCalls = 0;
  let createAttempts = 0;
  const captureRunCaptured = async (bin, args) => {
    const body = args.slice(0, -2);
    if (body[0] === 'r2' && body[1] === 'bucket' && body[2] === 'dev-url') {
      devUrlCalls += 1;
      return {
        exitCode: 0,
        stdout: 'Public access via the r2.dev URL is disabled.\n',
        stderr: '',
      };
    }
    return fakes.runCaptured(bin, args);
  };
  const captureRunInteractive = async (bin, args, options) => {
    const body = args.slice(0, -2);
    if (body[0] === 'r2' && body[1] === 'bucket' && body[2] === 'create') {
      createAttempts += 1;
    }
    return fakes.runInteractive(bin, args, options);
  };
  const evidence = await runGatewayCeremonyWizard({
    channel: PRODUCTION_CHANNEL,
    ceremonyDir,
    ...executeOptions(root, {
      ...fakes,
      runCaptured: captureRunCaptured,
      runInteractive: captureRunInteractive,
    }),
  });
  assert.equal(evidence.ok, true);
  assert.equal(devUrlCalls, 2);
  assert.equal(createAttempts, 0);
  assert.equal(evidence.uploadedObjects, 2);
});

test('sitting 2 bucket create probes absence and creates if missing', async (t) => {
  const { root, ceremonyDir } = await productionFixture(t);
  const fakes = fakeWrangler();
  let devUrlCalls = 0;
  let createAttempts = 0;
  const captureRunCaptured = async (bin, args) => {
    const body = args.slice(0, -2);
    if (body[0] === 'r2' && body[1] === 'bucket' && body[2] === 'dev-url') {
      devUrlCalls += 1;
      if (devUrlCalls === 1) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'The bucket does not exist.',
        };
      }
      return {
        exitCode: 0,
        stdout: 'Public access via the r2.dev URL is disabled.\n',
        stderr: '',
      };
    }
    return fakes.runCaptured(bin, args);
  };
  const captureRunInteractive = async (bin, args, options) => {
    const body = args.slice(0, -2);
    if (body[0] === 'r2' && body[1] === 'bucket' && body[2] === 'create') {
      createAttempts += 1;
    }
    return fakes.runInteractive(bin, args, options);
  };
  const evidence = await runGatewayCeremonyWizard({
    channel: PRODUCTION_CHANNEL,
    ceremonyDir,
    ...executeOptions(root, {
      ...fakes,
      runCaptured: captureRunCaptured,
      runInteractive: captureRunInteractive,
    }),
  });
  assert.equal(evidence.ok, true);
  assert.equal(devUrlCalls, 2);
  assert.equal(createAttempts, 1);
  assert.equal(evidence.uploadedObjects, 2);
});

test('sitting 2 bucket create fails if probe shows privacy violation', async (t) => {
  const { root, ceremonyDir } = await productionFixture(t);
  const fakes = fakeWrangler();
  const captureRunCaptured = async (bin, args) => {
    const body = args.slice(0, -2);
    if (body[0] === 'r2' && body[1] === 'bucket' && body[2] === 'dev-url') {
      return {
        exitCode: 0,
        stdout: 'Public access is enabled at https://pub.example.r2.dev.\n',
        stderr: '',
      };
    }
    return fakes.runCaptured(bin, args);
  };
  await assert.rejects(
    runGatewayCeremonyWizard({
      channel: PRODUCTION_CHANNEL,
      ceremonyDir,
      ...executeOptions(root, {
        ...fakes,
        runCaptured: captureRunCaptured,
      }),
    }),
    ({ code, message }) =>
      code === 'gateway_ceremony_precondition_failed' && message.includes('r2.dev'),
  );
});
