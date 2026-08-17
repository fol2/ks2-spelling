import { assertPackAuthority, findPackAuthority } from './pack-registry.js';

const APP_VERSION = '0.3.0-b3';
const SCHEMA_VERSION = 2;
const CAPABILITY = /^[A-Za-z0-9_-]{43}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const MANIFEST_FILE_KEYS = Object.freeze(['bytes', 'path', 'sha256']);

// The frozen B3 proof pack predates the pack builder, so its per-file authority
// is pinned here as defence in depth. Registry-built packs carry their file
// authority in the signed manifest alone.
const B3_FILES = Object.freeze([
  Object.freeze({
    bytes: 840,
    path: 'audio/proof-word.m4a',
    sha256: 'ef93d2c71f8490c7dd1b93929d8cba78b82c7c22c7c5da210e402be0f6b3f82f',
  }),
  Object.freeze({
    bytes: 242,
    path: 'catalogue.json',
    sha256: 'ee99faa101efe4e18e6e864f4b9265eabc8f0106dd72465c7c4fc3c1b36feb3e',
  }),
]);

function accessError(code) {
  return Object.assign(new Error(code), { code });
}

function equalRecord(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
       Object.getPrototypeOf(value) !== null)) return false;
  const expectedKeys = Object.keys(expected);
  const actualKeys = Reflect.ownKeys(value);
  if (actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))) return false;
  return Object.entries(expected).every(([key, expectedValue]) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') &&
      descriptor.value === expectedValue;
  });
}

function closedFileRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
       Object.getPrototypeOf(value) !== null)) return null;
  const actualKeys = Reflect.ownKeys(value);
  if (actualKeys.length !== MANIFEST_FILE_KEYS.length ||
      actualKeys.some((key) => typeof key !== 'string' || !MANIFEST_FILE_KEYS.includes(key)) ||
      MANIFEST_FILE_KEYS.some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value');
      })) return null;
  return value;
}

function compareVersions(left, right) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([a-z0-9.-]+))?$/.exec(value ?? '');
    if (!match) throw accessError('DOWNLOAD_APP_VERSION_INVALID');
    return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? null];
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  if (a[3] === b[3]) return 0;
  if (a[3] === null) return 1;
  if (b[3] === null) return -1;
  return a[3].localeCompare(b[3]);
}

function validManifestFiles(files, authority) {
  const paths = new Set();
  for (const file of files) {
    const record = closedFileRecord(file);
    if (!record ||
        !Number.isSafeInteger(record.bytes) || record.bytes < 0 ||
        typeof record.sha256 !== 'string' || !SHA256_HEX.test(record.sha256) ||
        typeof record.path !== 'string' || record.path.length === 0 ||
        record.path.length > 256 ||
        !/^[a-z0-9][a-z0-9/._-]*$/u.test(record.path) ||
        record.path.split('/').some((segment) =>
          segment === '' || segment === '.' || segment === '..') ||
        !authority.allowedExtensions.some((extension) => record.path.endsWith(extension)) ||
        paths.has(record.path)) {
      return false;
    }
    paths.add(record.path);
  }
  return true;
}

