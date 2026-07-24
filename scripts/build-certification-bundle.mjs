import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';

import { B4_EVIDENCE_PATHS } from './collect-b4-development-evidence.mjs';
import {
  EXIT_CODES,
  isMain,
  printJson,
  runCommand,
} from './lib/run-command.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const OUTPUT_ROOT = join(ROOT, '.native-build/certification');
const BUILDS_ROOT = join(ROOT, '.native-build/certification-inputs');
const COMMIT = /^[a-f0-9]{40}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const TAG = /^cert-[a-z0-9](?:[a-z0-9._-]{0,62})$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const MAXIMUM_EVIDENCE_BYTES = 16 * 1024 * 1024;
const MAXIMUM_SOURCE_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAXIMUM_BUILD_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAXIMUM_BUILD_BYTES = 1024 * 1024 * 1024;
const BUILD_ARCHIVES = Object.freeze([
  'android-compile.tar',
  'domain-web.tar',
  'ios-compile.tar',
]);

function certificationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function exactKeys(value, keys) {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).toSorted().join('|') === keys.toSorted().join('|');
}

function sameFileIdentity(left, right) {
  return right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs;
}

export async function readBoundedRegularFile(path, {
  maximumBytes,
  allowExecutable = false,
} = {}) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw certificationError('certification_file_policy_invalid', 'Certification file policy is invalid.');
  }
  let before;
  try {
    before = await lstat(path);
  } catch {
    throw certificationError('certification_file_missing', 'Certification input is missing.');
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size <= 0 ||
      before.size > maximumBytes || (!allowExecutable && (before.mode & 0o111) !== 0)) {
    throw certificationError(
      'certification_file_invalid',
      'Certification input is not a bounded regular file.',
    );
  }
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (!sameFileIdentity(before, after) || bytes.length !== before.size) {
    throw certificationError(
      'certification_file_changed',
      'Certification input changed while being read.',
    );
  }
  return Object.freeze({ bytes, byteSize: bytes.length, sha256: sha256(bytes) });
}

function validateEvidenceFileRecord(value) {
  if (!exactKeys(value, ['path', 'byteSize', 'sha256']) ||
      typeof value.path !== 'string' ||
      !Number.isSafeInteger(value.byteSize) || value.byteSize <= 0 ||
      !HASH.test(value.sha256) ||
      !value.path.startsWith('reports/') || value.path.includes('..') ||
      value.path.includes('\\') || value.path.includes('\0')) {
    throw certificationError('certification_evidence_path_invalid', 'Certification evidence path is unsafe.');
  }
  return { path: value.path, byteSize: value.byteSize, sha256: value.sha256 };
}

function validateBuildFileRecord(value) {
  if (!exactKeys(value, ['path', 'byteSize', 'sha256']) ||
      !BUILD_ARCHIVES.includes(value.path) ||
      !Number.isSafeInteger(value.byteSize) || value.byteSize <= 0 ||
      value.byteSize > MAXIMUM_BUILD_ARCHIVE_BYTES || !HASH.test(value.sha256)) {
    throw certificationError('certification_build_invalid', 'Certification build archive is invalid.');
  }
  return { path: value.path, byteSize: value.byteSize, sha256: value.sha256 };
}

function aggregateSha256(files) {
  return sha256(files
    .map(({ path, byteSize, sha256: digest }) => `${path}\0${byteSize}\0${digest}\n`)
    .join(''));
}

export function validateCertificationTopology({
  applicationCheckpoint,
  evidenceCommit,
  evidenceParent,
  taggedCommit,
  evidenceTree,
  taggedTree,
  changedPaths,
} = {}) {
  if (![applicationCheckpoint, evidenceCommit, evidenceParent, taggedCommit, evidenceTree, taggedTree]
    .every((value) => COMMIT.test(value ?? ''))) {
    throw certificationError('certification_topology_invalid', 'Certification Git topology is invalid.');
  }
  if (evidenceParent !== applicationCheckpoint || evidenceCommit === applicationCheckpoint) {
    throw certificationError(
      'certification_topology_invalid',
      'Certification evidence is not the immediate successor of its application checkpoint.',
    );
  }
  if (evidenceTree !== taggedTree) {
    throw certificationError(
      'certification_topology_invalid',
      'The tagged tree differs from the evidence-only successor tree.',
    );
  }
  const paths = Array.isArray(changedPaths) ? changedPaths.toSorted() : [];
  if (paths.length === 0 || new Set(paths).size !== paths.length ||
      !paths.includes('reports/b4/b4-development-report.json') ||
      paths.some((path) => !B4_EVIDENCE_PATHS.includes(path))) {
    throw certificationError(
      'certification_topology_invalid',
      'Certification does not contain one evidence-only B4 successor.',
    );
  }
  return Object.freeze({ applicationCheckpoint, evidenceCommit });
}

