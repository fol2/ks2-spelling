import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const SHA256 = /^[a-f0-9]{64}$/;
const DEFAULT_MAXIMUM_POM_BYTES = 1024 * 1024;
const DEFAULT_POM_TIMEOUT_MILLISECONDS = 30_000;

function evidenceError(message, { code = 'maven_licence_unknown', reason } = {}) {
  const error = new Error(message);
  error.code = code;
  if (reason) error.reason = reason;
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
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw evidenceError(`Cached Maven POM is missing: ${coordinate}`, {
        reason: 'cache-missing',
      });
    }
    throw evidenceError(`Unreadable Maven cache entry: ${coordinate}`);
  }
  for (const directory of hashDirectories) {
    if (directory.isSymbolicLink()) {
      throw evidenceError(`Symlinked Maven cache entry: ${coordinate}`);
    }
    if (!directory.isDirectory()) {
      throw evidenceError(`Unsafe Maven cache entry: ${coordinate}`);
    }
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
    throw evidenceError(`Cached Maven POM is missing: ${coordinate}`, {
      reason: 'cache-missing',
    });
  }
  if (new Set(candidates.map(({ sha256 }) => sha256)).size !== 1) {
    throw evidenceError(`Conflicting cached Maven POMs: ${coordinate}`);
  }
  return candidates.sort((left, right) => left.path.localeCompare(right.path))[0];
}

function validateRepositoryBase(repository) {
  let parsed;
  try {
    parsed = new URL(repository);
  } catch {
    throw evidenceError(`Invalid approved Maven repository: ${repository}`, {
      code: 'maven_pom_authority_invalid',
    });
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !parsed.pathname.endsWith('/') ||
    parsed.href !== repository
  ) {
    throw evidenceError(`Unsafe approved Maven repository: ${repository}`, {
      code: 'maven_pom_authority_invalid',
    });
  }
  return repository;
}

function validateCommittedSourceAuthority(coordinate, sourceAuthority, repositoryBases) {
  if (sourceAuthority === null || sourceAuthority === undefined) return null;
  if (
    sourceAuthority === null ||
    typeof sourceAuthority !== 'object' ||
    Array.isArray(sourceAuthority) ||
    !Object.hasOwn(sourceAuthority, 'repository') ||
    !Object.hasOwn(sourceAuthority, 'sourceUrl')
  ) {
    throw evidenceError(`Invalid committed Maven source authority: ${coordinate}`, {
      code: 'maven_pom_authority_invalid',
    });
  }
  const repositories = repositoryBases.map(validateRepositoryBase);
  const repository = validateRepositoryBase(sourceAuthority.repository);
  const sourceUrl = `${repository}${mavenPomRelativePath(coordinate)}`;
  if (!repositories.includes(repository) || sourceAuthority.sourceUrl !== sourceUrl) {
    throw evidenceError(`Committed Maven source authority drifted: ${coordinate}`, {
      code: 'maven_pom_authority_invalid',
    });
  }
  return Object.freeze({ repository, sourceUrl });
}

async function readBoundedResponse(response, maximumBytes) {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength < 0 ||
      parsedLength > maximumBytes
    ) {
      throw evidenceError('Maven POM response length is invalid or too large', {
        code: 'maven_source_unresolved',
      });
    }
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maximumBytes) {
        await reader.cancel();
        throw evidenceError('Maven POM response is too large', {
          code: 'maven_source_unresolved',
        });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, byteLength);
}

export async function fetchVerifiedMavenPom({
  coordinate,
  expectedSha256,
  repositoryBases,
  fetchImpl = globalThis.fetch,
  maximumBytes = DEFAULT_MAXIMUM_POM_BYTES,
  timeoutMilliseconds = DEFAULT_POM_TIMEOUT_MILLISECONDS,
}) {
  if (!SHA256.test(expectedSha256 ?? '')) {
    throw evidenceError(`Missing exact Maven POM authority: ${coordinate}`, {
      code: 'maven_pom_authority_invalid',
    });
  }
  const relativePath = mavenPomRelativePath(coordinate);
  if (
    !Array.isArray(repositoryBases) ||
    repositoryBases.length === 0 ||
    typeof fetchImpl !== 'function' ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 1
  ) {
    throw evidenceError(`Invalid Maven POM source authority: ${coordinate}`, {
      code: 'maven_pom_authority_invalid',
    });
  }
  const repositories = repositoryBases.map(validateRepositoryBase);
  const failures = [];
  for (const repository of repositories) {
    const sourceUrl = `${repository}${relativePath}`;
    try {
      const response = await fetchImpl(sourceUrl, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMilliseconds),
      });
      if (
        response.redirected ||
        (response.url && response.url !== sourceUrl) ||
        (response.status >= 300 && response.status < 400)
      ) {
        failures.push(`redirect:${repository}`);
        continue;
      }
      if (!response.ok) {
        failures.push(`${response.status}:${repository}`);
        continue;
      }
      const content = await readBoundedResponse(response, maximumBytes);
      const actualSha256 = createHash('sha256').update(content).digest('hex');
      if (actualSha256 !== expectedSha256) {
        failures.push(`sha256:${repository}`);
        continue;
      }
      return {
        path: null,
        text: content.toString('utf8'),
        sha256: actualSha256,
        repository,
        sourceUrl,
      };
    } catch (error) {
      failures.push(`${error.name}:${repository}`);
    }
  }
  throw evidenceError(
    `No approved Maven source matched ${coordinate}: ${failures.join(', ')}`,
    { code: 'maven_source_unresolved' },
  );
}

export async function resolveVerifiedMavenPom({
  gradleUserHome,
  coordinate,
  expectedSha256,
  repositoryBases = [],
  sourceAuthority = null,
  fetchImpl = globalThis.fetch,
  maximumBytes = DEFAULT_MAXIMUM_POM_BYTES,
  timeoutMilliseconds = DEFAULT_POM_TIMEOUT_MILLISECONDS,
}) {
  if (!SHA256.test(expectedSha256 ?? '')) {
    throw evidenceError(`Missing exact Maven POM authority: ${coordinate}`, {
      code: 'maven_pom_authority_invalid',
    });
  }
  const committedSource = validateCommittedSourceAuthority(
    coordinate,
    sourceAuthority,
    repositoryBases,
  );
  let cached;
  try {
    cached = await readCachedMavenPom(gradleUserHome, coordinate);
  } catch (error) {
    if (error.reason !== 'cache-missing') throw error;
    return fetchVerifiedMavenPom({
      coordinate,
      expectedSha256,
      repositoryBases: committedSource ? [committedSource.repository] : repositoryBases,
      fetchImpl,
      maximumBytes,
      timeoutMilliseconds,
    });
  }
  if (cached.sha256 !== expectedSha256) {
    throw evidenceError(`Cached Maven POM checksum mismatch: ${coordinate}`, {
      code: 'maven_pom_checksum_mismatch',
    });
  }
  if (committedSource) {
    return {
      ...cached,
      repository: committedSource.repository,
      sourceUrl: committedSource.sourceUrl,
    };
  }
  const source = await fetchVerifiedMavenPom({
    coordinate,
    expectedSha256,
    repositoryBases,
    fetchImpl,
    maximumBytes,
    timeoutMilliseconds,
  });
  return {
    ...cached,
    repository: source.repository,
    sourceUrl: source.sourceUrl,
  };
}
