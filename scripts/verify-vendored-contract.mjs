import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const DEFAULT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const EXPECTED_PROVENANCE = Object.freeze({
  schemaVersion: 1,
  upstream: {
    repository: 'https://github.com/fol2/ks2-mastery.git',
    commit: '4501607a9b58f2fb252b4cce64ba056e6f60c630',
    tree: '129ba457cccf21df03f4be813b4f4ed6e7d9f6ad',
  },
  evidence: {
    a1Manifest: {
      path: 'content/spelling.mobile-a1-kernel-manifest.json',
      sha256: '51af549ce31a30adc021d5fa0bd6a70ed9de2366887add0df3fc7f8f42dc312f',
    },
    a2Manifest: {
      path: 'content/spelling.mobile-a2-contract-manifest.json',
      sha256: '237b26b14e7506fa271bb3324f701d6205e6e0166d659a16789937478cc77b66',
    },
    a3Manifest: {
      path: 'content/spelling.mobile-a3-contract-manifest.json',
      sha256: '7fea17613ee10f747c1cfa9d5c923da4e506e23e61d1530ca71c283c0ce39465',
    },
  },
  runtime: {
    entry: 'shared/spelling/mobile/a3/index.js',
    fileCount: 24,
    hashAuthority: 'content/spelling.mobile-a3-contract-manifest.json#runtime.files',
    importAuthority:
      'content/spelling.mobile-a3-contract-manifest.json#runtime.importPolicy.records',
    publicExportAuthority:
      'content/spelling.mobile-a3-contract-manifest.json#runtime.publicExports',
  },
  catalogues: {
    starter: {
      path: 'content/spelling.mobile-runtime-starter.json',
      sha256: 'a67317764d1bae4e1796e070fa8d482c0b4702451c63ba7cacf9470c5272eb34',
      itemCount: 20,
    },
    full: {
      path: 'content/spelling.mobile-runtime-full.json',
      sha256: '50918c93043eba984cb2472238ac9370be4f46fb52a55c76cf5c469beb330d84',
      itemCount: 213,
    },
  },
  vendor: {
    root: 'vendor/ks2-mastery',
    expectedFileCount: 29,
    extraction:
      'Exact bytes extracted from the frozen commit with git archive; no upstream worktree files are used.',
  },
  producerTests: {
    root: 'vendor/ks2-mastery',
    fileCount: 9,
    runtimeAuthority: false,
    source:
      'Exact bytes extracted from the frozen Gate A commit for downstream contract testing.',
    files: {
      'tests/spelling-mobile-a3-command-contracts.test.js':
        'd4d6eb6032f9022161c6ad6d109e20a7edb575c9edbf085c191d60f16366f93e',
      'tests/spelling-mobile-a3-command-planner.test.js':
        '5d26781a4fc32e84290215f25016927eb3a500ad433c6e90a782ea87fdf12cda',
      'tests/spelling-mobile-a3-command-repository.test.js':
        'efabf2976cbe696cb5986491c4fc0ba8acf57fd5ee356124a92061d7c9cc0fbd',
      'tests/spelling-mobile-a3-atomicity.test.js':
        'aa43b0e113397d544b9d0d1cd900f01744673e8e150cc852594b7edef14357b2',
      'tests/spelling-mobile-a3-monster-projection.test.js':
        'c995de43c6ab5c3741c2c3ea7904240aebb82e930eeec6a521b1da1a29f4d1ec',
      'tests/spelling-mobile-a3-camp-projection.test.js':
        '741190527be9a76ffcd8d4d33180981844700f16318e7aa72dc16bdb6bc1bae7',
      'tests/spelling-mobile-a3-revision-projection.test.js':
        '996c5708d7a0b0167ed9f178f972f9d39f7e4d90bf66c9dd9ded09600141f8ce',
      'tests/spelling-mobile-a3-parent-projection.test.js':
        '7cb95867ee9762fdf6088bc4191a8ae0362677e8d849559e649c41838d3a9d86',
      'tests/spelling-mobile-a3-profile-repository.test.js':
        '696bdbf6c98f8361bc7270b3538dce0528e1be380066fa767b3976280bda2482',
    },
  },
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function recordIssue(issues, message) {
  issues.push(message);
}

async function validateVendorRoot(root, vendorRoot, issues) {
  const components = [
    { path: root, label: 'repository root' },
    { path: resolve(root, 'vendor'), label: 'vendor' },
    { path: vendorRoot, label: EXPECTED_PROVENANCE.vendor.root, isVendorRoot: true },
  ];
  let vendorRootStats = null;

  for (const component of components) {
    try {
      const stats = await lstat(component.path);
      if (stats.isSymbolicLink()) {
        recordIssue(
          issues,
          component.isVendorRoot
            ? 'vendor root is a symlink'
            : `vendored path component is a symlink: ${component.label}`,
        );
        return;
      }
      if (component.isVendorRoot) vendorRootStats = stats;
    } catch (error) {
      if (component.isVendorRoot) {
        recordIssue(
          issues,
          `invalid vendor root: ${vendorRoot} (${error.code ?? error.message})`,
        );
      }
    }
  }

  if (!vendorRootStats) return;
  if (!vendorRootStats.isDirectory()) {
    recordIssue(issues, 'vendor root is not a directory');
    return;
  }

  try {
    const resolvedRoot = await realpath(root);
    const resolvedVendorRoot = await realpath(vendorRoot);
    const vendorPathFromRoot = relative(resolvedRoot, resolvedVendorRoot);
    if (
      vendorPathFromRoot === '' ||
      vendorPathFromRoot === '..' ||
      vendorPathFromRoot.startsWith(`..${sep}`) ||
      isAbsolute(vendorPathFromRoot)
    ) {
      recordIssue(issues, 'vendor root escapes repository');
    }
  } catch (error) {
    recordIssue(issues, `invalid vendor root: ${vendorRoot} (${error.code ?? error.message})`);
  }
}

async function readBytes(path, label, issues) {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      recordIssue(issues, `${label} is not a regular file: ${path}`);
      return null;
    }
    return await readFile(path);
  } catch (error) {
    recordIssue(issues, `missing ${label}: ${path} (${error.code ?? error.message})`);
    return null;
  }
}

