import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  B4_COMMAND_TRACE,
  B4_START_TIMESTAMP,
  loadB4SpellingCatalogue,
  randomAtB4Command,
} from '../src/app/b4-round-contract.js';
import { applySpellingCommand } from '../src/domain/spelling/index.js';
import { seedB2Learners } from '../src/platform/database/b2-seed.js';
import { createDatabaseCommandGate } from '../src/platform/database/database-command-gate.js';
import { configureAndMigrateDatabase } from '../src/platform/database/migrate-database.js';
import { createSQLiteSpellingCommandRepository } from '../src/platform/database/sqlite-spelling-command-repository.js';
import { createSQLiteSpellingSnapshotStore } from '../src/platform/database/sqlite-spelling-snapshot-store.js';
import { createNodeSqliteConnection } from '../tests/helpers/node-sqlite-connection.mjs';
import { investigationError, roundMs } from './lib/investigation.mjs';
import { EXIT_CODES, isMain, printJson } from './lib/run-command.mjs';

const LEARNER_ID = 'learner-a';
const SQLITE_TRANSACTION_UPPER_BOUND_MS = 50;
const LIMITATIONS = Object.freeze([
  'Node-process isolation; not a WebView or installed-application measurement.',
]);

function buildReport(perCommandMs) {
  const maxMs = roundMs(Math.max(...perCommandMs));
  const meanMs = roundMs(
    perCommandMs.reduce((sum, value) => sum + value, 0) / perCommandMs.length,
  );
  return Object.freeze({
    ok: true,
    commandCount: perCommandMs.length,
    perCommandMs: Object.freeze([...perCommandMs]),
    maxMs,
    meanMs,
    comparator: Object.freeze({
      sqliteTransactionUpperBoundMs: SQLITE_TRANSACTION_UPPER_BOUND_MS,
    }),
    withinComparator: perCommandMs.every(
      (value) => value <= SQLITE_TRANSACTION_UPPER_BOUND_MS,
    ),
    limitations: LIMITATIONS,
  });
}

/**
 * Mirror the SQLite composition inside createB4AppServices (Node connectionFactory
 * style from the B4 round tests) without audio player or round-controller involvement.
 */
async function createSqliteSeam(databasePath) {
  const connection = createNodeSqliteConnection(databasePath);
  await connection.open();
  await configureAndMigrateDatabase(connection);
  await seedB2Learners(connection);

  const catalogue = loadB4SpellingCatalogue();
  const cataloguesById = Object.freeze({ [catalogue.catalogueId]: catalogue });
  const snapshotStore = createSQLiteSpellingSnapshotStore({ connection, cataloguesById });
  const learner = await snapshotStore.read(LEARNER_ID);
  const gate = createDatabaseCommandGate();
  let timestampIndex = learner.revision;
  const baseRepository = createSQLiteSpellingCommandRepository({
    connection,
    gate,
    store: snapshotStore,
    cataloguesById,
    now: () => B4_START_TIMESTAMP + timestampIndex,
  });
  const repository = Object.freeze({
    async runCommandTransaction(learnerId, planner) {
      const result = await baseRepository.runCommandTransaction(learnerId, planner);
      timestampIndex += 1;
      return result;
    },
  });

  return Object.freeze({
    catalogue,
    snapshotStore,
    repository,
    async dispose() {
      await connection.close();
    },
  });
}

export async function run() {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-b4-performance-'));
  try {
    const seam = await createSqliteSeam(join(directory, 'investigate.sqlite'));
    try {
      const perCommandMs = [];
      for (let index = 0; index < B4_COMMAND_TRACE.length; index += 1) {
        const command = B4_COMMAND_TRACE[index];
        const before = await seam.snapshotStore.read(LEARNER_ID);
        if (before.revision !== index) {
          throw investigationError(
            'b4_performance_revision_mismatch',
            `Expected revision ${index} before command ${index}, got ${before.revision}.`,
          );
        }

        const started = performance.now();
        await seam.repository.runCommandTransaction(LEARNER_ID, (fresh) => {
          if (fresh.revision !== before.revision) {
            throw investigationError(
              'b4_performance_revision_changed',
              'Learner revision changed inside the SQLite transaction.',
            );
          }
          return applySpellingCommand({
            snapshot: fresh,
            command,
            contentSnapshot: seam.catalogue,
            now: () => B4_START_TIMESTAMP + index,
            random: randomAtB4Command(index),
          });
        });
        const elapsedMs = performance.now() - started;

        const committed = await seam.snapshotStore.read(LEARNER_ID);
        if (committed.revision !== index + 1) {
          throw investigationError(
            'b4_performance_commit_missing',
            `Expected revision ${index + 1} after command ${index}, got ${committed.revision}.`,
          );
        }
        perCommandMs.push(roundMs(elapsedMs));
      }

      if (perCommandMs.length !== B4_COMMAND_TRACE.length) {
        throw investigationError(
          'b4_performance_trace_incomplete',
          'The isolated B4 command trace did not complete.',
        );
      }
      return buildReport(perCommandMs);
    } finally {
      await seam.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function main() {
  try {
    const report = await run();
    printJson(report);
    return report.ok ? EXIT_CODES.success : EXIT_CODES.commandFailed;
  } catch (error) {
    printJson({
      ok: false,
      code: error.code ?? 'b4_performance_investigation_failed',
      message: error.message,
    }, process.stderr);
    return EXIT_CODES.commandFailed;
  }
}

if (isMain(import.meta.url)) process.exitCode = await main();
