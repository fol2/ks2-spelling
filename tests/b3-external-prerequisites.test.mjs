import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmod,
  link,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  B3_REMOTE_MUTATION_SCOPES,
  B3_REQUIRED_EXTERNAL_GATES,
  B3_RUN_AUTHORITY_MAX_LIFETIME_MS,
  B3_RUN_AUTHORITY_PLAN_COMMIT,
  checkB3ExternalPrerequisites,
  createCloudflareRemoteInspector,
  readValidatedB3OperatorFile,
  parseB3StrictJsonBytes,
  runB3PrerequisitesCli,
  runOAuthSafeWrangler,
  runSafeGitPolicyCommand,
  validateB3ApprovalFilePolicy,
  validateB3LocalMutationAuthority,
} from '../scripts/check-b3-external-prerequisites.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const TOKEN = 'ab'.repeat(32);
const PLAN_COMMIT = '7f681f886ee1b627d574641a4a23add9d98796d2';
const NOW = new Date('2026-07-12T15:00:00.000Z');
const TEST_CLOCK = () => new Date(NOW);

const REQUIRED_GATES = Object.freeze([
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
  'cloudflareOAuth',
  'cloudflareWorker',
  'cloudflarePrivateR2',
  'cloudflareBindings',
  'cloudflareSecretNames',
  'remoteMutationApprovals',
]);

const SCOPES = Object.freeze([
  'cloudflare-deploy',
  'apple-signed-distribution',
  'apple-sandbox-history-refund',
  'google-test-track-refund-revoke',
]);

const CLOUDFLARE_BINDINGS = Object.freeze([
  'GATEWAY_RATE_LIMIT',
  'PACKS',
  'WORKER_VERSION_METADATA',
]);

const CLOUDFLARE_SECRET_NAMES = Object.freeze([
  'APPLE_IAP_ISSUER_ID',
  'APPLE_IAP_KEY_ID',
  'APPLE_IAP_PRIVATE_KEY',
  'ENTITLEMENT_HANDLE_KEY_CURRENT',
  'ENTITLEMENT_HANDLE_KEY_PREVIOUS',
  'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON',
  'R2_CAPABILITY_HMAC_KEY',
]);
const CLOUDFLARE_GATES = Object.freeze([
  'cloudflareOAuth',
  'cloudflareWorker',
  'cloudflarePrivateR2',
  'cloudflareBindings',
  'cloudflareSecretNames',
]);
const SAFE_ENV_FILE_ARGS = Object.freeze(['--env-file', '/dev/null']);
const WRANGLER_4_110_BANNER = '\n ⛅️ wrangler 4.110.0\n────────────────────\n\n';
const R2_DEV_URL_DISABLED = 'Public access via the r2.dev URL is disabled.\n';
const R2_DEV_URL_ENABLED =
  "Public access is enabled at 'https://pub-0123456789abcdef.r2.dev'.\n";
const noR2Domains = (bucket) =>
  `Listing custom domains connected to bucket '${bucket}'...\n` +
  'There are no custom domains connected to this bucket.\n';
const labelledR2Domain = (bucket) =>
  `Listing custom domains connected to bucket '${bucket}'...\n` +
  'domain:            packs.example.test\n' +
  'enabled:           Yes\n' +
  'ownership_status:  active\n' +
  'ssl_status:        active\n' +
  'min_tls_version:   1.2\n' +
  'zone_id:           0123456789abcdef0123456789abcdef\n' +
  'zone_name:         example.test\n';

test('strict B3 operator JSON rejects duplicate members before schema validation', () => {
  assert.throws(
    () => parseB3StrictJsonBytes(Buffer.from('{"schemaVersion":1,"schemaVersion":2}'), 'operator fixture'),
    /duplicate JSON member/i,
  );
});

test('external prerequisite orchestration rejects duplicate approval members before remote inspection', async (t) => {
  const value = cleanFixture(t, await fixture());
  const valid = JSON.stringify(approval());
  const duplicate = valid.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1');
  await writeFile(value.approvalFile, duplicate, { mode: 0o600 });
  let remoteCalls = 0;
  const result = await checkB3ExternalPrerequisites({
    approvalFile: value.approvalFile,
    runToken: TOKEN,
    root: value.root,
    gitRunner: value.gitRunner,
    clock: value.clock,
    remoteInspector: async () => { remoteCalls += 1; return remoteState(); },
  });
  assert.equal(result.status, 'blocked-external');
  assert.equal(remoteCalls, 0);
});

function approval() {
  return {
    schemaVersion: 1,
    gates: {
      appleAgreements: { approved: true, identifier: 'agreements-active' },
      appleProduct: { approved: true, identifier: 'uk.eugnel.ks2spelling.fullks2' },
      appleSandboxTesterContexts: {
        approved: true,
        identifiers: ['ask-to-buy-context', 'standard-sandbox-context'],
      },
      appleServerKeySecretName: { approved: true, identifier: 'APPLE_IAP_PRIVATE_KEY' },
      applePhysicalDevice: { approved: true, identifier: 'physical-development-iphone' },
      appleSignedArtefact: { approved: true, identifier: 'development-signed-ipa' },
      googleMerchant: { approved: true, identifier: 'merchant-active' },
      googleProduct: { approved: true, identifier: 'full_ks2' },
      googleServiceAccountSecretName: {
        approved: true,
        identifier: 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON',
      },
      googleInternalTrack: { approved: true, identifier: 'internal-test-track' },
      googleLicenceTester: { approved: true, identifier: 'licence-tester-context' },
      googlePlayCertifiedDevice: { approved: true, identifier: 'play-certified-device' },
      googlePlayAppSigningCertificateSha256: { approved: true, identifier: '12'.repeat(32) },
      cloudflareOAuth: { approved: true, identifier: '1234567890abcdef1234567890abcdef' },
      cloudflareWorker: { approved: true, identifier: 'ks2-spelling-b3-sandbox' },
      cloudflarePrivateR2: {
        approved: true,
        identifier: 'ks2-spelling-b3-sandbox-packs',
      },
      cloudflareBindings: { approved: true, identifiers: [...CLOUDFLARE_BINDINGS] },
      cloudflareSecretNames: { approved: true, identifiers: [...CLOUDFLARE_SECRET_NAMES] },
      remoteMutationApprovals: { approved: true, scopes: [...SCOPES] },
    },
  };
}

function remoteState(overrides = {}) {
  return {
    oauthAvailable: true,
    accountId: '1234567890abcdef1234567890abcdef',
    workerName: 'ks2-spelling-b3-sandbox',
    privateR2BucketName: 'ks2-spelling-b3-sandbox-packs',
    bindingNames: [...CLOUDFLARE_BINDINGS],
    bindingTypes: {
      GATEWAY_RATE_LIMIT: 'ratelimit',
      PACKS: 'r2_bucket',
      WORKER_VERSION_METADATA: 'version_metadata',
    },
    boundR2BucketName: 'ks2-spelling-b3-sandbox-packs',
    versionSecretNames: [...CLOUDFLARE_SECRET_NAMES],
    secretNames: [...CLOUDFLARE_SECRET_NAMES],
    r2DevUrlPublicAccess: false,
    hasCustomDomains: false,
    ...overrides,
  };
}

function successfulCloudflareResponse(args, request) {
  let body;
  if (args[0] === 'whoami') {
    body = { authType: 'OAuth Token', accounts: [{ id: request.accountId }] };
  } else if (args[0] === 'deployments') {
    body = {
      id: 'deployment-current',
      versions: [{ version_id: 'version-current', percentage: 100 }],
    };
  } else if (args[0] === 'versions') {
    body = {
      resources: {
        bindings: [
          { name: 'GATEWAY_RATE_LIMIT', type: 'ratelimit' },
          { name: 'PACKS', type: 'r2_bucket', bucket_name: request.privateR2BucketName },
          { name: 'WORKER_VERSION_METADATA', type: 'version_metadata' },
          ...CLOUDFLARE_SECRET_NAMES.map((name) => ({ name, type: 'secret_text' })),
        ],
      },
    };
  } else if (args.slice(0, 3).join(' ') === 'r2 bucket info') {
    body = { name: request.privateR2BucketName };
  } else if (args.slice(0, 4).join(' ') === 'r2 bucket dev-url get') {
    body = R2_DEV_URL_DISABLED;
  } else if (args.slice(0, 4).join(' ') === 'r2 bucket domain list') {
    body = noR2Domains(request.privateR2BucketName);
  } else if (args[0] === 'secret') {
    body = CLOUDFLARE_SECRET_NAMES.map((name) => ({ name, type: 'secret_text' }));
  } else {
    throw new Error(`unexpected Cloudflare command: ${args.join(' ')}`);
  }
  return {
    exitCode: 0,
    stdout: typeof body === 'string' ? body : JSON.stringify(body),
    stderr: '',
  };
}

