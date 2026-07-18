import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const source = resolve(root, 'tests/fixtures/b3-hostile-zips');
const destination = resolve(root, 'android/app/src/test/resources/b3-hostile-zips');
const manifest = JSON.parse(await readFile(resolve(source, 'manifest.json'), 'utf8'));
if (!Array.isArray(manifest.fixtures) || manifest.fixtures.length !== 53) {
  throw new Error('The canonical B3 hostile ZIP authority is incomplete.');
}
await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
const temporary = await mkdtemp(resolve(tmpdir(), 'ks2-android-pack-'));
try {
  const build = spawnSync(process.execPath, [
    'scripts/build-b3-proof-pack.mjs', '--output-directory', temporary,
  ], { cwd: root, encoding: 'utf8' });
  if (build.status !== 0) throw new Error(build.stderr || build.stdout);
  await cp(
    resolve(temporary, 'b3-sandbox-proof.zip'),
    resolve(root, 'android/app/src/test/resources/b3-sandbox-proof.zip'),
  );
  await cp(
    resolve(root, 'tests/fixtures/b3-signed-manifest.json'),
    resolve(root, 'android/app/src/test/resources/b3-signed-manifest.json'),
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
process.stdout.write(`Synced ${manifest.fixtures.length} canonical hostile ZIP fixtures.\n`);
