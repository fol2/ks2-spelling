import {
  STORE_METHODS,
  assertClosedArray,
  assertExactPort,
  cloneClosedData,
  cloneFrozenArray,
  fail,
  validateFinishRequest,
  validateFinishResult,
  validateObservation,
  validateProduct,
  validateProductIdsRequest,
  validateProductRequest,
} from '../commerce/store-port.js';

const OPTION_KEYS = Object.freeze([
  'productOutcomes',
  'purchaseOutcomes',
  'transactionOutcomes',
  'restoreOutcomes',
  'finishOutcomes',
  'updateOutcomes',
]);

const PRODUCT = Object.freeze({
  productId: 'full_ks2',
  displayName: 'Full KS2',
  description: 'The complete statutory spelling catalogue.',
  displayPrice: '£4.99',
  currencyCode: 'GBP',
});
const CANCELLED = Object.freeze({
  store: 'google',
  environment: 'sandbox',
  productId: 'full_ks2',
  outcome: 'cancelled',
  transactionRef: 'fake-cancelled-transaction',
});

function readOptions(options) {
  if (options === undefined) return {};
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.getPrototypeOf(options) !== Object.prototype
  ) {
    fail('B3 fake store options', 'must be a closed plain record');
  }
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== 'string' || !OPTION_KEYS.includes(key)) {
      fail('B3 fake store options', 'contain an unknown field');
    }
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail('B3 fake store options', 'must contain data fields only');
    }
  }
  return options;
}

function queue(value, fallback, label) {
  const source = value ?? fallback;
  return [...assertClosedArray(source, label, { max: 128 })];
}

function take(values, label) {
  if (values.length === 0) {
    const error = new Error(`${label} script is exhausted.`);
    error.code = 'B3_FAKE_SCRIPT_EXHAUSTED';
    throw error;
  }
  const value = values.shift();
  if (value instanceof Error) throw value;
  return cloneClosedData(value, `Fake ${label} outcome`);
}

function crossCheck(values, requested, label, rejectDuplicates = false) {
  const allowed = new Set(requested);
  const seen = new Set();
  for (const value of values) {
    if (!allowed.has(value.productId) || (rejectDuplicates && seen.has(value.productId))) {
      fail(label, 'contains an unrequested or duplicate product');
    }
    seen.add(value.productId);
  }
  return values;
}

export function createB3FakeStore(rawOptions) {
  const options = readOptions(rawOptions);
  const products = queue(options.productOutcomes, [[PRODUCT]], 'Fake product outcomes');
  const purchases = queue(options.purchaseOutcomes, [CANCELLED], 'Fake purchase outcomes');
  const transactions = queue(options.transactionOutcomes, [[]], 'Fake transaction outcomes');
  const restores = queue(options.restoreOutcomes, [[]], 'Fake restore outcomes');
  const finishes = queue(
    options.finishOutcomes,
    [{ completion: 'finished' }],
    'Fake finish outcomes',
  );
  const updates = queue(options.updateOutcomes, [], 'Fake update outcomes');

  const port = {
    async queryProducts(request) {
      const input = validateProductIdsRequest(request);
      return crossCheck(
        cloneFrozenArray(take(products, 'queryProducts'), validateProduct),
        input.productIds,
        'Fake product result',
        true,
      );
    },
    async purchase(request) {
      const input = validateProductRequest(request);
      const result = validateObservation(take(purchases, 'purchase'));
      if (result.productId !== input.productId) fail('Fake purchase product identity');
      return result;
    },
    async queryTransactions(request) {
      const input = validateProductIdsRequest(request);
      return crossCheck(
        cloneFrozenArray(take(transactions, 'queryTransactions'), validateObservation),
        input.productIds,
        'Fake transaction result',
      );
    },
    async restore(request) {
      const input = validateProductIdsRequest(request);
      return crossCheck(
        cloneFrozenArray(take(restores, 'restore'), validateObservation),
        input.productIds,
        'Fake restore result',
      );
    },
    async finishTransaction(request) {
      validateFinishRequest(request);
      return validateFinishResult(take(finishes, 'finishTransaction'));
    },
    async subscribeTransactionUpdates(listener) {
      if (typeof listener !== 'function') fail('Fake transaction listener');
      let active = true;
      const scripted = updates.splice(0).map((value) =>
        cloneClosedData(value, 'Fake transaction update'));
      queueMicrotask(() => {
        for (const value of scripted) {
          if (!active) break;
          listener(validateObservation(value));
        }
      });
      return Object.freeze({
        async remove() {
          active = false;
        },
      });
    },
  };
  assertExactPort(port, STORE_METHODS, 'StorePort');
  return Object.freeze(port);
}
