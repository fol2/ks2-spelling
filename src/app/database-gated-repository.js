export function createDatabaseGatedRepository(repository, commandGate) {
  if (
    !repository ||
    typeof repository !== 'object' ||
    Array.isArray(repository) ||
    !commandGate ||
    typeof commandGate !== 'object' ||
    typeof commandGate.run !== 'function'
  ) {
    throw new TypeError('Database-gated repository dependencies are invalid.');
  }
  const methods = Reflect.ownKeys(repository);
  if (
    methods.length === 0 ||
    methods.some((method) =>
      typeof method !== 'string' || typeof repository[method] !== 'function')
  ) {
    throw new TypeError('Database-gated repository surface is invalid.');
  }
  const gated = {};
  for (const method of methods) {
    const implementation = repository[method];
    gated[method] = async (...args) =>
      commandGate.run(() => Reflect.apply(implementation, repository, args));
  }
  return Object.freeze(gated);
}
