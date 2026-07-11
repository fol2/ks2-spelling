const APP_LIFECYCLE_METHODS = Object.freeze([
  'onPause',
  'onResume',
  'onStateChange',
  'getState',
  'dispose',
]);

export function assertAppLifecycle(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('App lifecycle must be an object.');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('App lifecycle must have a plain object prototype.');
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== APP_LIFECYCLE_METHODS.length ||
    keys.some(
      (key) =>
        typeof key !== 'string' || !APP_LIFECYCLE_METHODS.includes(key),
    )
  ) {
    throw new TypeError('App lifecycle must expose exactly the required methods.');
  }
  for (const methodName of APP_LIFECYCLE_METHODS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, methodName);
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, 'value') ||
      !descriptor.enumerable ||
      typeof descriptor.value !== 'function'
    ) {
      throw new TypeError(`${methodName} must be an own enumerable function.`);
    }
  }
  return value;
}
