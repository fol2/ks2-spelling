import { assertSqlConnection } from './sql-connection-contract.js';
import {
  SCHEMA_VERSION as SCHEMA_V1_VERSION,
  SCHEMA_V1_STATEMENTS,
} from './schema-v1.js';
import { SCHEMA_VERSION, SCHEMA_V2_STATEMENTS } from './schema-v2.js';

const CONFIGURATION_PRAGMAS = Object.freeze([
  Object.freeze({
    setSql: 'PRAGMA foreign_keys = ON',
    setOperation: 'execute',
    readSql: 'PRAGMA foreign_keys',
    property: 'foreign_keys',
    expected: 1,
  }),
  Object.freeze({
    setSql: 'PRAGMA journal_mode = WAL',
    setOperation: 'query',
    readSql: 'PRAGMA journal_mode',
    property: 'journal_mode',
    expected: 'wal',
  }),
  Object.freeze({
    setSql: 'PRAGMA synchronous = FULL',
    setOperation: 'execute',
    readSql: 'PRAGMA synchronous',
    property: 'synchronous',
    expected: 2,
  }),
  Object.freeze({
    setSql: 'PRAGMA busy_timeout = 5000',
    setOperation: 'query',
    readSql: 'PRAGMA busy_timeout',
    property: 'timeout',
    expected: 5000,
  }),
]);

const MIGRATION_QUEUES = new WeakMap();

function createMigrationError(code, options) {
  const error = new Error(code, options);
  error.code = code;
  return error;
}

function readExactSingleValue(rows, property, code) {
  if (
    !Array.isArray(rows) ||
    Object.getPrototypeOf(rows) !== Array.prototype ||
    Reflect.ownKeys(rows).length !== 2 ||
    !Reflect.ownKeys(rows).includes('0') ||
    !Reflect.ownKeys(rows).includes('length') ||
    rows.length !== 1 ||
    !Object.getOwnPropertyDescriptor(rows, '0')?.enumerable
  ) {
    throw createMigrationError(code);
  }
  const row = Object.getOwnPropertyDescriptor(rows, '0').value;
  if (
    !row ||
    typeof row !== 'object' ||
    Object.getPrototypeOf(row) !== Object.prototype ||
    Reflect.ownKeys(row).length !== 1 ||
    Reflect.ownKeys(row)[0] !== property
  ) {
    throw createMigrationError(code);
  }
  const descriptor = Object.getOwnPropertyDescriptor(row, property);
  if (
    !descriptor ||
    !Object.hasOwn(descriptor, 'value') ||
    !descriptor.enumerable
  ) {
    throw createMigrationError(code);
  }
  return descriptor.value;
}

function normaliseSchemaSql(sql) {
  return sql.endsWith(';') ? sql.slice(0, -1) : sql;
}

async function assertForeignKeysValid(connection) {
  const rows = await connection.query('PRAGMA foreign_key_check');
  if (!Array.isArray(rows) || rows.length !== 0) {
    throw createMigrationError('sqlite_foreign_key_check_failed');
  }
}

async function assertIntegrityValid(connection) {
  const rows = await connection.query('PRAGMA integrity_check');
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    !rows[0] ||
    typeof rows[0] !== 'object' ||
    rows[0].integrity_check !== 'ok'
  ) {
    throw createMigrationError('sqlite_integrity_check_failed');
  }
}

async function assertSchema(connection, statements, code) {
  const actual = await connection.query(
    'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name',
  );
  const expected = statements.map((sql) => ({
    type: 'table',
    name: /^CREATE TABLE ([a-z_]+) /.exec(sql)?.[1],
    tbl_name: /^CREATE TABLE ([a-z_]+) /.exec(sql)?.[1],
    sql: normaliseSchemaSql(sql),
  })).toSorted((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );

  if (!Array.isArray(actual)) {
    throw createMigrationError(code);
  }
  const appOwned = [];
  for (const row of actual) {
    if (!row || typeof row !== 'object') {
      throw createMigrationError(code);
    }
    const keys = Reflect.ownKeys(row);
    if (
      keys.length !== 4 ||
      ['type', 'name', 'tbl_name', 'sql'].some((key) => !keys.includes(key)) ||
      keys.some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(row, key);
        return (
          typeof key !== 'string' ||
          !descriptor ||
          !Object.hasOwn(descriptor, 'value') ||
          !descriptor.enumerable
        );
      })
    ) {
      throw createMigrationError(code);
    }
    const values = Object.fromEntries(
      keys.map((key) => [key, Object.getOwnPropertyDescriptor(row, key).value]),
    );
    const internalAutoIndex =
      values.type === 'index' &&
      typeof values.name === 'string' &&
      values.name.startsWith('sqlite_autoindex_') &&
      expected.some(({ name }) => name === values.tbl_name) &&
      values.sql === null;
    if (!internalAutoIndex) appOwned.push(values);
  }

  if (
    appOwned.length !== expected.length ||
    appOwned.some(
      (row, index) =>
        row.type !== expected[index].type ||
        row.name !== expected[index].name ||
        row.tbl_name !== expected[index].tbl_name ||
        row.sql !== expected[index].sql,
    )
  ) {
    throw createMigrationError(code);
  }
}

