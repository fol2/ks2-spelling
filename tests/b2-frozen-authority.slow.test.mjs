import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';

import { readFrozenB2Blob } from '../scripts/lib/frozen-b2-git.mjs';
import {
  verifyB2Authority,
  verifyB2GitHistory,
} from '../scripts/verify-b2-authority.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const FROZEN_COMMIT = '39ef90a5a33efb41368272c4c6d4d002f04658b3';
const FROZEN_TREE = 'd4e43a1571fd1a811ce572670c30ae7209e52024';
const FROZEN_GIT_INPUTS = Object.freeze([
  'package-lock.json',
  'vendor/ks2-mastery/content/spelling.mobile-a2-contract-manifest.json',
]);

function commitObjectId(rawCommit) {
  return createHash('sha1')
    .update(Buffer.from(`commit ${rawCommit.length}\0`, 'ascii'))
    .update(rawCommit)
    .digest('hex');
}

const FROZEN_RAW_COMMIT = execFileSync(
  '/usr/bin/git',
  ['cat-file', 'commit', FROZEN_COMMIT],
  { cwd: ROOT },
);
const TEST_HEAD_RAW_COMMIT = Buffer.from(
  `tree ${'b'.repeat(40)}\nparent ${FROZEN_COMMIT}\n` +
    'author Test <test@example.invalid> 1 +0000\n' +
    'committer Test <test@example.invalid> 1 +0000\n' +
    'gpgsig -----BEGIN PGP SIGNATURE-----\n signed-line\n -----END PGP SIGNATURE-----\n' +
    '\nHEAD\n',
);
const TEST_HEAD = commitObjectId(TEST_HEAD_RAW_COMMIT);

function readFrozenGitInput(path) {
  return execFileSync('git', ['cat-file', 'blob', `${FROZEN_COMMIT}:${path}`], {
    cwd: ROOT,
  });
}

async function verifiedHistoryRunner(args, _root, options) {
  const command = args.join(' ');
  if (command === 'rev-parse --show-object-format') {
    return { stdout: 'sha1\n', stderr: '' };
  }
  if (command === 'rev-parse --verify HEAD^{commit}') {
    return { stdout: `${TEST_HEAD}\n`, stderr: '' };
  }
  if (command === `cat-file commit ${TEST_HEAD}`) {
    assert.deepEqual(options, { encoding: null });
    return {
      stdout: TEST_HEAD_RAW_COMMIT,
      stderr: Buffer.alloc(0),
    };
  }
  if (command === `cat-file commit ${FROZEN_COMMIT}`) {
    assert.deepEqual(options, { encoding: null });
    return { stdout: FROZEN_RAW_COMMIT, stderr: Buffer.alloc(0) };
  }
  throw new Error(`unexpected Git history command: ${command}`);
}

function verifyFixture(root, overrides = {}) {
  return verifyB2Authority({
    root,
    frozenReader: readFrozenGitInput,
    gitRunner: verifiedHistoryRunner,
    ...overrides,
  });
}

const EXPECTED = Object.freeze({
  schemaVersion: 1,
  commit: '39ef90a5a33efb41368272c4c6d4d002f04658b3',
  tree: 'd4e43a1571fd1a811ce572670c30ae7209e52024',
  hostedCiUrl: 'https://github.com/fol2/ks2-spelling/actions/runs/29192615770',
  exitReportSha256: '6d19101ff93a3c4f0e74ad0ee987beb915686d108071b6a06b6e3e4562cab6ce',
  dependencyAuditSha256: 'bb3b572280d84beeca2ac4a892836e92fc847bf5cf67015c434f54b94ab085d6',
  nativeBuildReportSha256: 'a72e95958e287be21f34588a167f12fd59058ab003dfe3f559b3ba244988a6f9',
  nativePluginAuditSha256: '6c09fcc78055a3ab7f693160da22eb84080e25ee3f389b1b79b2a831b63d3740',
  packageLockSha256: '534b10c7f317622eba32b277b8755a0ac3d04aaf30359117fdeb7510050b6479',
  gateACommit: '4501607a9b58f2fb252b4cce64ba056e6f60c630',
  a2ContractManifestSha256: '237b26b14e7506fa271bb3324f701d6205e6e0166d659a16789937478cc77b66',
});

