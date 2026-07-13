import {
  STORE_METHODS,
  assertClosedArray,
  assertClosedRecord,
  assertExactPort,
  assertPromise,
  cloneFrozenArray,
  fail,
  validateFinishRequest,
  validateFinishResult,
  validateObservation,
  validateProduct,
  validateProductIdsRequest,
  validateProductRequest,
} from './store-port.js';

const COMMERCE_METHODS = Object.freeze([
  'queryProducts',
  'purchase',
  'queryTransactions',
  'restore',
  'finishTransaction',
  'addListener',
]);

function safeNativeError() {
  const error = new Error('The native store operation failed.');
  Object.defineProperties(error, {
    name: { value: 'StorePortError' },
    code: { value: 'STORE_NATIVE_FAILURE', enumerable: true },
  });
  return error;
}

async function invokeNative(Commerce, method, args, label) {
  let result;
  try {
    result = Commerce[method](...args);
  } catch {
    throw safeNativeError();
  }
  assertPromise(result, label);
  try {
    return await result;
  } catch {
    throw safeNativeError();
  }
}

function validateCollection(value, key, itemValidator, label) {
  assertClosedRecord(value, [key], label);
  const items = assertClosedArray(value[key], `${label} ${key}`, { max: 64 });
  return cloneFrozenArray(items, itemValidator);
}

function crossCheckProducts(values, requestedProductIds, label, rejectDuplicates = false) {
  const requested = new Set(requestedProductIds);
  const seen = new Set();
  for (const value of values) {
    if (!requested.has(value.productId) || (rejectDuplicates && seen.has(value.productId))) {
      fail(label, 'contains an unrequested or duplicate product');
    }
    seen.add(value.productId);
  }
  return values;
}

function validateListenerHandle(value) {
  assertClosedRecord(value, ['remove'], 'Native transaction listener handle');
  if (typeof value.remove !== 'function') {
    fail('Native transaction listener handle', 'remove must be a function');
  }
  return value;
}

export function createCapacitorStore(options) {
  assertClosedRecord(options, ['Commerce'], 'Capacitor store options');
  const Commerce = assertExactPort(options.Commerce, COMMERCE_METHODS, 'Commerce plugin');

  const port = {
    async queryProducts(request) {
      const input = validateProductIdsRequest(request);
      const result = await invokeNative(
        Commerce,
        'queryProducts',
        [input],
        'Commerce.queryProducts',
      );
      return crossCheckProducts(
        validateCollection(result, 'products', validateProduct, 'Native product result'),
        input.productIds,
        'Native product result',
        true,
      );
    },

    async purchase(request) {
      const input = validateProductRequest(request);
      const observation = validateObservation(
        await invokeNative(Commerce, 'purchase', [input], 'Commerce.purchase'),
      );
      if (observation.productId !== input.productId) {
        fail('Native purchase result', 'does not match the requested product');
      }
      return observation;
    },

    async queryTransactions(request) {
      const input = validateProductIdsRequest(request);
      const result = await invokeNative(
        Commerce,
        'queryTransactions',
        [input],
        'Commerce.queryTransactions',
      );
      return crossCheckProducts(
        validateCollection(
          result,
          'transactions',
          validateObservation,
          'Native transaction result',
        ),
        input.productIds,
        'Native transaction result',
      );
    },

    async restore(request) {
      const input = validateProductIdsRequest(request);
      const result = await invokeNative(Commerce, 'restore', [input], 'Commerce.restore');
      return crossCheckProducts(
        validateCollection(
          result,
          'transactions',
          validateObservation,
          'Native restore result',
        ),
        input.productIds,
        'Native restore result',
      );
    },

    async finishTransaction(request) {
      const input = validateFinishRequest(request);
      return validateFinishResult(
        await invokeNative(
          Commerce,
          'finishTransaction',
          [input],
          'Commerce.finishTransaction',
        ),
      );
    },

    async subscribeTransactionUpdates(listener) {
      if (typeof listener !== 'function') {
        fail('Store transaction update listener', 'must be a function');
      }
      let active = true;
      const nativeListener = (value) => {
        if (!active) return undefined;
        return listener(validateObservation(value));
      };
      const handle = validateListenerHandle(
        await invokeNative(
          Commerce,
          'addListener',
          ['transactionUpdated', nativeListener],
          'Commerce.addListener',
        ),
      );
      let removed = false;
      return Object.freeze({
        async remove() {
          if (removed) return;
          removed = true;
          active = false;
          let result;
          try {
            result = handle.remove();
          } catch {
            throw safeNativeError();
          }
          assertPromise(result, 'Commerce listener remove');
          try {
            await result;
          } catch {
            throw safeNativeError();
          }
        },
      });
    },
  };

  assertExactPort(port, STORE_METHODS, 'StorePort');
  return Object.freeze(port);
}
