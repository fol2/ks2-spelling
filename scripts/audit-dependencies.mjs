import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { EXIT_CODES, isMain, printJson } from './lib/run-command.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const REPORT_PATH = resolve(ROOT, 'reports/b1/dependency-audit.json');
const NOTICES_PATH = resolve(ROOT, 'THIRD_PARTY_NOTICES.md');

function policyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function packageNameFromPath(path) {
  return path.split('node_modules/').at(-1);
}

function stableSortByName(entries) {
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

function markdownCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

export function renderThirdPartyNotices({ lockPackages, spm, androidResolution }) {
  const rows = [...lockPackages]
    .sort((left, right) =>
      `${left.name}@${left.version}:${left.locator}`.localeCompare(
        `${right.name}@${right.version}:${right.locator}`,
      ),
    )
    .map(
      ({ name, version, licence, source, locator }) =>
        `| ${markdownCell(name)} | ${markdownCell(version)} | ${markdownCell(licence)} | npm | ${markdownCell(source)} | ${markdownCell(locator)} |`,
    );
  rows.push(
    `| ${markdownCell(spm.name)} | ${markdownCell(spm.version)} | ${markdownCell(spm.licence)} | SwiftPM | ${markdownCell(spm.source)} | revision ${markdownCell(spm.revision)} |`,
  );
  return `# Third-party notices

This is the deterministic preliminary dependency inventory for the B1 local prototype. It records package identity, source and declared licence; it is not a substitute for the full licence texts or final store disclosure review.

- Android resolution: \`${androidResolution}\`
- Runtime network endpoints: none
- Native plugins beyond Capacitor core/platform packages: none

| Package | Version | Declared licence | Source type | Source | Locator |
|---|---:|---|---|---|---|
${rows.join('\n')}
`;
}

async function listFiles(root) {
  const files = [];
  async function walk(directory) {
    const directoryStats = await lstat(directory);
    if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
      throw policyError('unsafe_audited_path', `Audited directory is not regular: ${directory}`);
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw policyError('unsafe_audited_path', `Symbolic link in audited tree: ${path}`);
      }
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
      else {
        throw policyError('unsafe_audited_path', `Non-regular entry in audited tree: ${path}`);
      }
    }
  }
  await walk(root);
  return files.sort();
}

async function assertRegularFilePath(root, path) {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(root, path);
  const relativePath = relative(absoluteRoot, absolutePath);
  if (relativePath.startsWith('..') || relativePath === '') {
    throw policyError('unsafe_audited_path', `Audited file is outside its root: ${path}`);
  }
  const rootStats = await lstat(absoluteRoot);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw policyError('unsafe_audited_path', `Audited root is not regular: ${absoluteRoot}`);
  }
  const components = relativePath.split('/');
  let current = absoluteRoot;
  for (const [index, component] of components.entries()) {
    current = join(current, component);
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) {
      throw policyError('unsafe_audited_path', `Symbolic link in audited path: ${path}`);
    }
    const isLast = index === components.length - 1;
    if ((isLast && !stats.isFile()) || (!isLast && !stats.isDirectory())) {
      throw policyError('unsafe_audited_path', `Audited path is not regular: ${path}`);
    }
  }
}

function commonClassification(policy, name, lockEntry) {
  const classification = policy.npmClassifications[name];
  if (!classification) {
    throw policyError('unclassified_dependency', `No classification for ${name}`);
  }
  return {
    name,
    version: lockEntry.version,
    source: lockEntry.resolved,
    licence: lockEntry.license,
    role: classification.role,
    platform: classification.platform,
    permissions: [],
    dataAccess: [],
    networkEndpoints: [],
    applePrivacyManifest: classification.applePrivacyManifest,
    googleDataSafety: classification.googleDataSafety,
    owner: policy.owner,
    reviewDate: policy.reviewDate,
  };
}

