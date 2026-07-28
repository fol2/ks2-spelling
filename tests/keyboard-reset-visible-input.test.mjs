import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

async function source(path) {
  return readFile(join(root, path), 'utf8');
}

test('the product leaves keyboard ownership with the real visible field', async () => {
  const [productRoot, main, productApp] = await Promise.all([
    source('src/app/ProductRoot.jsx'),
    source('src/main.jsx'),
    source('src/app/ProductApp.jsx'),
  ]);

  assert.match(productApp, /id="product-spelling-input"/u);
  assert.doesNotMatch(productRoot, /ios-dictation-input-session|installIOSDictationInputSession|observeKeyboardInset/u);
  assert.doesNotMatch(main, /applyKeyboardChrome|@capacitor\/keyboard/u);
});

test('the retired hidden-input and viewport-ownership files stay absent', async () => {
  const retired = [
    'src/app/keyboard-inset.js',
    'src/app/ios-dictation-input-session.css',
    'src/platform/keyboard/capacitor-keyboard.js',
    'src/platform/keyboard/ios-dictation-input-session.js',
  ];

  for (const path of retired) {
    await assert.rejects(
      readFile(join(root, path), 'utf8'),
      { code: 'ENOENT' },
      `${path} must not return as a second keyboard subsystem`,
    );
  }
});
