import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// The replace-all DELETE must stay on the adapter's single-statement run
// path (an explicit values array). The Capacitor plugin's statement-batch
// API executed the value-less form as a no-op on iOS, so the import never
// removed existing learners and a same-learner re-import failed on its
// primary key. That platform behaviour cannot execute under Node, so this
// pin holds the call shape instead.
test('Learning backup import deletes learners through the single-statement path', async () => {
  const source = await readFile(
    new URL(
      '../src/platform/database/sqlite-learning-backup-repository.js',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(
    source,
    /connection\.execute\('DELETE FROM learner_profiles', \[\]\)/u,
  );
  assert.doesNotMatch(
    source,
    /connection\.execute\('DELETE FROM learner_profiles'\)/u,
  );
});
