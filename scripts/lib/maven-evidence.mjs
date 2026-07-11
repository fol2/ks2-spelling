import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const SHA256 = /^[a-f0-9]{64}$/;

function evidenceError(message) {
  const error = new Error(message);
  error.code = 'maven_licence_unknown';
  return error;
}

function decodeXml(value) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
    .trim();
}

function elementText(xml, name) {
  const match = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return match
    ? decodeXml(
        match[1]
          .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
          .replace(/<[^>]+>/g, ''),
      )
    : '';
}

export function parseMavenPom(xml) {
  if (typeof xml !== 'string') throw evidenceError('Maven POM is not text');
  const parentBlock = xml.match(/<parent(?:\s[^>]*)?>([\s\S]*?)<\/parent>/)?.[1];
  const parentParts = parentBlock
    ? ['groupId', 'artifactId', 'version'].map((field) => elementText(parentBlock, field))
    : [];
  if (parentBlock && parentParts.some((value) => !value)) {
    throw evidenceError('Maven parent identity is incomplete');
  }
  const licencesBlock = xml.match(/<licenses(?:\s[^>]*)?>([\s\S]*?)<\/licenses>/)?.[1];
  const licences = licencesBlock
    ? [...licencesBlock.matchAll(/<license(?:\s[^>]*)?>([\s\S]*?)<\/license>/g)].map(
        ([, block]) => ({
          name: elementText(block, 'name'),
          url: elementText(block, 'url'),
          distribution: elementText(block, 'distribution'),
          comments: elementText(block, 'comments'),
        }),
      )
    : [];
  if (licences.some(({ name, url }) => !name || !url)) {
    throw evidenceError('Maven licence name or URL is missing');
  }
  return {
    parentCoordinate: parentParts.length ? parentParts.join(':') : null,
    licences,
  };
}

export async function resolveEffectiveMavenLicences(coordinates, readPom) {
  const cache = new Map();
  async function resolveCoordinate(coordinate, ancestors) {
    if (ancestors.has(coordinate)) {
      throw evidenceError(`Maven parent cycle at ${coordinate}`);
    }
    if (cache.has(coordinate)) return cache.get(coordinate);
    const pom = await readPom(coordinate);
    if (
      !pom ||
      typeof pom.text !== 'string' ||
      !SHA256.test(pom.sha256) ||
      typeof pom.sourceUrl !== 'string' ||
      !pom.sourceUrl
    ) {
      throw evidenceError(`Missing Maven POM provenance for ${coordinate}`);
    }
    const parsed = parseMavenPom(pom.text);
    if (parsed.licences.length) {
      const resolved = {
        declaredBy: coordinate,
        inherited: false,
        pom: { sha256: pom.sha256, sourceUrl: pom.sourceUrl },
        licences: parsed.licences,
      };
      cache.set(coordinate, resolved);
      return resolved;
    }
    if (!parsed.parentCoordinate || parsed.parentCoordinate.includes('${')) {
      throw evidenceError(`No exact Maven licence declaration for ${coordinate}`);
    }
    const resolved = await resolveCoordinate(
      parsed.parentCoordinate,
      new Set([...ancestors, coordinate]),
    );
    cache.set(coordinate, resolved);
    return resolved;
  }

  const resolved = [];
  for (const coordinate of coordinates) {
    const evidence = await resolveCoordinate(coordinate, new Set());
    resolved.push({
      coordinate,
      ...evidence,
      inherited: evidence.declaredBy !== coordinate,
    });
  }
  return resolved;
}

export function mavenLicenceSignature(licences) {
  if (!Array.isArray(licences) || licences.length !== 1) {
    throw evidenceError('Licence signatures require one exact Maven licence entry');
  }
  const normalise = (value) =>
    value == null ? null : value.normalize('NFC').replace(/\s+/g, ' ').trim();
  const [{ name, url, comments }] = licences;
  const payload = JSON.stringify([
    normalise(name),
    normalise(url),
    normalise(comments || null),
  ]);
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

export function classifyAndroidDistribution(component) {
  if (!Array.isArray(component.scopes) || component.scopes.length === 0) {
    throw evidenceError('Android component has no distribution scope');
  }
  for (const scope of component.scopes) {
    const recognised = scope.buildscript
      ? scope.configuration === 'classpath'
      : scope.configuration.startsWith('_internal-') ||
        /^(?:debug|release)(?:AndroidTest|UnitTest)?(?:Compile|Runtime)Classpath$/.test(
          scope.configuration,
        );
    if (!recognised) {
      throw evidenceError(
        `Ambiguous Android dependency scope: ${scope.project}:${scope.configuration}`,
      );
    }
  }
  const debugRuntime = component.scopes.some(
    ({ project, configuration, buildscript }) =>
      project === ':app' &&
      configuration === 'debugRuntimeClasspath' &&
      buildscript === false,
  );
  const releaseRuntime = component.scopes.some(
    ({ project, configuration, buildscript }) =>
      project === ':app' &&
      configuration === 'releaseRuntimeClasspath' &&
      buildscript === false,
  );
  return debugRuntime || releaseRuntime
    ? 'packaged-runtime'
    : 'tooling-or-test-only';
}

export function mavenPomRelativePath(coordinate) {
  const [group, name, version, ...extra] = coordinate.split(':');
  if (
    extra.length ||
    ![group, name, version].every((part) => /^[A-Za-z0-9_.-]+$/.test(part))
  ) {
    throw evidenceError(`Unsafe Maven coordinate: ${coordinate}`);
  }
  return `${group.replaceAll('.', '/')}/${name}/${version}/${name}-${version}.pom`;
}

export async function readCachedMavenPom(gradleUserHome, coordinate) {
  const [group, name, version] = coordinate.split(':');
  mavenPomRelativePath(coordinate);
  const coordinateRoot = join(
    gradleUserHome,
    'caches/modules-2/files-2.1',
    group,
    name,
    version,
  );
  const candidates = [];
  let hashDirectories;
  try {
    hashDirectories = await readdir(coordinateRoot, { withFileTypes: true });
  } catch {
    throw evidenceError(`Cached Maven POM is missing: ${coordinate}`);
  }
  for (const directory of hashDirectories) {
    if (directory.isSymbolicLink() || !directory.isDirectory()) continue;
    const hashRoot = join(coordinateRoot, directory.name);
    for (const entry of await readdir(hashRoot, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        throw evidenceError(`Symlinked Maven cache entry: ${coordinate}`);
      }
      if (!entry.isFile() || !entry.name.endsWith('.pom')) continue;
      const path = join(hashRoot, entry.name);
      const stats = await lstat(path);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw evidenceError(`Unsafe Maven cache entry: ${coordinate}`);
      }
      const content = await readFile(path);
      candidates.push({
        path,
        text: content.toString('utf8'),
        sha256: createHash('sha256').update(content).digest('hex'),
      });
    }
  }
  if (!candidates.length) {
    throw evidenceError(`Cached Maven POM is missing: ${coordinate}`);
  }
  if (new Set(candidates.map(({ sha256 }) => sha256)).size !== 1) {
    throw evidenceError(`Conflicting cached Maven POMs: ${coordinate}`);
  }
  return candidates.sort((left, right) => left.path.localeCompare(right.path))[0];
}
