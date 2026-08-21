import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  IOS_RELEASE_BUILD_STEPS,
  verifyIosReleaseArtefactPair,
} from '../scripts/verify-ios-release-artefacts.mjs';

const PRODUCTION_KEYRING = JSON.stringify({
  keys: [{ keyId: 'production-ks2-p256-2026-08', allowedPackIds: ['full-ks2-spelling'] }],
});
const SANDBOX_KEYRING = JSON.stringify({
  keys: [{ keyId: 'b3-test-p256-2026-07', allowedPackIds: ['b3-sandbox-proof'] }],
});

async function writeApp(root, name, javascript, keyring) {
  const app = join(root, `${name}.app`);
  await mkdir(join(app, 'public/assets'), { recursive: true });
  await writeFile(join(app, 'public/assets/index.js'), javascript);
  await writeFile(join(app, 'pack-signing-public-keys.json'), keyring);
  await writeFile(join(app, 'App'), 'native executable');
  return app;
}

test('the iOS Release artefact verifier accepts the production and sandbox pair', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ks2-ios-release-artefacts-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const productionApp = await writeApp(
    root, 'Production', 'const gateway = "ks2-gateway.eugnel.uk";', PRODUCTION_KEYRING,
  );
  const sandboxApp = await writeApp(
    root, 'Sandbox',
    'const proof = "b3-gateway.eugnel.uk b3-test-p256-2026-07 b3-sandbox-proof";',
    SANDBOX_KEYRING,
  );

  assert.deepEqual(
    await verifyIosReleaseArtefactPair({ productionApp, sandboxApp }),
    {
      production: { releaseChannel: 'production', appPath: productionApp },
      sandbox: { releaseChannel: 'sandbox', appPath: sandboxApp },
    },
  );
});

test('a sandbox-selected production Release fails direct artefact inspection', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ks2-ios-release-mutation-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const sandboxApp = await writeApp(
    root, 'Sandbox',
    'const proof = "b3-gateway.eugnel.uk b3-test-p256-2026-07 b3-sandbox-proof";',
    SANDBOX_KEYRING,
  );
  await writeFile(join(sandboxApp, 'App'), 'native b3-gateway.eugnel.uk executable');

  await assert.rejects(
    verifyIosReleaseArtefactPair({ productionApp: sandboxApp, sandboxApp }),
    /Production artefact contains forbidden identity b3-gateway\.eugnel\.uk/u,
  );
});

test('the release verifier command and CI wiring select both unsigned iOS applications', async () => {
  // Executing the npm command in CI is the proof that these commands produce
  // and directly inspect the paired application bundles. This test locks the
  // command construction and workflow wiring without claiming to build them.
  const commands = IOS_RELEASE_BUILD_STEPS.map(({ command, args }) => `${command} ${args.join(' ')}`);
  assert.equal(commands.length, 6);
  assert.match(commands[2], /-scheme Sandbox -configuration Sandbox/u);
  assert.match(commands[2], /CODE_SIGNING_ALLOWED=NO build$/u);
  assert.match(commands[5], /-scheme KS2Spelling -configuration Release/u);
  assert.match(commands[5], /CODE_SIGNING_ALLOWED=NO build$/u);

  const [workflow, packageJson] = await Promise.all([
    readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ]);
  assert.match(packageJson, /"verify:ios-release-artefacts":\s*"node scripts\/verify-ios-release-artefacts\.mjs"/u);
  assert.match(workflow, /npm run verify:ios-release-artefacts/u);
});

test('both native CI path filters select the listed native release gate inputs', async () => {
  const {
    NATIVE_CI_PATH_PREFIXES,
    pathSelectsNativeCi,
  } = await import('../scripts/lib/native-ci-path-filter.mjs');
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.equal(
    [...workflow.matchAll(/node scripts\/detect-native-ci-changes\.mjs/gu)].length,
    2,
  );

  const authorities = new Map([
    ['config/production/pack-signing-public-keys.json', 'config/'],
    ['scripts/select-pack-signing-keyring.mjs', 'scripts/'],
    ['scripts/verify-ios-release-artefacts.mjs', 'scripts/'],
  ]);
  for (const [path, prefix] of authorities) {
    assert.equal(pathSelectsNativeCi(path), true, `${path} must select native CI`);
    const reverted = NATIVE_CI_PATH_PREFIXES.filter((entry) => entry !== prefix);
    assert.equal(
      pathSelectsNativeCi(path, { prefixes: reverted }),
      false,
      `${path} must turn the contract red when its exact filter prefix is reverted`,
    );
  }
});
