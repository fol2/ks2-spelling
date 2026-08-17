import { resolve } from 'node:path';
import {
  SANDBOX_CHANNEL,
  ceremonyExitCode,
  runGatewayCeremonyWizard,
} from './lib/gateway-ceremony-wizard.mjs';
import { EXIT_CODES, isMain, printJson } from './lib/run-command.mjs';

// Sitting 1 of #143/#156: the first sandbox gateway deploy, owner-driven.
// Default is --dry-run (prints the plan, contacts nothing). --execute requires
// GATEWAY_CEREMONY_EXECUTE=owner and confirms every mutating step.

const ROOT = resolve(import.meta.dirname, '..');

export async function main(args = process.argv.slice(2), options = {}) {
  try {
    const result = await runGatewayCeremonyWizard({
      ...options,
      root: options.root ?? ROOT,
      channel: SANDBOX_CHANNEL,
      args,
      env: options.env ?? process.env,
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
