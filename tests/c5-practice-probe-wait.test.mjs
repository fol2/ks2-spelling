import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const probeUrl = new URL(
  '../ios/App/B3ProofUITests/C5ProductLayoutTests.swift',
  import.meta.url,
);

test('the physical Practice probe waits on the unconditional setup chrome', async () => {
  const source = await readFile(probeUrl, 'utf8');

  assert.match(
    source,
    /application\.buttons\["Back to the trail"\]\.waitForExistence\(timeout: 10\)/u,
    'the wait must anchor on the unconditional setup chrome control',
  );
  assert.doesNotMatch(source, /staticTexts\["Vocabulary set"\]/u);
  assert.match(source, /Guardian-due Setup renders/u);
});
