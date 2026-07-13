import { createHash } from 'node:crypto';

import { seedB2Learners } from '../../src/platform/database/b2-seed.js';
import { canonicalJson } from '../../src/platform/database/canonical-json.js';
import { SCHEMA_V1_STATEMENTS } from '../../src/platform/database/schema-v1.js';

import { createNodeSqliteConnection } from './node-sqlite-connection.mjs';

const V1_TABLES = Object.freeze([
  ['app_metadata', 'key'],
  ['learner_profiles', 'learner_id'],
  ['spelling_aggregates', 'learner_id'],
  ['spelling_subject_states', 'learner_id'],
  ['spelling_practice_sessions', 'learner_id'],
  ['spelling_events', 'learner_id, sequence_no'],
  ['spelling_monster_states', 'learner_id, reward_track_id'],
  ['spelling_camp_states', 'learner_id, pack_id'],
]);

export async function createSeededV1(filename) {
  const connection = createNodeSqliteConnection(filename);
  await connection.open();
  await connection.begin();
  for (const sql of SCHEMA_V1_STATEMENTS) await connection.execute(sql);
  await connection.execute('PRAGMA user_version = 1');
  await connection.commit();
  await seedB2Learners(connection);
  return connection;
}

export async function learnerCellDigest(connection) {
  const state = {};
  for (const [table, orderBy] of V1_TABLES) {
    const columns = await connection.query(`PRAGMA table_info(${table})`);
    const projection = columns
      .flatMap(({ name }) => [
        `typeof(${name}) AS ${name}_type`,
        `hex(CAST(${name} AS BLOB)) AS ${name}_bytes`,
      ])
      .join(', ');
    state[table] = await connection.query(
      `SELECT ${projection} FROM ${table} ORDER BY ${orderBy}`,
    );
  }
  return createHash('sha256').update(canonicalJson(state)).digest('hex');
}