function runAuthority(token = TOKEN) {
  return {
    schemaVersion: 1,
    runToken: token,
    issuedAt: '2026-07-12T14:00:00.000Z',
    expiresAt: '2026-07-12T16:00:00.000Z',
    planCommit: PLAN_COMMIT,
  };
}

async function fixture({
  approvalValue = approval(),
  token = TOKEN,
  runAuthorityValue = runAuthority(token),
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ks2-spelling-b3-prerequisites-'));
  const approvalRoot = await mkdtemp(join(tmpdir(), 'ks2-spelling-b3-operator-'));
  const approvalFile = join(approvalRoot, 'user-owned-prerequisites.json');
  await writeFile(approvalFile, `${JSON.stringify(approvalValue, null, 2)}\n`);
  await chmod(approvalFile, 0o600);
  await mkdir(join(root, '.native-build/b3'), { recursive: true });
  const runAuthorityFile = join(root, '.native-build/b3/run-authority.json');
  await writeFile(
    runAuthorityFile,
    `${JSON.stringify(runAuthorityValue, null, 2)}\n`,
  );
  await chmod(runAuthorityFile, 0o600);
  return {
    root,
    approvalRoot,
    approvalFile,
    runAuthorityFile,
    gitRunner: async (args) => (args[0] === 'ls-files' ? 1 : 0),
    clock: TEST_CLOCK,
  };
}

function cleanFixture(t, value) {
  t.after(() => Promise.all([
    rm(value.root, { recursive: true, force: true }),
    rm(value.approvalRoot, { recursive: true, force: true }),
  ]));
  return value;
}

test('external prerequisite constants freeze every named gate and exact remote scope', () => {
  assert.deepEqual(B3_REQUIRED_EXTERNAL_GATES, REQUIRED_GATES);
  assert.deepEqual(B3_REMOTE_MUTATION_SCOPES, SCOPES);
  assert.equal(B3_RUN_AUTHORITY_PLAN_COMMIT, PLAN_COMMIT);
  assert.equal(B3_RUN_AUTHORITY_MAX_LIFETIME_MS, 86_400_000);
});

test('local mutation gate binds exact secure approval scope and current run token', async (t) => {
  const value = cleanFixture(t, await fixture());
  assert.deepEqual(
    await validateB3LocalMutationAuthority({
      root: value.root,
      approvalFile: value.approvalFile,
      runToken: TOKEN,
      requestedScope: 'apple-sandbox-history-refund',
      gitRunner: value.gitRunner,
      clock: value.clock,
    }),
    { status: 'pass', scope: 'apple-sandbox-history-refund', approvedPlayCertificateSha256: '12'.repeat(32) },
  );
  await assert.rejects(
    validateB3LocalMutationAuthority({
      root: value.root,
      approvalFile: value.approvalFile,
      runToken: 'cd'.repeat(32),
      requestedScope: 'apple-sandbox-history-refund',
      gitRunner: value.gitRunner,
      clock: value.clock,
    }),
    /invalid or expired/i,
  );
});

test('external checker accepts durable approvals, current run token and matching name-only remote state', async (t) => {
  const { root, approvalFile } = cleanFixture(t, await fixture());
  let inspectionRequest;

  const result = await checkB3ExternalPrerequisites({
    root,
    approvalFile,
    runToken: TOKEN,
    gitRunner: async (args) => (args[0] === 'ls-files' ? 1 : 0),
    clock: TEST_CLOCK,
    remoteInspector: async (request) => {
      inspectionRequest = request;
      return remoteState({
        bindingNames: [...CLOUDFLARE_BINDINGS].reverse(),
        secretNames: [...CLOUDFLARE_SECRET_NAMES].reverse(),
      });
    },
  });

  assert.deepEqual(result, { status: 'pass', gates: REQUIRED_GATES });
  assert.deepEqual(inspectionRequest, {
    accountId: '1234567890abcdef1234567890abcdef',
    workerName: 'ks2-spelling-b3-sandbox',
    privateR2BucketName: 'ks2-spelling-b3-sandbox-packs',
    bindingNames: CLOUDFLARE_BINDINGS,
    secretNames: CLOUDFLARE_SECRET_NAMES,
  });
  assert.equal(JSON.stringify(inspectionRequest).includes('secretValue'), false);
});

test('missing approval is blocked-external with only all named missing gates and no remote call', async () => {
  let remoteCalls = 0;
  const result = await checkB3ExternalPrerequisites({
    root: ROOT,
    approvalFile: join(ROOT, '.native-build/b3/does-not-exist.json'),
    runToken: TOKEN,
    remoteInspector: async () => {
      remoteCalls += 1;
      return remoteState();
    },
  });
  assert.deepEqual(result, { status: 'blocked-external', gates: REQUIRED_GATES });
  assert.equal(remoteCalls, 0);
});

test('checker rejects scope, run-token and remote-name drift without exposing identifiers', async (t) => {
  const driftedApproval = approval();
  driftedApproval.gates.remoteMutationApprovals.scopes = SCOPES.slice(0, 3);
  const scopeFixture = cleanFixture(t, await fixture({ approvalValue: driftedApproval }));
  assert.deepEqual(
    await checkB3ExternalPrerequisites({
      root: scopeFixture.root,
      approvalFile: scopeFixture.approvalFile,
      runToken: TOKEN,
      gitRunner: scopeFixture.gitRunner,
      clock: scopeFixture.clock,
      remoteInspector: async () => remoteState(),
    }),
    { status: 'blocked-external', gates: ['remoteMutationApprovals'] },
  );

  const currentFixture = cleanFixture(t, await fixture());
  assert.deepEqual(
    await checkB3ExternalPrerequisites({
      root: currentFixture.root,
      approvalFile: currentFixture.approvalFile,
      runToken: 'cd'.repeat(32),
      gitRunner: currentFixture.gitRunner,
      clock: currentFixture.clock,
      remoteInspector: async () => remoteState(),
    }),
    { status: 'blocked-external', gates: ['remoteMutationApprovals'] },
  );

  assert.deepEqual(
    await checkB3ExternalPrerequisites({
      root: currentFixture.root,
      approvalFile: currentFixture.approvalFile,
      runToken: TOKEN,
      gitRunner: currentFixture.gitRunner,
      clock: currentFixture.clock,
      remoteInspector: async () =>
        remoteState({ secretNames: CLOUDFLARE_SECRET_NAMES.slice(0, 6) }),
    }),
    { status: 'blocked-external', gates: ['cloudflareSecretNames'] },
  );

  assert.deepEqual(
    await checkB3ExternalPrerequisites({
      root: currentFixture.root,
      approvalFile: currentFixture.approvalFile,
      runToken: TOKEN,
      gitRunner: currentFixture.gitRunner,
      clock: currentFixture.clock,
      remoteInspector: async () =>
        remoteState({ versionSecretNames: CLOUDFLARE_SECRET_NAMES.slice(0, 6) }),
    }),
    { status: 'blocked-external', gates: ['cloudflareSecretNames'] },
  );
  assert.deepEqual(
    await checkB3ExternalPrerequisites({
      root: currentFixture.root,
      approvalFile: currentFixture.approvalFile,
      runToken: TOKEN,
      gitRunner: currentFixture.gitRunner,
      clock: currentFixture.clock,
      remoteInspector: async () =>
        remoteState({
          bindingTypes: {
            GATEWAY_RATE_LIMIT: 'plain_text',
            PACKS: 'r2_bucket',
            WORKER_VERSION_METADATA: 'version_metadata',
          },
        }),
    }),
    { status: 'blocked-external', gates: ['cloudflareBindings'] },
  );
  assert.deepEqual(
    await checkB3ExternalPrerequisites({
      root: currentFixture.root,
      approvalFile: currentFixture.approvalFile,
      runToken: TOKEN,
      gitRunner: currentFixture.gitRunner,
      clock: currentFixture.clock,
      remoteInspector: async () =>
        remoteState({ boundR2BucketName: 'different-approved-private-bucket' }),
    }),
    {
      status: 'blocked-external',
      gates: ['cloudflarePrivateR2', 'cloudflareBindings'],
    },
  );
  for (const privacyDrift of [
    { r2DevUrlPublicAccess: true },
    { hasCustomDomains: true },
  ]) {
    assert.deepEqual(
      await checkB3ExternalPrerequisites({
        root: currentFixture.root,
        approvalFile: currentFixture.approvalFile,
        runToken: TOKEN,
        gitRunner: currentFixture.gitRunner,
        clock: currentFixture.clock,
        remoteInspector: async () => remoteState(privacyDrift),
      }),
      { status: 'blocked-external', gates: ['cloudflarePrivateR2'] },
    );
  }
});

test('checker rejects unknown approval fields, secret-bearing fields and invalid run authority', async (t) => {
  const unsafeApproval = approval();
  unsafeApproval.gates.cloudflareSecretNames.values = ['must-never-be-read'];
  const unsafeFixture = cleanFixture(t, await fixture({ approvalValue: unsafeApproval }));
  assert.deepEqual(
    await checkB3ExternalPrerequisites({
      root: unsafeFixture.root,
      approvalFile: unsafeFixture.approvalFile,
      runToken: TOKEN,
      gitRunner: unsafeFixture.gitRunner,
      clock: unsafeFixture.clock,
      remoteInspector: async () => remoteState(),
    }),
    { status: 'blocked-external', gates: ['cloudflareSecretNames'] },
  );

  const invalidTokenFixture = cleanFixture(
    t,
    await fixture({ token: 'not-a-256-bit-token' }),
  );
  assert.deepEqual(
    await checkB3ExternalPrerequisites({
      root: invalidTokenFixture.root,
      approvalFile: invalidTokenFixture.approvalFile,
      runToken: 'not-a-256-bit-token',
      gitRunner: invalidTokenFixture.gitRunner,
      clock: invalidTokenFixture.clock,
      remoteInspector: async () => remoteState(),
    }),
    { status: 'blocked-external', gates: ['remoteMutationApprovals'] },
  );
});

test('run authority is valid only for the exact plan and bounded current UTC window', async (t) => {
  const cases = [
    {
      name: 'expired',
      mutate: (value) => {
        value.issuedAt = '2026-07-12T12:00:00.000Z';
        value.expiresAt = '2026-07-12T14:00:00.000Z';
      },
      clock: TEST_CLOCK,
    },
    {
      name: 'future',
      mutate: (value) => {
        value.issuedAt = '2026-07-12T16:00:00.000Z';
        value.expiresAt = '2026-07-12T17:00:00.000Z';
      },
      clock: TEST_CLOCK,
    },
    {
      name: 'overlong',
      mutate: (value) => {
        value.issuedAt = '2026-07-12T00:00:00.000Z';
        value.expiresAt = '2026-07-13T00:00:00.001Z';
      },
      clock: TEST_CLOCK,
    },
    {
      name: 'wrong plan',
      mutate: (value) => {
        value.planCommit = '0'.repeat(40);
      },
      clock: TEST_CLOCK,
    },
    {
      name: 'non-canonical UTC',
      mutate: (value) => {
        value.issuedAt = '2026-07-12T14:00:00Z';
      },
      clock: TEST_CLOCK,
    },
  ];
  for (const value of cases) {
    const authority = runAuthority();
    value.mutate(authority);
    const item = cleanFixture(t, await fixture({ runAuthorityValue: authority }));
    assert.deepEqual(
      await checkB3ExternalPrerequisites({
        root: item.root,
        approvalFile: item.approvalFile,
        runToken: TOKEN,
        gitRunner: item.gitRunner,
        clock: value.clock,
        remoteInspector: async () => remoteState(),
      }),
      { status: 'blocked-external', gates: ['remoteMutationApprovals'] },
      value.name,
    );
  }

  const replay = cleanFixture(t, await fixture());
  assert.equal(
    (await checkB3ExternalPrerequisites({
      root: replay.root,
      approvalFile: replay.approvalFile,
      runToken: TOKEN,
      gitRunner: replay.gitRunner,
      clock: replay.clock,
      remoteInspector: async () => remoteState(),
    })).status,
    'pass',
  );
  assert.deepEqual(
    await checkB3ExternalPrerequisites({
      root: replay.root,
      approvalFile: replay.approvalFile,
      runToken: TOKEN,
      gitRunner: replay.gitRunner,
      clock: () => new Date('2026-07-12T16:00:00.001Z'),
      remoteInspector: async () => remoteState(),
    }),
    { status: 'blocked-external', gates: ['remoteMutationApprovals'] },
  );
});

test('run authority must remain current after remote inspection finishes', async (t) => {
  const value = cleanFixture(t, await fixture());
  const clockReadings = [
    new Date('2026-07-12T15:00:00.000Z'),
    new Date('2026-07-12T16:00:00.000Z'),
  ];
  let remoteCalls = 0;

  assert.deepEqual(
    await checkB3ExternalPrerequisites({
      root: value.root,
      approvalFile: value.approvalFile,
      runToken: TOKEN,
      gitRunner: value.gitRunner,
      clock: () => clockReadings.shift(),
      remoteInspector: async () => {
        remoteCalls += 1;
        return remoteState();
      },
    }),
    { status: 'blocked-external', gates: ['remoteMutationApprovals'] },
  );
  assert.equal(remoteCalls, 1);
  assert.deepEqual(clockReadings, []);
});

test('run authority deletion or same-byte replacement during remote inspection is rejected', async (t) => {
  for (const [name, mutate] of [
    ['deleted', async ({ runAuthorityFile }) => rm(runAuthorityFile)],
    ['replaced', async ({ runAuthorityFile }) => {
      const bytes = await readFile(runAuthorityFile);
      await rename(runAuthorityFile, `${runAuthorityFile}.previous`);
      await writeFile(runAuthorityFile, bytes);
      await chmod(runAuthorityFile, 0o600);
    }],
  ]) {
    const value = cleanFixture(t, await fixture());
    assert.deepEqual(
      await checkB3ExternalPrerequisites({
        root: value.root,
        approvalFile: value.approvalFile,
        runToken: TOKEN,
        gitRunner: value.gitRunner,
        clock: value.clock,
        remoteInspector: async () => {
          await mutate(value);
          return remoteState();
        },
      }),
      { status: 'blocked-external', gates: ['remoteMutationApprovals'] },
      name,
    );
  }
});

test('remote mutation approval revocation during inspection is re-read and rejected', async (t) => {
  const value = cleanFixture(t, await fixture());
  assert.deepEqual(
    await checkB3ExternalPrerequisites({
      root: value.root,
      approvalFile: value.approvalFile,
      runToken: TOKEN,
      gitRunner: value.gitRunner,
      clock: value.clock,
      remoteInspector: async () => {
        const revoked = JSON.parse(await readFile(value.approvalFile, 'utf8'));
        revoked.gates.remoteMutationApprovals.approved = false;
        await writeFile(value.approvalFile, `${JSON.stringify(revoked, null, 2)}\n`);
        await chmod(value.approvalFile, 0o600);
        return remoteState();
      },
    }),
    { status: 'blocked-external', gates: ['remoteMutationApprovals'] },
  );
});

test('approval file policy accepts secure outside-root and ignored in-root files only', async (t) => {
  const outside = cleanFixture(t, await fixture());
  assert.equal(
    await validateB3ApprovalFilePolicy({
      root: outside.root,
      approvalFile: outside.approvalFile,
    }),
    true,
  );

  await chmod(outside.approvalFile, 0o644);
  assert.equal(
    await validateB3ApprovalFilePolicy({
      root: outside.root,
      approvalFile: outside.approvalFile,
    }),
    false,
  );
  await chmod(outside.approvalFile, 0o600);

  const symlinkPath = join(outside.approvalRoot, 'approval-link.json');
  await symlink(outside.approvalFile, symlinkPath);
  assert.equal(
    await validateB3ApprovalFilePolicy({ root: outside.root, approvalFile: symlinkPath }),
    false,
  );

  const inRootPath = join(ROOT, '.native-build/b3/policy-fixture.json');
  await mkdir(join(ROOT, '.native-build/b3'), { recursive: true });
  await writeFile(inRootPath, '{}\n', { mode: 0o600 });
  await chmod(inRootPath, 0o600);
  t.after(() => rm(inRootPath, { force: true }));
  assert.equal(
    await validateB3ApprovalFilePolicy({ root: ROOT, approvalFile: inRootPath }),
    true,
  );
  assert.equal(
    await validateB3ApprovalFilePolicy({
      root: ROOT,
      approvalFile: inRootPath,
      gitRunner: async (args) => (args[0] === 'ls-files' ? 0 : 1),
    }),
    false,
  );
});

test('Git policy ignores hostile ambient alternate-index configuration', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ks2-spelling-b3-git-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const approvalFile = join(root, 'tracked-approval.json');
  await writeFile(join(root, '.gitignore'), 'tracked-approval.json\n');
  await writeFile(approvalFile, '{}\n');
  await chmod(approvalFile, 0o600);
  execFileSync('git', ['add', '-f', 'tracked-approval.json'], { cwd: root });

  const alternateIndex = join(root, 'alternate-index');
  execFileSync('git', ['read-tree', '--empty'], {
    cwd: root,
    env: { ...process.env, GIT_INDEX_FILE: alternateIndex },
  });
  const previousIndex = process.env.GIT_INDEX_FILE;
  process.env.GIT_INDEX_FILE = alternateIndex;
  try {
    assert.equal(
      await validateB3ApprovalFilePolicy({ root, approvalFile }),
      false,
    );
  } finally {
    if (previousIndex === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = previousIndex;
  }

  let invocation;
  await runSafeGitPolicyCommand(['status', '--porcelain'], root, {
    ambientEnv: {
      ...process.env,
      GIT_INDEX_FILE: alternateIndex,
      GIT_CONFIG_GLOBAL: '/hostile/config',
      GIT_SSH_COMMAND: 'hostile-command',
    },
    execFileImpl: async (command, args, options) => {
      invocation = { command, args, options };
      return { stdout: '', stderr: '' };
    },
  });
  assert.equal(invocation.options.env.GIT_INDEX_FILE, undefined);
  assert.equal(invocation.options.env.GIT_SSH_COMMAND, undefined);
  assert.equal(invocation.command, '/usr/bin/git');
  assert.equal(invocation.options.env.PATH, '/usr/bin:/bin');
  assert.equal(invocation.options.env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(invocation.options.env.GIT_CONFIG_GLOBAL, '/dev/null');

  const fakeBin = join(root, 'node_modules/.bin');
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(fakeBin, 'git'), '#!/bin/sh\nprintf "hostile-path-shadow\\n"\n');
  await chmod(join(fakeBin, 'git'), 0o755);
  const realResult = await runSafeGitPolicyCommand(
    ['rev-parse', '--is-inside-work-tree'],
    root,
    { ambientEnv: { PATH: `${fakeBin}:/usr/bin:/bin` } },
  );
  assert.equal(realResult.stdout, 'true\n');
  assert.equal(realResult.stdout.includes('hostile-path-shadow'), false);

  let unsafeExecCalls = 0;
  await assert.rejects(
    runSafeGitPolicyCommand(['status', '--porcelain'], root, {
      gitStatReader: async () => ({
        isFile: () => true,
        isSymbolicLink: () => false,
        uid: 0n,
        mode: 0o100777n,
      }),
      execFileImpl: async () => {
        unsafeExecCalls += 1;
        return { stdout: '', stderr: '' };
      },
    }),
    /secure validation/,
  );
  assert.equal(unsafeExecCalls, 0);
});

test('Cloudflare inspector runs read-only name-only commands and rejects missing OAuth', async () => {
  const calls = [];
  const responses = [
    {
      authType: 'OAuth Token',
      accounts: [
        { id: 'ffffffffffffffffffffffffffffffff', name: 'other-account' },
        { id: '1234567890abcdef1234567890abcdef', name: 'not-returned' },
      ],
    },
    {
      id: 'deployment-current',
      versions: [{ version_id: 'version-1', percentage: 100 }],
      author_email: 'not-returned@example.test',
    },
    {
      resources: {
        bindings: [
          {
            name: 'PACKS',
            type: 'r2_bucket',
            bucket_name: 'ks2-spelling-b3-sandbox-packs',
            value: 'not-returned',
          },
          { name: 'GATEWAY_RATE_LIMIT', type: 'ratelimit', value: 'not-returned' },
          { name: 'WORKER_VERSION_METADATA', type: 'version_metadata', value: 'not-returned' },
          ...CLOUDFLARE_SECRET_NAMES.map((name) => ({
            name,
            type: 'secret_text',
            value: 'must-not-be-an-ordinary-binding',
          })),
        ],
      },
    },
    { name: 'ks2-spelling-b3-sandbox-packs', jurisdiction: 'not-returned' },
    R2_DEV_URL_DISABLED,
    noR2Domains('ks2-spelling-b3-sandbox-packs'),
    CLOUDFLARE_SECRET_NAMES.map((name) => ({
      name,
      type: 'secret_text',
      value: 'not-returned',
    })),
    {
      id: 'deployment-current',
      versions: [{ version_id: 'version-1', percentage: 100 }],
    },
    { name: 'ks2-spelling-b3-sandbox-packs' },
    R2_DEV_URL_DISABLED,
    noR2Domains('ks2-spelling-b3-sandbox-packs'),
  ];
  const inspector = createCloudflareRemoteInspector({
    commandRunner: async (args, context) => {
      calls.push({ args, context });
      const response = responses.shift();
      return {
        exitCode: 0,
        stdout: typeof response === 'string' ? response : JSON.stringify(response),
        stderr: '',
      };
    },
  });
  const inspected = await inspector({
      accountId: '1234567890abcdef1234567890abcdef',
      workerName: 'ks2-spelling-b3-sandbox',
      privateR2BucketName: 'ks2-spelling-b3-sandbox-packs',
      bindingNames: CLOUDFLARE_BINDINGS,
      secretNames: CLOUDFLARE_SECRET_NAMES,
    });
  assert.deepEqual(inspected, remoteState());
  assert.deepEqual(calls, [
    { args: ['whoami', '--json', ...SAFE_ENV_FILE_ARGS], context: undefined },
    {
      args: [
        'deployments', 'status', '--name', 'ks2-spelling-b3-sandbox', '--json',
        ...SAFE_ENV_FILE_ARGS,
      ],
      context: { accountId: '1234567890abcdef1234567890abcdef' },
    },
    {
      args: [
        'versions', 'view', 'version-1', '--name', 'ks2-spelling-b3-sandbox', '--json',
        ...SAFE_ENV_FILE_ARGS,
      ],
      context: { accountId: '1234567890abcdef1234567890abcdef' },
    },
    {
      args: [
        'r2', 'bucket', 'info', 'ks2-spelling-b3-sandbox-packs', '--json',
        ...SAFE_ENV_FILE_ARGS,
      ],
      context: { accountId: '1234567890abcdef1234567890abcdef' },
    },
    {
      args: [
        'r2', 'bucket', 'dev-url', 'get', 'ks2-spelling-b3-sandbox-packs',
        ...SAFE_ENV_FILE_ARGS,
      ],
      context: { accountId: '1234567890abcdef1234567890abcdef' },
    },
    {
      args: [
        'r2', 'bucket', 'domain', 'list', 'ks2-spelling-b3-sandbox-packs',
        ...SAFE_ENV_FILE_ARGS,
      ],
      context: { accountId: '1234567890abcdef1234567890abcdef' },
    },
    {
      args: [
        'secret', 'list', '--name', 'ks2-spelling-b3-sandbox', '--format', 'json',
        ...SAFE_ENV_FILE_ARGS,
      ],
      context: { accountId: '1234567890abcdef1234567890abcdef' },
    },
    {
      args: [
        'deployments', 'status', '--name', 'ks2-spelling-b3-sandbox', '--json',
        ...SAFE_ENV_FILE_ARGS,
      ],
      context: { accountId: '1234567890abcdef1234567890abcdef' },
    },
    {
      args: [
        'r2', 'bucket', 'info', 'ks2-spelling-b3-sandbox-packs', '--json',
        ...SAFE_ENV_FILE_ARGS,
      ],
      context: { accountId: '1234567890abcdef1234567890abcdef' },
    },
    {
      args: [
        'r2', 'bucket', 'dev-url', 'get', 'ks2-spelling-b3-sandbox-packs',
        ...SAFE_ENV_FILE_ARGS,
      ],
      context: { accountId: '1234567890abcdef1234567890abcdef' },
    },
    {
      args: [
        'r2', 'bucket', 'domain', 'list', 'ks2-spelling-b3-sandbox-packs',
        ...SAFE_ENV_FILE_ARGS,
      ],
      context: { accountId: '1234567890abcdef1234567890abcdef' },
    },
  ]);
  assert.equal(JSON.stringify(inspected).includes('not-returned'), false);

  const unavailable = createCloudflareRemoteInspector({
    commandRunner: async () => ({ exitCode: 1, stdout: '', stderr: 'login required' }),
  });
  await assert.rejects(
    unavailable({
      accountId: '1234567890abcdef1234567890abcdef',
      workerName: 'ks2-spelling-b3-sandbox',
      privateR2BucketName: 'ks2-spelling-b3-sandbox-packs',
      bindingNames: CLOUDFLARE_BINDINGS,
      secretNames: CLOUDFLARE_SECRET_NAMES,
    }),
    /inspection unavailable/,
  );
});

test('Cloudflare inspector rejects split current deployment and returns complete extra sets', async (t) => {
  const request = {
    accountId: '1234567890abcdef1234567890abcdef',
    workerName: 'ks2-spelling-b3-sandbox',
    privateR2BucketName: 'ks2-spelling-b3-sandbox-packs',
    bindingNames: CLOUDFLARE_BINDINGS,
    secretNames: CLOUDFLARE_SECRET_NAMES,
  };
  const splitResponses = [
    { authType: 'OAuth Token', accounts: [{ id: request.accountId }] },
    {
      id: 'deployment-split',
      versions: [
        { version_id: 'version-a', percentage: 50 },
        { version_id: 'version-b', percentage: 50 },
      ],
    },
  ];
  await assert.rejects(
    createCloudflareRemoteInspector({
      commandRunner: async () => ({
        exitCode: 0,
        stdout: JSON.stringify(splitResponses.shift()),
        stderr: '',
      }),
    })(request),
    /inspection unavailable/,
  );

  const extraResponses = [
    { authType: 'OAuth Token', accounts: [{ id: request.accountId }] },
    { id: 'deployment-current', versions: [{ version_id: 'version-current', percentage: 100 }] },
    {
      resources: {
        bindings: [
          { name: 'GATEWAY_RATE_LIMIT', type: 'plain_text' },
          {
            name: 'PACKS',
            type: 'r2_bucket',
            bucket_name: request.privateR2BucketName,
          },
          { name: 'WORKER_VERSION_METADATA', type: 'plain_text' },
          { name: 'UNAPPROVED_BINDING', type: 'plain_text' },
          { name: 'UNAPPROVED_SECRET_STORE', type: 'secret_store' },
          ...CLOUDFLARE_SECRET_NAMES.map((name) => ({ name, type: 'secret_text' })),
        ],
      },
    },
    { name: request.privateR2BucketName },
    R2_DEV_URL_DISABLED,
    noR2Domains(request.privateR2BucketName),
    [
      ...CLOUDFLARE_SECRET_NAMES.map((name) => ({ name, type: 'secret_text' })),
      { name: 'UNAPPROVED_SECRET', type: 'secret_text' },
    ],
    { id: 'deployment-current', versions: [{ version_id: 'version-current', percentage: 100 }] },
    { name: request.privateR2BucketName },
    R2_DEV_URL_DISABLED,
    noR2Domains(request.privateR2BucketName),
  ];
  const state = await createCloudflareRemoteInspector({
    commandRunner: async () => {
      const response = extraResponses.shift();
      return {
        exitCode: 0,
        stdout: typeof response === 'string' ? response : JSON.stringify(response),
        stderr: '',
      };
    },
  })(request);
  assert.deepEqual(
    state.bindingNames,
    [
      ...CLOUDFLARE_BINDINGS,
      'UNAPPROVED_BINDING',
      'UNAPPROVED_SECRET_STORE',
    ].sort(),
  );
  assert.deepEqual(
    state.secretNames,
    [...CLOUDFLARE_SECRET_NAMES, 'UNAPPROVED_SECRET'].sort(),
  );

  const value = cleanFixture(t, await fixture());
  assert.deepEqual(
    await checkB3ExternalPrerequisites({
      root: value.root,
      approvalFile: value.approvalFile,
      runToken: TOKEN,
      gitRunner: value.gitRunner,
      clock: value.clock,
      remoteInspector: async () => state,
    }),
    {
      status: 'blocked-external',
      gates: ['cloudflareBindings', 'cloudflareSecretNames'],
    },
  );
});

test('Cloudflare inspector accepts only an OAuth Token whoami authority', async () => {
  const request = {
    accountId: '1234567890abcdef1234567890abcdef',
    workerName: 'ks2-spelling-b3-sandbox',
    privateR2BucketName: 'ks2-spelling-b3-sandbox-packs',
    bindingNames: CLOUDFLARE_BINDINGS,
    secretNames: CLOUDFLARE_SECRET_NAMES,
  };
  for (const authType of [undefined, 'User API Token', 'Account API Token', 'OAuth']) {
    let calls = 0;
    const inspector = createCloudflareRemoteInspector({
      commandRunner: async () => {
        calls += 1;
        return {
          exitCode: 0,
          stdout: JSON.stringify({ authType, accounts: [{ id: request.accountId }] }),
          stderr: '',
        };
      },
    });
    await assert.rejects(inspector(request), /inspection unavailable/);
    assert.equal(calls, 1, String(authType));
  }
});

test('Cloudflare inspector rejects an active deployment switch during inspection', async () => {
  const request = {
    accountId: '1234567890abcdef1234567890abcdef',
    workerName: 'ks2-spelling-b3-sandbox',
    privateR2BucketName: 'ks2-spelling-b3-sandbox-packs',
    bindingNames: CLOUDFLARE_BINDINGS,
    secretNames: CLOUDFLARE_SECRET_NAMES,
  };
  const responses = [
    { authType: 'OAuth Token', accounts: [{ id: request.accountId }] },
    { id: 'deployment-a', versions: [{ version_id: 'version-a', percentage: 100 }] },
    {
      resources: {
        bindings: [
          { name: 'GATEWAY_RATE_LIMIT', type: 'ratelimit' },
          {
            name: 'PACKS',
            type: 'r2_bucket',
            bucket_name: request.privateR2BucketName,
          },
          { name: 'WORKER_VERSION_METADATA', type: 'version_metadata' },
          ...CLOUDFLARE_SECRET_NAMES.map((name) => ({ name, type: 'secret_text' })),
        ],
      },
    },
    { name: request.privateR2BucketName },
    R2_DEV_URL_DISABLED,
    noR2Domains(request.privateR2BucketName),
    CLOUDFLARE_SECRET_NAMES.map((name) => ({ name, type: 'secret_text' })),
    { id: 'deployment-b', versions: [{ version_id: 'version-b', percentage: 100 }] },
  ];
  const inspector = createCloudflareRemoteInspector({
    commandRunner: async () => {
      const response = responses.shift();
      return {
        exitCode: 0,
        stdout: typeof response === 'string' ? response : JSON.stringify(response),
        stderr: '',
      };
    },
  });
  await assert.rejects(inspector(request), /inspection unavailable/);
});

test('Cloudflare inspector rejects private R2 becoming public during inspection', async (t) => {
  const request = {
    accountId: '1234567890abcdef1234567890abcdef',
    workerName: 'ks2-spelling-b3-sandbox',
    privateR2BucketName: 'ks2-spelling-b3-sandbox-packs',
    bindingNames: CLOUDFLARE_BINDINGS,
    secretNames: CLOUDFLARE_SECRET_NAMES,
  };
  const deployment = {
    id: 'deployment-current',
    versions: [{ version_id: 'version-current', percentage: 100 }],
  };
  const responses = [
    { authType: 'OAuth Token', accounts: [{ id: request.accountId }] },
    deployment,
    {
      resources: {
        bindings: [
          { name: 'GATEWAY_RATE_LIMIT', type: 'ratelimit' },
          {
            name: 'PACKS',
            type: 'r2_bucket',
            bucket_name: request.privateR2BucketName,
          },
          { name: 'WORKER_VERSION_METADATA', type: 'version_metadata' },
          ...CLOUDFLARE_SECRET_NAMES.map((name) => ({ name, type: 'secret_text' })),
        ],
      },
    },
    { name: request.privateR2BucketName },
    R2_DEV_URL_DISABLED,
    noR2Domains(request.privateR2BucketName),
    CLOUDFLARE_SECRET_NAMES.map((name) => ({ name, type: 'secret_text' })),
    deployment,
    { name: request.privateR2BucketName },
    R2_DEV_URL_ENABLED,
    noR2Domains(request.privateR2BucketName),
  ];
  const inspector = createCloudflareRemoteInspector({
    commandRunner: async () => {
      const response = responses.shift();
      return {
        exitCode: 0,
        stdout: typeof response === 'string' ? response : JSON.stringify(response),
        stderr: '',
      };
    },
  });
  const value = cleanFixture(t, await fixture());
  assert.deepEqual(
    await checkB3ExternalPrerequisites({
      root: value.root,
      approvalFile: value.approvalFile,
      runToken: TOKEN,
      gitRunner: value.gitRunner,
      clock: value.clock,
      remoteInspector: inspector,
    }),
    { status: 'blocked-external', gates: ['cloudflarePrivateR2'] },
  );
});

test('R2 command authentication failures conservatively block every Cloudflare gate', async (t) => {
  const request = {
    accountId: '1234567890abcdef1234567890abcdef',
    workerName: 'ks2-spelling-b3-sandbox',
    privateR2BucketName: 'ks2-spelling-b3-sandbox-packs',
    bindingNames: CLOUDFLARE_BINDINGS,
    secretNames: CLOUDFLARE_SECRET_NAMES,
  };
  for (const target of [
    'r2 bucket info',
    'r2 bucket dev-url get',
    'r2 bucket domain list',
  ]) {
    const value = cleanFixture(t, await fixture());
    const inspector = createCloudflareRemoteInspector({
      commandRunner: async (args) =>
        args.slice(0, target.split(' ').length).join(' ') === target
          ? { exitCode: 1, stdout: '', stderr: 'OAuth expired\n' }
          : successfulCloudflareResponse(args, request),
    });
    assert.deepEqual(
      await checkB3ExternalPrerequisites({
        root: value.root,
        approvalFile: value.approvalFile,
        runToken: TOKEN,
        gitRunner: value.gitRunner,
        clock: value.clock,
        remoteInspector: inspector,
      }),
      { status: 'blocked-external', gates: CLOUDFLARE_GATES },
      target,
    );
  }
});

test('successful public URL and custom-domain evidence maps only the R2 privacy gate', async (t) => {
  const request = {
    accountId: '1234567890abcdef1234567890abcdef',
    workerName: 'ks2-spelling-b3-sandbox',
    privateR2BucketName: 'ks2-spelling-b3-sandbox-packs',
    bindingNames: CLOUDFLARE_BINDINGS,
    secretNames: CLOUDFLARE_SECRET_NAMES,
  };
  for (const [target, stdout] of [
    ['r2 bucket dev-url get', R2_DEV_URL_ENABLED],
    ['r2 bucket domain list', labelledR2Domain(request.privateR2BucketName)],
  ]) {
    const value = cleanFixture(t, await fixture());
    const inspector = createCloudflareRemoteInspector({
      commandRunner: async (args) =>
        args.slice(0, target.split(' ').length).join(' ') === target
          ? { exitCode: 0, stdout, stderr: '' }
          : successfulCloudflareResponse(args, request),
    });
    assert.deepEqual(
      await checkB3ExternalPrerequisites({
        root: value.root,
        approvalFile: value.approvalFile,
        runToken: TOKEN,
        gitRunner: value.gitRunner,
        clock: value.clock,
        remoteInspector: inspector,
      }),
      { status: 'blocked-external', gates: ['cloudflarePrivateR2'] },
      target,
    );
  }
});

test('Cloudflare inspector rejects malformed and duplicate binding or secret entries', async () => {
  const request = {
    accountId: '1234567890abcdef1234567890abcdef',
    workerName: 'ks2-spelling-b3-sandbox',
    privateR2BucketName: 'ks2-spelling-b3-sandbox-packs',
    bindingNames: CLOUDFLARE_BINDINGS,
    secretNames: CLOUDFLARE_SECRET_NAMES,
  };
  const validBindings = [
    { name: 'GATEWAY_RATE_LIMIT', type: 'ratelimit' },
    {
      name: 'PACKS',
      type: 'r2_bucket',
      bucket_name: request.privateR2BucketName,
    },
    { name: 'WORKER_VERSION_METADATA', type: 'version_metadata' },
  ];
  const validSecrets = CLOUDFLARE_SECRET_NAMES.map((name) => ({ name, type: 'secret_text' }));
  const cases = [
    { bindings: [...validBindings, { ...validBindings[0] }], secrets: validSecrets },
    { bindings: [...validBindings, { type: 'plain_text' }], secrets: validSecrets },
    { bindings: [...validBindings, { name: 'MISSING_TYPE' }], secrets: validSecrets },
    { bindings: validBindings, secrets: [...validSecrets, { ...validSecrets[0] }] },
    { bindings: validBindings, secrets: [...validSecrets, { type: 'secret_text' }] },
    { bindings: validBindings, secrets: [...validSecrets, { name: 'MISSING_TYPE' }] },
  ];
  for (const value of cases) {
    const responses = [
      { authType: 'OAuth Token', accounts: [{ id: request.accountId }] },
      { id: 'deployment-current', versions: [{ version_id: 'version-current', percentage: 100 }] },
      { resources: { bindings: value.bindings } },
      { name: request.privateR2BucketName },
      R2_DEV_URL_DISABLED,
      noR2Domains(request.privateR2BucketName),
      value.secrets,
    ];
    const inspector = createCloudflareRemoteInspector({
      commandRunner: async () => {
        const response = responses.shift();
        return {
          exitCode: 0,
          stdout: typeof response === 'string' ? response : JSON.stringify(response),
          stderr: '',
        };
      },
    });
    await assert.rejects(inspector(request), /inspection unavailable/);
  }
});

test('Cloudflare inspector strictly proves disabled r2.dev and zero custom domains', async () => {
  const request = {
    accountId: '1234567890abcdef1234567890abcdef',
    workerName: 'ks2-spelling-b3-sandbox',
    privateR2BucketName: 'ks2-spelling-b3-sandbox-packs',
    bindingNames: CLOUDFLARE_BINDINGS,
    secretNames: CLOUDFLARE_SECRET_NAMES,
  };
  for (const [devUrlOutput, domainOutput, devUrlStderr = ''] of [
    [
      R2_DEV_URL_ENABLED,
      noR2Domains(request.privateR2BucketName),
    ],
    [
      R2_DEV_URL_DISABLED,
      labelledR2Domain(request.privateR2BucketName),
    ],
    [
      R2_DEV_URL_DISABLED,
      `${noR2Domains(request.privateR2BucketName)}unexpected\n`,
    ],
    [
      `${WRANGLER_4_110_BANNER}${R2_DEV_URL_DISABLED}`,
      noR2Domains(request.privateR2BucketName),
    ],
    [
      `A newer version of Wrangler is available.\n${R2_DEV_URL_DISABLED}`,
      noR2Domains(request.privateR2BucketName),
    ],
    [
      R2_DEV_URL_DISABLED,
      noR2Domains(request.privateR2BucketName),
      'unexpected stderr\n',
    ],
  ]) {
    const responses = [
      { authType: 'OAuth Token', accounts: [{ id: request.accountId }] },
      { id: 'deployment-current', versions: [{ version_id: 'version-current', percentage: 100 }] },
      {
        resources: {
          bindings: [
            { name: 'GATEWAY_RATE_LIMIT', type: 'ratelimit' },
            {
              name: 'PACKS',
              type: 'r2_bucket',
              bucket_name: request.privateR2BucketName,
            },
            { name: 'WORKER_VERSION_METADATA', type: 'version_metadata' },
            ...CLOUDFLARE_SECRET_NAMES.map((name) => ({ name, type: 'secret_text' })),
          ],
        },
      },
      { name: request.privateR2BucketName },
      { capturedStdout: devUrlOutput, capturedStderr: devUrlStderr },
      domainOutput,
      CLOUDFLARE_SECRET_NAMES.map((name) => ({ name, type: 'secret_text' })),
    ];
    const inspector = createCloudflareRemoteInspector({
      commandRunner: async () => {
        const response = responses.shift();
        if (Object.hasOwn(response, 'capturedStdout')) {
          return {
            exitCode: 0,
            stdout: response.capturedStdout,
            stderr: response.capturedStderr,
          };
        }
        return {
          exitCode: 0,
          stdout: typeof response === 'string' ? response : JSON.stringify(response),
          stderr: '',
        };
      },
    });
    await assert.rejects(inspector(request), /inspection unavailable/);
  }
});

test('CLI adapter seam can pass complete gates and blocks missing OAuth with exit 6', async (t) => {
  const complete = cleanFixture(t, await fixture());
  const output = [];
  const passExit = await runB3PrerequisitesCli({
    root: complete.root,
    env: {
      B3_PREREQUISITES_FILE: complete.approvalFile,
      B3_REMOTE_RUN_TOKEN: TOKEN,
    },
    stdout: { write: (value) => output.push(value) },
    remoteInspector: async () => remoteState(),
    gitRunner: complete.gitRunner,
    clock: complete.clock,
  });
  assert.equal(passExit, 0);
  assert.deepEqual(JSON.parse(output.join('')), { status: 'pass', gates: REQUIRED_GATES });

  output.length = 0;
  const blockedExit = await runB3PrerequisitesCli({
    root: complete.root,
    env: {
      B3_PREREQUISITES_FILE: complete.approvalFile,
      B3_REMOTE_RUN_TOKEN: TOKEN,
    },
    stdout: { write: (value) => output.push(value) },
    remoteInspector: async () => {
      throw new Error('OAuth missing');
    },
    gitRunner: complete.gitRunner,
    clock: complete.clock,
  });
  assert.equal(blockedExit, 6);
  assert.deepEqual(JSON.parse(output.join('')), {
    status: 'blocked-external',
    gates: [
      'cloudflareOAuth',
      'cloudflareWorker',
      'cloudflarePrivateR2',
      'cloudflareBindings',
      'cloudflareSecretNames',
    ],
  });
});

test('OAuth-safe Wrangler spawn is local, non-interactive and strips token/value environment', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ks2-spelling-b3-wrangler-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const wranglerPath = join(root, 'gateway/node_modules/wrangler/bin/wrangler.js');
  const wranglerPackagePath = join(root, 'gateway/node_modules/wrangler/package.json');
  await mkdir(resolve(wranglerPath, '..'), { recursive: true });
  await writeFile(wranglerPath, '#!/usr/bin/env node\n');
  await writeFile(wranglerPackagePath, '{"name":"wrangler","version":"4.110.0"}\n');
  await writeFile(join(root, '.env'), 'CLOUDFLARE_API_TOKEN=repo-env-must-not-load\n');
  let invocation;
  const result = await runOAuthSafeWrangler(
    ['whoami', '--json'],
    {
      root,
      env: {
        HOME: '/operator/home',
        PATH: '/usr/bin',
        TMPDIR: '/tmp',
        CLOUDFLARE_API_TOKEN: 'must-not-pass',
        CLOUDFLARE_API_KEY: 'must-not-pass',
        CLOUDFLARE_EMAIL: 'must-not-pass',
        APPLE_IAP_PRIVATE_KEY: 'must-not-pass',
      },
      accountId: '1234567890abcdef1234567890abcdef',
      spawnRunner: async (command, args, options) => {
        invocation = { command, args, options };
        return { exitCode: 0, stdout: '{}', stderr: '' };
      },
    },
  );
  assert.deepEqual(result, { exitCode: 0, stdout: '{}', stderr: '' });
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args, [wranglerPath, 'whoami', '--json', ...SAFE_ENV_FILE_ARGS]);
  assert.deepEqual(invocation.options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(invocation.options.env.CI, '1');
  assert.equal(invocation.options.env.CLOUDFLARE_AUTH_USE_KEYRING, 'false');
  assert.equal(invocation.options.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV, 'false');
  assert.equal(invocation.options.env.CLOUDFLARE_INCLUDE_PROCESS_ENV, 'false');
  assert.equal(invocation.options.env.WRANGLER_HIDE_BANNER, 'true');
  assert.equal(
    invocation.options.env.CLOUDFLARE_ACCOUNT_ID,
    '1234567890abcdef1234567890abcdef',
  );
  assert.equal(invocation.options.env.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(invocation.options.env.CLOUDFLARE_API_KEY, undefined);
  assert.equal(invocation.options.env.CLOUDFLARE_EMAIL, undefined);
  assert.equal(invocation.options.env.APPLE_IAP_PRIVATE_KEY, undefined);
  assert.equal(Object.values(invocation.options.env).includes('must-not-pass'), false);
  assert.equal(Object.values(invocation.options.env).includes('repo-env-must-not-load'), false);
  assert.equal(invocation.args.includes('login'), false);

  let unsafeSpawnCalls = 0;
  assert.deepEqual(
    await runOAuthSafeWrangler(
      ['whoami', '--json', '--env-file', join(root, '.env'), ...SAFE_ENV_FILE_ARGS],
      {
        root,
        accountId: '1234567890abcdef1234567890abcdef',
        spawnRunner: async () => {
          unsafeSpawnCalls += 1;
          return { exitCode: 0, stdout: '{}', stderr: '' };
        },
      },
    ),
    { exitCode: 1, stdout: '', stderr: '' },
  );
  assert.equal(unsafeSpawnCalls, 0);
  assert.deepEqual(
    await runOAuthSafeWrangler(
      ['whoami', '--json', `--env-file=${join(root, '.env')}`, ...SAFE_ENV_FILE_ARGS],
      {
        root,
        accountId: '1234567890abcdef1234567890abcdef',
        spawnRunner: async () => {
          unsafeSpawnCalls += 1;
          return { exitCode: 0, stdout: '{}', stderr: '' };
        },
      },
    ),
    { exitCode: 1, stdout: '', stderr: '' },
  );
  assert.equal(unsafeSpawnCalls, 0);

  let packageValidationSpawnCalls = 0;
  const failsBeforeSpawn = async () =>
    runOAuthSafeWrangler(['whoami', '--json'], {
      root,
      spawnRunner: async () => {
        packageValidationSpawnCalls += 1;
        return { exitCode: 0, stdout: '{}', stderr: '' };
      },
    });
  await writeFile(wranglerPackagePath, '{"name":"wrangler","version":"4.109.0"}\n');
  assert.deepEqual(await failsBeforeSpawn(), { exitCode: 1, stdout: '', stderr: '' });
  await rm(wranglerPackagePath);
  assert.deepEqual(await failsBeforeSpawn(), { exitCode: 1, stdout: '', stderr: '' });
  const packageTarget = join(root, 'wrangler-package-target.json');
  await writeFile(packageTarget, '{"name":"wrangler","version":"4.110.0"}\n');
  await symlink(packageTarget, wranglerPackagePath);
  assert.deepEqual(await failsBeforeSpawn(), { exitCode: 1, stdout: '', stderr: '' });
  assert.equal(packageValidationSpawnCalls, 0);
});

test('operator-file handle rejects a pathname replacement after policy validation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ks2-spelling-b3-race-root-'));
  const operatorRoot = await mkdtemp(join(tmpdir(), 'ks2-spelling-b3-race-operator-'));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(operatorRoot, { recursive: true, force: true }),
  ]));
  const approvalFile = join(operatorRoot, 'approval.json');
  const openedOriginal = join(operatorRoot, 'opened-original.json');
  const replacement = join(operatorRoot, 'replacement.json');
  await writeFile(approvalFile, '{"authority":"original"}\n');
  await writeFile(replacement, '{"authority":"replacement"}\n');
  await Promise.all([chmod(approvalFile, 0o600), chmod(replacement, 0o600)]);

  await assert.rejects(
    readValidatedB3OperatorFile({
      root,
      path: approvalFile,
      afterPolicyHook: async () => {
        await rename(approvalFile, openedOriginal);
        await symlink(replacement, approvalFile);
      },
    }),
    /operator file changed during validation/,
  );
  assert.equal((await readFile(openedOriginal, 'utf8')).includes('original'), true);
  assert.equal((await readFile(replacement, 'utf8')).includes('replacement'), true);
});

