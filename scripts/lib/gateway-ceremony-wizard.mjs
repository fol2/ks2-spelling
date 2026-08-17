import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  B3_SANDBOX_REQUIRED_SECRET_NAMES,
  GOOGLE_PLAY_SERVICE_ACCOUNT_SECRET_NAME,
  PRODUCTION_IOS_REQUIRED_SECRET_NAMES,
  assertProductionIosRequiredSecretNames,
} from './gateway-required-secret-names.mjs';
import { EXIT_CODES, resolveExecutable, runCommand } from './run-command.mjs';

// The two owner sittings decided at #143 and worked as #156. The wizards
// prompt-and-confirm the identities decided on the map instead of asking the
// owner to invent them at the console; they validate every precondition before
// prompting; and they never hold a credential of their own — secret values are
// typed into wrangler's own hidden prompt, never into this process.

export const GATEWAY_CEREMONY_EXECUTE_ENV = 'GATEWAY_CEREMONY_EXECUTE';
export const GATEWAY_CEREMONY_EXECUTE_VALUE = 'owner';
export const CLOUDFLARE_ACCOUNT_ID = '6d00cb4a0396c17ad6ba617bcbcaa45d';
export const PACK_AUTHORITIES_RELATIVE = 'config/downloadable-pack-authorities.json';
export const SIGNING_KEYRING_RELATIVE = 'config/pack-signing-public-keys.json';

// Sitting 1 keeps the historical seven sandbox secrets; Sitting 2 collects
// exactly the six iOS names and must never prompt for the Play secret (#157).
export const SANDBOX_CHANNEL = Object.freeze({
  releaseChannel: 'sandbox',
  sitting: 1,
  workerName: 'ks2-spelling-b3-sandbox',
  hostname: 'b3-gateway.eugnel.uk',
  bucketName: 'ks2-spelling-b3-sandbox-packs',
  rateLimitNamespaceId: '1001',
  requiredSecretNames: B3_SANDBOX_REQUIRED_SECRET_NAMES,
});

export const PRODUCTION_CHANNEL = Object.freeze({
  releaseChannel: 'production',
  sitting: 2,
  workerName: 'ks2-spelling-production',
  hostname: 'ks2-gateway.eugnel.uk',
  bucketName: 'ks2-spelling-production-packs',
  // namespace_id is account-scoped: sharing "1001" with the sandbox Worker
  // would share rate-limit counters across channels (#145 B4).
  rateLimitNamespaceId: '2001',
  requiredSecretNames: PRODUCTION_IOS_REQUIRED_SECRET_NAMES,
});

export function ceremonyExitCode(error) {
  switch (error?.code) {
    case 'gateway_ceremony_execute_refused':
      return EXIT_CODES.usage;
    case 'gateway_ceremony_wrangler_missing':
      return EXIT_CODES.missingTool;
    case 'gateway_ceremony_aborted':
    case 'gateway_ceremony_precondition_failed':
    case 'gateway_ceremony_keyring_not_ready':
    case 'gateway_ceremony_dir_invalid':
    case 'gateway_ceremony_secret_gate_failed':
      return EXIT_CODES.stateMismatch;
    default:
      return EXIT_CODES.commandFailed;
  }
}

function wizardError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function assertCeremonyExecuteAllowed(env = process.env) {
  if (env[GATEWAY_CEREMONY_EXECUTE_ENV] === GATEWAY_CEREMONY_EXECUTE_VALUE) return;
  throw wizardError(
    'gateway_ceremony_execute_refused',
    'Live Cloudflare mutation is owner-gated. Re-run with --dry-run, or set ' +
      `${GATEWAY_CEREMONY_EXECUTE_ENV}=${GATEWAY_CEREMONY_EXECUTE_VALUE} with --execute.`,
  );
}

