import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';

const platform = process.argv[2] ?? 'ios';
const database = new DatabaseSync(resolve(
  process.cwd(),
  '.native-build',
  'b3',
  'evidence',
  `${platform}-capture-state`,
  'recovery.sqlite',
));
database.exec(`
  PRAGMA journal_mode = DELETE;
  PRAGMA synchronous = FULL;
  BEGIN IMMEDIATE;
  UPDATE b3_authority_state SET next_allocation_sequence = 2;
`);
process.stdout.write('HOT\n');
setInterval(() => {}, 1_000);