test('operator-file handle rejects in-place metadata and post-read Git-policy drift', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ks2-spelling-b3-metadata-root-'));
  const operatorRoot = await mkdtemp(join(tmpdir(), 'ks2-spelling-b3-metadata-operator-'));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(operatorRoot, { recursive: true, force: true }),
  ]));

  for (const [index, mutate] of [
    async (path) => writeFile(path, '{"authority":"rewritten"}\n'),
    async (path) => chmod(path, 0o400),
  ].entries()) {
    const path = join(operatorRoot, `operator-${index}.json`);
    await writeFile(path, '{"authority":"trusted"}\n');
    await chmod(path, 0o600);
    await assert.rejects(
      readValidatedB3OperatorFile({
        root,
        path,
        afterPolicyHook: () => mutate(path),
      }),
      /operator file changed during validation/,
    );
  }

  const inRootPath = join(root, 'operator.json');
  await writeFile(inRootPath, '{"authority":"trusted"}\n');
  await chmod(inRootPath, 0o600);
  let tracked = false;
  await assert.rejects(
    readValidatedB3OperatorFile({
      root,
      path: inRootPath,
      gitRunner: async (args) => {
        if (args[0] === 'ls-files') return tracked ? 0 : 1;
        return 0;
      },
      afterPolicyHook: async () => {
        tracked = true;
      },
    }),
    /operator file changed during validation/,
  );
});

