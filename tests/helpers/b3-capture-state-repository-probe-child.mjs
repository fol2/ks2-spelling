import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

import { installB3CaptureStateRootMock } from './b3-capture-state-install-root-mock.mjs';

installB3CaptureStateRootMock();

const { openB3CaptureStateRepository } = await import(
  '../../scripts/lib/b3-capture-state-repository.mjs'
);

const mode = process.argv[2];
const platform = process.argv[3];
const commands = process.argv.slice(4).map((value) =>
  JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
let repository;
let getterCalls = 0;
let repositoryClosed = false;
let sqlTrace = null;
let originalExec = null;
let originalPrepare = null;
try {
  repository = await openB3CaptureStateRepository({ platform });
  if (mode === 'read-order-invalid') {
    const corruptor = new DatabaseSync(join(
      process.cwd(), '.native-build', 'b3', 'evidence',
      `${platform}-capture-state`, 'recovery.sqlite',
    ));
    corruptor.exec('UPDATE b3_authority_state SET next_allocation_sequence = 2');
    corruptor.close();
  }
  if (mode === 'read-order' || mode === 'read-order-invalid') {
    sqlTrace = [];
    originalExec = DatabaseSync.prototype.exec;
    originalPrepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.exec = function tracedExec(sql) {
      const transaction = String(sql).trim().split(/\s+/u)[0].toUpperCase();
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(transaction)) {
        sqlTrace.push(transaction);
      }
      return originalExec.call(this, sql);
    };
    DatabaseSync.prototype.prepare = function tracedPrepare(sql) {
      sqlTrace.push('READ');
      return originalPrepare.call(this, sql);
    };
  }
  let result;
  if (mode === 'retry') {
    result = [
      await repository.reserveInitialCaptureStart({ command: commands[0] }),
      await repository.reserveInitialCaptureStart({ command: commands[1] }),
    ];
  } else if (mode === 'invalid-extra') {
    const options = {
      get command() {
        getterCalls += 1;
        throw new Error('command getter must not run');
      },
      unexpected: true,
    };
    result = await repository.reserveInitialCaptureStart(options);
  } else if (mode === 'invalid-getter') {
    const options = {
      get command() {
        getterCalls += 1;
        return commands[0];
      },
    };
    result = await repository.reserveInitialCaptureStart(options);
  } else if (mode === 'closed') {
    await repository.close();
    repositoryClosed = true;
    result = await repository.reserveInitialCaptureStart({ command: commands[0] });
  } else if (mode === 'read-closed') {
    await repository.close();
    repositoryClosed = true;
    result = await repository.readActiveCommand();
  } else if (mode === 'read-extra') {
    result = await repository.readActiveCommand({
      get unexpected() {
        getterCalls += 1;
        throw new Error('read argument getter must not run');
      },
    });
  } else if (mode === 'shape') {
    result = Reflect.ownKeys(repository).map(String).sort();
  } else if (mode === 'read' || mode === 'read-order' || mode === 'read-order-invalid') {
    result = await repository.readActiveCommand();
  } else {
    throw new Error('unknown repository probe mode');
  }
  const output = { ok: true, result, getterCalls };
  if (sqlTrace !== null) output.sqlTrace = sqlTrace;
  process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
  const output = {
    ok: false,
    error: { code: error?.code ?? null, message: error?.message ?? String(error) },
    getterCalls,
  };
  if (sqlTrace !== null) output.sqlTrace = sqlTrace;
  process.stdout.write(`${JSON.stringify(output)}\n`);
} finally {
  if (originalExec) DatabaseSync.prototype.exec = originalExec;
  if (originalPrepare) DatabaseSync.prototype.prepare = originalPrepare;
  if (!repositoryClosed) await repository?.close();
}
