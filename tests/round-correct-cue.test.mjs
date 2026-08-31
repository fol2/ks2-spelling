/* RoundScreen maps both success and info feedback to the correct cue.
   `info` still means the learner spelled it correctly — only `error` is a miss. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFile(join(ROOT, path), 'utf8');

test('RoundScreen maps success and info to correct, error to retry', async () => {
  const source = await read('src/app/ProductApp.jsx');

  assert.match(
    source,
    /const FEEDBACK_TONE = Object\.freeze\(\{\s*success: 'success',\s*info: 'success',/u,
    "FEEDBACK_TONE must map both success and info to 'success'",
  );
  assert.match(
    source,
    /error: 'retry',/u,
    "FEEDBACK_TONE must map error to 'retry'",
  );

  const playMatches = source.match(/sfx\?\.play\('correct'\)/g) ?? [];
  assert.equal(
    playMatches.length,
    1,
    "exactly one sfx?.play('correct') must exist in ProductApp.jsx",
  );

  assert.match(
    source,
    /if \(tone === 'success'\) \{\s*haptics\?\.answerCorrect\?\.\(\);\s*\n\s*sfx\?\.play\('correct'\);\s*\n\s*\} else if \(tone === 'retry'\) \{\s*sfx\?\.play\('retry'\);/u,
    "correct plays in the success branch; retry plays 'retry'",
  );

  assert.doesNotMatch(
    source,
    /tone === 'success'[\s\S]{0,200}sfx\?\.play\('(?:flourish|catch|evolve)'\)/u,
    'in-round success must not reuse Results celebration cues',
  );

  assert.match(
    source,
    /`success` and `info` both mean[\s\S]*so both must read as a win/u,
    'nearby comment must still say both success and info must read as a win',
  );
});