export function createCertificationManifest({
  tag,
  repository,
  commit,
  tree,
  evidenceTopology,
  sourceArchive,
  evidenceFiles,
  buildFiles,
}) {
  if (!TAG.test(tag ?? '')) {
    throw certificationError('certification_tag_invalid', 'Certification tag is invalid.');
  }
  if (!REPOSITORY.test(repository ?? '') || !COMMIT.test(commit ?? '') || !COMMIT.test(tree ?? '')) {
    throw certificationError('certification_source_invalid', 'Certification source authority is invalid.');
  }
  if (!exactKeys(evidenceTopology, ['applicationCheckpoint', 'evidenceCommit']) ||
      !COMMIT.test(evidenceTopology.applicationCheckpoint ?? '') ||
      !COMMIT.test(evidenceTopology.evidenceCommit ?? '')) {
    throw certificationError('certification_topology_invalid', 'Certification evidence topology is invalid.');
  }
  const expectedArchiveName = `ks2-spelling-${tag}-${commit}.tar`;
  if (!exactKeys(sourceArchive, ['fileName', 'byteSize', 'sha256']) ||
      sourceArchive.fileName !== expectedArchiveName ||
      basename(sourceArchive.fileName) !== sourceArchive.fileName ||
      !Number.isSafeInteger(sourceArchive.byteSize) || sourceArchive.byteSize <= 0 ||
      sourceArchive.byteSize > MAXIMUM_SOURCE_ARCHIVE_BYTES || !HASH.test(sourceArchive.sha256 ?? '')) {
    throw certificationError('certification_archive_invalid', 'Certification source archive metadata is invalid.');
  }
  if (!Array.isArray(evidenceFiles) || evidenceFiles.length === 0) {
    throw certificationError('certification_evidence_invalid', 'Certification evidence is missing.');
  }
  const files = evidenceFiles.map(validateEvidenceFileRecord)
    .toSorted((left, right) => left.path.localeCompare(right.path));
  if (new Set(files.map(({ path }) => path)).size !== files.length) {
    throw certificationError('certification_evidence_duplicate', 'Certification contains a duplicate evidence path.');
  }
  if (!files.some(({ path }) => path === 'reports/b4/b4-development-report.json')) {
    throw certificationError('certification_evidence_invalid', 'Certification evidence is incomplete.');
  }
  if (!Array.isArray(buildFiles)) {
    throw certificationError('certification_build_invalid', 'Certification build archives are missing.');
  }
  const builds = buildFiles.map(validateBuildFileRecord)
    .toSorted((left, right) => left.path.localeCompare(right.path));
  if (builds.map(({ path }) => path).join('|') !== BUILD_ARCHIVES.join('|') ||
      builds.reduce((total, { byteSize }) => total + byteSize, 0) > MAXIMUM_BUILD_BYTES) {
    throw certificationError('certification_build_invalid', 'Certification build archive set is invalid.');
  }

  return {
    schemaVersion: 1,
    kind: 'ks2-spelling-development-milestone',
    tag,
    repository,
    source: {
      commit,
      tree,
      archive: {
        fileName: sourceArchive.fileName,
        byteSize: sourceArchive.byteSize,
        sha256: sourceArchive.sha256,
      },
    },
    evidence: {
      applicationCheckpoint: evidenceTopology.applicationCheckpoint,
      evidenceCommit: evidenceTopology.evidenceCommit,
      files,
      aggregateSha256: aggregateSha256(files),
    },
    builds: {
      files: builds,
      aggregateSha256: aggregateSha256(builds),
    },
    claims: {
      scope: 'development-milestone',
      signedDistribution: false,
      storeReadiness: false,
      productionReadiness: false,
    },
  };
}

export function serialiseCertificationManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function git(args, { root = ROOT } = {}) {
  const result = await runCommand('git', args, { cwd: root });
  if (result.exitCode !== 0) {
    throw certificationError('certification_git_failed', 'Certification Git authority failed.');
  }
  return result.stdout.trim();
}

function resolveExactDirectory(value, expected, message) {
  if (typeof value !== 'string' || value.length === 0 || resolve(value) !== expected) {
    throw certificationError('certification_input_invalid', message);
  }
  return expected;
}

