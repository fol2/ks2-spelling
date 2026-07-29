import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const controllerUrl = new URL(
  '../src/app/product-learning-controller.js',
  import.meta.url,
);

test('the product command boundary normalizes every visible spelling answer', async () => {
  const source = await readFile(controllerUrl, 'utf8');

  assert.match(
    source,
    /import \{ earlyRoundSummary, spellingOnly \} from '\.\/practice-feel\.js';/u,
  );
  assert.match(
    source,
    /submitAnswer\(typed\) \{[\s\S]*?const spelling = spellingOnly\(typed\);[\s\S]*?if \(spelling === ''\)[\s\S]*?payload: \{ typed: spelling \}/u,
  );
  assert.doesNotMatch(
    source,
    /payload: \{ typed: typed\.trim\(\) \}/u,
    'the command engine must never receive the unsanitized visible-field value',
  );
});
