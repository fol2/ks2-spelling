const SQL_CONNECTION_METHODS = Object.freeze([
  'open',
  'close',
  'execute',
  'query',
  'begin',
  'commit',
  'rollback',
  'isTransactionActive',
]);

const ASYNC_FUNCTION_PROTOTYPE = Object.getPrototypeOf(async function () {});

export function assertSqlConnection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('SQL connection must be an object.');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('SQL connection must have a plain object prototype.');
  }

  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== SQL_CONNECTION_METHODS.length ||
    keys.some(
      (key) => typeof key !== 'string' || !SQL_CONNECTION_METHODS.includes(key),
    )
  ) {
    throw new TypeError('SQL connection must expose exactly the required methods.');
  }

  for (const methodName of SQL_CONNECTION_METHODS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, methodName);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${methodName} must be an own data property.`);
    }
    if (!descriptor.enumerable) {
      throw new TypeError(`${methodName} must be enumerable.`);
    }
    if (
      typeof descriptor.value !== 'function' ||
      Object.getPrototypeOf(descriptor.value) !== ASYNC_FUNCTION_PROTOTYPE
    ) {
      throw new TypeError(`${methodName} must be an async function.`);
    }
  }

  return value;
}