function makeContract(authority, pinnedFiles = null, gatewayOrigin = null) {
  if (!gatewayOrigin) {
    gatewayOrigin = ['https:', '', 'b3-gateway.eugnel.uk'].join('/');
  }
  function requireManifest(manifest, currentAppVersion, currentSchemaVersion) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw accessError('DOWNLOAD_MANIFEST_INVALID');
    }
    const manifestKeys = [
      'allowedExtensions', 'archive', 'ceilings', 'files', 'packId',
      'requiredEntitlementId', 'schemaVersion', 'version',
    ];
    const allowedManifestKeys = new Set([
      ...manifestKeys, 'minimumAppVersion', 'minimumSchemaVersion',
    ]);
    const actualManifestKeys = Reflect.ownKeys(manifest);
    if (
      (Object.getPrototypeOf(manifest) !== Object.prototype &&
       Object.getPrototypeOf(manifest) !== null) ||
      actualManifestKeys.length < manifestKeys.length || actualManifestKeys.length > manifestKeys.length + 2 ||
      actualManifestKeys.some((key) => typeof key !== 'string' || !allowedManifestKeys.has(key)) ||
      actualManifestKeys.some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(manifest, key);
        return !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value');
      }) ||
      manifest.packId !== authority.packId || manifest.version !== authority.version ||
      manifest.schemaVersion !== 1 ||
      manifest.requiredEntitlementId !== authority.requiredEntitlementId ||
      !equalRecord(manifest.archive, {
        bytes: authority.archiveBytes,
        name: authority.archiveName,
        sha256: authority.archiveSha256,
      }) ||
      !equalRecord(manifest.ceilings, authority.ceilings) ||
      !Array.isArray(manifest.allowedExtensions) ||
      manifest.allowedExtensions.length !== authority.allowedExtensions.length ||
      manifest.allowedExtensions.some(
        (extension, index) => extension !== authority.allowedExtensions[index],
      ) ||
      !Array.isArray(manifest.files) ||
      (pinnedFiles
        ? manifest.files.length !== pinnedFiles.length ||
          manifest.files.some((file, index) => !equalRecord(file, pinnedFiles[index]))
        : manifest.files.length === 0 ||
          manifest.files.length > authority.ceilings.fileCount ||
          !validManifestFiles(manifest.files, authority))
    ) {
      throw accessError('DOWNLOAD_MANIFEST_AUTHORITY_MISMATCH');
    }
    if (currentAppVersion !== APP_VERSION || currentSchemaVersion !== SCHEMA_VERSION) {
      throw accessError('DOWNLOAD_RUNTIME_AUTHORITY_MISMATCH');
    }
    // Pack manifests predating the generic minima fields may omit them. If an
    // injected verifier supplies them they must equal the compatibility baseline.
    if (
      (Object.hasOwn(manifest, 'minimumAppVersion') &&
        (manifest.minimumAppVersion !== APP_VERSION ||
         compareVersions(currentAppVersion, manifest.minimumAppVersion) < 0)) ||
      (Object.hasOwn(manifest, 'minimumSchemaVersion') &&
        (manifest.minimumSchemaVersion !== SCHEMA_VERSION ||
         currentSchemaVersion < manifest.minimumSchemaVersion))
    ) {
      throw accessError('DOWNLOAD_RUNTIME_MINIMUM_NOT_MET');
    }
    const extractedBytes = manifest.files.reduce((total, file) => total + file.bytes, 0);
    if (!Number.isSafeInteger(extractedBytes) ||
        extractedBytes > authority.ceilings.extractedBytes) {
      throw accessError('DOWNLOAD_MANIFEST_CEILING_MISMATCH');
    }
    return extractedBytes;
  }

  function requireGatewayAuthority(authorisation, envelopeSha256) {
    const manifestObject = authorisation?.objects?.[0];
    const archiveObject = authorisation?.objects?.[1];
    const capability = authorisation?.archiveCapability;
    if (
      authorisation?.state !== 'active' ||
      authorisation.entitlementId !== authority.requiredEntitlementId ||
      authorisation.packId !== authority.packId ||
      authorisation.version !== authority.version ||
      authorisation.signedEnvelopeSha256 !== authority.manifestSha256 ||
      envelopeSha256 !== authority.manifestSha256 ||
      !Array.isArray(authorisation.objects) || authorisation.objects.length !== 2 ||
      !equalRecord(manifestObject, {
        objectKind: 'manifest', sha256: authority.manifestSha256,
        size: authority.manifestBytes, etag: authority.manifestEtag,
      }) ||
      !equalRecord(archiveObject, {
        objectKind: 'archive', sha256: authority.archiveSha256,
        size: authority.archiveBytes, etag: authority.archiveEtag,
      }) ||
      !capability || capability.packId !== authority.packId ||
      capability.version !== authority.version ||
      capability.archiveName !== authority.archiveName ||
      capability.sha256 !== authority.archiveSha256 ||
      capability.compressedBytes !== authority.archiveBytes ||
      capability.etag !== authority.archiveEtag
    ) {
      throw accessError('DOWNLOAD_GATEWAY_AUTHORITY_MISMATCH');
    }
    return capability;
  }

  function assertSignedDownloadAccess({ capabilityUrl, nowUnixSeconds }) {
    if (typeof capabilityUrl !== 'string' || !Number.isSafeInteger(nowUnixSeconds)) {
      throw accessError('DOWNLOAD_CAPABILITY_INVALID');
    }
    let parsed;
    try {
      parsed = new URL(capabilityUrl);
    } catch {
      throw accessError('DOWNLOAD_CAPABILITY_INVALID');
    }
    const entries = [...parsed.searchParams.entries()];
    const expiresText = entries[0]?.[1] ?? '';
    const expires = Number(expiresText);
    const canonicalPath =
      `/v1/packs/${authority.packId}/${authority.version}/${authority.archiveName}`;
    if (
      parsed.protocol !== 'https:' || parsed.origin !== gatewayOrigin ||
      parsed.username || parsed.password || parsed.port || parsed.hash ||
      parsed.pathname !== canonicalPath || entries.length !== 2 ||
      entries[0]?.[0] !== 'expires' || !/^[1-9][0-9]*$/.test(expiresText) ||
      !Number.isSafeInteger(expires) || expires <= nowUnixSeconds || expires > nowUnixSeconds + 600 ||
      entries[1]?.[0] !== 'cap' || !CAPABILITY.test(entries[1]?.[1] ?? '') ||
      parsed.href !== capabilityUrl ||
      parsed.search !== `?expires=${expiresText}&cap=${entries[1]?.[1]}`
    ) {
      throw accessError('DOWNLOAD_CAPABILITY_INVALID');
    }
    return Object.freeze({ capabilityUrl, expiresAtUnixSeconds: expires });
  }

  function assertSubmittedDownloadEntitlement({
    activeEntitlement,
    submittedSealedRefreshHandle,
  }) {
    if (
      !activeEntitlement ||
      activeEntitlement.entitlementId !== authority.requiredEntitlementId ||
      activeEntitlement.state !== 'active' ||
      typeof submittedSealedRefreshHandle !== 'string' ||
      submittedSealedRefreshHandle.length === 0 ||
      activeEntitlement.sealedRefreshHandle !== submittedSealedRefreshHandle
    ) {
      throw accessError('DOWNLOAD_ENTITLEMENT_INACTIVE');
    }
    return Object.freeze({
      entitlementId: authority.requiredEntitlementId,
      sealedRefreshHandle: submittedSealedRefreshHandle,
    });
  }

  function createVerifiedDownloadAuthority({
    authorisation,
    verifiedManifest,
    envelopeSha256,
    activeEntitlement,
    submittedSealedRefreshHandle,
    currentAppVersion,
    currentSchemaVersion,
    nowUnixSeconds,
  }) {
    const extractedBytes = requireManifest(
      verifiedManifest?.manifest,
      currentAppVersion,
      currentSchemaVersion,
    );
    assertSubmittedDownloadEntitlement({
      activeEntitlement,
      submittedSealedRefreshHandle,
    });
    if (
      typeof authorisation?.sealedRefreshHandle !== 'string' ||
      authorisation.sealedRefreshHandle.length === 0 ||
      !Number.isSafeInteger(authorisation.refreshHandleVersion) ||
      authorisation.refreshHandleVersion < 1
    ) {
      throw accessError('DOWNLOAD_GATEWAY_AUTHORITY_MISMATCH');
    }
    const capability = requireGatewayAuthority(authorisation, envelopeSha256);
    const access = assertSignedDownloadAccess({
      capabilityUrl: capability.capabilityUrl,
      nowUnixSeconds,
    });
    const downloadAuthority = {
      packId: authority.packId,
      version: authority.version,
      jobId: `${authority.packId}.${authority.version}`,
      manifestSha256: authority.manifestSha256,
      archiveName: authority.archiveName,
      archiveSha256: authority.archiveSha256,
      compressedBytes: authority.archiveBytes,
      extractedBytes,
      fileCount: verifiedManifest.manifest.files.length,
      ceilings: authority.ceilings,
      etag: authority.archiveEtag,
      capabilityUrl: access.capabilityUrl,
      signedManifestEnvelopeBase64: authorisation.signedManifestEnvelopeBase64,
    };
    Object.freeze(downloadAuthority.ceilings);
    return Object.freeze(downloadAuthority);
  }

  return Object.freeze({
    assertSignedDownloadAccess,
    assertSubmittedDownloadEntitlement,
    createVerifiedDownloadAuthority,
  });
}

export function createSignedDownloadAccessContract(packAuthority, gatewayOrigin = null) {
  const authority = assertPackAuthority(packAuthority);
  // The frozen B3 proof pack keeps its compiled per-file pin no matter who
  // constructs its contract; no caller can widen it.
  return makeContract(authority, authority.packId === 'b3-sandbox-proof' ? B3_FILES : null, gatewayOrigin);
}

const B3_CONTRACT = createSignedDownloadAccessContract(
  findPackAuthority('b3-sandbox-proof'),
  ['https:', '', 'b3-gateway.eugnel.uk'].join('/')
);

export const assertSignedDownloadAccess = B3_CONTRACT.assertSignedDownloadAccess;
export const assertSubmittedDownloadEntitlement = B3_CONTRACT.assertSubmittedDownloadEntitlement;
export const createVerifiedDownloadAuthority = B3_CONTRACT.createVerifiedDownloadAuthority;

export const B3_DOWNLOAD_CHUNK_BYTES = 1_048_576;
