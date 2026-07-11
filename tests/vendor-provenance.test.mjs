import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, cp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PROVENANCE_PATH = join(ROOT, 'provenance/ks2-mastery-gate-a.json');
const VERIFIER_PATH = join(ROOT, 'scripts/verify-vendored-contract.mjs');
const A3_MANIFEST_PATH = join(
  ROOT,
  'vendor/ks2-mastery/content/spelling.mobile-a3-contract-manifest.json',
);

const EXPECTED = Object.freeze({
  repository: 'https://github.com/fol2/ks2-mastery.git',
  commit: '4501607a9b58f2fb252b4cce64ba056e6f60c630',
  tree: '129ba457cccf21df03f4be813b4f4ed6e7d9f6ad',
  manifestSha256:
    '7fea17613ee10f747c1cfa9d5c923da4e506e23e61d1530ca71c283c0ce39465',
  runtimeEntry: 'shared/spelling/mobile/a3/index.js',
  runtimeFileCount: 24,
  starterSha256:
    'a67317764d1bae4e1796e070fa8d482c0b4702451c63ba7cacf9470c5272eb34',
  starterCount: 20,
  fullSha256:
    '50918c93043eba984cb2472238ac9370be4f46fb52a55c76cf5c469beb330d84',
  fullCount: 213,
});

async function copyRepository() {
  const parent = await mkdtemp(join(tmpdir(), 'ks2-spelling-vendor-test-'));
  const copyRoot = join(parent, 'isolated-mobile-repository');
  await cp(ROOT, copyRoot, {
    recursive: true,
    filter: (source) => !source.split('/').includes('.git'),
  });
  return copyRoot;
}

async function expectVerificationFailure(mutate, expectedPattern) {
  const copyRoot = await copyRepository();
  await mutate(copyRoot);

  const { verifyVendoredContract } = await import(
    `${pathToFileURL(VERIFIER_PATH).href}?tamper=${crypto.randomUUID()}`
  );
  await assert.rejects(
    () => verifyVendoredContract({ rootDir: copyRoot }),
    expectedPattern,
  );
}

test('the frozen Gate A spelling runtime is vendored and certified', async () => {
  assert.ok(
    existsSync(PROVENANCE_PATH) &&
      existsSync(A3_MANIFEST_PATH) &&
      existsSync(VERIFIER_PATH),
    'missing vendored Gate A runtime, provenance record or verifier',
  );

  const provenance = JSON.parse(await readFile(PROVENANCE_PATH, 'utf8'));
  assert.equal(provenance.upstream.repository, EXPECTED.repository);
  assert.equal(provenance.upstream.commit, EXPECTED.commit);
  assert.equal(provenance.upstream.tree, EXPECTED.tree);
  assert.equal(provenance.evidence.a3Manifest.sha256, EXPECTED.manifestSha256);
  assert.equal(provenance.runtime.entry, EXPECTED.runtimeEntry);
  assert.equal(provenance.runtime.fileCount, EXPECTED.runtimeFileCount);
  assert.equal(provenance.catalogues.starter.sha256, EXPECTED.starterSha256);
  assert.equal(provenance.catalogues.starter.itemCount, EXPECTED.starterCount);
  assert.equal(provenance.catalogues.full.sha256, EXPECTED.fullSha256);
  assert.equal(provenance.catalogues.full.itemCount, EXPECTED.fullCount);

  const a3Manifest = JSON.parse(await readFile(A3_MANIFEST_PATH, 'utf8'));

  const { verifyVendoredContract } = await import(
    pathToFileURL(VERIFIER_PATH).href
  );
  const result = await verifyVendoredContract({ rootDir: ROOT });
  assert.deepEqual(result, {
    runtimeFilesVerified: 24,
    importRecordsVerified: a3Manifest.runtime.importPolicy.records.length,
    starterItemsVerified: 20,
    fullItemsVerified: 213,
  });

  const cli = spawnSync(process.execPath, [VERIFIER_PATH], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env },
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /24\/24 runtime hashes verified/);
  assert.match(cli.stdout, /Starter 20; Full 213/);
});

test('the app-owned façade exposes only the certified runtime and read-only catalogues', async () => {
  const a3Manifest = JSON.parse(await readFile(A3_MANIFEST_PATH, 'utf8'));
  const facadeSource = await readFile(
    join(ROOT, 'src/domain/spelling/index.js'),
    'utf8',
  );
  assert.doesNotMatch(facadeSource, /(?:from|import\s*)\s*['"]node:/);
  const facade = await import(
    `${pathToFileURL(join(ROOT, 'src/domain/spelling/index.js')).href}?test=${crypto.randomUUID()}`
  );
  const expectedExports = [
    ...a3Manifest.runtime.publicExports,
    'loadFullSpellingCatalogue',
    'loadStarterSpellingCatalogue',
  ].sort();
  assert.deepEqual(Object.keys(facade).sort(), expectedExports);

  const starter = await facade.loadStarterSpellingCatalogue();
  const full = await facade.loadFullSpellingCatalogue();
  assert.equal(starter.items.length, EXPECTED.starterCount);
  assert.equal(full.items.length, EXPECTED.fullCount);
  assert.ok(Object.isFrozen(starter));
  assert.ok(Object.isFrozen(starter.items));
  assert.ok(Object.isFrozen(full));
  assert.ok(Object.isFrozen(full.items));
  assert.equal(
    [...starter.items, ...full.items].filter((item) =>
      /secure|extra/i.test(item.coverageTier),
    ).length,
    0,
    'Starter and Full catalogues must not leak secure or Extra tier items',
  );
});

test('verification fails closed for representative tampering', async (t) => {
  await t.test('recorded runtime hash drift', async () => {
    await expectVerificationFailure(async (copyRoot) => {
      const target = join(
        copyRoot,
        'vendor/ks2-mastery/shared/spelling/mobile/a3/index.js',
      );
      await writeFile(target, `${await readFile(target, 'utf8')}\n// tampered\n`);
    }, /hash mismatch.*shared\/spelling\/mobile\/a3\/index\.js/is);
  });

  await t.test('an unexpected vendored file', async () => {
    await expectVerificationFailure(async (copyRoot) => {
      const target = join(
        copyRoot,
        'vendor/ks2-mastery/shared/spelling/mobile/a3/unexpected.js',
      );
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, 'export const unexpected = true;\n');
    }, /unexpected vendored file.*unexpected\.js/is);
  });

  await t.test('an absolute import outside the certified closure', async () => {
    await expectVerificationFailure(async (copyRoot) => {
      const target = join(
        copyRoot,
        'vendor/ks2-mastery/shared/spelling/mobile/a3/index.js',
      );
      await writeFile(
        target,
        `${await readFile(target, 'utf8')}\nimport '/Users/example/ks2-mastery/shared/escape.js';\n`,
      );
    }, /absolute import.*\/Users\/example\/ks2-mastery\/shared\/escape\.js/is);
  });

  await t.test('recorded upstream authority drift', async () => {
    await expectVerificationFailure(async (copyRoot) => {
      const target = join(copyRoot, 'provenance/ks2-mastery-gate-a.json');
      const provenance = JSON.parse(await readFile(target, 'utf8'));
      provenance.upstream.commit = '0000000000000000000000000000000000000000';
      await writeFile(target, `${JSON.stringify(provenance, null, 2)}\n`);
    }, /authority mismatch.*commit/is);
  });
});
