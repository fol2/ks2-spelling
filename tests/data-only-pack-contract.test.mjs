import assert from 'node:assert/strict';
import test from 'node:test';

import { validateDataOnlyInventory } from '../src/domain/packs/data-only-pack-contract.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function validInput() {
  return {
    manifest: {
      allowedExtensions: ['.json', '.m4a'],
      ceilings: {
        fileCount: 16,
        compressedBytes: 1_048_576,
        extractedBytes: 4_194_304,
      },
      files: [
        { path: 'audio/proof-word.m4a', sha256: SHA_A, bytes: 5 },
        { path: 'catalogue.json', sha256: SHA_B, bytes: 7 },
      ],
    },
    entries: [
      { path: 'audio/proof-word.m4a', compressedBytes: 5, extractedBytes: 5 },
      { path: 'catalogue.json', compressedBytes: 7, extractedBytes: 7 },
    ],
  };
}

test('data-only inventory accepts the exact declared bounded file set', () => {
  const result = validateDataOnlyInventory(validInput());

  assert.deepEqual(result, {
    fileCount: 2,
    compressedBytes: 12,
    extractedBytes: 12,
    paths: ['audio/proof-word.m4a', 'catalogue.json'],
  });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.paths));
});

test('data-only inventory rejects unsafe and non-canonical paths', () => {
  const unsafePaths = [
    '../catalogue.json',
    '/catalogue.json',
    'C:/catalogue.json',
    'C:catalogue.json',
    'audio\\proof-word.m4a',
    './catalogue.json',
    'audio/../catalogue.json',
    'audio//proof-word.m4a',
    'audio/.hidden.json',
    'catalogue.JSON',
    'script.js',
    'audio/Stra\u00dfe.m4a',
    'audio/cafe\u0301.m4a',
  ];

  for (const path of unsafePaths) {
    const input = validInput();
    input.manifest.files[0].path = path;
    input.entries[0].path = path;
    assert.throws(() => validateDataOnlyInventory(input), /path|extension|data-only/i, path);
  }
});

test('data-only inventory judges bytes by the safe leaf format, not dotted directory names', () => {
  for (const path of [
    'Payload.app/catalogue.json',
    'Frameworks/Core.framework/catalogue.json',
    'Frameworks/Core.xcframework/catalogue.json',
  ]) {
    const input = validInput();
    input.manifest.files[0].path = path;
    input.entries[0].path = path;
    assert.doesNotThrow(() => validateDataOnlyInventory(input), path);
  }
});

test('data-only inventory intersects declarations with the exact binary-owned extension set', () => {
  assert.doesNotThrow(() => validateDataOnlyInventory(validInput()));

  for (const extension of [
    '.vue', '.svelte', '.vbs', '.msi', '.dmg', '.txt', '.yaml', '.png', '.data',
  ]) {
    const input = validInput();
    input.manifest.allowedExtensions.push(extension);
    input.manifest.files[0].path = `payload${extension}`;
    input.entries[0].path = `payload${extension}`;
    assert.throws(
      () => validateDataOnlyInventory(input),
      /binary|extension|data-only/i,
      extension,
    );
  }

  const declarationDoesNotIncludeAudio = validInput();
  declarationDoesNotIncludeAudio.manifest.allowedExtensions = ['.json'];
  assert.throws(
    () => validateDataOnlyInventory(declarationDoesNotIncludeAudio),
    /extension|data-only/i,
  );
});

test('data-only inventory rejects duplicate, case-fold and Unicode NFC collisions', () => {
  const collisionPairs = [
    ['catalogue.json', 'catalogue.json'],
    ['Audio/proof.m4a', 'audio/proof.m4a'],
    ['audio/caf\u00e9.m4a', 'audio/cafe\u0301.m4a'],
  ];

  for (const [first, second] of collisionPairs) {
    const input = validInput();
    input.manifest.files[0].path = first;
    input.manifest.files[1].path = second;
    input.entries[0].path = first;
    input.entries[1].path = second;
    assert.throws(() => validateDataOnlyInventory(input), /duplicate|collision|NFC|case|path/i);
  }
});

test('data-only inventory rejects undeclared, missing and malformed members', () => {
  const undeclared = validInput();
  undeclared.entries.push({
    path: 'audio/extra.m4a',
    compressedBytes: 1,
    extractedBytes: 1,
  });
  assert.throws(() => validateDataOnlyInventory(undeclared), /undeclared|inventory/i);

  const missing = validInput();
  missing.entries.pop();
  assert.throws(() => validateDataOnlyInventory(missing), /missing|inventory/i);

  const wrongSize = validInput();
  wrongSize.entries[0].extractedBytes = 6;
  assert.throws(() => validateDataOnlyInventory(wrongSize), /size|bytes|inventory/i);

  const wrongDigest = validInput();
  wrongDigest.manifest.files[0].sha256 = 'A'.repeat(64);
  assert.throws(() => validateDataOnlyInventory(wrongDigest), /SHA-256|digest/i);
});

test('data-only inventory enforces file, compressed and extracted ceilings', () => {
  for (const mutate of [
    (input) => { input.manifest.ceilings.fileCount = 1; },
    (input) => { input.manifest.ceilings.compressedBytes = 11; },
    (input) => { input.manifest.ceilings.extractedBytes = 11; },
  ]) {
    const input = validInput();
    mutate(input);
    assert.throws(() => validateDataOnlyInventory(input), /ceiling|count|compressed|extracted/i);
  }
});

test('data-only inventory accepts only the closed manifest and entry seam', () => {
  for (const mutate of [
    (input) => { input.extra = true; },
    (input) => { input.manifest.extra = true; },
    (input) => { input.entries[0].mode = 0o100644; },
    (input) => { input.entries[0].compressedBytes = -1; },
    (input) => { input.manifest.files[0].bytes = 1.5; },
  ]) {
    const input = validInput();
    mutate(input);
    assert.throws(() => validateDataOnlyInventory(input), /exact|field|integer|closed|approved/i);
  }
});