test('operator-file handle rejects an outside-root hard-link alias of a tracked file', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ks2-spelling-b3-hardlink-root-'));
  const operatorRoot = await mkdtemp(join(tmpdir(), 'ks2-spelling-b3-hardlink-operator-'));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(operatorRoot, { recursive: true, force: true }),
  ]));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const trackedPath = join(root, 'tracked-authority.json');
  const outsideAlias = join(operatorRoot, 'outside-authority.json');
  await writeFile(trackedPath, '{"authority":"tracked"}\n');
  await chmod(trackedPath, 0o600);
  execFileSync('git', ['add', 'tracked-authority.json'], { cwd: root });
  await link(trackedPath, outsideAlias);

  await assert.rejects(
    readValidatedB3OperatorFile({ root, path: outsideAlias }),
    /operator file failed secure validation/,
  );

  const initiallyUnique = join(operatorRoot, 'initially-unique.json');
  const lateAlias = join(operatorRoot, 'late-alias.json');
  await writeFile(initiallyUnique, '{"authority":"initially-unique"}\n');
  await chmod(initiallyUnique, 0o600);
  await assert.rejects(
    readValidatedB3OperatorFile({
      root,
      path: initiallyUnique,
      afterPolicyHook: () => link(initiallyUnique, lateAlias),
    }),
    /operator file changed during validation/,
  );
});

