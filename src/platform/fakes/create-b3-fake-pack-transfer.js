import {
  assertClosedArray,
  cloneScriptOutcome,
  fail,
} from '../commerce/store-port.js';
import {
  PACK_TRANSFER_METHODS,
  assertPackTransferPort,
  validateDownloadRangeRequest,
  validateDownloadRangeResult,
  validateFreeBytes,
  validateInspectRequest,
  validateInspectResult,
  validateInventory,
  validateOwnedStateRequest,
  validateRemovalResult,
  validateSealRequest,
  validateSealResult,
} from '../pack-transfer/pack-transfer-port.js';

const OPTION_KEYS = Object.freeze([
  'freeByteOutcomes',
  'downloadOutcomes',
  'inspectOutcomes',
  'sealOutcomes',
  'inventoryOutcomes',
  'removeOutcomes',
]);
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function readOptions(options) {
  if (options === undefined) return {};
  if (
    !options || typeof options !== 'object' || Array.isArray(options) ||
    Object.getPrototypeOf(options) !== Object.prototype
  ) {
    fail('B3 fake pack-transfer options', 'must be a closed plain record');
  }
  for (const key of Reflect.ownKeys(options)) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (
      typeof key !== 'string' || !OPTION_KEYS.includes(key) ||
      !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
    ) {
      fail('B3 fake pack-transfer options', 'contain an unknown or unsafe field');
    }
  }
  return options;
}

function queue(value, fallback, label) {
  return assertClosedArray(value ?? fallback, label, { max: 128 }).map((outcome) =>
    cloneScriptOutcome(outcome, label));
}

function take(values, label) {
  if (values.length === 0) {
    const error = new Error(`${label} script is exhausted.`);
    error.code = 'B3_FAKE_SCRIPT_EXHAUSTED';
    throw error;
  }
  const value = values.shift();
  if (value instanceof Error) throw value;
  return cloneScriptOutcome(value, `Fake ${label} outcome`);
}

export function createB3FakePackTransfer(rawOptions) {
  const options = readOptions(rawOptions);
  const freeBytes = queue(options.freeByteOutcomes, [64 * 1024 * 1024], 'Fake free-byte outcomes');
  const downloads = queue(options.downloadOutcomes, [{
    status: 206,
    startByte: 0,
    endByteExclusive: 16,
    totalBytes: 16,
    bytesWritten: 16,
    etag: 'archive-etag',
  }], 'Fake download outcomes');
  const inspections = queue(options.inspectOutcomes, [{
    archiveSha256: SHA_A,
    manifestSha256: SHA_B,
    extractedBytes: 32,
    fileCount: 2,
    stagingToken: 'staging/b3-sandbox-proof/1.0.0-b3.1',
  }], 'Fake inspection outcomes');
  const seals = queue(options.sealOutcomes, [{
    installedPathToken: 'installed/b3-sandbox-proof/1.0.0-b3.1',
    activationMarkerSha256: SHA_B,
  }], 'Fake seal outcomes');
  const inventories = queue(options.inventoryOutcomes, [[]], 'Fake inventory outcomes');
  const removals = queue(options.removeOutcomes, [{ removed: true }], 'Fake removal outcomes');
  const port = {
    async getFreeBytes() {
      if (arguments.length !== 0) fail('getFreeBytes', 'does not accept input');
      return validateFreeBytes(take(freeBytes, 'getFreeBytes'));
    },
    async downloadRange(request) {
      validateDownloadRangeRequest(request);
      return validateDownloadRangeResult(take(downloads, 'downloadRange'));
    },
    async inspectAndExtract(request) {
      validateInspectRequest(request);
      return validateInspectResult(take(inspections, 'inspectAndExtract'));
    },
    async sealAndInstall(request) {
      validateSealRequest(request);
      return validateSealResult(take(seals, 'sealAndInstall'));
    },
    async inventoryInstalledVersions() {
      if (arguments.length !== 0) {
        fail('inventoryInstalledVersions', 'does not accept input');
      }
      return validateInventory(take(inventories, 'inventoryInstalledVersions'));
    },
    async removeOwnedTemporaryState(request) {
      validateOwnedStateRequest(request);
      return validateRemovalResult(take(removals, 'removeOwnedTemporaryState'));
    },
  };
  assertPackTransferPort(port);
  if (Reflect.ownKeys(port).length !== PACK_TRANSFER_METHODS.length) {
    fail('PackTransferPort');
  }
  return Object.freeze(port);
}
