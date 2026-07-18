import { assertSqlConnection } from '../platform/database/sql-connection-contract.js';

function connectionError() {
  const error = new Error('b2_database_connection_closed');
  error.code = 'b2_database_connection_closed';
  return error;
}

export function createSwitchableSqlConnection(connectionFactory) {
  if (typeof connectionFactory !== 'function') {
    throw new TypeError('connectionFactory must be a function.');
  }
  let active = null;

  function requireActive() {
    if (active === null) throw connectionError();
    return active;
  }

  return assertSqlConnection(Object.freeze({
    async open() {
      if (active !== null) return;
      const candidate = assertSqlConnection(await connectionFactory());
      try {
        await candidate.open();
        active = candidate;
      } catch (error) {
        try {
          await candidate.close();
        } catch {
          // The opening error remains authoritative.
        }
        throw error;
      }
    },
    async close() {
      if (active === null) return;
      const closing = active;
      await closing.close();
      if (active === closing) active = null;
    },
    async execute(sql, values) { return requireActive().execute(sql, values); },
    async query(sql, values) { return requireActive().query(sql, values); },
    async begin() { return requireActive().begin(); },
    async commit() { return requireActive().commit(); },
    async rollback() { return requireActive().rollback(); },
    async isTransactionActive() { return requireActive().isTransactionActive(); },
  }));
}
