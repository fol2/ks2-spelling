const PACK_ID = 'b3-sandbox-proof';
const PACK_VERSION = '1.0.0-b3.1';
const ARCHIVE_NAME = 'b3-sandbox-proof.zip';
const ENTITLEMENT_ID = 'full-ks2';
const APP_VERSION = '0.3.0-b3';
const SCHEMA_VERSION = 2;
const GATEWAY_ORIGIN = ['https:', '', 'b3-gateway.eugnel.uk'].join('/');
const ARCHIVE_SHA256 = '4c2ca2eb4d4bb7ac3347b66e3483dcb6aa71b41958704733bfc471c970ce7664';
const ENVELOPE_SHA256 = '39b6a788a3686d7cbf1fd4791bce45623af21ef53c60eabc03d955395856218a';
const ARCHIVE_BYTES = 1_324;
const ENVELOPE_BYTES = 1_135;
const ARCHIVE_ETAG = '913d2b2485ca6cd31d467bd7228d7e75';
const ENVELOPE_ETAG = 'c76b2858b8345814279a1c92ae64e365';
const CEILINGS = Object.freeze({
  fileCount: 16,
  compressedBytes: 1_048_576,
  extractedBytes: 4_194_304,
});
const FILES = Object.freeze([
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
const CAPABILITY = /^[A-Za-z0-9_-]{43}$/;

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
    manifest.packId !== PACK_ID || manifest.version !== PACK_VERSION ||
    manifest.schemaVersion !== 1 ||
    manifest.requiredEntitlementId !== ENTITLEMENT_ID ||
    !equalRecord(manifest.archive, {
      bytes: ARCHIVE_BYTES,
      name: ARCHIVE_NAME,
      sha256: ARCHIVE_SHA256,
    }) ||
    !equalRecord(manifest.ceilings, CEILINGS) ||
    !Array.isArray(manifest.allowedExtensions) ||
    manifest.allowedExtensions.length !== 2 ||
    manifest.allowedExtensions[0] !== '.json' || manifest.allowedExtensions[1] !== '.m4a' ||
    !Array.isArray(manifest.files) || manifest.files.length !== FILES.length ||
    manifest.files.some((file, index) => !equalRecord(file, FILES[index]))
  ) {
    throw accessError('DOWNLOAD_MANIFEST_AUTHORITY_MISMATCH');
  }
  if (currentAppVersion !== APP_VERSION || currentSchemaVersion !== SCHEMA_VERSION) {
    throw accessError('DOWNLOAD_RUNTIME_AUTHORITY_MISMATCH');
  }
  // The frozen B3 proof manifest predates the generic pack minima fields. If an
  // injected verifier supplies them they must equal the B3 compatibility baseline.
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
  if (!Number.isSafeInteger(extractedBytes) || extractedBytes > CEILINGS.extractedBytes) {
    throw accessError('DOWNLOAD_MANIFEST_CEILING_MISMATCH');
  }
  return extractedBytes;
}

function requireGatewayAuthority(authorisation, envelopeSha256) {
  const manifestObject = authorisation?.objects?.[0];
  const archiveObject = authorisation?.objects?.[1];
  const capability = authorisation?.archiveCapability;
  if (
    authorisation?.state !== 'active' || authorisation.entitlementId !== ENTITLEMENT_ID ||
    authorisation.packId !== PACK_ID || authorisation.version !== PACK_VERSION ||
    authorisation.signedEnvelopeSha256 !== ENVELOPE_SHA256 ||
    envelopeSha256 !== ENVELOPE_SHA256 ||
    !Array.isArray(authorisation.objects) || authorisation.objects.length !== 2 ||
    !equalRecord(manifestObject, {
      objectKind: 'manifest', sha256: ENVELOPE_SHA256,
      size: ENVELOPE_BYTES, etag: ENVELOPE_ETAG,
    }) ||
    !equalRecord(archiveObject, {
      objectKind: 'archive', sha256: ARCHIVE_SHA256,
      size: ARCHIVE_BYTES, etag: ARCHIVE_ETAG,
    }) ||
    !capability || capability.packId !== PACK_ID || capability.version !== PACK_VERSION ||
    capability.archiveName !== ARCHIVE_NAME || capability.sha256 !== ARCHIVE_SHA256 ||
    capability.compressedBytes !== ARCHIVE_BYTES || capability.etag !== ARCHIVE_ETAG
  ) {
    throw accessError('DOWNLOAD_GATEWAY_AUTHORITY_MISMATCH');
  }
  return capability;
}

export function assertSignedDownloadAccess({ capabilityUrl, nowUnixSeconds }) {
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
  const canonicalPath = `/v1/packs/${PACK_ID}/${PACK_VERSION}/${ARCHIVE_NAME}`;
  if (
    parsed.protocol !== 'https:' || parsed.origin !== GATEWAY_ORIGIN ||
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

export function assertSubmittedDownloadEntitlement({
  activeEntitlement,
  submittedSealedRefreshHandle,
}) {
  if (
    !activeEntitlement || activeEntitlement.entitlementId !== ENTITLEMENT_ID ||
    activeEntitlement.state !== 'active' ||
    typeof submittedSealedRefreshHandle !== 'string' ||
    submittedSealedRefreshHandle.length === 0 ||
    activeEntitlement.sealedRefreshHandle !== submittedSealedRefreshHandle
  ) {
    throw accessError('DOWNLOAD_ENTITLEMENT_INACTIVE');
  }
  return Object.freeze({
    entitlementId: ENTITLEMENT_ID,
    sealedRefreshHandle: submittedSealedRefreshHandle,
  });
}

export function createVerifiedDownloadAuthority({
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
  const authority = {
    packId: PACK_ID,
    version: PACK_VERSION,
    jobId: `${PACK_ID}.${PACK_VERSION}`,
    manifestSha256: ENVELOPE_SHA256,
    archiveName: ARCHIVE_NAME,
    archiveSha256: ARCHIVE_SHA256,
    compressedBytes: ARCHIVE_BYTES,
    extractedBytes,
    fileCount: verifiedManifest.manifest.files.length,
    ceilings: CEILINGS,
    etag: ARCHIVE_ETAG,
    capabilityUrl: access.capabilityUrl,
    signedManifestEnvelopeBase64: authorisation.signedManifestEnvelopeBase64,
  };
  Object.freeze(authority.ceilings);
  return Object.freeze(authority);
}

export const B3_DOWNLOAD_CHUNK_BYTES = 1_048_576;
