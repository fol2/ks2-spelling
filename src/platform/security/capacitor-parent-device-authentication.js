function deviceAuthenticationError(
  code = 'parent_device_authentication_failed',
) {
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
    throw new TypeError(`${label} is invalid device authentication data.`);
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
  const required = new Set([
    'getDeviceOwnerAuthenticationAvailability',
    'authenticateDeviceOwner',
  ]);
  // The device-owner and biometric ports intentionally share one native
  // ParentAccess plugin. Capacitor exposes a keyless proxy; closed test doubles
  // may expose the complete four-method surface, but no unrelated operation.
  const supported = new Set([
    ...required,
    'getBiometricAvailability',
    'authenticateBiometric',
  ]);
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== 0 &&
    (required.size > ownKeys.length ||
      ownKeys.some((key) => !supported.has(key)) ||
      [...required].some((key) => !ownKeys.includes(key)))
  ) {
    throw new TypeError('ParentAccess plugin exposes unsupported methods.');
  }
  const methods = {};
  for (const name of required) {
    let method;
    try {
      method = value[name];
    } catch {
      throw new TypeError(`ParentAccess.${name} must be available.`);
    }
    if (typeof method !== 'function') {
      throw new TypeError(`ParentAccess.${name} must be a function.`);
    }
    methods[name] = (request) => Reflect.apply(method, value, [request]);
  }
  return Object.freeze(methods);
}

function availabilityResult(value) {
  const result = requireClosedRecord(
    value,
    ['available'],
    'Parent device authentication availability',
  );
  if (typeof result.available !== 'boolean') {
    throw new TypeError(
      'Parent device authentication availability is invalid.',
    );
  }
  return Object.freeze({ available: result.available });
}

function authenticationRequest(value) {
  const request = requireClosedRecord(
    value,
    ['reason'],
    'Parent device authentication request',
  );
  const bytes = typeof request.reason === 'string'
    ? new TextEncoder().encode(request.reason).length
    : 0;
  if (bytes < 1 || bytes > 120) {
    throw new TypeError('Parent device authentication reason is invalid.');
  }
  return Object.freeze({ reason: request.reason });
}

export function createCapacitorParentDeviceAuthentication({ ParentAccess } = {}) {
  const methods = nativeMethods(ParentAccess);
  return Object.freeze({
    async getAvailability() {
      let result;
      try {
        result = await requirePromise(
          methods.getDeviceOwnerAuthenticationAvailability({}),
        );
      } catch {
        throw deviceAuthenticationError(
          'parent_device_authentication_unavailable',
        );
      }
      return availabilityResult(result);
    },
    authenticate(candidate) {
      const request = authenticationRequest(candidate);
      return (async () => {
        let result;
        try {
          result = await requirePromise(
            methods.authenticateDeviceOwner(request),
          );
        } catch {
          throw deviceAuthenticationError(
            'parent_device_authentication_rejected',
          );
        }
        const value = requireClosedRecord(
          result,
          ['authenticated'],
          'Parent device authentication result',
        );
        if (value.authenticated !== true) {
          throw deviceAuthenticationError(
            'parent_device_authentication_rejected',
          );
        }
        return Object.freeze({ authenticated: true });
      })();
    },
  });
}