const AUTHORITY_PATHS = Object.freeze([
  'provenance/b2-gate.json',
  'provenance/b3-package-transition.json',
  'reports/b2/b2-exit-report.json',
  'reports/b2/dependency-audit.json',
  'reports/b2/native-plugin-build.json',
  'reports/b2/native-plugin-audit.json',
  'package.json',
  'package-lock.json',
  'provenance/ks2-mastery-gate-a.json',
  'vendor/ks2-mastery/content/spelling.mobile-a2-contract-manifest.json',
  'scripts/build-b2-native-plugin-report.mjs',
  'scripts/lib/frozen-b2-git.mjs',
  'scripts/lib/pinned-system-git.mjs',
  'tests/b2-native-plugin-build-policy.test.mjs',
]);

async function copyAuthorityFixture() {
  const fixture = await mkdtemp(join(tmpdir(), 'ks2-spelling-b2-authority-'));
  for (const relativePath of AUTHORITY_PATHS) {
    const target = join(fixture, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(join(ROOT, relativePath)));
  }
  return fixture;
}

test('B2 verifier freezes the exact historical commit, tree, hosted CI and authority bytes', async () => {
  assert.deepEqual(await verifyB2Authority({ root: ROOT }), EXPECTED);
});

test('B2 verifier proves HEAD, frozen ancestry and the exact frozen tree through Git', async () => {
  const calls = [];
  assert.deepEqual(
    await verifyB2Authority({
      root: ROOT,
      gitRunner: async (args, root, options) => {
        calls.push({ args, root, options });
        return verifiedHistoryRunner(args, root, options);
      },
    }),
    EXPECTED,
  );
  assert.deepEqual(calls, [
    { args: ['rev-parse', '--show-object-format'], root: ROOT, options: undefined },
    { args: ['rev-parse', '--verify', 'HEAD^{commit}'], root: ROOT, options: undefined },
    {
      args: ['cat-file', 'commit', TEST_HEAD],
      root: ROOT,
      options: { encoding: null },
    },
    {
      args: ['cat-file', 'commit', FROZEN_COMMIT],
      root: ROOT,
      options: { encoding: null },
    },
  ]);

  for (const [name, runner] of [
    ['no HEAD', async () => { throw new Error('no HEAD'); }],
    ['non-descendant', async (args) => {
      if (args[0] === 'cat-file') {
        return {
          stdout: `tree ${'b'.repeat(40)}\nauthor Test <test@example.invalid> 1 +0000\ncommitter Test <test@example.invalid> 1 +0000\n\nunrelated\n`,
          stderr: '',
        };
      }
      return verifiedHistoryRunner(args);
    }],
    ['wrong tree', async (args) =>
      args.at(-1) === FROZEN_COMMIT
        ? {
          stdout: `tree ${'0'.repeat(40)}\nauthor Test <test@example.invalid> 1 +0000\ncommitter Test <test@example.invalid> 1 +0000\n\nfrozen\n`,
          stderr: '',
        }
        : verifiedHistoryRunner(args)],
  ]) {
    await assert.rejects(
      verifyB2Authority({ root: ROOT, gitRunner: runner }),
      /B2 Git history verification failed/,
      name,
    );
  }
});

test('B2 verifier rejects an orphan repository before reading provenance', async (t) => {
  const orphan = await mkdtemp(join(tmpdir(), 'ks2-spelling-b2-orphan-'));
  t.after(() => rm(orphan, { recursive: true, force: true }));
  execFileSync('/usr/bin/git', ['init', '-q'], { cwd: orphan });
  await assert.rejects(
    verifyB2Authority({ root: orphan }),
    /B2 Git history verification failed/,
  );
});