function parseJson(bytes, label, issues) {
  if (!bytes) return null;
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    recordIssue(issues, `invalid JSON in ${label}: ${error.message}`);
    return null;
  }
}

async function listVendorFiles(root, issues) {
  const files = [];

  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      recordIssue(issues, `missing vendor directory: ${directory} (${error.code ?? error.message})`);
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) {
        recordIssue(issues, `unexpected vendored symlink: ${relative(root, path)}`);
      } else if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        files.push(relative(root, path).split(sep).join('/'));
      } else {
        recordIssue(issues, `unexpected vendored filesystem entry: ${relative(root, path)}`);
      }
    }
  }

  await visit(root);
  return files.sort();
}

function moduleStatements(source) {
  const statements = [];
  const startPattern = /(?:^|\n)\s*(import|export)\b/g;
  let match;
  while ((match = startPattern.exec(source)) !== null) {
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0);
    const keywordIndex = source.indexOf(match[1], start);
    const afterKeyword = source.slice(keywordIndex + match[1].length).trimStart();
    if (match[1] === 'export' && !afterKeyword.startsWith('{') && !afterKeyword.startsWith('*')) {
      continue;
    }
    let quote = null;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    let end = source.length;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      const next = source[index + 1];
      if (lineComment) {
        if (character === '\n') lineComment = false;
        continue;
      }
      if (blockComment) {
        if (character === '*' && next === '/') {
          blockComment = false;
          index += 1;
        }
        continue;
      }
      if (quote) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === quote) quote = null;
        continue;
      }
      if (character === '/' && next === '/') {
        lineComment = true;
        index += 1;
      } else if (character === '/' && next === '*') {
        blockComment = true;
        index += 1;
      } else if (character === "'" || character === '"' || character === '`') {
        quote = character;
      } else if (character === ';') {
        end = index + 1;
        break;
      }
    }
    statements.push({ kind: match[1], source: source.slice(start, end) });
  }
  return statements;
}