// Deployment-target config for the one-off bootstrap deploys. The tracked
// gateway/wrangler.jsonc stays byte-frozen and build-shaped; this config adds
// the deploy-only facts (account, custom-domain route) per channel. The
// fail-closed re-deploy gate in scripts/deploy-b3-sandbox-gateway.mjs stays
// intact: bootstrap is a runbook event, not a code path (#143).
export function buildCeremonyWranglerConfig(channel, { root }) {
  return Object.freeze({
    name: channel.workerName,
    account_id: CLOUDFLARE_ACCOUNT_ID,
    main: resolve(root, 'gateway/src/handler.js'),
    compatibility_date: '2026-07-12',
    compatibility_flags: ['nodejs_compat'],
    workers_dev: false,
    routes: [{ pattern: channel.hostname, custom_domain: true }],
    rules: [{ type: 'Data', globs: ['**/*.der'], fallthrough: true }],
    r2_buckets: [{ binding: 'PACKS', bucket_name: channel.bucketName }],
    version_metadata: { binding: 'WORKER_VERSION_METADATA' },
    // Invocation logs would retain full request URLs (the signed capability
    // token); the App Privacy declaration depends on this staying off (#158).
    observability: { enabled: true, logs: { enabled: true, invocation_logs: false } },
    ratelimits: [{
      name: 'GATEWAY_RATE_LIMIT',
      namespace_id: channel.rateLimitNamespaceId,
      simple: { limit: 600, period: 60 },
    }],
  });
}

export async function loadShardObjectInventory(root) {
  const document = JSON.parse(await readFile(resolve(root, PACK_AUTHORITIES_RELATIVE), 'utf8'));
  return document.packs.map((pack) => Object.freeze({
    packId: pack.packId,
    version: pack.version,
    archiveName: pack.archiveName,
    archiveSha256: pack.archiveSha256,
    archiveBytes: pack.archiveBytes,
    archiveKey: `packs/${pack.packId}/${pack.version}/${pack.archiveName}`,
    manifestKey: `packs/${pack.packId}/${pack.version}/signed-manifest.json`,
  }));
}

export function assertProductionKeyringReady(keyring, { packIds, now = new Date() } = {}) {
  const key = (keyring?.keys ?? []).find((candidate) =>
    candidate?.testOnly === false &&
    Array.isArray(candidate.allowedEnvironments) &&
    candidate.allowedEnvironments.length === 1 &&
    candidate.allowedEnvironments[0] === 'production');
  if (!key) {
    throw wizardError(
      'gateway_ceremony_keyring_not_ready',
      `${SIGNING_KEYRING_RELATIVE} holds no production key (testOnly:false, ` +
        'allowedEnvironments:["production"]). Complete the key ceremony first.',
    );
  }
  const missing = (packIds ?? []).filter((packId) => !key.allowedPackIds?.includes(packId));
  if (missing.length > 0) {
    throw wizardError(
      'gateway_ceremony_keyring_not_ready',
      `Production key ${key.keyId} does not allow: ${missing.join(', ')}`,
    );
  }
  if (!(new Date(key.notAfter) > now)) {
    throw wizardError(
      'gateway_ceremony_keyring_not_ready',
      `Production key ${key.keyId} is expired (notAfter ${key.notAfter}).`,
    );
  }
  return key;
}

