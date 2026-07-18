import {
  assertClosedArray,
  assertClosedRecord,
  assertExactPort,
  assertSafeInteger,
  assertString,
  cloneFrozenArray,
  fail,
} from '../commerce/store-port.js';

export const PACK_TRANSFER_METHODS = Object.freeze([
  'getFreeBytes',
  'downloadRange',
  'inspectAndExtract',
  'sealAndInstall',
  'inventoryInstalledVersions',
  'removeOwnedTemporaryState',
]);

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ARCHIVE = /^[a-z0-9][a-z0-9._-]{0,119}\.zip$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const LOGICAL_TOKEN = /^[a-z0-9][a-z0-9/._-]{0,255}$/;
const PACK_GATEWAY_ORIGIN = ['https:', '', 'b3-gateway.eugnel.uk'].join('/');

function validateLogicalToken(value, label) {
  const token = assertString(value, label, { max: 256, pattern: LOGICAL_TOKEN });
  const segments = token.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail(label, 'must contain only owned logical path segments');
  }
  return token;
}

function safeIdentity(value, keys, label) {
  assertClosedRecord(value, keys, label);
  return {
    packId: assertString(value.packId, 'Pack identifier', {
      max: 64,
      pattern: SAFE_ID,
    }),
    version: assertString(value.version, 'Pack version', {
      max: 64,
      pattern: SAFE_ID,
    }),
  };
}

export function validateDownloadRangeRequest(value) {
  const identity = safeIdentity(
    value,
    [
      'capabilityUrl',
      'packId',
      'version',
      'archiveName',
      'startByte',
      'endByteExclusive',
      'truncate',
    ],
    'Pack range download request',
  );
  const archiveName = assertString(value.archiveName, 'Archive name', {
    max: 128,
    pattern: ARCHIVE,
  });
  const startByte = assertSafeInteger(value.startByte, 'Range start byte');
  const endByteExclusive = assertSafeInteger(value.endByteExclusive, 'Range end byte', {
    min: 1,
  });
  if (endByteExclusive <= startByte) fail('Pack byte range');
  if (typeof value.truncate !== 'boolean') fail('Pack truncate flag');
  const capabilityUrl = assertString(value.capabilityUrl, 'Pack capability URL', {
    max: 8_192,
  });
  let parsed;
  try {
    parsed = new URL(capabilityUrl);
  } catch {
    fail('Pack capability URL');
  }
  const expectedPath = `/v1/packs/${identity.packId}/${identity.version}/${archiveName}`;
  const entries = [...parsed.searchParams.entries()];
  const expires = Number(entries[0]?.[1]);
  if (
    parsed.protocol !== 'https:' ||
    parsed.origin !== PACK_GATEWAY_ORIGIN ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.hash ||
    parsed.pathname !== expectedPath ||
    entries.length !== 2 ||
    entries[0]?.[0] !== 'expires' ||
    !/^[1-9][0-9]*$/.test(entries[0]?.[1] ?? '') ||
    !Number.isSafeInteger(expires) ||
    entries[1]?.[0] !== 'cap' ||
    !/^[A-Za-z0-9_-]{43}$/.test(entries[1]?.[1] ?? '') ||
    parsed.href !== capabilityUrl ||
    parsed.search !== `?expires=${entries[0]?.[1]}&cap=${entries[1]?.[1]}`
  ) {
    fail('Pack capability URL');
  }
  return Object.freeze({
    capabilityUrl,
    ...identity,
    archiveName,
    startByte,
    endByteExclusive,
    truncate: value.truncate,
  });
}

export function validateInspectRequest(value) {
  const identity = safeIdentity(
    value,
    ['packId', 'version', 'archiveName', 'signedManifestEnvelopeBase64'],
    'Pack inspection request',
  );
  return Object.freeze({
    ...identity,
    archiveName: assertString(value.archiveName, 'Archive name', {
      max: 128,
      pattern: ARCHIVE,
    }),
    signedManifestEnvelopeBase64: assertString(
      value.signedManifestEnvelopeBase64,
      'Signed manifest envelope',
      { max: 1_048_576, pattern: BASE64 },
    ),
  });
}

export function validateSealRequest(value) {
  const identity = safeIdentity(
    value,
    ['packId', 'version', 'manifestSha256'],
    'Pack installation request',
  );
  return Object.freeze({
    ...identity,
    manifestSha256: assertString(value.manifestSha256, 'Manifest SHA-256', {
      min: 64,
      max: 64,
      pattern: SHA256,
    }),
  });
}