async function verifyRuntimeBoundary(packageJson) {
  const approvedCapacitorPackages = new Set([
    '@capacitor/android',
    '@capacitor/core',
    '@capacitor/ios',
  ]);
  const unexpectedPlugins = Object.keys(packageJson.dependencies ?? {}).filter(
    (name) => name.startsWith('@capacitor/') && !approvedCapacitorPackages.has(name),
  );
  if (unexpectedPlugins.length) {
    throw policyError('unapproved_native_plugin', unexpectedPlugins.join(', '));
  }

  const manifest = await readFile(
    resolve(ROOT, 'android/app/src/main/AndroidManifest.xml'),
    'utf8',
  );
  if (/<uses-permission\b/.test(manifest)) {
    throw policyError('android_permission_declared', 'B1 app manifest declares a permission');
  }
  const iosAppFiles = await listFiles(resolve(ROOT, 'ios/App/App'));
  const entitlements = iosAppFiles
    .filter((path) => path.endsWith('.entitlements'))
    .map((path) => path.slice(`${ROOT}/`.length));
  const infoPlist = await readFile(resolve(ROOT, 'ios/App/App/Info.plist'), 'utf8');
  const usageDescriptionKeys = [
    ...infoPlist.matchAll(/<key>([^<]*UsageDescription)<\/key>/g),
  ].map(([, key]) => key);
  if (entitlements.length || usageDescriptionKeys.length) {
    throw policyError(
      'ios_permission_surface_declared',
      `iOS permission surface found: ${[...entitlements, ...usageDescriptionKeys].join(', ')}`,
    );
  }
  const capacitorAndroid = await readFile(
    resolve(ROOT, 'android/app/capacitor.build.gradle'),
    'utf8',
  );
  const generatedDependencies = capacitorAndroid.match(/dependencies\s*\{([\s\S]*?)\}/)?.[1] ?? '';
  if (/\b(?:implementation|api|classpath)\b/.test(generatedDependencies)) {
    throw policyError('unapproved_native_plugin', 'Generated Android plugin dependency found');
  }
  const packageSwift = await readFile(resolve(ROOT, 'ios/App/CapApp-SPM/Package.swift'), 'utf8');
  const products = [...packageSwift.matchAll(/\.product\(name: "([^"]+)"/g)].map(
    ([, name]) => name,
  );
  if (products.join(',') !== 'Capacitor,Cordova') {
    throw policyError('unapproved_native_plugin', `Unexpected iOS products: ${products.join(',')}`);
  }
  for (const path of [
    'ios/App/Podfile',
    'ios/App/Podfile.lock',
    'ios/App/Pods',
    'ios/App/App.xcworkspace',
  ]) {
    if (existsSync(resolve(ROOT, path))) {
      throw policyError('cocoapods_active', `Active CocoaPods path found: ${path}`);
    }
  }
  const capacitorConfig = await readJson(resolve(ROOT, 'capacitor.config.json'));
  if (Object.hasOwn(capacitorConfig, 'server')) {
    throw policyError('runtime_endpoint_declared', 'Capacitor server configuration is forbidden');
  }
  const runtimeFiles = [resolve(ROOT, 'index.html'), ...(await listFiles(resolve(ROOT, 'src')))];
  for (const path of runtimeFiles) {
    if (/https?:\/\//i.test(await readFile(path, 'utf8'))) {
      throw policyError('runtime_endpoint_declared', `Runtime URL found in ${path}`);
    }
  }
  return {
    androidUsesPermissions: [],
    iosEntitlements: entitlements,
    iosUsageDescriptionKeys: usageDescriptionKeys,
  };
}

function validateLock(policy, lock) {
  const approvedLicences = new Set(policy.approvedLicences);
  const lockPackages = [];
  for (const [locator, entry] of Object.entries(lock.packages)) {
    if (!locator) continue;
    const name = packageNameFromPath(locator);
    if (!entry.version || !entry.resolved || !entry.integrity || !entry.license) {
      throw policyError('incomplete_lock_entry', `Incomplete lock entry: ${locator}`);
    }
    if (!entry.resolved.startsWith(policy.allowedSources.npm)) {
      throw policyError('unapproved_package_source', `${name}: ${entry.resolved}`);
    }
    if (/\s+(?:AND|OR)\s+|[()]/.test(entry.license) || !approvedLicences.has(entry.license)) {
      throw policyError('licence_review_required', `${name}: ${entry.license}`);
    }
    lockPackages.push({
      locator,
      name,
      version: entry.version,
      licence: entry.license,
      source: entry.resolved,
      integrity: entry.integrity,
      dev: entry.dev === true,
    });
  }
  return lockPackages;
}