export async function validateCeremonyDirectory({ root, ceremonyDir, productionKeyId }) {
  if (typeof ceremonyDir !== 'string' || ceremonyDir.length === 0) {
    throw wizardError(
      'gateway_ceremony_dir_invalid',
      'Sitting 2 requires --ceremony-dir <dir> holding packs/<packId>/<version>/… ' +
        'with the fifteen archives and fifteen production-signed manifests.',
    );
  }
  const inventory = await loadShardObjectInventory(root);
  const uploads = [];
  for (const pack of inventory) {
    const archivePath = join(ceremonyDir, pack.archiveKey);
    const manifestPath = join(ceremonyDir, pack.manifestKey);
    let archiveBytes;
    let manifestBytes;
    try {
      [archiveBytes, manifestBytes] = await Promise.all([
        readFile(archivePath),
        readFile(manifestPath),
      ]);
    } catch {
      throw wizardError(
        'gateway_ceremony_dir_invalid',
        `Missing ceremony object for ${pack.packId}: expected ${pack.archiveKey} ` +
          `and ${pack.manifestKey} under ${ceremonyDir}.`,
      );
    }
    const digest = createHash('sha256').update(archiveBytes).digest('hex');
    if (digest !== pack.archiveSha256) {
      throw wizardError(
        'gateway_ceremony_dir_invalid',
        `${pack.archiveName} differs from the tracked authority ` +
          `(sha256 ${digest} != ${pack.archiveSha256}). Archives are re-signed, never re-encoded.`,
      );
    }
    let envelope;
    try {
      envelope = JSON.parse(manifestBytes.toString('utf8'));
    } catch {
      throw wizardError('gateway_ceremony_dir_invalid', `${pack.manifestKey} is not valid JSON.`);
    }
    if (envelope?.keyId !== productionKeyId) {
      throw wizardError(
        'gateway_ceremony_dir_invalid',
        `${pack.manifestKey} is signed by ${envelope?.keyId ?? 'no key'}, ` +
          `not the production key ${productionKeyId}.`,
      );
    }
    uploads.push(
      { key: pack.archiveKey, path: archivePath, contentType: 'application/zip' },
      { key: pack.manifestKey, path: manifestPath, contentType: 'application/json' },
    );
  }
  return uploads;
}

