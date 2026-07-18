const METHOD_NAMES = Object.freeze([
  'getLaunchCommand',
  'publishObservation',
]);

export function assertB3ProofObservationPort(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== METHOD_NAMES.length ||
    Reflect.ownKeys(value).some((key) =>
      typeof key !== 'string' ||
      !METHOD_NAMES.includes(key) ||
      !Object.getOwnPropertyDescriptor(value, key)?.enumerable ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value') ||
      typeof value[key] !== 'function')
  ) {
    throw new TypeError('B3 proof observation port is invalid.');
  }
  return value;
}