test('raw B2 ancestry rejects static and concurrently toggled grafts between orphan commits', async (t) => {
  const repository = await mkdtemp(join(tmpdir(), 'ks2-spelling-b2-grafts-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  execFileSync('/usr/bin/git', ['init', '-q'], { cwd: repository });
  await writeFile(join(repository, 'first.txt'), 'first\n');
  execFileSync('/usr/bin/git', ['add', 'first.txt'], { cwd: repository });
  execFileSync(
    '/usr/bin/git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'first'],
    { cwd: repository },
  );
  const first = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
  }).trim();
  execFileSync('/usr/bin/git', ['checkout', '--orphan', 'unrelated', '-q'], { cwd: repository });
  execFileSync('/usr/bin/git', ['rm', '-rfq', '.'], { cwd: repository });
  await writeFile(join(repository, 'second.txt'), 'second\n');
  execFileSync('/usr/bin/git', ['add', 'second.txt'], { cwd: repository });
  execFileSync(
    '/usr/bin/git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'second'],
    { cwd: repository },
  );
  const second = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
  }).trim();
  assert.throws(() =>
    execFileSync('/usr/bin/git', ['merge-base', '--is-ancestor', first, second], {
      cwd: repository,
      stdio: 'ignore',
    }),
  );
  const graftsPath = join(repository, '.git/info/grafts');
  await writeFile(graftsPath, `${second} ${first}\n`);
  execFileSync('/usr/bin/git', ['merge-base', '--is-ancestor', first, second], {
    cwd: repository,
    stdio: 'ignore',
  });
  const firstTree = execFileSync('/usr/bin/git', ['show', '-s', '--format=%T', first], {
    cwd: repository,
    encoding: 'utf8',
  }).trim();
  const rejectsRawAncestry = () =>
    assert.rejects(
      verifyB2GitHistory({
        root: repository,
        frozenCommit: first,
        frozenTree: firstTree,
      }),
      ({ message }) => message === 'B2 Git history verification failed',
    );
  await rejectsRawAncestry();

  let toggling = true;
  const toggler = (async () => {
    for (let index = 0; index < 100 && toggling; index += 1) {
      if (index % 2 === 0) await writeFile(graftsPath, `${second} ${first}\n`);
      else await rm(graftsPath, { force: true });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2));
    }
  })();
  try {
    for (let attempt = 0; attempt < 20; attempt += 1) await rejectsRawAncestry();
  } finally {
    toggling = false;
    await toggler;
  }
});

test('raw B2 ancestry accepts merge history from a linked worktree', async (t) => {
  const repository = await mkdtemp(join(tmpdir(), 'ks2-spelling-b2-merge-'));
  const linked = join(repository, 'linked-worktree');
  t.after(() => rm(repository, { recursive: true, force: true }));
  execFileSync('/usr/bin/git', ['init', '-q'], { cwd: repository });
  await writeFile(join(repository, 'tracked.txt'), 'tracked\n');
  execFileSync('/usr/bin/git', ['add', 'tracked.txt'], { cwd: repository });
  execFileSync(
    '/usr/bin/git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base'],
    { cwd: repository },
  );
  const base = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
  }).trim();
  const baseTree = execFileSync('/usr/bin/git', ['show', '-s', '--format=%T', base], {
    cwd: repository,
    encoding: 'utf8',
  }).trim();
  execFileSync('/usr/bin/git', ['checkout', '-qb', 'feature'], { cwd: repository });
  await writeFile(join(repository, 'feature.txt'), 'feature\n');
  execFileSync('/usr/bin/git', ['add', 'feature.txt'], { cwd: repository });
  execFileSync(
    '/usr/bin/git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'feature'],
    { cwd: repository },
  );
  execFileSync('/usr/bin/git', ['checkout', '-q', '-'], { cwd: repository });
  await writeFile(join(repository, 'main.txt'), 'main\n');
  execFileSync('/usr/bin/git', ['add', 'main.txt'], { cwd: repository });
  execFileSync(
    '/usr/bin/git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'main'],
    { cwd: repository },
  );
  execFileSync(
    '/usr/bin/git',
    [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'merge', '--no-ff', '-qm', 'merge', 'feature',
    ],
    { cwd: repository },
  );
  execFileSync('/usr/bin/git', ['worktree', 'add', '--detach', '-q', linked, 'HEAD'], {
    cwd: repository,
  });
  for (const root of [repository, linked]) {
    await assert.doesNotReject(() =>
      verifyB2GitHistory({ root, frozenCommit: base, frozenTree: baseTree }),
    );
  }
});