function stripGradleComments(text) {
  let output = '';
  let state = 'normal';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (state === 'line-comment') {
      if (character === '\n') {
        output += character;
        state = 'normal';
      }
      continue;
    }
    if (state === 'block-comment') {
      if (character === '*' && next === '/') {
        index += 1;
        state = 'normal';
      } else if (character === '\n') {
        output += character;
      }
      continue;
    }
    if (state === 'single-quote' || state === 'double-quote') {
      output += character;
      if (character === '\\' && next) {
        output += next;
        index += 1;
      } else if (
        (state === 'single-quote' && character === "'") ||
        (state === 'double-quote' && character === '"')
      ) {
        state = 'normal';
      }
      continue;
    }
    if (character === '/' && next === '/') {
      state = 'line-comment';
      index += 1;
    } else if (character === '/' && next === '*') {
      state = 'block-comment';
      index += 1;
    } else {
      output += character;
      if (character === "'") state = 'single-quote';
      if (character === '"') state = 'double-quote';
    }
  }
  return output;
}

function extractNamedBlocks(text, keyword) {
  const blocks = [];
  const pattern = new RegExp(`\\b${keyword}\\s*\\{`, 'g');
  for (const match of text.matchAll(pattern)) {
    const openingBrace = match.index + match[0].lastIndexOf('{');
    let depth = 0;
    for (let index = openingBrace; index < text.length; index += 1) {
      if (text[index] === '{') depth += 1;
      if (text[index] === '}') depth -= 1;
      if (depth === 0) {
        blocks.push(text.slice(openingBrace + 1, index));
        break;
      }
    }
  }
  return blocks;
}

