import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createDefaultB3CloudflarePrimitives } from './lib/b3-cloudflare-live-adapter.mjs';
import { B3_SCRIPT_AUTHORITY_PLACEHOLDER } from './lib/b3-cloudflare-evidence.mjs';
import { EXIT_CODES, isMain, printJson } from './lib/run-command.mjs';

// #156 slice 2 — the pattern is "a check is green because it never ran on the
// thing that ships". CI's deploy:dry-run compiles gateway/wrangler.jsonc, a
// build-shaped config with no route and workers_dev:false; every real deploy
// compiles the runtime-derived config instead (custom-domain route, no_bundle,
// find_additional_modules, different rules). dryRunBundle compiles BOTH — the
// tracked bundle and then the derived, deploy-shaped config over the exact
// discovered modules — using only the pinned Wrangler, offline, with no
// ceremony credentials. This lane makes the deploy-shaped compile a CI fact.

const ROOT = resolve(import.meta.dirname, '..');

export async function main({
  root = ROOT,
  createPrimitives = createDefaultB3CloudflarePrimitives,
} = {}) {
  try {
    const primitives = createPrimitives({ root });
    const { source } = await primitives.dryRunBundle({
      placeholder: B3_SCRIPT_AUTHORITY_PLACEHOLDER,
    });
    printJson({
      ok: true,
      rehearsal: 'deploy-shaped-config-compile',
      mainModuleSha256: createHash('sha256').update(source, 'utf8').digest('hex'),
    });
    return EXIT_CODES.success;
  } catch (error) {
    printJson(
      {
        ok: false,
        code: error.code ?? 'deploy_config_rehearsal_failed',
        message: error.message,
      },
      process.stderr,
    );
    return EXIT_CODES.commandFailed;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