test('raw B2 ancestry fails on malformed, missing or over-limit commit objects', async () => {
  const parent = 'c'.repeat(40);
  const validHeadRaw = Buffer.from(
    `tree ${'b'.repeat(40)}\nparent ${parent}\n` +
      'author Test <test@example.invalid> 1 +0000\n' +
      'committer Test <test@example.invalid> 1 +0000\n\nhead\n',
  );
  const runner = ({ rawCommit = validHeadRaw, missing = false } = {}) => {
    const head = commitObjectId(rawCommit);
    return async (args) => {
      if (args.join(' ') === 'rev-parse --show-object-format') {
        return { stdout: 'sha1\n', stderr: '' };
      }
      if (args.join(' ') === 'rev-parse --verify HEAD^{commit}') {
        return { stdout: `${head}\n`, stderr: '' };
      }
      if (args.at(-1) === head) {
        return { stdout: rawCommit, stderr: Buffer.alloc(0) };
      }
      if (missing) throw new Error('missing commit object');
      throw new Error(`unexpected Git command: ${args.join(' ')}`);
    };
  };
  for (const options of [
    { rawCommit: Buffer.from('not a raw commit\n') },
    { missing: true },
  ]) {
    await assert.rejects(
      verifyB2GitHistory({
        root: ROOT,
        gitRunner: runner(options),
        frozenCommit: parent,
        frozenTree: FROZEN_TREE,
      }),
      /B2 Git history verification failed/,
    );
  }
  await assert.rejects(
    verifyB2GitHistory({
      root: ROOT,
      gitRunner: runner(),
      frozenCommit: parent,
      frozenTree: FROZEN_TREE,
      maxCommits: 1,
    }),
    /B2 Git history verification failed/,
  );
});

test('raw B2 ancestry rejects substituted loose commit bytes under the queued object ID', async (t) => {
  const repository = await mkdtemp(join(tmpdir(), 'ks2-spelling-b2-object-id-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  execFileSync('/usr/bin/git', ['init', '-q'], { cwd: repository });
  await writeFile(join(repository, 'tracked.txt'), 'first\n');
  execFileSync('/usr/bin/git', ['add', 'tracked.txt'], { cwd: repository });
  execFileSync(
    '/usr/bin/git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'first'],
    { cwd: repository },
  );
  const frozenCommit = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
  }).trim();
  const frozenTree = execFileSync('/usr/bin/git', ['show', '-s', '--format=%T', frozenCommit], {
    cwd: repository,
    encoding: 'utf8',
  }).trim();
  await writeFile(join(repository, 'tracked.txt'), 'second\n');
  execFileSync('/usr/bin/git', ['add', 'tracked.txt'], { cwd: repository });
  execFileSync(
    '/usr/bin/git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'second'],
    { cwd: repository },
  );
  const head = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
  }).trim();
  await assert.doesNotReject(() =>
    verifyB2GitHistory({ root: repository, frozenCommit, frozenTree }),
  );

  const substituted = execFileSync('/usr/bin/git', ['cat-file', 'commit', head], {
    cwd: repository,
  });
  substituted[substituted.length - 2] ^= 1;
  const looseObject = Buffer.concat([
    Buffer.from(`commit ${substituted.length}\0`, 'ascii'),
    substituted,
  ]);
  const looseObjectPath = join(repository, '.git/objects', head.slice(0, 2), head.slice(2));
  await chmod(looseObjectPath, 0o600);
  await writeFile(looseObjectPath, deflateSync(looseObject));

  await assert.rejects(
    verifyB2GitHistory({ root: repository, frozenCommit, frozenTree }),
    /B2 Git history verification failed/,
  );
});

test('raw B2 ancestry independently rejects substituted bytes returned for a queued object ID', async () => {
  const frozenRaw = Buffer.from(
    `tree ${FROZEN_TREE}\nauthor Test <test@example.invalid> 1 +0000\n` +
      'committer Test <test@example.invalid> 1 +0000\n\nfrozen\n',
  );
  const frozenCommit = commitObjectId(frozenRaw);
  const validHeadRaw = Buffer.from(
    `tree ${'b'.repeat(40)}\nparent ${frozenCommit}\n` +
      'author Test <test@example.invalid> 1 +0000\n' +
      'committer Test <test@example.invalid> 1 +0000\n' +
      'gpgsig -----BEGIN PGP SIGNATURE-----\n signed-line\n -----END PGP SIGNATURE-----\n' +
      '\nvalid\n',
  );
  const head = commitObjectId(validHeadRaw);
  const substituted = Buffer.from(validHeadRaw);
  substituted[substituted.length - 2] ^= 1;
  let servedHead = validHeadRaw;
  const runner = async (args) => {
    if (args.join(' ') === 'rev-parse --show-object-format') {
      return { stdout: 'sha1\n', stderr: '' };
    }
    if (args.join(' ') === 'rev-parse --verify HEAD^{commit}') {
      return { stdout: `${head}\n`, stderr: '' };
    }
    if (args.at(-1) === head) {
      return { stdout: servedHead, stderr: Buffer.alloc(0) };
    }
    if (args.at(-1) === frozenCommit) {
      return { stdout: frozenRaw, stderr: Buffer.alloc(0) };
    }
    throw new Error(`unexpected Git command: ${args.join(' ')}`);
  };
  await assert.doesNotReject(() =>
    verifyB2GitHistory({
      root: ROOT,
      gitRunner: runner,
      frozenCommit,
      frozenTree: FROZEN_TREE,
    }),
  );
  servedHead = substituted;
  await assert.rejects(
    verifyB2GitHistory({
      root: ROOT,
      gitRunner: runner,
      frozenCommit,
      frozenTree: FROZEN_TREE,
    }),
    /B2 Git history verification failed/,
  );
});