export function validateOwnedStateRequest(value) {
  const identity = safeIdentity(
    value,
    ['packId', 'version'],
    'Owned pack state request',
  );
  return Object.freeze(identity);
}

export function validateFreeBytes(value) {
  return assertSafeInteger(value, 'Available filesystem bytes');
}

export function validateDownloadRangeResult(value) {
  assertClosedRecord(
    value,
    ['status', 'startByte', 'endByteExclusive', 'totalBytes', 'bytesWritten', 'etag'],
    'Pack range result',
  );
  if (value.status !== 200 && value.status !== 206) fail('Pack range status');
  const startByte = assertSafeInteger(value.startByte, 'Downloaded range start');
  const endByteExclusive = assertSafeInteger(value.endByteExclusive, 'Downloaded range end', {
    min: 1,
  });
  const totalBytes = assertSafeInteger(value.totalBytes, 'Archive total bytes', { min: 1 });
  const bytesWritten = assertSafeInteger(value.bytesWritten, 'Downloaded byte count', { min: 1 });
  if (
    endByteExclusive <= startByte ||
    endByteExclusive > totalBytes ||
    bytesWritten !== endByteExclusive - startByte ||
    (value.status === 200 && startByte !== 0)
  ) {
    fail('Pack range result');
  }
  return Object.freeze({
    status: value.status,
    startByte,
    endByteExclusive,
    totalBytes,
    bytesWritten,
    etag: assertString(value.etag, 'Archive ETag', { max: 256 }),
  });
}

export function validateInspectResult(value) {
  assertClosedRecord(
    value,
    ['archiveSha256', 'manifestSha256', 'extractedBytes', 'fileCount', 'stagingToken'],
    'Pack inspection result',
  );
  return Object.freeze({
    archiveSha256: assertString(value.archiveSha256, 'Archive SHA-256', {
      min: 64, max: 64, pattern: SHA256,
    }),
    manifestSha256: assertString(value.manifestSha256, 'Manifest SHA-256', {
      min: 64, max: 64, pattern: SHA256,
    }),
    extractedBytes: assertSafeInteger(value.extractedBytes, 'Extracted bytes', { min: 1 }),
    fileCount: assertSafeInteger(value.fileCount, 'Extracted file count', { min: 1 }),
    stagingToken: validateLogicalToken(value.stagingToken, 'Pack staging token'),
  });
}

export function validateSealResult(value) {
  assertClosedRecord(
    value,
    ['installedPathToken', 'activationMarkerSha256'],
    'Pack installation result',
  );
  return Object.freeze({
    installedPathToken: validateLogicalToken(value.installedPathToken, 'Installed path token'),
    activationMarkerSha256: assertString(
      value.activationMarkerSha256,
      'Activation marker SHA-256',
      { min: 64, max: 64, pattern: SHA256 },
    ),
  });
}

function validateInventoryRecord(value) {
  assertClosedRecord(
    value,
    ['packId', 'version', 'installedPathToken', 'manifestSha256', 'activationMarkerSha256'],
    'Installed pack inventory record',
  );
  const identity = safeIdentity(value, Reflect.ownKeys(value), 'Installed pack inventory record');
  return Object.freeze({
    ...identity,
    installedPathToken: validateLogicalToken(value.installedPathToken, 'Installed path token'),
    manifestSha256: assertString(value.manifestSha256, 'Manifest SHA-256', {
      min: 64, max: 64, pattern: SHA256,
    }),
    activationMarkerSha256: assertString(
      value.activationMarkerSha256,
      'Activation marker SHA-256',
      { min: 64, max: 64, pattern: SHA256 },
    ),
  });
}

export function validateInventory(value) {
  return cloneFrozenArray(
    assertClosedArray(value, 'Installed pack inventory', { max: 64 }),
    validateInventoryRecord,
  );
}

export function validateRemovalResult(value) {
  assertClosedRecord(value, ['removed'], 'Owned state removal result');
  if (typeof value.removed !== 'boolean') fail('Owned state removal result');
  return Object.freeze({ removed: value.removed });
}

export function assertPackTransferPort(value) {
  return assertExactPort(value, PACK_TRANSFER_METHODS, 'PackTransferPort');
}
