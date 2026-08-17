import { resolve } from 'node:path';
import {
  PRODUCTION_CHANNEL,
  ceremonyExitCode,
  runGatewayCeremonyWizard,
} from './lib/gateway-ceremony-wizard.mjs';
import { EXIT_CODES, isMain, printJson } from './lib/run-command.mjs';

// Sitting 2 of #143/#156: production day. Key-ceremony outcomes are validated
// (never performed) here; the wizard collects exactly the six iOS secret names
// and refuses a Worker whose secret list includes the Google Play secret
// (#157/#197). Default is --dry-run; --execute requires
// GATEWAY_CEREMONY_EXECUTE=owner plus --ceremony-dir with the fifteen
// re-signed manifests beside the byte-identical archives.

const ROOT = resolve(import.meta.dirname, '..');

export function parseCeremonyDir(args) {
  const index = args.indexOf('--ceremony-dir');
  if (index !== -1 && typeof args[index + 1] === 'string') return args[index + 1];
  const inline = args.find((argument) => argument.startsWith('--ceremony-dir='));
  return inline ? inline.slice('--ceremony-dir='.length) : undefined;
}

export async function main(args = process.argv.slice(2), options = {}) {
  try {
    const result = await runGatewayCeremonyWizard({
      ...options,
      root: options.root ?? ROOT,
      channel: PRODUCTION_CHANNEL,
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
