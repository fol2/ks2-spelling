import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const probeUrl = new URL(
  '../ios/App/B3ProofUITests/C5ProductLayoutTests.swift',
  import.meta.url,
);

test('the physical Practice probe respects feedback before typing the next card', async () => {
  const source = await readFile(probeUrl, 'utf8');

  assert.match(source, /label CONTAINS\[c\].*words a week/u);
  assert.match(source, /previous probe added one on[\s\S]*every run/u);
  assert.match(source, /let feedbackKeyboard = application\.keyboards\.firstMatch/u);
  assert.match(source, /Feedback left only the input assistant without software letter rows/u);
  assert.match(source, /let lockedValue = spelling\.value as\? String/u);
  assert.match(source, /spelling\.typeText\("x"\)[\s\S]*The feedback lock accepted an edit/u);
  assert.match(
    source,
    /application\.buttons\["Submit"\]\.waitForExistence\(timeout: 10\)[\s\S]*spelling\.typeText\("a"\)/u,
    'the probe must wait for the real auto-advance before typing the next answer',
  );
});
