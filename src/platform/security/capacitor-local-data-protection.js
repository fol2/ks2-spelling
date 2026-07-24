const PLATFORM_PROTECTIONS = new Set([
  'ios-complete',
  'ios-simulator-protection-unobservable',
  'android-app-private',
]);

function dataProtectionError() {
  return Object.assign(
    new Error('Local data protection could not be verified.'),
    { code: 'local_data_protection_unavailable' },
  );
}

function exactRecord(value, keys, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new TypeError(`${label} is invalid local data protection data.`);
  }
  return value;
}

function nativeMethod(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('LocalDataProtection plugin must be an object.');
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 0 &&
    (keys.length !== 1 || keys[0] !== 'applyDatabasePolicy')
  ) {
    throw new TypeError('LocalDataProtection exposes unsupported methods.');
  }
  let method;
  try {
    method = value.applyDatabasePolicy;
  } catch {
    throw new TypeError(
      'LocalDataProtection.applyDatabasePolicy must be available.',
    );
  }
  if (typeof method !== 'function') {
    throw new TypeError(
      'LocalDataProtection.applyDatabasePolicy must be a function.',
    );
  }
  return (request) => Reflect.apply(method, value, [request]);
}

export function createCapacitorLocalDataProtection({
  LocalDataProtection,
} = {}) {
  const applyNative = nativeMethod(LocalDataProtection);
  return Object.freeze({
    async applyPolicy(candidate) {
      const value = exactRecord(
        candidate,
        ['databaseName'],
        'Local data protection request',
      );
      if (value.databaseName !== 'ks2-spelling') {
        throw new TypeError(
          'Local data protection database identity is invalid.',
        );
      }
      let pending;
      try {
        pending = applyNative(
          Object.freeze({ databaseName: 'ks2-spelling' }),
        );
      } catch {
        throw dataProtectionError();
      }
      if (!(pending instanceof Promise)) {
        throw new TypeError(
          'LocalDataProtection.applyDatabasePolicy must return a Promise.',
        );
      }
      let response;
      try {
        response = await pending;
      } catch {
        throw dataProtectionError();
      }
      const result = exactRecord(
        response,
        ['automaticBackupDisabled', 'platformProtection'],
        'Local data protection result',
      );
      if (
        result.automaticBackupDisabled !== true ||
        !PLATFORM_PROTECTIONS.has(result.platformProtection)
      ) {
        throw dataProtectionError();
      }
      return Object.freeze({
        automaticBackupDisabled: true,
        platformProtection: result.platformProtection,
      });
    },
  });
}
