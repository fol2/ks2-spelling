import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { EXIT_CODES, isMain, printJson } from './lib/run-command.mjs';

const ROOT = resolve(import.meta.dirname, '..');

export async function main(args = process.argv.slice(2)) {
  const preBootstrap = args.includes('--pre-bootstrap');
  const write = args.includes('--write');
  try {
    const { buildDependencyArtifacts } = await import('./audit-dependencies.mjs');
    const artifacts = await buildDependencyArtifacts({ preBootstrap });
    const path = resolve(ROOT, 'THIRD_PARTY_NOTICES.md');
    if (write) {
      await writeFile(path, artifacts.noticesMarkdown, 'utf8');
    } else if ((await readFile(path, 'utf8')) !== artifacts.noticesMarkdown) {
      const stale = new Error('Committed third-party notices are stale; rerun with --write');
      stale.code = 'dependency_evidence_stale';
      throw stale;
    }
    printJson({
      ok: true,
      file: 'THIRD_PARTY_NOTICES.md',
      evidence: write ? 'written' : 'current',
      npmPackages: artifacts.report.npm.lockPackageCount,
      spmIdentities: artifacts.report.spm.length,
      mavenComponents: artifacts.report.android?.componentCount ?? 0,
      approval: artifacts.pluginAudit.approval,
    });
    return EXIT_CODES.success;
  } catch (error) {
    printJson(
      { ok: false, code: error.code ?? 'notice_generation_failed', message: error.message },
      process.stderr,
    );
    return ['android_resolution_pending', 'dependency_evidence_stale'].includes(error.code)
      ? EXIT_CODES.stateMismatch
      : EXIT_CODES.commandFailed;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
