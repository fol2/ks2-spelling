import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_ASC_ISSUER_ID,
  DEFAULT_ASC_KEY_ID,
  resolveAscPrivateKey,
} from './app-store-connect.mjs';
import {
  CLOUDFLARE_ACCOUNT_ID,
  runGatewayCeremonyWizard,
} from './gateway-ceremony-wizard.mjs';
import { GOOGLE_PLAY_SERVICE_ACCOUNT_SECRET_NAME } from './gateway-required-secret-names.mjs';
import { runCommand } from './run-command.mjs';

// The autonomous ceremony driver decided under the 2026-08-17 owner grant on
// #156: both sittings run agent-executed, composing the prompt-and-confirm
// wizard with auto-confirmation and non-interactive secret provisioning.
// Secret values are derived here (the ASC key already on disk; fresh 32-byte
// keys minted per gateway format) and travel to `wrangler secret put` on
// piped stdin only — they never appear in argv, logs or evidence.

// The pinned wrangler's OAuth flow has NO dedicated r2 scope — `r2:write`
// appears nowhere in its DefaultScopes, and R2 API access rides the OAuth
// session's account grant (measured: the 2026-08-13 sandbox bucket creation
// succeeded on a token whose whoami lists no r2 scope). What a re-consent
// CAN add, and what Custom-Domain attachment needs, are the zone and
// certificate scopes below. R2 access itself is proven behaviourally by the
// read-only probe in the preflight.
export const CEREMONY_REQUIRED_OAUTH_SCOPES = Object.freeze([
  'account:read',
  'user:read',
  'workers:write',
  'workers_routes:write',
  'workers_scripts:write',
  'zone:read',
  'ssl_certs:write',
]);

export const GOOGLE_PLAY_SERVICE_ACCOUNT_PATH_ENV = 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_PATH';

function driverError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function assertCeremonyOauthScopes(tokenPermissions) {
  const scopes = Array.isArray(tokenPermissions)
    ? tokenPermissions.filter((entry) => typeof entry === 'string')
    : [];
  const missing = CEREMONY_REQUIRED_OAUTH_SCOPES.filter((scope) => !scopes.includes(scope));
  if (missing.length > 0) {
    throw driverError(
      'gateway_ceremony_scope_missing',
      `The wrangler OAuth token is missing scopes: ${missing.join(', ')}. ` +
        'Re-consent with a browser `wrangler login` (the default scope set covers them), ' +
        'then re-run. Discovering this mid-ceremony is exactly what this gate prevents.',
    );
  }
  return Object.freeze([...scopes]);
}

function mintKeyMaterial(randomBytesImpl) {
  // Node's base64url output is canonical (unpadded), matching the gateway's
  // fail-closed decodeBase64url round-trip check.
  return randomBytesImpl(32).toString('base64url');
}

export function mintEntitlementHandleKeyring({ randomBytesImpl = randomBytes } = {}) {
  const current = mintKeyMaterial(randomBytesImpl);
  const previous = mintKeyMaterial(randomBytesImpl);
  if (current === previous) {
    throw driverError(
      'gateway_ceremony_secret_derivation_failed',
      'Minted entitlement handle keys collided; the random source is broken.',
    );
  }
  // parseRefreshHandleKeyring requires distinct versions and distinct bytes.
  return Object.freeze({ current: `v2:${current}`, previous: `v1:${previous}` });
}

async function deriveGooglePlaySecret({ env, readFileImpl }) {
  const path = env[GOOGLE_PLAY_SERVICE_ACCOUNT_PATH_ENV];
  if (typeof path !== 'string' || path.length === 0) {
    throw driverError(
      'gateway_ceremony_secret_derivation_failed',
      `Sitting 1 collects ${GOOGLE_PLAY_SERVICE_ACCOUNT_SECRET_NAME}; set ` +
        `${GOOGLE_PLAY_SERVICE_ACCOUNT_PATH_ENV} to the service-account JSON file on disk.`,
    );
  }
  let text;
  try {
    text = await readFileImpl(path, 'utf8');
  } catch {
    throw driverError(
      'gateway_ceremony_secret_derivation_failed',
      `The Google Play service-account file at ${path} is not readable.`,
    );
  }
  try {
    JSON.parse(text);
  } catch {
    throw driverError(
      'gateway_ceremony_secret_derivation_failed',
      `The Google Play service-account file at ${path} is not valid JSON; the gateway ` +
        'JSON-parses this secret and would fail closed at request time.',
    );
  }
  return text;
}