export function buildCeremonyPlan(channel, { root }) {
  if (channel.releaseChannel === 'production' &&
      channel.requiredSecretNames.includes(GOOGLE_PLAY_SERVICE_ACCOUNT_SECRET_NAME)) {
    throw wizardError(
      'gateway_ceremony_plan_invalid',
      'Sitting 2 must not prompt for the Google Play secret (#157).',
    );
  }
  const wrangler = 'gateway/node_modules/.bin/wrangler';
  const steps = [];
  if (channel.sitting === 2) {
    steps.push(
      {
        id: 'key-ceremony',
        actor: 'owner',
        kind: 'manual',
        action: 'Mint the production ECDSA P-256 signing key, take custody of the private half, ' +
          `land the public key in ${SIGNING_KEYRING_RELATIVE} (testOnly:false, ` +
          'allowedEnvironments:["production"], notAfter ten years out, all fifteen shard packIds) ' +
          'through a reviewed PR, and re-sign the fifteen canonical manifests. Record every ' +
          'envelope sha256, byte count and MD5 etag.',
      },
      {
        id: 'keyring-check',
        actor: 'agent',
        kind: 'read-only',
        action: `Verify ${SIGNING_KEYRING_RELATIVE} holds the production key covering all fifteen shards.`,
      },
    );
  }
  steps.push({
    id: 'inspect',
    actor: 'owner',
    kind: 'read-only',
    action: 'Read-only preconditions: OAuth session (API tokens are rejected), bucket privacy, ' +
      `and no DNS records at ${channel.hostname}.`,
    commands: [
      `${wrangler} whoami --json`,
      `${wrangler} r2 bucket dev-url get ${channel.bucketName}`,
      `${wrangler} r2 bucket domain list ${channel.bucketName}`,
      `dig +short ${channel.hostname}`,
    ],
  });
  if (channel.sitting === 2) {
    steps.push(
      {
        id: 'r2-create',
        actor: 'owner',
        kind: 'mutating',
        action: `Create the private production bucket ${channel.bucketName} and confirm r2.dev ` +
          'stays disabled with zero bucket custom domains.',
        commands: [`${wrangler} r2 bucket create ${channel.bucketName}`],
      },
      {
        id: 'r2-upload',
        actor: 'owner',
        kind: 'mutating',
        action: 'Upload the fifteen archives (byte-identical to the tracked authority) and the ' +
          'fifteen production-signed manifests from --ceremony-dir. Custom metadata stays empty: ' +
          'wrangler cannot set it, and shard object rows declare metadata {}.',
        commands: [
          `${wrangler} r2 object put "${channel.bucketName}/packs/<packId>/<version>/<archiveName>" --file <archive> --content-type application/zip`,
          `${wrangler} r2 object put "${channel.bucketName}/packs/<packId>/<version>/signed-manifest.json" --file <manifest> --content-type application/json`,
        ],
      },
    );
  }
  steps.push(
    {
      id: 'secrets',
      actor: 'owner',
      kind: 'mutating',
      action: `Set the ${channel.requiredSecretNames.length} Worker secrets. Values are typed into ` +
        "wrangler's own hidden prompt; the wizard never reads or stores them.",
      commands: channel.requiredSecretNames.map(
        (name) => `${wrangler} secret put ${name} --name ${channel.workerName}`,
      ),
    },
    {
      id: 'versions-upload',
      actor: 'owner',
      kind: 'mutating',
      action: 'Upload a version without deploying it (reversible; traffic does not move).',
      commands: [`${wrangler} versions upload --config <generated ${channel.releaseChannel} config>`],
    },
    {
      id: 'observe-custom-domain',
      actor: 'owner',
      kind: 'read-only',
      action: `Record whether versions upload provisioned the Custom Domain at ${channel.hostname} ` +
        '— unsettled by public Cloudflare docs (#149); this observation goes into the runbook.',
    },
    {
      id: 'deploy',
      actor: 'owner',
      kind: 'mutating',
      action: 'Deploy the uploaded version to 100%. This is the step expected to create the ' +
        'Custom Domain, and the only step with a manual-cleanup tail (the Advanced Certificate ' +
        'survives domain removal), so it is deliberately last.',
      commands: [`${wrangler} versions deploy <version-id>@100% --name ${channel.workerName} --yes`],
    },
    {
      id: 'rollback-drill',
      actor: 'owner',
      kind: 'mutating',
      action: 'Upload and deploy a second version, roll back to the first, and confirm traffic ' +
        'moved. Proves the undo path on this account before production ever needs it.',
      commands: [
        `${wrangler} versions upload --config <generated ${channel.releaseChannel} config>`,
        `${wrangler} versions deploy <second-version-id>@100% --name ${channel.workerName} --yes`,
        `${wrangler} rollback <first-version-id> --name ${channel.workerName}`,
        `${wrangler} deployments status --name ${channel.workerName}`,
      ],
    },
  );
  if (channel.sitting === 2) {
    steps.push({
      id: 'secret-gate',
      actor: 'agent',
      kind: 'read-only',
      action: 'Assert wrangler secret list returns exactly the six iOS names — fail if the Play ' +
        'secret is present or any of the six is missing (#157, #197).',
      commands: [`${wrangler} secret list --name ${channel.workerName} --format json`],
    });
    steps.push({
      id: 'observability-confirmation',
      actor: 'owner',
      kind: 'read-only',
      action: 'Confirm the live Worker keeps invocation logs disabled per ' +
        'docs/operations/gateway-observability-confirmation.md.',
    });
  }
  steps.push({
    id: 'handover',
    actor: 'agent',
    kind: 'manual',
    action: channel.sitting === 1
      ? 'Prerequisites for scripts/deploy-b3-sandbox-gateway.mjs now hold; every later pass is ' +
        'the tracked, evidence-producing lane.'
      : 'Record the sitting on the issue; the submission-day runbook requires this sitting complete.',
  });
  return Object.freeze({
    sitting: channel.sitting,
    releaseChannel: channel.releaseChannel,
    accountId: CLOUDFLARE_ACCOUNT_ID,
    workerName: channel.workerName,
    hostname: channel.hostname,
    bucketName: channel.bucketName,
    rateLimitNamespaceId: channel.rateLimitNamespaceId,
    secretNames: [...channel.requiredSecretNames],
    wranglerConfig: buildCeremonyWranglerConfig(channel, { root }),
    steps: Object.freeze(steps.map((step) => Object.freeze(step))),
  });
}

