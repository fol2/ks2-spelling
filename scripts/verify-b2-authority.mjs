import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  assertB2PackageTransition,
  C6_PLANNED_PACKAGE_DEPENDENCY_ADDITIONS,
  verifyB3PackageTransitionAuthority,
} from './lib/b3-package-transition-authority.mjs';
import { readFrozenB2Blob } from './lib/frozen-b2-git.mjs';
import { runPinnedSystemGit } from './lib/pinned-system-git.mjs';

const DEFAULT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_MAX_ANCESTRY_COMMITS = 100_000;
const OBJECT_ID_PATTERN = /^[0-9a-f]{40}$/u;
const COMMIT_HEADER_SEPARATOR = Buffer.from('\n\n', 'ascii');
const TREE_HEADER_PREFIX = Buffer.from('tree ', 'ascii');
const PARENT_HEADER_PREFIX = Buffer.from('parent ', 'ascii');

const FROZEN_AUTHORITY = Object.freeze({
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

const HASHED_INPUTS = Object.freeze([
  ['exitReportSha256', 'reports/b2/b2-exit-report.json'],
  ['dependencyAuditSha256', 'reports/b2/dependency-audit.json'],
  ['nativeBuildReportSha256', 'reports/b2/native-plugin-build.json'],
  ['nativePluginAuditSha256', 'reports/b2/native-plugin-audit.json'],
]);

const FROZEN_GIT_INPUTS = Object.freeze([
  ['packageLockSha256', 'package-lock.json'],
  [
    'a2ContractManifestSha256',
    'vendor/ks2-mastery/content/spelling.mobile-a2-contract-manifest.json',
  ],
]);

async function readRegularFile(path, label) {
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    throw new Error(`missing ${label}`);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file`);
  }
  return readFile(path);
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function defaultGitRunner(args, root, { encoding = 'utf8' } = {}) {
  return runPinnedSystemGit(args, {
    root,
    encoding,
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
}

function isLowerHexObjectId(bytes) {
  if (bytes.length !== 40) return false;
  for (const byte of bytes) {
    if (!((byte >= 0x30 && byte <= 0x39) || (byte >= 0x61 && byte <= 0x66))) return false;
  }
  return true;
}

function parseObjectIdHeader(line, prefix) {
  if (
    line.length !== prefix.length + 40 ||
    !line.subarray(0, prefix.length).equals(prefix) ||
    !isLowerHexObjectId(line.subarray(prefix.length))
  ) {
    return null;
  }
  return line.subarray(prefix.length).toString('ascii');
}

function splitHeaderLines(header) {
  const lines = [];
  let start = 0;
  for (;;) {
    const end = header.indexOf(0x0a, start);
    if (end < 0) {
      lines.push(header.subarray(start));
      return lines;
    }
    lines.push(header.subarray(start, end));
    start = end + 1;
  }
}

function isAdditionalHeaderName(bytes) {
  if (bytes.length < 1 || bytes[0] < 0x61 || bytes[0] > 0x7a) return false;
  for (const byte of bytes.subarray(1)) {
    if (
      !(
        (byte >= 0x61 && byte <= 0x7a) ||
        (byte >= 0x30 && byte <= 0x39) ||
        byte === 0x2d
      )
    ) {
      return false;
    }
  }
  return true;
}

function parseRawCommit(rawCommit) {
  if (!Buffer.isBuffer(rawCommit)) throw new Error('invalid raw commit');
  const headerEnd = rawCommit.indexOf(COMMIT_HEADER_SEPARATOR);
  if (headerEnd < 0) throw new Error('invalid raw commit');
  const header = rawCommit.subarray(0, headerEnd);
  if (header.includes(0x0d) || header.includes(0x00)) throw new Error('invalid raw commit');

  const lines = splitHeaderLines(header);
  const tree = parseObjectIdHeader(lines[0] ?? Buffer.alloc(0), TREE_HEADER_PREFIX);
  if (!tree) throw new Error('invalid raw commit tree');

  const parents = [];
  let index = 1;
  while (index < lines.length) {
    const parent = parseObjectIdHeader(lines[index], PARENT_HEADER_PREFIX);
    if (!parent) break;
    parents.push(parent);
    index += 1;
  }

  let hasAdditionalHeader = false;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line[0] === 0x20) {
      if (!hasAdditionalHeader) throw new Error('invalid raw commit continuation');
      continue;
    }
    const separator = line.indexOf(0x20);
    const name = separator > 0 ? line.subarray(0, separator) : Buffer.alloc(0);
    const nameText = name.toString('ascii');
    if (
      separator === line.length - 1 ||
      !isAdditionalHeaderName(name) ||
      nameText === 'tree' ||
      nameText === 'parent'
    ) {
      throw new Error('invalid raw commit header');
    }
    hasAdditionalHeader = true;
  }

  return { tree, parents };
}

function rawCommitObjectId(rawCommit) {
  return createHash('sha1')
    .update(Buffer.from(`commit ${rawCommit.length}\0`, 'ascii'))
    .update(rawCommit)
    .digest('hex');
}

export async function verifyB2GitHistory({
  root,
  gitRunner = defaultGitRunner,
  frozenCommit = FROZEN_AUTHORITY.commit,
  frozenTree = FROZEN_AUTHORITY.tree,
  maxCommits = DEFAULT_MAX_ANCESTRY_COMMITS,
} = {}) {
  try {
    if (
      !OBJECT_ID_PATTERN.test(frozenCommit) ||
      !OBJECT_ID_PATTERN.test(frozenTree) ||
      !Number.isSafeInteger(maxCommits) ||
      maxCommits < 1 ||
      maxCommits > DEFAULT_MAX_ANCESTRY_COMMITS
    ) {
      throw new Error('invalid ancestry configuration');
    }
    const objectFormat = await gitRunner(['rev-parse', '--show-object-format'], root);
    if (objectFormat?.stdout !== 'sha1\n' || objectFormat?.stderr !== '') {
      throw new Error('unsupported Git object format');
    }
    const head = await gitRunner(['rev-parse', '--verify', 'HEAD^{commit}'], root);
    if (!/^[0-9a-f]{40}\n$/u.test(head?.stdout ?? '') || head?.stderr !== '') {
      throw new Error('invalid HEAD');
    }

    const queue = [head.stdout.slice(0, -1)];
    const visited = new Set();
    for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
      const commit = queue[queueIndex];
      if (visited.has(commit)) continue;
      if (visited.size >= maxCommits) throw new Error('ancestry traversal limit exceeded');
      visited.add(commit);

      const result = await gitRunner(
        ['cat-file', 'commit', commit],
        root,
        { encoding: null },
      );
      if (
        !Buffer.isBuffer(result?.stdout) ||
        !Buffer.isBuffer(result?.stderr) ||
        result.stderr.length !== 0 ||
        rawCommitObjectId(result.stdout) !== commit
      ) {
        throw new Error('invalid commit object');
      }
      const parsed = parseRawCommit(result.stdout);
      if (commit === frozenCommit) {
        if (parsed.tree !== frozenTree) throw new Error('frozen tree mismatch');
        return;
      }
      queue.push(...parsed.parents);
    }

    throw new Error('frozen commit is not an ancestor');
  } catch {
    throw new Error('B2 Git history verification failed');
  }
}

export async function verifyB2Authority({
  root = DEFAULT_ROOT,
  frozenReader = (path) => readFrozenB2Blob({ root, path }),
  gitRunner = defaultGitRunner,
} = {}) {
  await verifyB2GitHistory({ root, gitRunner });
  const provenanceBytes = await readRegularFile(
    resolve(root, 'provenance/b2-gate.json'),
    'B2 frozen authority record',
  );
  const provenance = parseJson(provenanceBytes, 'B2 frozen authority record');
  if (!isDeepStrictEqual(provenance, FROZEN_AUTHORITY)) {
    throw new Error('B2 frozen authority record does not match the approved closed schema');
  }

  for (const [field, relativePath] of HASHED_INPUTS) {
    const actual = sha256(await readRegularFile(resolve(root, relativePath), relativePath));
    if (actual !== FROZEN_AUTHORITY[field]) {
      throw new Error(`${field} mismatch`);
    }
  }
  for (const [field, relativePath] of FROZEN_GIT_INPUTS) {
    const actual = sha256(await frozenReader(relativePath));
    if (actual !== FROZEN_AUTHORITY[field]) {
      throw new Error(`${field} mismatch`);
    }
  }
  // The current lock may differ from the frozen B2 lock only by the exact
  // dependency additions authorised by the schema-4 package transition
  // authority (C6 game-layer uplift). Frozen history above stays byte-pinned.
  const currentLock = parseJson(
    await readRegularFile(resolve(root, 'package-lock.json'), 'current package-lock.json'),
    'current package-lock.json',
  );
  const frozenLock = parseJson(
    await frozenReader('package-lock.json'),
    'frozen package-lock.json',
  );
  const frozenRootDependencies = frozenLock?.packages?.['']?.dependencies ?? {};
  const currentRootDependencies = currentLock?.packages?.['']?.dependencies ?? {};
  for (const [name, version] of Object.entries(frozenRootDependencies)) {
    if (currentRootDependencies[name] !== version) {
      throw new Error(`current packageLock frozen dependency drifted: ${name}`);
    }
  }
  for (const [name, version] of Object.entries(currentRootDependencies)) {
    if (Object.hasOwn(frozenRootDependencies, name)) continue;
    if (C6_PLANNED_PACKAGE_DEPENDENCY_ADDITIONS[name] !== version) {
      throw new Error(`current packageLock addition is not authorised: ${name}`);
    }
    if (currentLock?.packages?.[`node_modules/${name}`]?.version !== version) {
      throw new Error(`current packageLock addition version mismatch: ${name}`);
    }
  }

  const gateA = parseJson(
    await readRegularFile(
      resolve(root, 'provenance/ks2-mastery-gate-a.json'),
      'Gate A provenance',
    ),
    'Gate A provenance',
  );
  if (gateA?.upstream?.commit !== FROZEN_AUTHORITY.gateACommit) {
    throw new Error('Gate A commit mismatch');
  }
  if (gateA?.evidence?.a2Manifest?.sha256 !== FROZEN_AUTHORITY.a2ContractManifestSha256) {
    throw new Error('Gate A A2 contract manifest mismatch');
  }

  const transitionAuthority = await verifyB3PackageTransitionAuthority({ root });
  const frozenPackage = parseJson(await frozenReader('package.json'), 'frozen B2 package.json');
  const currentPackage = parseJson(
    await readRegularFile(resolve(root, 'package.json'), 'current package.json'),
    'current package.json',
  );
  assertB2PackageTransition(frozenPackage, currentPackage, transitionAuthority);

  return structuredClone(FROZEN_AUTHORITY);
}

async function main() {
  try {
    const authority = await verifyB2Authority({ root: DEFAULT_ROOT });
    process.stdout.write(`${JSON.stringify(authority)}\n`);
  } catch (error) {
    process.stderr.write(`B2 authority verification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
