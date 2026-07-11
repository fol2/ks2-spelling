import { loadStarterSpellingCatalogue } from '../domain/spelling/index.js';
import { canonicalJson } from '../platform/database/canonical-json.js';
import { seedB2Learners } from '../platform/database/b2-seed.js';
import { createCapacitorSqliteConnection } from '../platform/database/capacitor-sqlite-connection.js';
import { createDatabaseCommandGate } from '../platform/database/database-command-gate.js';
import { configureAndMigrateDatabase } from '../platform/database/migrate-database.js';
import { DATABASE_NAME, SCHEMA_VERSION } from '../platform/database/schema-v1.js';
import { assertSqlConnection } from '../platform/database/sql-connection-contract.js';
import { createSQLiteSpellingCommandRepository } from '../platform/database/sqlite-spelling-command-repository.js';
import { createSQLiteSpellingSnapshotStore } from '../platform/database/sqlite-spelling-snapshot-store.js';
import { createCapacitorAppLifecycle } from '../platform/lifecycle/capacitor-app-lifecycle.js';

import {
  B2_PROOF_METADATA_KEY,
  createB2AtomicFailureError,
  createB2ProofController,
} from './b2-proof-controller.js';
import { createDatabaseLifecycleCoordinator } from './database-lifecycle-coordinator.js';

const START_TIMESTAMP = 1_768_478_400_000;
const MIGRATION_FAILURE_STEP = 2;

function serviceError(code, options) {
  const error = new Error(code, options);
  error.code = code;
  return error;
}

function userVersionFrom(rows) {
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    !rows[0] ||
    Reflect.ownKeys(rows[0]).length !== 1 ||
    rows[0].user_version === undefined ||
    !Number.isSafeInteger(rows[0].user_version)
  ) {
    throw serviceError('b2_user_version_invalid');
  }
  return rows[0].user_version;
}

function createSwitchableConnection(connectionFactory) {
  if (typeof connectionFactory !== 'function') {
    throw new TypeError('connectionFactory must be a function.');
  }
  let active = null;

  function requireActive() {
    if (active === null) throw serviceError('b2_database_connection_closed');
    return active;
  }

  return assertSqlConnection(
    Object.freeze({
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
            // The opening error remains the authoritative diagnostic.
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
      async execute(sql, values) {
        return requireActive().execute(sql, values);
      },
      async query(sql, values) {
        return requireActive().query(sql, values);
      },
      async begin() {
        return requireActive().begin();
      },
      async commit() {
        return requireActive().commit();
      },
      async rollback() {
        return requireActive().rollback();
      },
      async isTransactionActive() {
        return requireActive().isTransactionActive();
      },
    }),
  );
}

async function proveFreshMigrationRollback(connection, migrate) {
  let injected = false;
  try {
    await migrate(connection, {
      async afterMigrationStep(step) {
        if (
          step.phase === 'schema_statement' &&
          step.statementIndex === MIGRATION_FAILURE_STEP
        ) {
          injected = true;
          throw serviceError('b2_injected_migration_failure');
        }
      },
    });
    throw serviceError('b2_migration_failure_not_injected');
  } catch (error) {
    if (!injected || error?.code !== 'b2_injected_migration_failure') throw error;
  }

  if (
    userVersionFrom(await connection.query('PRAGMA user_version')) !== 0 ||
    (await connection.isTransactionActive()) !== false
  ) {
    throw serviceError('b2_migration_rollback_unverified');
  }
  const schema = await connection.query(
    'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name',
  );
  if (!Array.isArray(schema) || schema.length !== 0) {
    throw serviceError('b2_migration_rollback_unverified');
  }
}

function createProofStore(connection) {
  return Object.freeze({
    async read(key) {
      if (key !== B2_PROOF_METADATA_KEY) {
        throw serviceError('b2_proof_metadata_key_invalid');
      }
      const rows = await connection.query(
        'SELECT value_json, updated_at FROM app_metadata WHERE key = ?',
        [key],
      );
      if (!Array.isArray(rows) || rows.length > 1) {
        throw serviceError('b2_proof_metadata_row_invalid');
      }
      if (rows.length === 0) return null;
      if (
        !rows[0] ||
        typeof rows[0].value_json !== 'string' ||
        !Number.isSafeInteger(rows[0].updated_at)
      ) {
        throw serviceError('b2_proof_metadata_row_invalid');
      }
      let value;
      try {
        value = JSON.parse(rows[0].value_json);
      } catch (cause) {
        throw serviceError('b2_proof_metadata_json_invalid', { cause });
      }
      if (canonicalJson(value) !== rows[0].value_json) {
        throw serviceError('b2_proof_metadata_json_invalid');
      }
      if (value?.updatedAt !== rows[0].updated_at) {
        throw serviceError('b2_proof_metadata_row_invalid');
      }
      return value;
    },
    async write(key, value) {
      if (key !== B2_PROOF_METADATA_KEY) {
        throw serviceError('b2_proof_metadata_key_invalid');
      }
      if ((await connection.isTransactionActive()) !== false) {
        throw serviceError('b2_proof_metadata_inside_command_transaction');
      }
      const encoded = canonicalJson(value);
      const result = await connection.execute(
        'INSERT INTO app_metadata (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
        [key, encoded, value.updatedAt],
      );
      if (result.changes !== 1) {
        throw serviceError('b2_proof_metadata_write_failed');
      }
    },
  });
}