test('frozen B2 blob reader uses exact cat-file arguments and a closed Git environment', async () => {
  let invocation;
  const bytes = await readFrozenB2Blob({
    root: ROOT,
    path: 'package-lock.json',
    ambientEnv: {
      PATH: '/usr/bin',
      GIT_INDEX_FILE: '/hostile/index',
      GIT_OBJECT_DIRECTORY: '/hostile/objects',
      GIT_CONFIG_GLOBAL: '/hostile/config',
    },
    execFileImpl: async (command, args, options) => {
      invocation = { command, args, options };
      return { stdout: Buffer.from('frozen bytes'), stderr: Buffer.alloc(0) };
    },
  });
  assert.deepEqual(bytes, Buffer.from('frozen bytes'));
  assert.equal(invocation.command, '/usr/bin/git');
  assert.deepEqual(invocation.args, [
    'cat-file',
    'blob',
    `${FROZEN_COMMIT}:package-lock.json`,
  ]);
  assert.deepEqual(invocation.options.env, {
    PATH: '/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
  });
});

test('frozen B2 blob reader ignores hostile PATH Git shadows', async (t) => {
  const fakeRoot = await mkdtemp(join(tmpdir(), 'ks2-spelling-fake-git-'));
  t.after(() => rm(fakeRoot, { recursive: true, force: true }));
  const fakeBin = join(fakeRoot, 'node_modules/.bin');
  await mkdir(fakeBin, { recursive: true });
  const fakeGit = join(fakeBin, 'git');
  await writeFile(fakeGit, '#!/bin/sh\nprintf "hostile fake frozen bytes"\n');
  await chmod(fakeGit, 0o755);

  const expected = execFileSync(
    '/usr/bin/git',
    ['cat-file', 'blob', `${FROZEN_COMMIT}:package-lock.json`],
    { cwd: ROOT },
  );
  const actual = await readFrozenB2Blob({
    root: ROOT,
    path: 'package-lock.json',
    ambientEnv: { PATH: `${fakeBin}:/usr/bin:/bin` },
  });
  assert.deepEqual(actual, expected);
  assert.equal(actual.includes('hostile fake frozen bytes'), false);
});

test('frozen B2 blob reader rejects an unsafe pinned Git executable before running', async () => {
  let execCalls = 0;
  await assert.rejects(
    readFrozenB2Blob({
      root: ROOT,
      path: 'package-lock.json',
      gitStatReader: async () => ({
        isFile: () => true,
        isSymbolicLink: () => false,
        uid: 0n,
        mode: 0o100775n,
      }),
      execFileImpl: async () => {
        execCalls += 1;
        return { stdout: Buffer.from('unsafe'), stderr: Buffer.alloc(0) };
      },
    }),
    /unavailable/,
  );
  assert.equal(execCalls, 0);
});

test('B2 verifier reads frozen bytes and does not rebuild historical evidence against B3 HEAD', async (t) => {
  const fixture = await copyAuthorityFixture();
  t.after(() => rm(fixture, { recursive: true, force: true }));

  assert.deepEqual(
    await verifyFixture(fixture),
    EXPECTED,
  );
  assert.equal((await readFile(join(fixture, 'reports/b2/b2-exit-report.json'))).length > 0, true);
});

test('B2 verifier reads historical package and A2 inventory from the frozen commit', async (t) => {
  const fixture = await copyAuthorityFixture();
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const a2Path = 'vendor/ks2-mastery/content/spelling.mobile-a2-contract-manifest.json';
  await writeFile(join(fixture, a2Path), Buffer.from('future B3 A2 bytes\n'));
  const reads = [];
  assert.deepEqual(
    await verifyFixture(fixture, {
      frozenReader: async (path) => {
        reads.push(path);
        return readFrozenGitInput(path);
      },
    }),
    EXPECTED,
  );
  assert.deepEqual(reads, [...FROZEN_GIT_INPUTS, 'package-lock.json', 'package.json']);

  await assert.rejects(
    verifyFixture(fixture, {
      frozenReader: async (path) =>
        path === 'package-lock.json'
          ? Buffer.from('mutated historical blob\n')
          : readFrozenGitInput(path),
    }),
    /packageLockSha256 mismatch/,
  );
});