function resolveOutputDirectory(value, root = ROOT) {
  if (typeof value !== 'string' || value.length === 0) {
    throw certificationError('certification_usage', 'An output directory is required.');
  }
  const outputRoot = root === ROOT ? OUTPUT_ROOT : join(root, '.native-build/certification');
  const output = resolve(root, value);
  const child = relative(outputRoot, output);
  if (!child || child.startsWith('..') || child.includes('..') || resolve(outputRoot, child) !== output) {
    throw certificationError(
      'certification_output_invalid',
      'Certification output must be a child of .native-build/certification.',
    );
  }
  return output;
}

function resolveBuildsDirectory(value, root = ROOT) {
  const expected = root === ROOT ? BUILDS_ROOT : join(root, '.native-build/certification-inputs');
  return resolveExactDirectory(
    resolve(root, value ?? ''),
    expected,
    'Certification builds must come from .native-build/certification-inputs.',
  );
}

async function assertMissing(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw certificationError('certification_output_exists', 'Certification output already exists.');
}

async function trackedEvidence(root) {
  const output = await git(['ls-files', '-z', '--', 'reports'], { root });
  const paths = output.split('\0').filter(Boolean).toSorted();
  if (paths.length === 0 || paths.length > 512) {
    throw certificationError('certification_evidence_missing', 'Tracked certification evidence is missing or unbounded.');
  }
  const records = [];
  for (const path of paths) {
    const fromRoot = relative(resolve(root), resolve(root, path));
    if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
      throw certificationError('certification_evidence_path_invalid', 'Certification evidence path is unsafe.');
    }
    const input = await readBoundedRegularFile(join(root, path), {
      maximumBytes: MAXIMUM_EVIDENCE_BYTES,
    });
    records.push({ path, byteSize: input.byteSize, sha256: input.sha256 });
  }
  return records;
}

async function certificationTopology(root, taggedCommit, taggedTree) {
  const reportInput = await readBoundedRegularFile(
    join(root, 'reports/b4/b4-development-report.json'),
    { maximumBytes: MAXIMUM_EVIDENCE_BYTES },
  );
  let report;
  try {
    report = JSON.parse(reportInput.bytes.toString('utf8'));
  } catch {
    throw certificationError('certification_topology_invalid', 'B4 development report is invalid.');
  }
  const applicationCheckpoint = report?.applicationCheckpoint?.commit;
  const reportedTree = report?.applicationCheckpoint?.tree;
  if (!COMMIT.test(applicationCheckpoint ?? '') || !COMMIT.test(reportedTree ?? '') ||
      await git(['rev-parse', `${applicationCheckpoint}^{tree}`], { root }) !== reportedTree) {
    throw certificationError('certification_topology_invalid', 'B4 checkpoint authority is invalid.');
  }
  await git(['merge-base', '--is-ancestor', applicationCheckpoint, taggedCommit], { root });
  const evidenceCommits = (await git([
    'log', '--format=%H', `${applicationCheckpoint}..${taggedCommit}`, '--',
    'reports/b4/b4-development-report.json',
  ], { root })).split('\n').filter(Boolean);
  if (evidenceCommits.length !== 1) {
    throw certificationError('certification_topology_invalid', 'Certification evidence lineage is ambiguous.');
  }
  const evidenceCommit = evidenceCommits[0];
  const evidenceParent = await git(['rev-parse', `${evidenceCommit}^`], { root });
  const evidenceTree = await git(['rev-parse', `${evidenceCommit}^{tree}`], { root });
  const changedPaths = (await git([
    'diff', '--name-only', `${applicationCheckpoint}..${evidenceCommit}`,
  ], { root })).split('\n').filter(Boolean);
  return validateCertificationTopology({
    applicationCheckpoint,
    evidenceCommit,
    evidenceParent,
    taggedCommit,
    evidenceTree,
    taggedTree,
    changedPaths,
  });
}

async function validateTarArchive(path, root) {
  const result = await runCommand('tar', ['-tf', path], { cwd: root });
  const entries = result.stdout.split('\n').filter(Boolean);
  if (result.exitCode !== 0 || entries.length === 0 || entries.some((entry) =>
    entry.startsWith('/') || entry.includes('\\') ||
    entry.split('/').some((part) => part === '..'))) {
    throw certificationError('certification_build_invalid', 'Certification build archive is unsafe.');
  }
}