function specifiersFromSource(source) {
  const specifiers = [];
  for (const statement of moduleStatements(source)) {
    const from = statement.source.match(/\bfrom\s*(['"])([^'"]+)\1/);
    const sideEffect = statement.kind === 'import'
      ? statement.source.match(/^\s*import\s*(['"])([^'"]+)\1/)
      : null;
    const match = from ?? sideEffect;
    if (match) specifiers.push(match[2]);
  }

  // No closing-paren anchor: a dynamic import may carry an import-attributes
  // second argument (import('x.json', { with: { type: 'json' } })).
  const dynamicPattern = /\b(import|require)\s*\(\s*(['"])([^'"]+)\2/g;
  let dynamic;
  while ((dynamic = dynamicPattern.exec(source)) !== null) specifiers.push(dynamic[3]);
  return specifiers;
}

function resolveSpecifier(importer, specifier, issues) {
  if (
    isAbsolute(specifier) ||
    posix.isAbsolute(specifier) ||
    /^[a-z][a-z0-9+.-]*:/i.test(specifier)
  ) {
    recordIssue(issues, `absolute import in ${importer}: ${specifier}`);
    return null;
  }
  if (specifier.startsWith('node:')) {
    recordIssue(issues, `Node built-in dependency in ${importer}: ${specifier}`);
    return null;
  }
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    recordIssue(issues, `non-relative dependency in ${importer}: ${specifier}`);
    return null;
  }
  if (/(^|\/)ks2-mastery(?:\/|$)/i.test(specifier)) {
    recordIssue(issues, `sibling-checkout dependency in ${importer}: ${specifier}`);
    return null;
  }
  return posix.normalize(posix.join(posix.dirname(importer), specifier));
}

function compareExactSet(actual, expected, onMissing, onExtra) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  for (const value of expectedSet) if (!actualSet.has(value)) onMissing(value);
  for (const value of actualSet) if (!expectedSet.has(value)) onExtra(value);
}

function authorityChecks(provenance, issues) {
  if (!provenance) return;
  if (provenance.upstream?.repository !== EXPECTED_PROVENANCE.upstream.repository) {
    recordIssue(issues, 'authority mismatch: upstream repository');
  }
  if (provenance.upstream?.commit !== EXPECTED_PROVENANCE.upstream.commit) {
    recordIssue(issues, 'authority mismatch: upstream commit');
  }
  if (provenance.upstream?.tree !== EXPECTED_PROVENANCE.upstream.tree) {
    recordIssue(issues, 'authority mismatch: upstream tree');
  }
  if (!isDeepStrictEqual(provenance, EXPECTED_PROVENANCE)) {
    recordIssue(issues, 'provenance record drift from the certified Gate A authority');
  }
}

function validateManifestAuthority(a2Manifest, a3Manifest, issues) {
  if (!a3Manifest) return;
  const runtime = a3Manifest.runtime;
  if (runtime?.entry !== EXPECTED_PROVENANCE.runtime.entry) {
    recordIssue(issues, 'public runtime entry drift');
  }
  if (runtime?.files?.length !== EXPECTED_PROVENANCE.runtime.fileCount) {
    recordIssue(issues, `runtime file count drift: expected 24, received ${runtime?.files?.length}`);
  }
  if (runtime?.importPolicy?.violationCount !== 0 || a3Manifest.boundary?.issueCount > 0) {
    recordIssue(issues, 'certified import boundary no longer passes');
  }
  const authority = a3Manifest.authority;
  for (const [label, expected] of Object.entries(EXPECTED_PROVENANCE.evidence)) {
    if (label === 'a3Manifest') continue;
    const actual = label === 'a1Manifest' ? authority?.a1Manifest : authority?.a2Manifest;
    if (actual?.path !== expected.path || actual?.sha256 !== expected.sha256) {
      recordIssue(issues, `authority mismatch: A3 ${label} record`);
    }
  }
  for (const tier of ['starter', 'full']) {
    const expected = EXPECTED_PROVENANCE.catalogues[tier];
    const actual = authority?.catalogues?.[tier];
    if (actual?.path !== expected.path || actual?.sha256 !== expected.sha256) {
      recordIssue(issues, `authority mismatch: A3 ${tier} catalogue record`);
    }
    if (a2Manifest?.catalogues?.counts?.[tier] !== expected.itemCount) {
      recordIssue(issues, `${tier} catalogue count authority drift`);
    }
  }
  if (
    a2Manifest?.catalogues?.excludedTierLeakage?.secureExtension !== 0 ||
    a2Manifest?.catalogues?.excludedTierLeakage?.enrichmentExtra !== 0
  ) {
    recordIssue(issues, 'catalogue tier-leakage authority drift');
  }
}

function validateCatalogue(catalogue, tier, issues) {
  const expected = EXPECTED_PROVENANCE.catalogues[tier];
  if (!catalogue || !Array.isArray(catalogue.items)) {
    recordIssue(issues, `${tier} catalogue has no items array`);
    return;
  }
  if (catalogue.items.length !== expected.itemCount) {
    recordIssue(
      issues,
      `${tier} catalogue item count drift: expected ${expected.itemCount}, received ${catalogue.items.length}`,
    );
  }
  const leakage = catalogue.items.filter(
    (item) => typeof item?.coverageTier !== 'string' || /secure|extra/i.test(item.coverageTier),
  );
  if (leakage.length > 0) {
    recordIssue(issues, `${tier} catalogue has ${leakage.length} secure/Extra tier leakage item(s)`);
  }
}

export class VendoredContractVerificationError extends Error {
  constructor(issues) {
    super(`Vendored Gate A contract verification failed:\n- ${issues.join('\n- ')}`);
    this.name = 'VendoredContractVerificationError';
    this.issues = issues;
  }
}

export async function verifyVendoredContract({ rootDir = DEFAULT_ROOT } = {}) {
  const root = resolve(rootDir);
  const issues = [];
  const vendorRoot = resolve(root, EXPECTED_PROVENANCE.vendor.root);
  await validateVendorRoot(root, vendorRoot, issues);
  if (issues.length > 0) throw new VendoredContractVerificationError(issues);

  const provenancePath = resolve(root, 'provenance/ks2-mastery-gate-a.json');
  const provenanceBytes = await readBytes(provenancePath, 'provenance record', issues);
  const provenance = parseJson(provenanceBytes, 'provenance record', issues);
  authorityChecks(provenance, issues);

  const evidenceBytes = {};
  const evidenceManifests = {};
  for (const [label, record] of Object.entries(EXPECTED_PROVENANCE.evidence)) {
    const path = resolve(vendorRoot, record.path);
    const bytes = await readBytes(path, label, issues);
    evidenceBytes[label] = bytes;
    if (bytes && sha256(bytes) !== record.sha256) {
      recordIssue(issues, `recorded hash mismatch for ${record.path}`);
    }
    evidenceManifests[label] = parseJson(bytes, label, issues);
  }

  const a2Manifest = evidenceManifests.a2Manifest;
  const a3Manifest = evidenceManifests.a3Manifest;
  validateManifestAuthority(a2Manifest, a3Manifest, issues);

  const runtimeFiles = Array.isArray(a3Manifest?.runtime?.files)
    ? a3Manifest.runtime.files
    : [];
  const runtimePaths = runtimeFiles.map((record) => record?.path);
  if (
    runtimePaths.some(
      (path) =>
        typeof path !== 'string' ||
        !path.startsWith('shared/spelling/') ||
        posix.normalize(path) !== path ||
        path.includes('..'),
    )
  ) {
    recordIssue(issues, 'runtime manifest contains an unsafe or invalid path');
  }
  if (new Set(runtimePaths).size !== runtimePaths.length) {
    recordIssue(issues, 'runtime manifest contains duplicate file paths');
  }

  const expectedVendorFiles = [
    ...Object.values(EXPECTED_PROVENANCE.evidence).map(({ path }) => path),
    ...Object.values(EXPECTED_PROVENANCE.catalogues).map(({ path }) => path),
    ...runtimePaths,
  ].sort();
  const producerTestFiles = Object.keys(EXPECTED_PROVENANCE.producerTests.files);
  if (
    producerTestFiles.length !== EXPECTED_PROVENANCE.producerTests.fileCount ||
    producerTestFiles.some(
      (path) =>
        !path.startsWith('tests/spelling-mobile-a3-') ||
        !path.endsWith('.test.js') ||
        posix.normalize(path) !== path ||
        path.includes('..'),
    )
  ) {
    recordIssue(issues, 'producer test provenance contains an unsafe path or count drift');
  }
  if (expectedVendorFiles.length !== EXPECTED_PROVENANCE.vendor.expectedFileCount) {
    recordIssue(
      issues,
      `runtime/content authority count drift: expected 29, received ${expectedVendorFiles.length}`,
    );
  }
  const expectedAllVendorFiles = [...expectedVendorFiles, ...producerTestFiles].sort();
  const producerTestPathSet = new Set(producerTestFiles);
  const actualVendorFiles = await listVendorFiles(vendorRoot, issues);
  compareExactSet(
    actualVendorFiles,
    expectedAllVendorFiles,
    (path) =>
      recordIssue(
        issues,
        producerTestPathSet.has(path)
          ? `missing producer test: ${path}`
          : `missing runtime/evidence file: ${path}`,
      ),
    (path) => recordIssue(issues, `unexpected vendored file: ${path}`),
  );
  const actualRuntimeAuthorityCount = actualVendorFiles.filter((path) =>
    expectedVendorFiles.includes(path),
  ).length;
  if (actualRuntimeAuthorityCount !== EXPECTED_PROVENANCE.vendor.expectedFileCount) {
    recordIssue(
      issues,
      `runtime/content authority count drift: expected 29, received ${actualRuntimeAuthorityCount}`,
    );
  }

  for (const [path, expectedHash] of Object.entries(
    EXPECTED_PROVENANCE.producerTests.files,
  )) {
    const bytes = await readBytes(resolve(vendorRoot, path), `producer test ${path}`, issues);
    if (bytes && sha256(bytes) !== expectedHash) {
      recordIssue(issues, `producer test hash mismatch for ${path}`);
    }
  }

  const sourceByPath = new Map();
  for (const record of runtimeFiles) {
    if (!record || typeof record.path !== 'string') continue;
    const bytes = await readBytes(resolve(vendorRoot, record.path), `runtime file ${record.path}`, issues);
    if (!bytes) continue;
    if (!/^[a-f0-9]{64}$/.test(record.sha256) || sha256(bytes) !== record.sha256) {
      recordIssue(issues, `recorded hash mismatch for ${record.path}`);
    }
    sourceByPath.set(record.path, bytes.toString('utf8'));
  }

  const runtimePathSet = new Set(runtimePaths);
  const allImportRecords = [];
  for (const record of runtimeFiles) {
    const importer = record?.path;
    const source = sourceByPath.get(importer);
    if (!source) continue;
    for (const specifier of specifiersFromSource(source)) {
      const resolved = resolveSpecifier(importer, specifier, issues);
      if (resolved && !runtimePathSet.has(resolved)) {
        recordIssue(issues, `import escapes the 24-file closure: ${importer} -> ${specifier} -> ${resolved}`);
      }
      allImportRecords.push({
        importer,
        kind: 'import-statement',
        specifier,
        resolved,
      });
    }
  }

  const certifiedImporters = new Set(
    (a3Manifest?.runtime?.importPolicy?.records ?? []).map(({ importer }) => importer),
  );
  const certifiedActualRecords = allImportRecords.filter(({ importer }) =>
    certifiedImporters.has(importer),
  ).sort((left, right) =>
    left.importer.localeCompare(right.importer) ||
    left.specifier.localeCompare(right.specifier) ||
    left.resolved.localeCompare(right.resolved),
  );
  const certifiedExpectedRecords = a3Manifest?.runtime?.importPolicy?.records ?? [];
  if (!isDeepStrictEqual(certifiedActualRecords, certifiedExpectedRecords)) {
    const firstMismatch = certifiedExpectedRecords.findIndex(
      (record, index) => !isDeepStrictEqual(record, certifiedActualRecords[index]),
    );
    recordIssue(
      issues,
      `import-record/specifier/resolution drift from the certified A3 manifest ` +
        `(expected ${certifiedExpectedRecords.length}, received ${certifiedActualRecords.length}, ` +
        `first mismatch ${firstMismatch})`,
    );
  }
  const actualA3Specifiers = [...new Set(certifiedActualRecords.map(({ specifier }) => specifier))].sort();
  const expectedA3Specifiers = [...(a3Manifest?.runtime?.importPolicy?.allowedSpecifiers ?? [])].sort();
  if (!isDeepStrictEqual(actualA3Specifiers, expectedA3Specifiers)) {
    recordIssue(issues, 'allowed import specifier drift from the certified A3 manifest');
  }

  for (const tier of ['starter', 'full']) {
    const record = EXPECTED_PROVENANCE.catalogues[tier];
    const bytes = await readBytes(resolve(vendorRoot, record.path), `${tier} catalogue`, issues);
    if (bytes && sha256(bytes) !== record.sha256) {
      recordIssue(issues, `recorded hash mismatch for ${record.path}`);
    }
    validateCatalogue(parseJson(bytes, `${tier} catalogue`, issues), tier, issues);
  }

  const facadePath = resolve(root, 'src/domain/spelling/index.js');
  const facadeBytes = await readBytes(facadePath, 'application spelling façade', issues);
  if (facadeBytes) {
    const facadeSpecifiers = specifiersFromSource(facadeBytes.toString('utf8')).sort();
    const expectedFacadeSpecifiers = [
      '../../../vendor/ks2-mastery/content/spelling.mobile-runtime-full.json',
      '../../../vendor/ks2-mastery/content/spelling.mobile-runtime-starter.json',
      '../../../vendor/ks2-mastery/shared/spelling/mobile/a3/index.js',
    ].sort();
    if (!isDeepStrictEqual(facadeSpecifiers, expectedFacadeSpecifiers)) {
      recordIssue(
        issues,
        'application spelling façade dependency drift or Node built-in dependency',
      );
    }
    if (facadeSpecifiers.some((specifier) => specifier.startsWith('node:'))) {
      recordIssue(issues, 'application spelling façade contains a Node built-in dependency');
    }
  }

  if (issues.length === 0) {
    try {
      const runtimeModule = await import(
        `${pathToFileURL(resolve(vendorRoot, EXPECTED_PROVENANCE.runtime.entry)).href}?verify=${randomUUID()}`
      );
      const actualExports = Object.keys(runtimeModule).sort();
      const expectedExports = [...a3Manifest.runtime.publicExports].sort();
      if (!isDeepStrictEqual(actualExports, expectedExports)) {
        recordIssue(issues, 'public runtime export drift from the certified A3 manifest');
      }
    } catch (error) {
      recordIssue(issues, `public runtime entry could not be imported: ${error.message}`);
    }
  }

  if (issues.length > 0) throw new VendoredContractVerificationError(issues);
  return {
    runtimeFilesVerified: runtimeFiles.length,
    runtimeAuthorityFilesVerified: expectedVendorFiles.length,
    producerTestFilesVerified: producerTestFiles.length,
    importRecordsVerified: certifiedExpectedRecords.length,
    starterItemsVerified: EXPECTED_PROVENANCE.catalogues.starter.itemCount,
    fullItemsVerified: EXPECTED_PROVENANCE.catalogues.full.itemCount,
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    const result = await verifyVendoredContract();
    process.stdout.write(
      `Gate A vendored contract verified: ${result.runtimeFilesVerified}/24 runtime hashes verified; ` +
        `${result.runtimeAuthorityFilesVerified}/29 runtime/content authority files verified; ` +
        `${result.producerTestFilesVerified}/9 producer test hashes verified; ` +
        `Starter ${result.starterItemsVerified}; Full ${result.fullItemsVerified}; ` +
        `${result.importRecordsVerified} A3 import records verified.\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  }
}