async function assertSchemaV1(connection) {
  await assertSchema(connection, SCHEMA_V1_STATEMENTS, 'sqlite_schema_v1_invalid');
}

async function assertSchemaV2(connection) {
  await assertSchema(
    connection,
    [...SCHEMA_V1_STATEMENTS, ...SCHEMA_V2_STATEMENTS],
    'sqlite_schema_v2_invalid',
  );
}

function requireMigrationStepHook(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Migration options must be an object.');
  }
  const keys = Reflect.ownKeys(options);
  if (keys.some((key) => key !== 'afterMigrationStep')) {
    throw new TypeError('Migration options contain an unsupported property.');
  }
  const hook = options.afterMigrationStep;
  if (hook !== undefined && typeof hook !== 'function') {
    throw new TypeError('afterMigrationStep must be a function.');
  }
  return hook ?? (async () => undefined);
}

async function rollbackAndProveInactive(connection, originalError) {
  const errors = [originalError];
  let initiallyActive;
  let stateInspectionFailed = false;
  try {
    initiallyActive = await connection.isTransactionActive();
    if (typeof initiallyActive !== 'boolean') {
      errors.push(
        createMigrationError('sqlite_migration_transaction_state_invalid'),
      );
      stateInspectionFailed = true;
    }
  } catch (error) {
    errors.push(error);
    stateInspectionFailed = true;
  }

  if (initiallyActive === true || stateInspectionFailed) {
    try {
      await connection.rollback();
    } catch (error) {
      errors.push(error);
    }
  }

  let transactionActive;
  try {
    transactionActive = await connection.isTransactionActive();
  } catch (error) {
    errors.push(error);
    throw createMigrationError('sqlite_migration_rollback_unverified', {
      cause: new AggregateError(
        errors,
        'Migration rollback could not be verified.',
      ),
    });
  }
  if (transactionActive !== false) {
    errors.push(
      createMigrationError(
        transactionActive === true
          ? 'sqlite_migration_transaction_still_active'
          : 'sqlite_migration_transaction_state_invalid',
      ),
    );
  }
  if (errors.length > 1) {
    throw createMigrationError('sqlite_migration_rollback_unverified', {
      cause: new AggregateError(
        errors,
        'Migration rollback did not become inactive.',
      ),
    });
  }
  throw originalError;
}

async function requireInactiveTransaction(connection) {
  let transactionActive;
  try {
    transactionActive = await connection.isTransactionActive();
  } catch (error) {
    throw createMigrationError('sqlite_migration_transaction_state_invalid', {
      cause: error,
    });
  }
  if (typeof transactionActive !== 'boolean') {
    throw createMigrationError('sqlite_migration_transaction_state_invalid');
  }
  if (transactionActive) {
    throw createMigrationError('sqlite_migration_transaction_already_active');
  }
}

async function beginOwnedTransaction(connection) {
  await requireInactiveTransaction(connection);
  try {
    await connection.begin();
  } catch (beginError) {
    let transactionActive;
    try {
      transactionActive = await connection.isTransactionActive();
    } catch (inspectionError) {
      await rollbackAndProveInactive(
        connection,
        createMigrationError('sqlite_migration_transaction_state_invalid', {
          cause: new AggregateError(
            [beginError, inspectionError],
            'Native begin outcome could not be verified.',
          ),
        }),
      );
    }
    if (typeof transactionActive !== 'boolean') {
      await rollbackAndProveInactive(
        connection,
        createMigrationError('sqlite_migration_transaction_state_invalid', {
          cause: new AggregateError(
            [
              beginError,
              createMigrationError('sqlite_migration_transaction_state_invalid'),
            ],
            'Native begin outcome could not be verified.',
          ),
        }),
      );
    }
    if (transactionActive) {
      await rollbackAndProveInactive(connection, beginError);
    }
    throw beginError;
  }
}

async function migrateV0ToV1(connection, afterMigrationStep) {
  let ownsTransaction = false;
  try {
    await beginOwnedTransaction(connection);
    ownsTransaction = true;
    let statementIndex = 0;
    for (const sql of SCHEMA_V1_STATEMENTS) {
      await connection.execute(sql);
      await afterMigrationStep(
        Object.freeze({ phase: 'schema_statement', sql, statementIndex }),
      );
      statementIndex += 1;
    }

    const setVersionSql = `PRAGMA user_version = ${SCHEMA_V1_VERSION}`;
    await connection.execute(setVersionSql);
    await afterMigrationStep(
      Object.freeze({
        phase: 'set_user_version',
        sql: setVersionSql,
        statementIndex,
      }),
    );
    statementIndex += 1;

    const foreignKeyCheckSql = 'PRAGMA foreign_key_check';
    await assertForeignKeysValid(connection);
    await afterMigrationStep(
      Object.freeze({
        phase: 'foreign_key_check',
        sql: foreignKeyCheckSql,
        statementIndex,
      }),
    );
    statementIndex += 1;

    const integrityCheckSql = 'PRAGMA integrity_check';
    await assertIntegrityValid(connection);
    await afterMigrationStep(
      Object.freeze({
        phase: 'integrity_check',
        sql: integrityCheckSql,
        statementIndex,
      }),
    );
    statementIndex += 1;

    await assertSchemaV1(connection);
    await afterMigrationStep(
      Object.freeze({ phase: 'before_commit', sql: 'COMMIT', statementIndex }),
    );
    await connection.commit();
    ownsTransaction = false;
  } catch (error) {
    if (ownsTransaction) {
      await rollbackAndProveInactive(connection, error);
    }
    throw error;
  }
}