test('run authority requires the same secure ignored and untracked operator-file policy', async (t) => {
  const value = cleanFixture(t, await fixture());
  const check = (gitRunner = value.gitRunner) =>
    checkB3ExternalPrerequisites({
      root: value.root,
      approvalFile: value.approvalFile,
      runToken: TOKEN,
      gitRunner,
      clock: value.clock,
      remoteInspector: async () => remoteState(),
    });
  assert.equal((await check()).status, 'pass');

  await chmod(value.runAuthorityFile, 0o644);
  assert.deepEqual(await check(), {
    status: 'blocked-external',
    gates: ['remoteMutationApprovals'],
  });
  await chmod(value.runAuthorityFile, 0o600);

  assert.deepEqual(
    await check(async (args) => {
      if (args[0] === 'ls-files' && args.at(-1).endsWith('run-authority.json')) return 0;
      return args[0] === 'ls-files' ? 1 : 0;
    }),
    { status: 'blocked-external', gates: ['remoteMutationApprovals'] },
  );
  assert.deepEqual(
    await check(async (args) => (args[0] === 'ls-files' ? 1 : 1)),
    { status: 'blocked-external', gates: ['remoteMutationApprovals'] },
  );

  const realRunAuthority = join(value.approvalRoot, 'real-run-authority.json');
  await writeFile(realRunAuthority, `${JSON.stringify({ schemaVersion: 1, runToken: TOKEN })}\n`);
  await chmod(realRunAuthority, 0o600);
  await rm(value.runAuthorityFile);
  await symlink(realRunAuthority, value.runAuthorityFile);
  assert.deepEqual(await check(), {
    status: 'blocked-external',
    gates: ['remoteMutationApprovals'],
  });
});