// Derives a value for every required secret name on the channel — and only
// those. Production never reads the Play secret source, even when the path
// env is set (#157).
export async function deriveCeremonySecretValues({
  channel,
  env = process.env,
  home = homedir(),
  readFileImpl = readFile,
  randomBytesImpl = randomBytes,
}) {
  let ascPrivateKey;
  try {
    ascPrivateKey = await resolveAscPrivateKey({ env, home, readFileImpl });
  } catch (error) {
    throw driverError(
      'gateway_ceremony_secret_derivation_failed',
      `${error.message}${error.path ? ` (expected at ${error.path})` : ''}`,
    );
  }
  const handleKeys = mintEntitlementHandleKeyring({ randomBytesImpl });
  const derivations = new Map([
    ['APPLE_IAP_ISSUER_ID', async () => env.ASC_ISSUER_ID || DEFAULT_ASC_ISSUER_ID],
    ['APPLE_IAP_KEY_ID', async () => env.ASC_KEY_ID || DEFAULT_ASC_KEY_ID],
    ['APPLE_IAP_PRIVATE_KEY', async () => ascPrivateKey],
    ['ENTITLEMENT_HANDLE_KEY_CURRENT', async () => handleKeys.current],
    ['ENTITLEMENT_HANDLE_KEY_PREVIOUS', async () => handleKeys.previous],
    ['R2_CAPABILITY_HMAC_KEY', async () => mintKeyMaterial(randomBytesImpl)],
    [
      GOOGLE_PLAY_SERVICE_ACCOUNT_SECRET_NAME,
      () => deriveGooglePlaySecret({ env, readFileImpl }),
    ],
  ]);
  const values = new Map();
  for (const name of channel.requiredSecretNames) {
    const derive = derivations.get(name);
    if (!derive) {
      throw driverError(
        'gateway_ceremony_secret_derivation_failed',
        `No derivation exists for required secret ${name}; refusing to guess.`,
      );
    }
    values.set(name, await derive());
  }
  return values;
}

// Wizard dependencies that make the ceremony autonomous: every confirmation
// is granted (and logged), and `secret put` receives its derived value on
// piped stdin instead of wrangler's interactive hidden prompt. All other
// wrangler steps stream their output; their prompts resolve to wrangler's
// own defaults in non-interactive mode (`versions deploy --yes`, rollback's
// default-true confirmation).
export function createAutonomousWizardDeps({
  secretValues,
  log = (line) => process.stderr.write(`${line}\n`),
  runCommandImpl = runCommand,
}) {
  const confirm = async (question) => {
    log(`auto-confirmed: ${question}`);
    return true;
  };
  const runInteractive = async (bin, args, options = {}) => {
    if (args[0] === 'secret' && args[1] === 'put') {
      const value = secretValues.get(args[2]);
      if (typeof value !== 'string' || value.length === 0) {
        return {
          exitCode: 1,
          spawnError: { message: `no derived value for secret ${args[2]}` },
        };
      }
      return runCommandImpl(bin, args, { ...options, input: value });
    }
    return runCommandImpl(bin, args, { ...options, stream: true });
  };
  return Object.freeze({ confirm, runInteractive });
}

async function runPreflight({ bin, root, wranglerEnv, runCapturedImpl }) {
  const whoami = await runCapturedImpl(
    bin,
    ['whoami', '--json', '--env-file', '/dev/null'],
    { cwd: root, env: wranglerEnv },
  );
  let identity;
  try {
    identity = JSON.parse(whoami.stdout);
  } catch {
    identity = null;
  }
  if (whoami.exitCode !== 0 || !identity) {
    throw driverError(
      'gateway_ceremony_scope_missing',
      'wrangler whoami --json failed; cannot prove the OAuth token scopes before mutating.',
    );
  }
  const scopes = assertCeremonyOauthScopes(identity.tokenPermissions);
  // Behavioural R2 probe: read-only, and the only way to prove R2 API access
  // on a token whose scope list cannot name r2 (see the scope note above).
  const r2Probe = await runCapturedImpl(
    bin,
    ['r2', 'bucket', 'list', '--env-file', '/dev/null'],
    { cwd: root, env: wranglerEnv },
  );
  if (r2Probe.exitCode !== 0) {
    throw driverError(
      'gateway_ceremony_scope_missing',
      'The read-only R2 probe (wrangler r2 bucket list) failed; the OAuth session cannot ' +
        'reach the R2 API. Re-consent with a browser `wrangler login` and re-run.',
    );
  }
  return scopes;
}

export async function runAutonomousGatewayCeremony({
  root,
  channel,
  args = [],
  env = process.env,
  ceremonyDir,
  runCapturedImpl = runCommand,
  runCommandImpl = runCommand,
  probeDns,
  resolveBin,
  log = (line) => process.stderr.write(`${line}\n`),
  now,
  home,
  readFileImpl,
  randomBytesImpl,
} = {}) {
  const execute = args.includes('--execute') && !args.includes('--dry-run');
  if (!execute) {
    return runGatewayCeremonyWizard({ root, channel, args, env, ceremonyDir });
  }
  const bin = join(root, 'gateway/node_modules/.bin/wrangler');
  const wranglerEnv = { ...env, CLOUDFLARE_ACCOUNT_ID, WRANGLER_SEND_METRICS: 'false' };
  const oauthScopes = await runPreflight({ bin, root, wranglerEnv, runCapturedImpl });
  const secretValues = await deriveCeremonySecretValues({
    channel,
    env,
    home,
    readFileImpl,
    randomBytesImpl,
  });
  const deps = createAutonomousWizardDeps({ secretValues, log, runCommandImpl });
  const evidence = await runGatewayCeremonyWizard({
    root,
    channel,
    args,
    env,
    ceremonyDir,
    confirm: deps.confirm,
    runInteractive: deps.runInteractive,
    runCaptured: runCapturedImpl,
    probeDns,
    resolveBin,
    log,
    now,
  });
  return Object.freeze({
    ...evidence,
    driver: 'autonomous',
    oauthScopes,
    secretProvisioning: 'derived-non-interactive',
  });
}
