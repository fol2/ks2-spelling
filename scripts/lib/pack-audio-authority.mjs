import { lstat, readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAudioAuthoringAuthority } from './starter-audio-authoring-authority.mjs';
import { createAudioEvidenceContract } from './starter-audio-evidence.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MAXIMUM_DOCUMENT_BYTES = 4 * 1_024 * 1_024;
const DOCUMENT_KEYS = Object.freeze([
  'schemaVersion',
  'catalogueId',
  'catalogueSource',
  'audioAuthoritySource',
  'audioSourceRoot',
  'audioEvidenceSource',
  'runtimeManifestTarget',
]);

function fail(detail, options) {
  throw new Error(`Pack audio authority ${detail}.`, options);
}

function isRepoRelativePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    value.split('/').every((segment) =>
      segment.length > 0 && segment !== '.' && segment !== '..')
  );
}

function resolveRepoPath(relativePath, label) {
  if (!isRepoRelativePath(relativePath)) fail(`rejected unsafe ${label}`);
  const resolved = resolve(ROOT, relativePath);
  if (!resolved.startsWith(`${ROOT}${sep}`)) {
    fail(`rejected ${label} outside the repository`);
  }
  return resolved;
}

async function readJsonDocument(path, label) {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAXIMUM_DOCUMENT_BYTES) {
    fail(`rejected unsafe or oversized ${label}`);
  }
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (cause) {
    return fail(`${label} is not valid JSON`, { cause });
  }
}

function validateDocument(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== DOCUMENT_KEYS.length ||
    DOCUMENT_KEYS.some((key) => !Object.hasOwn(value, key))
  ) {
    fail('must contain exactly the reviewed fields');
  }
  if (
    value.schemaVersion !== 1 ||
    typeof value.catalogueId !== 'string' ||
    value.catalogueId.length === 0 ||
    !isRepoRelativePath(value.catalogueSource) ||
    !isRepoRelativePath(value.audioAuthoritySource) ||
    !isRepoRelativePath(value.audioSourceRoot) ||
    !isRepoRelativePath(value.audioEvidenceSource) ||
    (value.runtimeManifestTarget !== null &&
      !isRepoRelativePath(value.runtimeManifestTarget))
  ) {
    fail('identity or source paths drifted');
  }
  return value;
}

// 'ks2-core:starter' names the Starter lane; the suffix is the reviewed label
// carried into evidence messages, so both existing lanes keep their wording.
function labelFor(catalogueId) {
  const suffix = catalogueId.slice(catalogueId.indexOf(':') + 1);
  return suffix.charAt(0).toUpperCase() + suffix.slice(1);
}

export async function loadPackAudioAuthority(relativePath) {
  const document = validateDocument(
    await readJsonDocument(
      resolveRepoPath(relativePath, 'pack audio authority'),
      'pack audio authority',
    ),
  );
  const authority = loadAudioAuthoringAuthority(
    await readJsonDocument(
      resolveRepoPath(document.audioAuthoritySource, 'audio authority'),
      'audio authority',
    ),
  );
  if (authority.catalogueId !== document.catalogueId) {
    fail('names an audio authority for a different catalogue');
  }
  const catalogue = await readJsonDocument(
    resolveRepoPath(document.catalogueSource, 'catalogue source'),
    'catalogue source',
  );
  const label = labelFor(document.catalogueId);
  // A pack whose sentence source declares no in-repository assetRoot is
  // authored from an external corpus, so creation must be given --source.
  const requiresExternalSource =
    !Object.hasOwn(authority.sources.sentence, 'assetRoot');
  const workspaceRoot = resolve(
    ROOT,
    '.native-build/packs',
    document.catalogueId.replace(':', '-'),
  );
  return Object.freeze({
    ...createAudioEvidenceContract(authority, label),
    label,
    authority,
    catalogue,
    catalogueId: document.catalogueId,
    requiresExternalSource,
    audioSourceRoot: resolveRepoPath(document.audioSourceRoot, 'audio source root'),
    audioEvidenceSource: resolveRepoPath(
      document.audioEvidenceSource,
      'audio evidence source',
    ),
    runtimeManifestTarget: document.runtimeManifestTarget === null
      ? null
      : resolveRepoPath(document.runtimeManifestTarget, 'runtime manifest target'),
    workspaceRoot,
    observationTarget: resolve(workspaceRoot, 'last-audio-observation.json'),
  });
}