function createLifecycleProof(lifecycle, coordinator) {
  const observed = [];
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  lifecycle.onPause(() => {
    if (observed.length === 0) observed.push('pause');
  });
  lifecycle.onResume(() => {
    if (observed.length === 1) {
      observed.push('resume');
      resolveReady();
    }
  });

  async function waitUntilCoordinatorActive() {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const diagnostic = coordinator.getDiagnosticState();
      if (diagnostic.state === 'active') return;
      if (diagnostic.state === 'failed') {
        throw serviceError('b2_lifecycle_resume_failed');
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw serviceError('b2_lifecycle_resume_timeout');
  }

  return Object.freeze({
    async waitForPauseResume() {
      await ready;
      await waitUntilCoordinatorActive();
      return Object.freeze([...observed]);
    },
  });
}

function wrapSuccessfulRepository(repository, onSuccess) {
  return Object.freeze({
    async runCommandTransaction(learnerId, planner) {
      const result = await repository.runCommandTransaction(learnerId, planner);
      onSuccess();
      return result;
    },
  });
}

function retainCleanupFailures(original, failures) {
  if (failures.length === 0) return original;
  const primary = original instanceof Error ? original : serviceError('b2_startup_failed');
  const causes = primary.cause === undefined
    ? failures
    : [primary.cause, ...failures];
  try {
    Object.defineProperty(primary, 'cause', {
      configurable: true,
      value: new AggregateError(causes, 'B2 service cleanup failed.'),
    });
    return primary;
  } catch {
    return serviceError(primary.code ?? 'b2_startup_failed', {
      cause: new AggregateError(
        [primary, ...causes],
        'B2 startup and cleanup failed.',
      ),
    });
  }
}

async function disposeOwned({ controller, coordinator, lifecycle, connection }) {
  const failures = [];
  for (const dispose of [
    controller && (() => controller.dispose()),
    coordinator && (() => coordinator.dispose()),
    lifecycle && (() => lifecycle.dispose()),
    connection && (() => connection.close()),
  ]) {
    if (!dispose) continue;
    try {
      await dispose();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

export async function createB2AppServices(options = {}) {
  let connection = null;
  let lifecycle = null;
  let coordinator = null;
  let controller = null;
  try {
    const connectionFactory =
      options.connectionFactory ?? (() => createCapacitorSqliteConnection());
    const migrate = options.migrate ?? configureAndMigrateDatabase;
    const seed = options.seed ?? seedB2Learners;
    connection = createSwitchableConnection(connectionFactory);
    const catalogue = loadStarterSpellingCatalogue();
    if (catalogue.items.length !== 20) {
      throw serviceError('b2_starter_catalogue_count_invalid');
    }
    const cataloguesById = Object.freeze({ [catalogue.catalogueId]: catalogue });

    await connection.open();
    const initialVersion = userVersionFrom(
      await connection.query('PRAGMA user_version'),
    );
    let migrationRollbackVerified = false;
    if (initialVersion === 0) {
      await proveFreshMigrationRollback(connection, migrate);
      migrationRollbackVerified = true;
    }
    await migrate(connection);
    await seed(connection);

    const store = createSQLiteSpellingSnapshotStore({
      connection,
      cataloguesById,
    });
    const [learnerA, learnerB] = await Promise.all([
      store.read('learner-a'),
      store.read('learner-b'),
    ]);
    if (learnerA.learnerId !== 'learner-a' || learnerB.learnerId !== 'learner-b') {
      throw serviceError('b2_learner_isolation_invalid');
    }

    const gate = createDatabaseCommandGate();
    let timestampIndex = learnerA.revision;
    const baseRepository = createSQLiteSpellingCommandRepository({
      connection,
      gate,
      store,
      cataloguesById,
      now: () => START_TIMESTAMP + timestampIndex,
    });
    const repository = wrapSuccessfulRepository(baseRepository, () => {
      timestampIndex += 1;
    });

    lifecycle =
      options.lifecycle ?? (options.lifecycleFactory ?? createCapacitorAppLifecycle)();
    coordinator = createDatabaseLifecycleCoordinator({
      lifecycle,
      commandGate: gate,
      createConnection: async () => connection,
      migrate,
      async rehydrateSelectedLearner(_connection, learnerId) {
        await store.read(learnerId);
      },
      selectedLearnerId: 'learner-a',
    });

    await connection.close();
    await coordinator.start();
    const lifecycleProof = createLifecycleProof(lifecycle, coordinator);
    const proofStore = createProofStore(connection);
    if (
      initialVersion === SCHEMA_VERSION &&
      (await proofStore.read(B2_PROOF_METADATA_KEY)) === null
    ) {
      throw serviceError('b2_proof_metadata_missing');
    }
    controller = createB2ProofController({
      catalogue,
      repository,
      snapshotStore: store,
      proofStore,
      lifecycleProof,
      migrationRollbackVerified:
        migrationRollbackVerified || initialVersion === SCHEMA_VERSION,
      createFailureRepository(checkpoint) {
        return createSQLiteSpellingCommandRepository({
          connection,
          gate,
          store,
          cataloguesById,
          now: () => START_TIMESTAMP + 4,
          failureInjector(candidate) {
            if (candidate === checkpoint) {
              throw createB2AtomicFailureError(checkpoint);
            }
          },
        });
      },
      updatedAt: START_TIMESTAMP,
    });

    let disposePromise;
    const dispose = () => {
      if (!disposePromise) {
        disposePromise = disposeOwned({
          controller,
          coordinator,
          lifecycle,
          connection,
        }).then((failures) => {
          if (failures.length > 0) {
            throw new AggregateError(failures, 'B2 service disposal failed.');
          }
        });
      }
      return disposePromise;
    };
    return Object.freeze({
      mode: 'b2-native-proof',
      controller,
      databaseName: DATABASE_NAME,
      dispose,
      platformRequirement: 'Native local data',
      schemaVersion: SCHEMA_VERSION,
    });
  } catch (error) {
    const failures = await disposeOwned({
      controller,
      coordinator,
      lifecycle,
      connection,
    });
    throw retainCleanupFailures(error, failures);
  }
}
