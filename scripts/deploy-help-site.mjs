import { resolve } from 'node:path';
import { runHelpSiteWizard } from './lib/help-site.mjs';
import { EXIT_CODES, isMain, printJson } from './lib/run-command.mjs';

const ROOT = resolve(import.meta.dirname, '..');

export async function main(args = process.argv.slice(2), options = {}) {
  try {
    const result = await runHelpSiteWizard({
      root: options.root ?? ROOT,
      args,
      env: options.env ?? process.env,
      wranglerDeploy: options.wranglerDeploy,
      resolveBin: options.resolveBin,
      run: options.run,
    });
    printJson(result);
    return EXIT_CODES.success;
  } catch (error) {
    printJson(
      {
        ok: false,
        code: error.code ?? 'help_site_wizard_failed',
        message: error.message,
      },
      process.stderr,
    );
    if (error.code === 'help_site_stale') return EXIT_CODES.stateMismatch;
    if (error.code === 'help_site_execute_refused') return EXIT_CODES.usage;
    if (error.code === 'help_site_wrangler_missing') return EXIT_CODES.missingTool;
    return EXIT_CODES.commandFailed;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
