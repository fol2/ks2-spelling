import { resolve } from 'node:path';
import { runAutonomousGatewayCeremony } from './lib/gateway-ceremony-driver.mjs';
import {
  PRODUCTION_CHANNEL,
  SANDBOX_CHANNEL,
  ceremonyExitCode,
} from './lib/gateway-ceremony-wizard.mjs';
import { EXIT_CODES, isMain, printJson } from './lib/run-command.mjs';
import { parseCeremonyDir } from './production-gateway-ceremony-wizard.mjs';

// Autonomous driver for the two gateway sittings (#156, owner grant
// 2026-08-17). Default is --dry-run (prints the wizard plan, contacts
// nothing). --execute still requires GATEWAY_CEREMONY_EXECUTE=owner, then
// fails closed on OAuth scopes and the R2 probe before the first mutation.
//
//   node scripts/autonomous-gateway-ceremony.mjs --channel sandbox --dry-run
//   GATEWAY_CEREMONY_EXECUTE=owner node scripts/autonomous-gateway-ceremony.mjs \
//     --channel production --execute --ceremony-dir <dir>

const ROOT = resolve(import.meta.dirname, '..');
const CHANNELS = Object.freeze({
  sandbox: SANDBOX_CHANNEL,
  production: PRODUCTION_CHANNEL,
});

export function parseChannel(args) {
  const index = args.indexOf('--channel');
  const value = index !== -1
    ? args[index + 1]
    : args.find((argument) => argument.startsWith('--channel='))?.slice('--channel='.length);
  return CHANNELS[value] ?? null;
}

export async function main(args = process.argv.slice(2), options = {}) {
  const channel = parseChannel(args);
  if (!channel) {
    printJson(
      {
        ok: false,
        code: 'gateway_ceremony_usage',
        message: 'Pass --channel sandbox or --channel production.',
      },
      process.stderr,
    );
    return EXIT_CODES.usage;
  }
  try {
    const result = await runAutonomousGatewayCeremony({
      ...options,
      root: options.root ?? ROOT,
      channel,
      args,
      env: options.env ?? process.env,
      ceremonyDir: options.ceremonyDir ?? parseCeremonyDir(args),
    });
    printJson(result);
    return EXIT_CODES.success;
  } catch (error) {
    printJson(
      { ok: false, code: error.code ?? 'gateway_ceremony_failed', message: error.message },
      process.stderr,
    );
    return ceremonyExitCode(error);
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
