import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import {
  B3_PLANNED_PACKAGE_SCRIPT_ADDITIONS,
  B4_PLANNED_PACKAGE_SCRIPT_ADDITIONS,
  SDLC_DAILY_LOOP_PACKAGE_SCRIPT_ADDITIONS,
  assertB2PackageTransition,
  verifyB3PackageTransitionAuthority,
} from '../scripts/lib/b3-package-transition-authority.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const FROZEN_COMMIT = '39ef90a5a33efb41368272c4c6d4d002f04658b3';

const EXPECTED_SCRIPT_NAMES = Object.freeze([
  'verify:b2-authority',
  'check:b3-prerequisites',
  'build:b3-proof-pack',
  'prove:b3:ios-storekit-test',
  'report:b3-native',
  'prove:b3:deterministic',
  'deploy:b3:sandbox',
  'prove:b3:cloudflare',
  'prove:b3:ios',
  'prove:b3:android',
  'prepare:b3:distribution',
  'verify:b3:installed-distribution',
  'verify:b3',
]);

const EXPECTED_B4_SCRIPT_NAMES = Object.freeze([
  'build:b4-development',
  'sync:b4-development',
  'prove:b4:ios',
  'prove:b4:android',
  'report:b4-development',
  'report:b4-development:check',
]);

const EXPECTED_SDLC_SCRIPT_NAMES = Object.freeze([
  'test:fast',
  'test:watch',
  'test:changed',
  'hooks:install',
]);

function frozenPackage() {
  return JSON.parse(
    execFileSync('git', ['cat-file', 'blob', `${FROZEN_COMMIT}:package.json`], {
      cwd: ROOT,
      encoding: 'utf8',
    }),
  );
}

async function authorityFixture() {
  const root = await mkdtemp(join(tmpdir(), 'ks2-spelling-b3-transition-'));
  for (const relativePath of [
    'provenance/b3-package-transition.json',
    'scripts/build-b2-native-plugin-report.mjs',
    'scripts/lib/frozen-b2-git.mjs',
    'scripts/lib/pinned-system-git.mjs',
    'tests/b2-native-plugin-build-policy.test.mjs',
  ]) {
    const target = join(root, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(join(ROOT, relativePath)));
  }
  return root;
}

test('transition authority freezes every package script declared by the approved B3 and B4 plans', async () => {
  const authority = await verifyB3PackageTransitionAuthority({ root: ROOT });
  assert.deepEqual(Object.keys(B3_PLANNED_PACKAGE_SCRIPT_ADDITIONS), EXPECTED_SCRIPT_NAMES);
  assert.deepEqual(Object.keys(B4_PLANNED_PACKAGE_SCRIPT_ADDITIONS), EXPECTED_B4_SCRIPT_NAMES);
  assert.deepEqual(
    Object.keys(SDLC_DAILY_LOOP_PACKAGE_SCRIPT_ADDITIONS),
    EXPECTED_SDLC_SCRIPT_NAMES,
  );
  assert.deepEqual(
    authority.allowedPackageScriptAdditions,
    {
      ...B3_PLANNED_PACKAGE_SCRIPT_ADDITIONS,
      ...B4_PLANNED_PACKAGE_SCRIPT_ADDITIONS,
      ...SDLC_DAILY_LOOP_PACKAGE_SCRIPT_ADDITIONS,
    },
  );
  assert.deepEqual(authority.protectedCurrentFiles.map(({ path }) => path), [
    'scripts/build-b2-native-plugin-report.mjs',
    'scripts/lib/frozen-b2-git.mjs',
    'scripts/lib/pinned-system-git.mjs',
    'tests/b2-native-plugin-build-policy.test.mjs',
  ]);
});

test('package transition accepts any reviewed subset of exact planned additions only', async () => {
  const authority = await verifyB3PackageTransitionAuthority({ root: ROOT });
  const frozen = frozenPackage();
  const current = structuredClone(frozen);
  current.scripts['verify:b2-authority'] =
    B3_PLANNED_PACKAGE_SCRIPT_ADDITIONS['verify:b2-authority'];
  current.scripts['check:b3-prerequisites'] =
    B3_PLANNED_PACKAGE_SCRIPT_ADDITIONS['check:b3-prerequisites'];
  assert.doesNotThrow(() => assertB2PackageTransition(frozen, current, authority));

  for (const [name, command] of Object.entries(B3_PLANNED_PACKAGE_SCRIPT_ADDITIONS)) {
    const candidate = structuredClone(current);
    candidate.scripts[name] = command;
    assert.doesNotThrow(() => assertB2PackageTransition(frozen, candidate, authority), name);
  }
  for (const [name, command] of Object.entries(B4_PLANNED_PACKAGE_SCRIPT_ADDITIONS)) {
    const candidate = structuredClone(current);
    candidate.scripts[name] = command;
    assert.doesNotThrow(() => assertB2PackageTransition(frozen, candidate, authority), name);
  }
});

test('package transition rejects arbitrary name, command, dependency and package drift', async () => {
  const authority = await verifyB3PackageTransitionAuthority({ root: ROOT });
  const frozen = frozenPackage();
  const current = structuredClone(frozen);
  current.scripts['verify:b2-authority'] =
    B3_PLANNED_PACKAGE_SCRIPT_ADDITIONS['verify:b2-authority'];

  const mutations = [
    (value) => {
      value.scripts['unexpected:b3'] = 'node scripts/unexpected.mjs';
    },
    (value) => {
      value.scripts['verify:b2-authority'] = 'node scripts/unsafe.mjs';
    },
    (value) => {
      value.dependencies.react = '0.0.0';
    },
    (value) => {
      value.version = '9.9.9';
    },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(current);
    mutate(candidate);
    assert.throws(
      () => assertB2PackageTransition(frozen, candidate, authority),
      ({ code }) => code === 'b3_package_transition_invalid',
    );
  }
});

test('transition authority rejects verifier, test and closed-schema mutations', async (t) => {
  const root = await authorityFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await verifyB3PackageTransitionAuthority({ root });

  const verifierPath = join(root, 'scripts/build-b2-native-plugin-report.mjs');
  await writeFile(verifierPath, Buffer.concat([await readFile(verifierPath), Buffer.from('\n')]));
  await assert.rejects(
    verifyB3PackageTransitionAuthority({ root }),
    /protected current file hash mismatch/,
  );

  const authorityPath = join(root, 'provenance/b3-package-transition.json');
  const synchronised = JSON.parse(await readFile(authorityPath, 'utf8'));
  synchronised.protectedCurrentFiles.find(({ path }) => path ===
    'scripts/build-b2-native-plugin-report.mjs').sha256 = createHash('sha256')
    .update(await readFile(verifierPath))
    .digest('hex');
  await writeFile(authorityPath, `${JSON.stringify(synchronised, null, 2)}\n`);
  await assert.rejects(
    verifyB3PackageTransitionAuthority({ root }),
    /independent protected hash authority mismatch/,
  );

  await writeFile(
    verifierPath,
    await readFile(join(ROOT, 'scripts/build-b2-native-plugin-report.mjs')),
  );
  const authority = JSON.parse(await readFile(authorityPath, 'utf8'));
  authority.protectedCurrentFiles = JSON.parse(
    await readFile(join(ROOT, 'provenance/b3-package-transition.json'), 'utf8'),
  ).protectedCurrentFiles;
  authority.unreviewed = true;
  await writeFile(authorityPath, `${JSON.stringify(authority, null, 2)}\n`);
  await assert.rejects(
    verifyB3PackageTransitionAuthority({ root }),
    /closed schema/,
  );
});
