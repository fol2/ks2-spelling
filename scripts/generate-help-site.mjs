import { resolve } from 'node:path';
import { assertHelpSiteCurrent, writeHelpSiteFiles } from './lib/help-site.mjs';
import { EXIT_CODES, isMain, printJson } from './lib/run-command.mjs';

const ROOT = resolve(import.meta.dirname, '..');

export async function main(args = process.argv.slice(2), { root = ROOT } = {}) {
  const write = args.includes('--write');
  try {
    if (write) {
      const files = await writeHelpSiteFiles(root);
      printJson({
        ok: true,
        evidence: 'written',
        files: [...files.keys()].map((relative) => `site/${relative}`),
      });
      return EXIT_CODES.success;
    }
    await assertHelpSiteCurrent(root);
    printJson({ ok: true, evidence: 'current', directory: 'site' });
    return EXIT_CODES.success;
  } catch (error) {
    printJson(
      { ok: false, code: error.code ?? 'help_site_generate_failed', message: error.message },
      process.stderr,
    );
    return error.code === 'help_site_stale' ? EXIT_CODES.stateMismatch : EXIT_CODES.commandFailed;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