test('B2 verifier rejects current root package-lock drift', async (t) => {
  const fixture = await copyAuthorityFixture();
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const packageLockPath = join(fixture, 'package-lock.json');
  const lock = JSON.parse(await readFile(packageLockPath, 'utf8'));
  lock.packages[''].dependencies.react = '0.0.0';
  await writeFile(packageLockPath, `${JSON.stringify(lock, null, 2)}\n`);
  await assert.rejects(
    verifyFixture(fixture),
    /current packageLock frozen dependency drifted: react/,
  );
});

test('B2 verifier rejects an unauthorised current package-lock addition', async (t) => {
  const fixture = await copyAuthorityFixture();
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const packageLockPath = join(fixture, 'package-lock.json');
  const lock = JSON.parse(await readFile(packageLockPath, 'utf8'));
  lock.packages[''].dependencies['left-pad'] = '1.3.0';
  await writeFile(packageLockPath, `${JSON.stringify(lock, null, 2)}\n`);
  await assert.rejects(
    verifyFixture(fixture),
    /current packageLock addition is not authorised: left-pad/,
  );
});

test('B2 verifier rejects authority drift and a non-closed provenance shape', async (t) => {
  const fixture = await copyAuthorityFixture();
  t.after(() => rm(fixture, { recursive: true, force: true }));

  const provenancePath = join(fixture, 'provenance/b2-gate.json');
  const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
  await writeFile(provenancePath, `${JSON.stringify({ ...provenance, rebuiltAtHead: true }, null, 2)}\n`);
  await assert.rejects(
    verifyFixture(fixture),
    /B2 frozen authority record does not match the approved closed schema/,
  );
});

test('B2 verifier rejects changed evidence bytes and Gate A identity drift', async (t) => {
  const fixture = await copyAuthorityFixture();
  t.after(() => rm(fixture, { recursive: true, force: true }));

  const auditPath = join(fixture, 'reports/b2/dependency-audit.json');
  await writeFile(auditPath, Buffer.concat([await readFile(auditPath), Buffer.from('\n')]));
  await assert.rejects(verifyFixture(fixture), /dependencyAuditSha256 mismatch/);

  await writeFile(auditPath, await readFile(join(ROOT, 'reports/b2/dependency-audit.json')));
  const gateAPath = join(fixture, 'provenance/ks2-mastery-gate-a.json');
  const gateA = JSON.parse(await readFile(gateAPath, 'utf8'));
  gateA.upstream.commit = '0'.repeat(40);
  await writeFile(gateAPath, `${JSON.stringify(gateA, null, 2)}\n`);
  await assert.rejects(
    verifyFixture(fixture),
    /Gate A commit mismatch/,
  );
});

test('B2 verifier enforces the approved package transition against frozen package bytes', async (t) => {
  const fixture = await copyAuthorityFixture();
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const packagePath = join(fixture, 'package.json');
  const frozenPackage = JSON.parse(readFrozenGitInput('package.json').toString('utf8'));
  const planned = structuredClone(frozenPackage);
  planned.scripts['verify:b2-authority'] = 'node scripts/verify-b2-authority.mjs';
  await writeFile(packagePath, `${JSON.stringify(planned, null, 2)}\n`);
  assert.deepEqual(await verifyFixture(fixture), EXPECTED);

  for (const [name, mutate] of [
    ['script name', (value) => {
      value.scripts['unapproved:b3'] = 'node scripts/unapproved.mjs';
    }],
    ['script command', (value) => {
      value.scripts['verify:b2-authority'] = 'node scripts/unapproved.mjs';
    }],
    ['version', (value) => {
      value.version = '9.9.9';
    }],
    ['dependency', (value) => {
      value.dependencies.react = '0.0.0';
    }],
  ]) {
    const candidate = structuredClone(planned);
    mutate(candidate);
    await writeFile(packagePath, `${JSON.stringify(candidate, null, 2)}\n`);
    await assert.rejects(verifyFixture(fixture), /package/i, name);
  }
});