async function defaultProbeDns(hostname) {
  const { resolve4, resolve6, resolveCname } = await import('node:dns/promises');
  const lookup = async (query) => {
    try {
      return await query(hostname);
    } catch {
      return [];
    }
  };
  return {
    cname: await lookup(resolveCname),
    a: await lookup(resolve4),
    aaaa: await lookup(resolve6),
  };
}

function hasDnsRecords(probe) {
  return probe.cname.length > 0 || probe.a.length > 0 || probe.aaaa.length > 0;
}

function defaultRunInteractive(bin, args, { cwd, env } = {}) {
  return new Promise((done) => {
    const child = spawn(bin, args, { cwd, env, stdio: 'inherit' });
    child.once('error', (error) => done({ exitCode: 1, spawnError: { message: error.message } }));
    child.once('close', (code) => done({ exitCode: code ?? 1 }));
  });
}

async function defaultConfirm(question) {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question(`${question} [y/N] `);
    return /^y(?:es)?$/iu.test(answer.trim());
  } finally {
    readline.close();
  }
}

function assertStepSucceeded(step, result) {
  if (result?.exitCode !== 0 || result?.spawnError) {
    throw wizardError(
      'gateway_ceremony_wrangler_failed',
      `${step}: wrangler exited ${result?.exitCode ?? 'without spawning'}` +
        `${result?.spawnError ? ` (${result.spawnError.message})` : ''}.`,
    );
  }
  return result;
}

async function requireConfirmation(confirm, question) {
  if (await confirm(question)) return;
  throw wizardError('gateway_ceremony_aborted', `Owner declined: ${question}`);
}

async function readUploadedVersionId(outputPath) {
  let text;
  try {
    text = await readFile(outputPath, 'utf8');
  } catch {
    throw wizardError('gateway_ceremony_wrangler_failed', 'versions upload wrote no output file.');
  }
  for (const line of text.split('\n').filter(Boolean)) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === 'version-upload' && typeof entry.version_id === 'string') {
      return entry.version_id;
    }
  }
  throw wizardError('gateway_ceremony_wrangler_failed', 'versions upload reported no version id.');
}