async function copyBuildArchives(inputDirectory, outputDirectory, root) {
  const entries = await readdir(inputDirectory, { withFileTypes: true });
  const names = entries.map(({ name }) => name).toSorted();
  if (names.join('|') !== BUILD_ARCHIVES.join('|') || entries.some((entry) => !entry.isFile())) {
    throw certificationError('certification_build_invalid', 'Certification build archive set is invalid.');
  }
  await mkdir(outputDirectory);
  const records = [];
  let totalBytes = 0;
  for (const name of BUILD_ARCHIVES) {
    const input = await readBoundedRegularFile(join(inputDirectory, name), {
      maximumBytes: MAXIMUM_BUILD_ARCHIVE_BYTES,
      allowExecutable: true,
    });
    totalBytes += input.byteSize;
    if (totalBytes > MAXIMUM_BUILD_BYTES) {
      throw certificationError('certification_build_invalid', 'Certification build archives exceed the size ceiling.');
    }
    const output = join(outputDirectory, name);
    await writeFile(output, input.bytes, { flag: 'wx' });
    await validateTarArchive(output, root);
    records.push({ path: name, byteSize: input.byteSize, sha256: input.sha256 });
  }
  return records;
}

export async function buildCertificationBundle({
  buildsDirectory,
  outputDirectory,
  root = ROOT,
  env = process.env,
} = {}) {
  if (env.GITHUB_REF_TYPE !== 'tag' || !TAG.test(env.GITHUB_REF_NAME ?? '')) {
    throw certificationError('certification_tag_invalid', 'Certification requires an exact cert-* tag ref.');
  }
  if (!REPOSITORY.test(env.GITHUB_REPOSITORY ?? '') || !COMMIT.test(env.GITHUB_SHA ?? '')) {
    throw certificationError('certification_source_invalid', 'GitHub source authority is invalid.');
  }

  const commit = await git(['rev-parse', 'HEAD'], { root });
  const tree = await git(['rev-parse', 'HEAD^{tree}'], { root });
  const taggedCommit = await git(['rev-parse', `refs/tags/${env.GITHUB_REF_NAME}^{commit}`], { root });
  if (commit !== env.GITHUB_SHA || taggedCommit !== commit || !COMMIT.test(tree)) {
    throw certificationError('certification_source_invalid', 'The certification tag does not bind the checked-out source.');
  }
  await git(['diff', '--quiet', 'HEAD', '--'], { root });

  const output = resolveOutputDirectory(outputDirectory, root);
  const buildInputs = resolveBuildsDirectory(buildsDirectory, root);
  await assertMissing(output);
  const evidenceTopology = await certificationTopology(root, commit, tree);
  const archiveName = `ks2-spelling-${env.GITHUB_REF_NAME}-${commit}.tar`;
  const archivePath = join(output, archiveName);
  const manifestPath = join(output, 'manifest.json');
  await mkdir(output, { recursive: true });

  try {
    await git(['archive', '--format=tar', `--output=${archivePath}`, commit], { root });
    const archive = await readBoundedRegularFile(archivePath, {
      maximumBytes: MAXIMUM_SOURCE_ARCHIVE_BYTES,
      allowExecutable: true,
    });
    const evidenceFiles = await trackedEvidence(root);
    const buildFiles = await copyBuildArchives(buildInputs, join(output, 'builds'), root);
    await git(['diff', '--quiet', 'HEAD', '--'], { root });
    const manifest = createCertificationManifest({
      tag: env.GITHUB_REF_NAME,
      repository: env.GITHUB_REPOSITORY,
      commit,
      tree,
      evidenceTopology,
      sourceArchive: {
        fileName: archiveName,
        byteSize: archive.byteSize,
        sha256: archive.sha256,
      },
      evidenceFiles,
      buildFiles,
    });
    await writeFile(manifestPath, serialiseCertificationManifest(manifest), { flag: 'wx' });
    return manifest;
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

function readArguments(args) {
  if (args.length !== 4 || args[0] !== '--builds-directory' || args[2] !== '--output-directory') {
    throw certificationError(
      'certification_usage',
      'Usage: node scripts/build-certification-bundle.mjs --builds-directory <path> --output-directory <path>',
    );
  }
  return { buildsDirectory: args[1], outputDirectory: args[3] };
}

async function main() {
  try {
    const options = readArguments(process.argv.slice(2));
    const manifest = await buildCertificationBundle(options);
    printJson({
      ok: true,
      code: 'certification_bundle_created',
      tag: manifest.tag,
      commit: manifest.source.commit,
      sourceArchiveSha256: manifest.source.archive.sha256,
      evidenceAggregateSha256: manifest.evidence.aggregateSha256,
      buildAggregateSha256: manifest.builds.aggregateSha256,
    });
    return EXIT_CODES.success;
  } catch (error) {
    printJson(
      {
        ok: false,
        code: error?.code ?? 'certification_bundle_failed',
        message: error?.message ?? 'Certification bundle failed.',
      },
      process.stderr,
    );
    return error?.code === 'certification_usage' ? EXIT_CODES.usage : EXIT_CODES.stateMismatch;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
