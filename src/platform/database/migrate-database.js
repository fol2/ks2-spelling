import { assertSqlConnection } from './sql-connection-contract.js';
import { SCHEMA_VERSION, SCHEMA_V1_STATEMENTS } from './schema-v1.js';

const CONFIGURATION_STATEMENTS = Object.freeze([
  'PRAGMA foreign_keys = ON',
  'PRAGMA journal_mode = WAL',
  'PRAGMA synchronous = FULL',
  'PRAGMA busy_timeout = 5000',
]);

function createMigrationError(code, options) {
  const error = new Error(code, options);
  error.code = code;
  return error;
}

function readSingleIntegerPragma(rows, property, code) {
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    !rows[0] ||
    typeof rows[0] !== 'object' ||
    !Number.isSafeInteger(rows[0][property]) ||
    rows[0][property] < 0
  ) {
    throw createMigrationError(code);
  }
  return rows[0][property];
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

async function assertSchemaV1(connection) {
  const actual = await connection.query(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const expected = SCHEMA_V1_STATEMENTS.map((sql) => ({
    name: /^CREATE TABLE ([a-z_]+) /.exec(sql)?.[1],
    sql: normaliseSchemaSql(sql),
  })).toSorted((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );

  if (
    !Array.isArray(actual) ||
    actual.length !== expected.length ||
    actual.some(
      (row, index) =>
        !row ||
        typeof row !== 'object' ||
        row.name !== expected[index].name ||
        row.sql !== expected[index].sql,
    )
  ) {
    throw createMigrationError('sqlite_schema_v1_invalid');
  }
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
  let rollbackError;
  try {
    if (await connection.isTransactionActive()) {
      await connection.rollback();
    }
  } catch (error) {
    rollbackError = error;
  }

  let transactionActive;
  try {
    transactionActive = await connection.isTransactionActive();
  } catch (error) {
    throw createMigrationError('sqlite_migration_rollback_unverified', {
      cause: new AggregateError(
        [originalError, rollbackError, error].filter(Boolean),
        'Migration rollback could not be verified.',
      ),
    });
  }
  if (rollbackError || transactionActive !== false) {
    throw createMigrationError('sqlite_migration_rollback_unverified', {
      cause: new AggregateError(
        [originalError, rollbackError].filter(Boolean),
        'Migration rollback did not become inactive.',
      ),
    });
  }
  throw originalError;
}

async function migrateV0ToV1(connection, afterMigrationStep) {
  await connection.begin();
  try {
    let statementIndex = 0;
    for (const sql of SCHEMA_V1_STATEMENTS) {
      await connection.execute(sql);
      await afterMigrationStep(
        Object.freeze({ phase: 'schema_statement', sql, statementIndex }),
      );
      statementIndex += 1;
    }

    const setVersionSql = `PRAGMA user_version = ${SCHEMA_VERSION}`;
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

    await afterMigrationStep(
      Object.freeze({ phase: 'before_commit', statementIndex }),
    );
    await connection.commit();
  } catch (error) {
    await rollbackAndProveInactive(connection, error);
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

export async function configureAndMigrateDatabase(connection, options = {}) {
  assertSqlConnection(connection);
  const afterMigrationStep = requireMigrationStepHook(options);

  for (const sql of CONFIGURATION_STATEMENTS) {
    await connection.execute(sql);
  }

  const userVersion = readSingleIntegerPragma(
    await connection.query('PRAGMA user_version'),
    'user_version',
    'sqlite_schema_version_invalid',
  );
  if (userVersion !== 0 && userVersion !== SCHEMA_VERSION) {
    await closeForUnsupportedVersion(connection);
  }

  if (userVersion === 0) {
    await migrateV0ToV1(connection, afterMigrationStep);
  }

  await assertSchemaV1(connection);
  await assertForeignKeysValid(connection);
  await assertIntegrityValid(connection);
}