export async function runGatewayCeremonyWizard({
  root,
  channel,
  args = [],
  env = process.env,
  ceremonyDir,
  confirm = defaultConfirm,
  runCaptured = runCommand,
  runInteractive = defaultRunInteractive,
  probeDns = defaultProbeDns,
  resolveBin = resolveExecutable,
  log = (line) => process.stderr.write(`${line}\n`),
  now = () => new Date(),
} = {}) {
  const execute = args.includes('--execute') && !args.includes('--dry-run');
  const plan = buildCeremonyPlan(channel, { root });
  if (!execute) return Object.freeze({ ok: true, mode: 'dry-run', plan });
  assertCeremonyExecuteAllowed(env);

  const bin = join(root, 'gateway/node_modules/.bin/wrangler');
  if (!(await resolveBin(bin, env))) {
    throw wizardError(
      'gateway_ceremony_wrangler_missing',
      `Install gateway dependencies to use the pinned wrangler at ${bin}.`,
    );
  }
  const wranglerEnv = {
    ...env,
    CLOUDFLARE_ACCOUNT_ID,
    WRANGLER_SEND_METRICS: 'false',
  };
  const safeArgs = (list) => [...list, '--env-file', '/dev/null'];
  const captured = async (step, list) =>
    assertStepSucceeded(step, await runCaptured(bin, safeArgs(list), { cwd: root, env: wranglerEnv }));
  const interactive = async (step, list, extraEnv = {}) =>
    assertStepSucceeded(step, await runInteractive(bin, safeArgs(list), {
      cwd: root,
      env: { ...wranglerEnv, ...extraEnv },
    }));

  const evidence = {
    ok: true,
    mode: 'execute',
    sitting: channel.sitting,
    releaseChannel: channel.releaseChannel,
    workerName: channel.workerName,
    hostname: channel.hostname,
    bucketName: channel.bucketName,
    startedAt: now().toISOString(),
    customDomain: {},
    versionIds: {},
  };

  let productionKey;
  let uploads = [];
  if (channel.sitting === 2) {
    const keyring = JSON.parse(await readFile(resolve(root, SIGNING_KEYRING_RELATIVE), 'utf8'));
    const inventory = await loadShardObjectInventory(root);
    productionKey = assertProductionKeyringReady(keyring, {
      packIds: inventory.map((pack) => pack.packId),
      now: now(),
    });
    uploads = await validateCeremonyDirectory({
      root,
      ceremonyDir,
      productionKeyId: productionKey.keyId,
    });
    evidence.productionKeyId = productionKey.keyId;
  }

  // Read-only preconditions, all before the first prompt.
  const whoami = await captured('whoami', ['whoami', '--json']);
  let identity;
  try {
    identity = JSON.parse(whoami.stdout);
  } catch {
    throw wizardError('gateway_ceremony_precondition_failed', 'wrangler whoami returned no JSON.');
  }
  const accountIds = (identity?.accounts ?? []).map(
    (entry) => entry?.id ?? entry?.accountId ?? entry?.account_id,
  );
  if (identity?.authType !== 'OAuth Token' || !accountIds.includes(CLOUDFLARE_ACCOUNT_ID)) {
    throw wizardError(
      'gateway_ceremony_precondition_failed',
      'A wrangler OAuth session on the product account is required; API tokens are rejected ' +
        '(scripts/check-b3-external-prerequisites.mjs holds the same gate).',
    );
  }
  const vacancy = await probeDns(channel.hostname);
  if (hasDnsRecords(vacancy)) {
    throw wizardError(
      'gateway_ceremony_precondition_failed',
      `${channel.hostname} already has DNS records; a Custom Domain cannot be created over them.`,
    );
  }

  // Exact output contracts mirrored from readR2PrivacySnapshot in
  // scripts/check-b3-external-prerequisites.mjs; anything else fails closed.
  const assertBucketPrivate = async () => {
    const devUrl = await captured('bucket privacy', ['r2', 'bucket', 'dev-url', 'get', channel.bucketName]);
    if (devUrl.stdout !== 'Public access via the r2.dev URL is disabled.\n') {
      throw wizardError(
        'gateway_ceremony_precondition_failed',
        `${channel.bucketName} r2.dev public access is not disabled.`,
      );
    }
    const domains = await captured('bucket domains', ['r2', 'bucket', 'domain', 'list', channel.bucketName]);
    const domainsPrefix = `Listing custom domains connected to bucket '${channel.bucketName}'...\n`;
    if (domains.stdout !== `${domainsPrefix}There are no custom domains connected to this bucket.\n`) {
      throw wizardError(
        'gateway_ceremony_precondition_failed',
        `${channel.bucketName} has bucket custom domains; it must stay private.`,
      );
    }
  };
  if (channel.sitting === 1) await assertBucketPrivate();

  const sessionParent = resolve(root, '.native-build/gateway-ceremony');
  await mkdir(sessionParent, { recursive: true, mode: 0o700 });
  const sessionDir = await mkdtemp(join(sessionParent, `sitting-${channel.sitting}-`));
  const configPath = join(sessionDir, `wrangler-${channel.releaseChannel}.json`);
  await writeFile(configPath, `${JSON.stringify(plan.wranglerConfig, null, 2)}\n`, { mode: 0o600 });

  if (channel.sitting === 2) {
    await requireConfirmation(confirm, `Create private bucket ${channel.bucketName}?`);
    await interactive('r2 bucket create', ['r2', 'bucket', 'create', channel.bucketName]);
    await assertBucketPrivate();
    await requireConfirmation(
      confirm,
      `Upload ${uploads.length} validated objects to ${channel.bucketName}?`,
    );
    for (const object of uploads) {
      await interactive(`upload ${object.key}`, [
        'r2', 'object', 'put', `${channel.bucketName}/${object.key}`,
        '--file', object.path, '--content-type', object.contentType,
      ]);
    }
    evidence.uploadedObjects = uploads.length;
  }

  await requireConfirmation(
    confirm,
    `Set the ${plan.secretNames.length} secrets on ${channel.workerName}? ` +
      'Each value goes into wrangler\'s own hidden prompt.',
  );
  for (const name of plan.secretNames) {
    await interactive(`secret put ${name}`, ['secret', 'put', name, '--name', channel.workerName]);
  }
  evidence.secretNames = [...plan.secretNames];

  if (channel.sitting === 2) {
    const secretList = await captured('secret list', [
      'secret', 'list', '--name', channel.workerName, '--format', 'json',
    ]);
    let entries;
    try {
      entries = JSON.parse(secretList.stdout);
    } catch {
      throw wizardError('gateway_ceremony_secret_gate_failed', 'secret list returned no JSON.');
    }
    const names = (Array.isArray(entries) ? entries : entries?.secrets ?? []).map((entry) => entry?.name);
    try {
      assertProductionIosRequiredSecretNames(names);
    } catch (error) {
      throw wizardError(
        'gateway_ceremony_secret_gate_failed',
        `${error.message} (got: ${names.join(', ') || 'none'})`,
      );
    }
    evidence.secretListGate = 'passed';
  }

  await requireConfirmation(confirm, `Upload a ${channel.releaseChannel} Worker version (not deployed)?`);
  const uploadOutput = join(sessionDir, 'versions-upload.jsonl');
  await interactive('versions upload', ['versions', 'upload', '--config', configPath], {
    WRANGLER_OUTPUT_FILE_PATH: uploadOutput,
  });
  evidence.versionIds.initial = await readUploadedVersionId(uploadOutput);

  const afterUpload = await probeDns(channel.hostname);
  evidence.customDomain.afterVersionsUpload = hasDnsRecords(afterUpload);
  log(`Observation for the runbook: versions upload ${evidence.customDomain.afterVersionsUpload
    ? 'DID provision' : 'did NOT provision'} the Custom Domain at ${channel.hostname}.`);

  await requireConfirmation(
    confirm,
    `Deploy version ${evidence.versionIds.initial} to 100% (creates the Custom Domain)?`,
  );
  await interactive('versions deploy', [
    'versions', 'deploy', `${evidence.versionIds.initial}@100%`,
    '--name', channel.workerName, '--yes',
  ]);
  const afterDeploy = await probeDns(channel.hostname);
  evidence.customDomain.afterVersionsDeploy = hasDnsRecords(afterDeploy);

  if (!evidence.customDomain.afterVersionsDeploy) {
    await requireConfirmation(
      confirm,
      `${channel.hostname} still has no DNS records; apply triggers from the generated config?`,
    );
    await interactive('triggers deploy', ['triggers', 'deploy', '--config', configPath]);
    evidence.customDomain.afterTriggersDeploy = hasDnsRecords(await probeDns(channel.hostname));
  }

  await requireConfirmation(confirm, 'Run the rollback drill (second upload, then roll back)?');
  const drillOutput = join(sessionDir, 'versions-upload-drill.jsonl');
  await interactive('drill versions upload', ['versions', 'upload', '--config', configPath], {
    WRANGLER_OUTPUT_FILE_PATH: drillOutput,
  });
  evidence.versionIds.drill = await readUploadedVersionId(drillOutput);
  await interactive('drill versions deploy', [
    'versions', 'deploy', `${evidence.versionIds.drill}@100%`,
    '--name', channel.workerName, '--yes',
  ]);
  await interactive('rollback', [
    'rollback', evidence.versionIds.initial,
    '--name', channel.workerName,
    '--message', `sitting ${channel.sitting} rollback drill`,
  ]);
  const status = await captured('deployments status', [
    'deployments', 'status', '--name', channel.workerName,
  ]);
  evidence.rollbackDrill = { rolledBackTo: evidence.versionIds.initial, statusStdout: status.stdout };
  evidence.finishedAt = now().toISOString();
  return Object.freeze(evidence);
}
