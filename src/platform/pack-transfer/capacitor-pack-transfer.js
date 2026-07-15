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
} from './pack-transfer-port.js';
import {
  assertClosedRecord,
  assertExactPort,
  assertPromise,
  fail,
} from '../commerce/store-port.js';

const SAFE_DOWNLOAD_ERROR_CODES = new Set([
  'PACK_CAPABILITY_EXPIRED',
  'PACK_RANGE_NOT_SATISFIABLE',
]);

function safeNativeError(code) {
  const safeCode = SAFE_DOWNLOAD_ERROR_CODES.has(code)
    ? code
    : 'PACK_TRANSFER_NATIVE_FAILURE';
  const error = new Error('The native pack-transfer operation failed.');
  Object.defineProperties(error, {
    name: { value: 'PackTransferPortError' },
    code: { value: safeCode, enumerable: true },
  });
  return error;
}

function createNativeFacade(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('PackTransfer plugin', 'must be an object');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 0) assertExactPort(value, PACK_TRANSFER_METHODS, 'PackTransfer plugin');
  const methods = {};
  for (const name of PACK_TRANSFER_METHODS) {
    let method;
    try {
      method = value[name];
    } catch {
      fail('PackTransfer plugin', `${name} must be available`);
    }
    if (typeof method !== 'function') fail('PackTransfer plugin', `${name} must be a function`);
    methods[name] = (...arguments_) => Reflect.apply(method, value, arguments_);
  }
  return Object.freeze(methods);
}

async function invoke(plugin, method, request) {
  let result;
  try {
    result = request === undefined ? plugin[method]() : plugin[method](request);
  } catch (error) {
    throw safeNativeError(method === 'downloadRange' ? error?.code : undefined);
  }
  assertPromise(result, `PackTransfer.${method}`);
  try {
    return await result;
  } catch (error) {
    throw safeNativeError(method === 'downloadRange' ? error?.code : undefined);
  }
}

export function createCapacitorPackTransfer(options) {
  assertClosedRecord(options, ['PackTransfer'], 'Capacitor pack-transfer options');
  const plugin = createNativeFacade(options.PackTransfer);
  return assertPackTransferPort(Object.freeze({
    async getFreeBytes() {
      const result = await invoke(plugin, 'getFreeBytes');
      assertClosedRecord(result, ['freeBytes'], 'Native free-space result');
      return validateFreeBytes(result.freeBytes);
    },
    async downloadRange(request) {
      const input = validateDownloadRangeRequest(request);
      return validateDownloadRangeResult(await invoke(plugin, 'downloadRange', input));
    },
    async inspectAndExtract(request) {
      const input = validateInspectRequest(request);
      return validateInspectResult(await invoke(plugin, 'inspectAndExtract', input));
    },
    async sealAndInstall(request) {
      const input = validateSealRequest(request);
      return validateSealResult(await invoke(plugin, 'sealAndInstall', input));
    },
    async inventoryInstalledVersions() {
      const result = await invoke(plugin, 'inventoryInstalledVersions');
      assertClosedRecord(result, ['versions'], 'Native installed-pack inventory');
      return validateInventory(result.versions);
    },
    async removeOwnedTemporaryState(request) {
      const input = validateOwnedStateRequest(request);
      return validateRemovalResult(
        await invoke(plugin, 'removeOwnedTemporaryState', input),
      );
    },
  }));
}