test('run authority rejects symlinked fixed-path parent components inside or outside root', async (t) => {
  const inside = cleanFixture(t, await fixture());
  const movedNativeBuild = join(inside.root, 'inside-authority-root');
  await rename(join(inside.root, '.native-build'), movedNativeBuild);
  await symlink(movedNativeBuild, join(inside.root, '.native-build'));

  const outside = cleanFixture(t, await fixture());
  const outsideParent = await mkdtemp(join(tmpdir(), 'ks2-spelling-b3-run-authority-parent-'));
  t.after(() => rm(outsideParent, { recursive: true, force: true }));
  const outsideB3 = join(outsideParent, 'b3');
  await mkdir(outsideB3, { recursive: true });
  await writeFile(
    join(outsideB3, 'run-authority.json'),
    `${JSON.stringify(runAuthority(), null, 2)}\n`,
  );
  await chmod(join(outsideB3, 'run-authority.json'), 0o600);
  await rm(join(outside.root, '.native-build/b3'), { recursive: true, force: true });
  await symlink(outsideB3, join(outside.root, '.native-build/b3'));

  for (const [name, value] of [['inside', inside], ['outside', outside]]) {
    let remoteCalls = 0;
    assert.deepEqual(
      await checkB3ExternalPrerequisites({
        root: value.root,
        approvalFile: value.approvalFile,
        runToken: TOKEN,
        gitRunner: value.gitRunner,
        clock: value.clock,
        remoteInspector: async () => {
          remoteCalls += 1;
          return remoteState();
        },
      }),
      { status: 'blocked-external', gates: ['remoteMutationApprovals'] },
      name,
    );
    assert.equal(remoteCalls, 0, name);
  }
});

test('CLI exits 6 and prints only named missing gates when user-owned approval is absent', () => {
  const secretMarker = 'do-not-print-this-secret';
  const result = spawnSync(process.execPath, ['scripts/check-b3-external-prerequisites.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      B3_PREREQUISITES_FILE: join(ROOT, '.native-build/b3/missing-prerequisites.json'),
      B3_REMOTE_RUN_TOKEN: secretMarker,
    },
    timeout: 5_000,
  });

  assert.equal(result.status, 6);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.includes(secretMarker), false);
  assert.deepEqual(JSON.parse(result.stdout), {
    status: 'blocked-external',
    gates: REQUIRED_GATES,
  });
});
