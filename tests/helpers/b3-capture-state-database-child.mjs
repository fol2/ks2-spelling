import { constants, DatabaseSync } from 'node:sqlite';
import { installB3CaptureStateRootMock } from './b3-capture-state-install-root-mock.mjs';

installB3CaptureStateRootMock();

const probeAuthoriser = process.argv[3] === 'authoriser-probe';
const probeSurface = process.argv[3] === 'surface-shape';
const original = Object.freeze({
  enableDefensive: DatabaseSync.prototype.enableDefensive,
  enableLoadExtension: DatabaseSync.prototype.enableLoadExtension,
  setAuthorizer: DatabaseSync.prototype.setAuthorizer,
});
const calls = [];
let installedAuthoriser = null;
if (probeAuthoriser) {
  DatabaseSync.prototype.enableDefensive = function enableDefensive(value) {
    calls.push(['defensive', value]);
    return original.enableDefensive.call(this, value);
  };
  DatabaseSync.prototype.enableLoadExtension = function enableLoadExtension(value) {
    calls.push(['extension', value]);
    return original.enableLoadExtension.call(this, value);
  };
  DatabaseSync.prototype.setAuthorizer = function setAuthorizer(authoriser) {
    installedAuthoriser = authoriser;
    calls.push(['authoriser']);
    return original.setAuthorizer.call(this, authoriser);
  };
}

const { openB3CaptureStateDatabase } = await import(
  '../../scripts/lib/b3-capture-state-database.mjs'
);

const platform = process.argv[2] ?? 'ios';
const state = await openB3CaptureStateDatabase({ platform });
const surfaceKeys = probeSurface ? Reflect.ownKeys(state).map(String).sort() : null;
await state.close();
const result = { ok: true };
if (probeSurface) result.surfaceKeys = surfaceKeys;
if (probeAuthoriser) {
  result.calls = calls;
  result.decisions = {
    readPragma: installedAuthoriser(constants.SQLITE_PRAGMA, 'journal_mode', null),
    writePragma: installedAuthoriser(constants.SQLITE_PRAGMA, 'journal_mode', 'WAL'),
    tempTable: installedAuthoriser(constants.SQLITE_CREATE_TEMP_TABLE, 'hostile', null),
    attach: installedAuthoriser(constants.SQLITE_ATTACH, '/tmp/hostile.sqlite', null),
    reindex: installedAuthoriser(constants.SQLITE_REINDEX, 'hostile', null),
    analyse: installedAuthoriser(constants.SQLITE_ANALYZE, 'hostile', null),
  };
  Object.assign(DatabaseSync.prototype, original);
}
process.stdout.write(`${JSON.stringify(result)}\n`);