async function migrateV1ToV2(connection, afterMigrationStep) {
  let ownsTransaction = false;
  try {
    await beginOwnedTransaction(connection);
    ownsTransaction = true;
    let statementIndex = 0;
    for (const sql of SCHEMA_V2_STATEMENTS) {
      await connection.execute(sql);
      await afterMigrationStep(
        Object.freeze({ phase: 'v2_schema_statement', sql, statementIndex }),
      );
      statementIndex += 1;
    }

    const setVersionSql = `PRAGMA user_version = ${SCHEMA_VERSION}`;
    await connection.execute(setVersionSql);
    await afterMigrationStep(
      Object.freeze({
        phase: 'v2_set_user_version',
        sql: setVersionSql,
        statementIndex,
      }),
    );
    statementIndex += 1;

    const foreignKeyCheckSql = 'PRAGMA foreign_key_check';
    await assertForeignKeysValid(connection);
    await afterMigrationStep(
      Object.freeze({
        phase: 'v2_foreign_key_check',
        sql: foreignKeyCheckSql,
        statementIndex,
      }),
    );
    statementIndex += 1;

    const integrityCheckSql = 'PRAGMA integrity_check';
    await assertIntegrityValid(connection);
    await afterMigrationStep(
      Object.freeze({
        phase: 'v2_integrity_check',
        sql: integrityCheckSql,
        statementIndex,
      }),
    );
    statementIndex += 1;

    await assertSchemaV2(connection);
    await afterMigrationStep(
      Object.freeze({
        phase: 'v2_before_commit',
        sql: 'COMMIT',
        statementIndex,
      }),
    );
    await connection.commit();
    ownsTransaction = false;
  } catch (error) {
    if (ownsTransaction) {
      await rollbackAndProveInactive(connection, error);
    }
    throw error;
  }
}

async function closeForUnsupportedVersion(connection) {
  const error = createMigrationError('sqlite_schema_version_unsupported');
  try {
    await connection.close();
  } catch (closeError) {
    error.cause = closeError;
  }
  throw error;
}

async function configureAndMigrateDatabaseOnce(connection, afterMigrationStep) {
  const userVersion = readExactSingleValue(
    await connection.query('PRAGMA user_version'),
    'user_version',
    'sqlite_schema_version_invalid',
  );
  if (!Number.isSafeInteger(userVersion) || userVersion < 0) {
    throw createMigrationError('sqlite_schema_version_invalid');
  }
  if (
    userVersion !== 0 &&
    userVersion !== SCHEMA_V1_VERSION &&
    userVersion !== SCHEMA_VERSION
  ) {
    await closeForUnsupportedVersion(connection);
  }

  await requireInactiveTransaction(connection);

  for (const { setSql, setOperation, property, expected } of CONFIGURATION_PRAGMAS) {
    if (setOperation === 'query') {
      const actual = readExactSingleValue(
        await connection.query(setSql),
        property,
        'sqlite_configuration_invalid',
      );
      if (actual !== expected) {
        throw createMigrationError('sqlite_configuration_invalid');
      }
    } else {
      await connection.execute(setSql);
    }
  }
  for (const { readSql, property, expected } of CONFIGURATION_PRAGMAS) {
    const actual = readExactSingleValue(
      await connection.query(readSql),
      property,
      'sqlite_configuration_invalid',
    );
    if (actual !== expected) {
      throw createMigrationError('sqlite_configuration_invalid');
    }
  }

  if (userVersion === 0) {
    await migrateV0ToV1(connection, afterMigrationStep);
  }

  if (userVersion === 0 || userVersion === SCHEMA_V1_VERSION) {
    await assertSchemaV1(connection);
    await migrateV1ToV2(connection, afterMigrationStep);
  }

  await assertSchemaV2(connection);
  await assertForeignKeysValid(connection);
  await assertIntegrityValid(connection);
}

export async function configureAndMigrateDatabase(connection, options = {}) {
  assertSqlConnection(connection);
  const afterMigrationStep = requireMigrationStepHook(options);
  const previous = MIGRATION_QUEUES.get(connection) ?? Promise.resolve();
  const result = previous
    .catch(() => undefined)
    .then(() => configureAndMigrateDatabaseOnce(connection, afterMigrationStep));
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  MIGRATION_QUEUES.set(connection, settled);

  try {
    return await result;
  } finally {
    if (MIGRATION_QUEUES.get(connection) === settled) {
      MIGRATION_QUEUES.delete(connection);
    }
  }
}
