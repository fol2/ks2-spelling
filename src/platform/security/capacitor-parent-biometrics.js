const BIOMETRIC_TYPES = new Set([
  'face',
  'fingerprint',
  'biometric',
  'none',
]);

function biometricError(code = 'parent_biometrics_failed') {
  const error = new Error(code);
  error.code = code;
  return error;
}

function requireClosedRecord(value, keys, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new TypeError(`${label} is invalid biometric data.`);
  }
  return value;
}

function requirePromise(value) {
  if (!(value instanceof Promise)) {
    throw new TypeError('ParentAccess native methods must return a Promise.');
  }
  return value;
}

function nativeMethods(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('ParentAccess plugin must be an object.');
  }
  const allowed = new Set([
    'getBiometricAvailability',
    'authenticateBiometric',
  ]);
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== 0 &&
    (ownKeys.length !== allowed.size ||
      ownKeys.some((key) => !allowed.has(key)))
  ) {
    throw new TypeError('ParentAccess plugin exposes unsupported methods.');
  }
  const methods = {};
  for (const name of allowed) {
    let method;
    try {
      method = value[name];
    } catch {
      throw new TypeError(`ParentAccess.${name} must be available.`);
    }
    if (typeof method !== 'function') {
      throw new TypeError(`ParentAccess.${name} must be a function.`);
    }
    methods[name] = (request) =>
      Reflect.apply(method, value, [request]);
  }
  return Object.freeze(methods);
}

function availabilityResult(value) {
  const result = requireClosedRecord(
    value,
    ['available', 'type'],
    'Parent biometric availability',
  );
  if (
    typeof result.available !== 'boolean' ||
    !BIOMETRIC_TYPES.has(result.type) ||
    (result.available ? result.type === 'none' : result.type !== 'none')
  ) {
    throw new TypeError('Parent biometric availability is invalid.');
  }
  return Object.freeze({
    available: result.available,
    type: result.type,
  });
}

function authenticationRequest(value) {
  const request = requireClosedRecord(
    value,
    ['reason'],
    'Parent biometric request',
  );
  const bytes = typeof request.reason === 'string'
    ? new TextEncoder().encode(request.reason).length
    : 0;
  if (bytes < 1 || bytes > 120) {
    throw new TypeError('Parent biometric reason is invalid.');
  }
  return Object.freeze({ reason: request.reason });
}

export function createCapacitorParentBiometrics({ ParentAccess } = {}) {
  const methods = nativeMethods(ParentAccess);
  return Object.freeze({
    async getAvailability() {
      let result;
      try {
        result = await requirePromise(methods.getBiometricAvailability({}));
      } catch {
        throw biometricError('parent_biometrics_unavailable');
      }
      return availabilityResult(result);
    },
    authenticate(candidate) {
      const request = authenticationRequest(candidate);
      return (async () => {
        let result;
        try {
          result = await requirePromise(
            methods.authenticateBiometric(request),
          );
        } catch {
          throw biometricError('parent_biometrics_rejected');
        }
        const value = requireClosedRecord(
          result,
          ['authenticated'],
          'Parent biometric result',
        );
        if (value.authenticated !== true) {
          throw biometricError('parent_biometrics_rejected');
        }
        return Object.freeze({ authenticated: true });
      })();
    },
  });
}
