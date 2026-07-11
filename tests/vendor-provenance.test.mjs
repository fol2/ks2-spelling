import assert from 'node:assert/strict';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
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
const TEMP_COPY_EXCLUDED_COMPONENTS = new Set([
  '.git',
  '.native-build',
  'dist',
  'node_modules',
]);

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

const EXPECTED_A3_PRODUCER_TESTS = Object.freeze({
  'tests/spelling-mobile-a3-command-contracts.test.js': 'd4d6eb6032f9022161c6ad6d109e20a7edb575c9edbf085c191d60f16366f93e',
  'tests/spelling-mobile-a3-command-planner.test.js': '5d26781a4fc32e84290215f25016927eb3a500ad433c6e90a782ea87fdf12cda',
  'tests/spelling-mobile-a3-command-repository.test.js': 'efabf2976cbe696cb5986491c4fc0ba8acf57fd5ee356124a92061d7c9cc0fbd',
  'tests/spelling-mobile-a3-atomicity.test.js': 'aa43b0e113397d544b9d0d1cd900f01744673e8e150cc852594b7edef14357b2',
  'tests/spelling-mobile-a3-monster-projection.test.js': 'c995de43c6ab5c3741c2c3ea7904240aebb82e930eeec6a521b1da1a29f4d1ec',
  'tests/spelling-mobile-a3-camp-projection.test.js': '741190527be9a76ffcd8d4d33180981844700f16318e7aa72dc16bdb6bc1bae7',
  'tests/spelling-mobile-a3-revision-projection.test.js': '996c5708d7a0b0167ed9f178f972f9d39f7e4d90bf66c9dd9ded09600141f8ce',
  'tests/spelling-mobile-a3-parent-projection.test.js': '7cb95867ee9762fdf6088bc4191a8ae0362677e8d849559e649c41838d3a9d86',
  'tests/spelling-mobile-a3-profile-repository.test.js': '696bdbf6c98f8361bc7270b3538dce0528e1be380066fa767b3976280bda2482',
});

async function copyRepository() {
  const parent = await mkdtemp(join(tmpdir(), 'ks2-spelling-vendor-test-'));
  const copyRoot = join(parent, 'isolated-mobile-repository');
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    await rm(parent, { force: true, recursive: true });
    cleaned = true;
  };

  try {
    await cp(ROOT, copyRoot, {
      recursive: true,
      filter: (source) =>
        !source
          .split(/[\\/]/)
          .some((component) => TEMP_COPY_EXCLUDED_COMPONENTS.has(component)),
    });
  } catch (error) {
    await cleanup();
    throw error;
  }

  return { cleanup, copyRoot, parent };
}