export function parseGradleEvidence(sources) {
  const cleanSources = sources.map(({ path, text }) => ({
    path,
    text: stripGradleComments(text),
  }));
  const combined = cleanSources.map(({ text }) => text).join('\n');
  const variables = new Map(
    [...combined.matchAll(/\b([A-Za-z][A-Za-z0-9_]*Version)\s*=\s*['"]([^'"]+)['"]/g)].map(
      ([, name, value]) => [name, value],
    ),
  );
  const declarations = new Map();
  const localDependencies = new Set();
  function recordDeclaration({ configuration, raw, path }) {
    const resolved = raw.replace(/\$\{?([A-Za-z][A-Za-z0-9_]*)\}?/g, (_, name) => {
      const value = variables.get(name);
      if (!value) {
        throw policyError(
          'gradle_declaration_drift',
          `Unresolved Gradle variable ${name} in ${path}`,
        );
      }
      return value;
    });
    const [group, artifact, ...versionParts] = resolved.split(':');
    if (!group || !artifact || versionParts.length === 0) {
      throw policyError(
        'gradle_declaration_drift',
        `Unresolved Maven coordinate in ${path}: ${raw}`,
      );
    }
    const version = versionParts.join(':');
    const key = `${group}:${artifact}:${version}`;
    const existing = declarations.get(key) ?? {
      coordinate: `${group}:${artifact}`,
      version,
      configurations: new Set(),
      sources: new Set(),
    };
    existing.configurations.add(configuration);
    existing.sources.add(path);
    declarations.set(key, existing);
  }
  for (const { path, text } of cleanSources) {
    for (const dependencyBlock of extractNamedBlocks(text, 'dependencies')) {
      for (const [, raw] of dependencyBlock.matchAll(
        /['"]([^'"\r\n]+:[^'"\r\n]+:[^'"\r\n]+)['"]/g,
      )) {
        recordDeclaration({ configuration: 'literal', raw, path });
      }
      const mapDeclarations = [
        ...dependencyBlock.matchAll(
          /\bgroup\s*:\s*['"]([^'"]+)['"]\s*,\s*name\s*:\s*['"]([^'"]+)['"]\s*,\s*version\s*:\s*['"]([^'"]+)['"]/g,
        ),
      ];
      for (const match of mapDeclarations) {
        recordDeclaration({
          configuration: 'map-literal',
          raw: `${match[1]}:${match[2]}:${match[3]}`,
          path,
        });
      }
      if ([...dependencyBlock.matchAll(/\bgroup\s*:/g)].length !== mapDeclarations.length) {
        throw policyError(
          'gradle_declaration_drift',
          `Dynamic Gradle map dependency is not permitted in ${path}`,
        );
      }
      const projectDependencies = [
        ...dependencyBlock.matchAll(/\bproject\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
      ];
      for (const match of projectDependencies) {
        localDependencies.add(`project:${match[1]}`);
      }
      if ([...dependencyBlock.matchAll(/\bproject\s*\(/g)].length !== projectDependencies.length) {
        throw policyError(
          'gradle_declaration_drift',
          `Dynamic Gradle project dependency is not permitted in ${path}`,
        );
      }
      const fileTreeDependencies = [...dependencyBlock.matchAll(/\bfileTree\s*\(([^)]*)\)/g)];
      for (const match of fileTreeDependencies) {
        const dir = match[1].match(/\bdir\s*:\s*['"]([^'"]+)['"]/)?.[1];
        if (!dir) {
          throw policyError('gradle_declaration_drift', `Unresolved fileTree in ${path}`);
        }
        localDependencies.add(`fileTree:${dir}`);
      }
      if ([...dependencyBlock.matchAll(/\bfileTree\s*\(/g)].length !== fileTreeDependencies.length) {
        throw policyError(
          'gradle_declaration_drift',
          `Dynamic Gradle fileTree dependency is not permitted in ${path}`,
        );
      }
      if (/\badd\s*\(/.test(dependencyBlock) || /\blibs(?:\.|\[)/.test(dependencyBlock)) {
        throw policyError(
          'gradle_declaration_drift',
          `Dynamic Gradle dependency syntax is not permitted in ${path}`,
        );
      }
      const fragments = dependencyBlock.replaceAll('{', '\n').replaceAll('}', '\n').split(/[;\n\r]+/);
      for (const fragment of fragments) {
        const statement = fragment.trim();
        if (!statement || /^(?:if|else|try|catch|finally)\b/.test(statement)) continue;
        const statementMatch = statement.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(.*)$/);
        if (!statementMatch) continue;
        const [, configuration, syntax] = statementMatch;
        if (!syntax) {
          if (configuration === 'constraints') continue;
          throw policyError(
            'gradle_declaration_drift',
            `Unresolved dependency statement in ${path}: ${statement}`,
          );
        }
        const projectMatch = syntax.match(/^project\(\s*['"]([^'"]+)['"]/);
        if (projectMatch) {
          localDependencies.add(`project:${projectMatch[1]}`);
          continue;
        }
        if (/^fileTree\b/.test(syntax)) {
          const dir = syntax.match(/\bdir\s*:\s*['"]([^'"]+)['"]/)?.[1];
          if (!dir) {
            throw policyError('gradle_declaration_drift', `Unresolved fileTree in ${path}`);
          }
          localDependencies.add(`fileTree:${dir}`);
          continue;
        }
        const stringMatch = syntax.match(
          /^(?:\(\s*)?(?:(?:platform|enforcedPlatform)\s*\(\s*)?['"]([^'"]+)['"]/,
        );
        if (stringMatch) {
          recordDeclaration({ configuration, raw: stringMatch[1], path });
          continue;
        }
        const mapMatch = syntax.match(
          /^(?:\(\s*)?group\s*:\s*['"]([^'"]+)['"]\s*,\s*name\s*:\s*['"]([^'"]+)['"]\s*,\s*version\s*:\s*['"]([^'"]+)['"]/,
        );
        if (mapMatch) {
          recordDeclaration({
            configuration,
            raw: `${mapMatch[1]}:${mapMatch[2]}:${mapMatch[3]}`,
            path,
          });
          continue;
        }
        throw policyError(
          'gradle_declaration_drift',
          `Unresolved ${configuration} declaration in ${path}: ${syntax}`,
        );
      }
    }
  }

  const repositories = new Set();
  const flatDirs = new Set();
  for (const { text } of cleanSources) {
    for (const block of extractNamedBlocks(text, 'repositories')) {
      for (const [, call] of block.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)/g)) {
        repositories.add(`${call}()`);
      }
      const urls = [
        ...block.matchAll(
          /(?:\burl\s*(?:=\s*)?(?:uri\s*\(\s*)?|\bsetUrl\s*\(\s*)['"]([^'"]+)['"]/g,
        ),
      ].map(([, url]) => url);
      for (const url of urls) repositories.add(url);
      for (const repositoryType of ['maven', 'ivy']) {
        for (const repositoryBlock of extractNamedBlocks(block, repositoryType)) {
          const hasLiteralUrl = /(?:\burl\s*(?:=\s*)?(?:uri\s*\(\s*)?|\bsetUrl\s*\(\s*)['"][^'"]+['"]/.test(
            repositoryBlock,
          );
          if (!hasLiteralUrl) repositories.add(`${repositoryType}:<missing-url>`);
        }
      }
      for (const flatDirBlock of extractNamedBlocks(block, 'flatDir')) {
        let literalCount = 0;
        for (const dirs of flatDirBlock.matchAll(/\bdirs\s*(?:\(\s*)?([^\n\r}]+)/g)) {
          for (const [, path] of dirs[1].matchAll(/['"]([^'"]+)['"]/g)) {
            flatDirs.add(path);
            literalCount += 1;
          }
        }
        if (literalCount === 0) flatDirs.add('flatDir:<dynamic>');
      }
    }
  }

  return {
    sourceFiles: sources
      .map(({ path, text }) => ({
        path,
        sha256: createHash('sha256').update(text).digest('hex'),
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    declarations: [...declarations.values()]
      .map((entry) => ({
        ...entry,
        configurations: [...entry.configurations].sort(),
        sources: [...entry.sources].sort(),
      }))
      .sort((left, right) =>
        `${left.coordinate}:${left.version}`.localeCompare(`${right.coordinate}:${right.version}`),
      ),
    repositories: [...repositories].sort(),
    flatDirs: [...flatDirs].sort(),
    localDependencies: [...localDependencies].sort(),
  };
}

function isGradleInputPath(path) {
  if (path.startsWith('android/capacitor-cordova-android-plugins/')) return false;
  if (path.startsWith('android/.gradle/') || path.includes('/build/')) return false;
  if (path.includes('/buildSrc/')) return true;
  return (
    /\.(?:gradle|gradle\.kts)$/.test(path) ||
    /(?:^|\/)libs\.versions\.toml$/.test(path) ||
    /(?:^|\/)gradle\.properties$/.test(path) ||
    /(?:^|\/)gradle-wrapper\.(?:properties|jar)$/.test(path) ||
    /(?:^|\/)gradlew(?:\.bat)?$/.test(path)
  );
}

export async function discoverGradleInputs(root = ROOT) {
  const androidRoot = resolve(root, 'android');
  const androidPaths = (await listFiles(androidRoot))
    .map((path) => relative(root, path))
    .filter(isGradleInputPath);
  const paths = [
    ...androidPaths,
    'node_modules/@capacitor/android/capacitor/build.gradle',
  ].sort();
  const entries = await Promise.all(
    paths.map(async (path) => {
      await assertRegularFilePath(root, path);
      const content = await readFile(resolve(root, path));
      return {
        path,
        sha256: createHash('sha256').update(content).digest('hex'),
        content,
      };
    }),
  );
  return {
    inventory: entries.map(({ path, sha256 }) => ({ path, sha256 })),
    parserSources: entries
      .filter(({ path }) => /\.(?:gradle|gradle\.kts)$/.test(path))
      .map(({ path, content }) => ({ path, text: content.toString('utf8') })),
  };
}

export function assertGradleInputInventoryMatchesPolicy(inventory, policy) {
  const expected = policy.gradleInputFiles ?? [];
  const actualByPath = new Map(inventory.map((entry) => [entry.path, entry.sha256]));
  const expectedByPath = new Map(expected.map((entry) => [entry.path, entry.sha256]));
  const duplicateActual = inventory.length !== actualByPath.size;
  const duplicateExpected = expected.length !== expectedByPath.size;
  const extra = [...actualByPath.keys()].filter((path) => !expectedByPath.has(path));
  const missing = [...expectedByPath.keys()].filter((path) => !actualByPath.has(path));
  const changed = [...actualByPath].flatMap(([path, sha256]) =>
    expectedByPath.has(path) && expectedByPath.get(path) !== sha256 ? [path] : [],
  );
  if (duplicateActual || duplicateExpected || extra.length || missing.length || changed.length) {
    throw policyError(
      'gradle_input_drift',
      `Gradle input allow-list drifted; extra=${extra.join(',')}; missing=${missing.join(',')}; changed=${changed.join(',')}`,
    );
  }
}

function exactSetDifference(actual, expected) {
  const expectedSet = new Set(expected);
  return actual.filter((value) => !expectedSet.has(value));
}

export function assertGradleEvidenceMatchesPolicy(evidence, policy) {
  const actualDeclarations = evidence.declarations.map(
    ({ coordinate, version }) => `${coordinate}:${version}`,
  );
  const expectedDeclarations = policy.gradleDeclared.map(
    ({ coordinate, version }) => `${coordinate}:${version}`,
  );
  const extraDeclarations = exactSetDifference(actualDeclarations, expectedDeclarations);
  const missingDeclarations = exactSetDifference(expectedDeclarations, actualDeclarations);
  if (extraDeclarations.length || missingDeclarations.length) {
    throw policyError(
      'gradle_declaration_drift',
      `Gradle declaration set drifted; extra=${extraDeclarations.join(',')}; missing=${missingDeclarations.join(',')}`,
    );
  }
  const extraRepositories = exactSetDifference(
    evidence.repositories,
    policy.allowedSources.gradleRepositories,
  );
  const missingRepositories = exactSetDifference(
    policy.allowedSources.gradleRepositories,
    evidence.repositories,
  );
  if (extraRepositories.length || missingRepositories.length) {
    throw policyError(
      'unapproved_gradle_source',
      `Gradle repository set drifted; extra=${extraRepositories.join(',')}; missing=${missingRepositories.join(',')}`,
    );
  }
  const extraFlatDirs = exactSetDifference(evidence.flatDirs, policy.allowedSources.gradleFlatDirs);
  const missingFlatDirs = exactSetDifference(policy.allowedSources.gradleFlatDirs, evidence.flatDirs);
  if (extraFlatDirs.length || missingFlatDirs.length) {
    throw policyError(
      'unapproved_flat_dir',
      `Gradle flatDir set drifted; extra=${extraFlatDirs.join(',')}; missing=${missingFlatDirs.join(',')}`,
    );
  }
  const extraLocalDependencies = exactSetDifference(
    evidence.localDependencies,
    policy.allowedSources.gradleLocalDependencies,
  );
  const missingLocalDependencies = exactSetDifference(
    policy.allowedSources.gradleLocalDependencies,
    evidence.localDependencies,
  );
  if (extraLocalDependencies.length || missingLocalDependencies.length) {
    throw policyError(
      'gradle_declaration_drift',
      `Gradle local dependency set drifted; extra=${extraLocalDependencies.join(',')}; missing=${missingLocalDependencies.join(',')}`,
    );
  }
}

async function verifyGradleDeclarations(policy) {
  const discovered = await discoverGradleInputs();
  assertGradleInputInventoryMatchesPolicy(discovered.inventory, policy);
  const evidence = parseGradleEvidence(discovered.parserSources);
  assertGradleEvidenceMatchesPolicy(evidence, policy);
  return {
    inputs: discovered.inventory,
    declarations: policy.gradleDeclared.map((entry) => ({
      ...entry,
      resolution: 'pending-toolchain',
    })),
    repositories: evidence.repositories,
    flatDirs: evidence.flatDirs,
    localDependencies: evidence.localDependencies,
  };
}

export async function buildDependencyArtifacts({ preBootstrap = false } = {}) {
  const [policy, packageJson, lock, packageLockText, packageResolved] = await Promise.all([
    readJson(resolve(ROOT, 'config/dependency-policy.json')),
    readJson(resolve(ROOT, 'package.json')),
    readJson(resolve(ROOT, 'package-lock.json')),
    readFile(resolve(ROOT, 'package-lock.json'), 'utf8'),
    readJson(
      resolve(
        ROOT,
        'ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved',
      ),
    ),
  ]);

  assertDirectPolicy(packageJson.dependencies, policy.directDependencies, 'runtime dependency');
  assertDirectPolicy(packageJson.devDependencies, policy.directBuildTools, 'build tool');
  assertDirectPolicy(lock.packages[''].dependencies, policy.directDependencies, 'lock runtime');
  assertDirectPolicy(lock.packages[''].devDependencies, policy.directBuildTools, 'lock build');
  const lockPackages = validateLock(policy, lock);
  const permissionEvidence = await verifyRuntimeBoundary(packageJson);

  const production = stableSortByName(
    lockPackages
      .filter(({ dev }) => !dev)
      .map(({ name }) => commonClassification(policy, name, lock.packages[`node_modules/${name}`])),
  );
  const directBuildTools = stableSortByName(
    Object.keys(policy.directBuildTools).map((name) =>
      commonClassification(policy, name, lock.packages[`node_modules/${name}`]),
    ),
  );

  const pin = packageResolved.pins?.find(({ identity }) => identity === policy.spm.name);
  if (
    packageResolved.version !== 3 ||
    !pin ||
    pin.location !== policy.spm.source ||
    pin.state?.version !== policy.spm.version ||
    pin.state?.revision !== policy.spm.revision ||
    !policy.allowedSources.spm.includes(pin.location)
  ) {
    throw policyError('spm_resolution_drift', 'Official Capacitor SwiftPM pin drifted');
  }
  const privacyManifests = [
    'node_modules/@capacitor/ios/Capacitor/Capacitor/PrivacyInfo.xcprivacy',
    'node_modules/@capacitor/ios/CapacitorCordova/CapacitorCordova/PrivacyInfo.xcprivacy',
  ];
  if (!privacyManifests.every((path) => existsSync(resolve(ROOT, path)))) {
    throw policyError('missing_privacy_manifest', 'Capacitor privacy manifest is missing');
  }
  for (const path of privacyManifests) {
    const manifest = await readFile(resolve(ROOT, path), 'utf8');
    if (!/<key>NSPrivacyTracking<\/key>\s*<false\/>/.test(manifest)) {
      throw policyError('privacy_manifest_drift', `${path} does not declare tracking false`);
    }
    for (const key of [
      'NSPrivacyAccessedAPITypes',
      'NSPrivacyCollectedDataTypes',
      'NSPrivacyTrackingDomains',
    ]) {
      if (
        !new RegExp(
          `<key>${key}</key>\\s*(?:<array\\s*/>|<array>\\s*</array>)`,
        ).test(manifest)
      ) {
        throw policyError('privacy_manifest_drift', `${path} has a non-empty ${key}`);
      }
    }
  }
  const spm = [
    {
      ...policy.spm,
      permissions: [],
      dataAccess: [],
      networkEndpoints: [],
      applePrivacyManifest: 'Framework privacy manifests supplied',
      googleDataSafety: 'Not applicable',
      owner: policy.owner,
      reviewDate: policy.reviewDate,
      privacyManifests,
    },
  ];
  const gradle = await verifyGradleDeclarations(policy);
  const report = {
    schemaVersion: 1,
    mode: 'pre-bootstrap',
    generatedFrom: {
      packageLockSha256: createHash('sha256').update(packageLockText).digest('hex'),
      spmResolvedVersion: packageResolved.version,
    },
    npm: {
      lockfileVersion: lock.lockfileVersion,
      lockPackageCount: lockPackages.length,
      approvedLicences: policy.approvedLicences,
      production,
      directBuildTools,
    },
    spm,
    androidResolution: 'pending-toolchain',
    gradleInputs: gradle.inputs,
    gradleRepositories: gradle.repositories,
    gradleFlatDirs: gradle.flatDirs,
    gradleLocalDependencies: gradle.localDependencies,
    gradleDeclared: gradle.declarations,
    plugins: {
      approved: policy.approvedNativePlugins,
      candidates: policy.candidatePlugins,
    },
    permissionEvidence,
    b1Truth: {
      childDataCollected: false,
      childDataTransmitted: false,
      analytics: false,
      advertising: false,
      appPermissions: [],
      storeCommerce: false,
      runtimeNetworkEndpoints: [],
      disclosureStatus: 'B1 evidence only; not a final store disclosure',
    },
  };
  const reportJson = `${JSON.stringify(report, null, 2)}\n`;
  const noticesMarkdown = renderThirdPartyNotices({
    lockPackages,
    spm: spm[0],
    androidResolution: report.androidResolution,
  });

  if (!preBootstrap) {
    throw policyError(
      'android_resolution_pending',
      'Android dependencies remain statically declared until Task 8 resolves the Gradle graph',
    );
  }
  return { report, reportJson, noticesMarkdown };
}

function assertDirectPolicy(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw policyError('direct_dependency_drift', `${label} versions do not match policy`);
  }
  for (const version of Object.values(actual)) {
    if (/^[~^]|latest|git|github/i.test(version)) {
      throw policyError('direct_dependency_range', `${label} is not exactly pinned: ${version}`);
    }
  }
}

export async function writeDependencyArtifacts(artifacts) {
  await mkdir(resolve(ROOT, 'reports/b1'), { recursive: true });
  await Promise.all([
    writeFile(REPORT_PATH, artifacts.reportJson, 'utf8'),
    writeFile(NOTICES_PATH, artifacts.noticesMarkdown, 'utf8'),
  ]);
}

export function assertDependencyEvidenceCurrent(artifacts, current) {
  if (
    current.reportJson !== artifacts.reportJson ||
    current.noticesMarkdown !== artifacts.noticesMarkdown
  ) {
    throw policyError(
      'dependency_evidence_stale',
      'Committed dependency report or third-party notices are stale; rerun with --write',
    );
  }
}

export async function main(args = process.argv.slice(2)) {
  const preBootstrap = args.includes('--pre-bootstrap');
  const write = args.includes('--write');
  try {
    const artifacts = await buildDependencyArtifacts({ preBootstrap });
    if (write) {
      await writeDependencyArtifacts(artifacts);
    } else {
      assertDependencyEvidenceCurrent(artifacts, {
        reportJson: await readFile(REPORT_PATH, 'utf8'),
        noticesMarkdown: await readFile(NOTICES_PATH, 'utf8'),
      });
    }
    printJson({
      ok: true,
      mode: artifacts.report.mode,
      npmPackages: artifacts.report.npm.lockPackageCount,
      androidResolution: artifacts.report.androidResolution,
      evidence: write ? 'written' : 'current',
    });
    return EXIT_CODES.success;
  } catch (error) {
    printJson(
      { ok: false, code: error.code ?? 'dependency_audit_failed', message: error.message },
      process.stderr,
    );
    return ['android_resolution_pending', 'dependency_evidence_stale'].includes(error.code)
      ? EXIT_CODES.stateMismatch
      : EXIT_CODES.commandFailed;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
