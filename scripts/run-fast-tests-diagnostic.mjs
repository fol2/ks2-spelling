import { readdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const EXCLUDED = new Set([
  'native-wrapper-contract.test.mjs',
  'b3-store-backed-live-capture.test.mjs',
  'gateway-workerd-runtime.test.mjs',
]);
const DIAGNOSTIC_PATH = '/tmp/trail-fast-diagnostic.log';

const tests = (await readdir('tests'))
  .filter((name) => (
    name.endsWith('.test.mjs')
    && !name.endsWith('.slow.test.mjs')
    && !EXCLUDED.has(name)
  ))
  .sort();

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', file], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (code, signal) => resolve({ code, signal, output }));
  });
}

let diagnostic = '';
for (const name of tests) {
  const file = join('tests', name);
  const result = await run(file);
  if (result.code !== 0) {
    diagnostic = `FAST_TEST_FAILURE: ${file}\n${result.output.trim()}\n`;
    console.error(diagnostic);
    process.exitCode = result.code || 1;
    break;
  }
}

if (process.exitCode === undefined) {
  diagnostic = `FAST_TEST_DIAGNOSTIC_PASS: ${tests.length} files\n`;
  console.log(diagnostic.trim());
}

await writeFile(DIAGNOSTIC_PATH, diagnostic);