async function expectVerificationFailure(mutate, expectedPattern) {
  const { cleanup, copyRoot } = await copyRepository();
  try {
    await mutate(copyRoot);

    const { verifyVendoredContract } = await import(
      `${pathToFileURL(VERIFIER_PATH).href}?tamper=${crypto.randomUUID()}`
    );
    await assert.rejects(
      () => verifyVendoredContract({ rootDir: copyRoot }),
      expectedPattern,
    );
  } finally {
    await cleanup();
  }
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
  assert.equal(provenance.vendor.expectedFileCount, 29);
  assert.deepEqual(provenance.producerTests, {
    root: 'vendor/ks2-mastery',
    fileCount: 9,
    runtimeAuthority: false,
    source:
      'Exact bytes extracted from the frozen Gate A commit for downstream contract testing.',
    files: EXPECTED_A3_PRODUCER_TESTS,
  });
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
    runtimeAuthorityFilesVerified: 29,
    producerTestFilesVerified: 9,
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
  assert.match(cli.stdout, /29\/29 runtime\/content authority files verified/);
  assert.match(cli.stdout, /9\/9 producer test hashes verified/);
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

test('temporary tamper copies exclude ignored outputs and clean up their parent', async () => {
  const { cleanup, copyRoot, parent } = await copyRepository();

  try {
    assert.equal(
      existsSync(join(copyRoot, 'node_modules')),
      false,
      'temporary copies must not include node_modules',
    );
    assert.equal(
      existsSync(join(copyRoot, 'dist')),
      false,
      'temporary copies must not include dist',
    );
    assert.equal(
      existsSync(join(copyRoot, '.native-build')),
      false,
      'temporary copies must not include native build output',
    );
    assert.equal(typeof cleanup, 'function');
  } finally {
    await cleanup();
  }

  assert.equal(existsSync(parent), false, 'temporary copy parent must be removed');
});

test('verification fails closed for representative tampering', async (t) => {
  await t.test('an intermediate vendored path component is replaced with a directory symlink', async () => {
    await expectVerificationFailure(async (copyRoot) => {
      const vendorDirectory = join(copyRoot, 'vendor');
      const relocatedVendorDirectory = join(copyRoot, 'vendor-relocated');
      await rename(vendorDirectory, relocatedVendorDirectory);
      await symlink(relocatedVendorDirectory, vendorDirectory, 'dir');
    }, /vendored path component is a symlink: vendor/i);
  });

  await t.test('the vendored root is replaced with a directory symlink', async () => {
    await expectVerificationFailure(async (copyRoot) => {
      const vendorRoot = join(copyRoot, 'vendor/ks2-mastery');
      const relocatedVendorRoot = join(copyRoot, 'vendor/ks2-mastery-relocated');
      await rename(vendorRoot, relocatedVendorRoot);
      await symlink(relocatedVendorRoot, vendorRoot, 'dir');
    }, /vendor root is a symlink/i);
  });

  await t.test('recorded runtime hash drift', async () => {
    await expectVerificationFailure(async (copyRoot) => {
      const target = join(
        copyRoot,
        'vendor/ks2-mastery/shared/spelling/mobile/a3/index.js',
      );
      await writeFile(target, `${await readFile(target, 'utf8')}\n// tampered\n`);
    }, /hash mismatch.*shared\/spelling\/mobile\/a3\/index\.js/is);
  });

  await t.test('a missing producer test', async () => {
    await expectVerificationFailure(async (copyRoot) => {
      await rm(
        join(
          copyRoot,
          'vendor/ks2-mastery/tests/spelling-mobile-a3-command-contracts.test.js',
        ),
      );
    }, /missing producer test.*spelling-mobile-a3-command-contracts\.test\.js/is);
  });

  await t.test('producer test hash drift', async () => {
    await expectVerificationFailure(async (copyRoot) => {
      const target = join(
        copyRoot,
        'vendor/ks2-mastery/tests/spelling-mobile-a3-command-planner.test.js',
      );
      await writeFile(target, `${await readFile(target, 'utf8')}\n// tampered\n`);
    }, /producer test hash mismatch.*spelling-mobile-a3-command-planner\.test\.js/is);
  });

  await t.test('an unexpected producer test', async () => {
    await expectVerificationFailure(async (copyRoot) => {
      const target = join(
        copyRoot,
        'vendor/ks2-mastery/tests/spelling-mobile-a3-unexpected.test.js',
      );
      await writeFile(target, "import test from 'node:test';\ntest('unexpected', () => {});\n");
    }, /unexpected vendored file.*spelling-mobile-a3-unexpected\.test\.js/is);
  });

  await t.test('a producer test is replaced with a symlink', async () => {
    await expectVerificationFailure(async (copyRoot) => {
      const target = join(
        copyRoot,
        'vendor/ks2-mastery/tests/spelling-mobile-a3-atomicity.test.js',
      );
      const relocated = join(copyRoot, 'relocated-producer-test.js');
      await rename(target, relocated);
      await symlink(relocated, target, 'file');
    }, /unexpected vendored symlink.*spelling-mobile-a3-atomicity\.test\.js/is);
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
