import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LEGACY_KEYBOARD_HELPER = join(
  ROOT,
  'src/platform/keyboard/capacitor-keyboard.js',
);

async function collectRuntimeSources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectRuntimeSources(path));
    } else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

test('ordinary iOS fields retain native keyboard ownership', async () => {
  const [
    mainSource,
    capacitorConfigSource,
    productRootSource,
    productAppSource,
    sessionSource,
    nativeTestSource,
  ] = await Promise.all([
    readFile(join(ROOT, 'src/main.jsx'), 'utf8'),
    readFile(join(ROOT, 'capacitor.config.json'), 'utf8'),
    readFile(join(ROOT, 'src/app/ProductRoot.jsx'), 'utf8'),
    readFile(join(ROOT, 'src/app/ProductApp.jsx'), 'utf8'),
    readFile(join(ROOT, 'src/platform/keyboard/ios-dictation-input-session.js'), 'utf8'),
    readFile(join(ROOT, 'ios/App/B3ProofUITests/C5ProductLayoutTests.swift'), 'utf8'),
  ]);

  const capacitorConfig = JSON.parse(capacitorConfigSource);
  assert.equal(
    capacitorConfig.plugins?.Keyboard?.resize ?? 'native',
    'native',
    'the iOS WebView must retain Capacitor’s native keyboard-resize default',
  );

  assert.doesNotMatch(mainSource, /applyKeyboardChrome/);
  assert.doesNotMatch(mainSource, /@capacitor\/keyboard/);

  const runtimeSources = await collectRuntimeSources(join(ROOT, 'src'));
  for (const path of runtimeSources) {
    if (path === LEGACY_KEYBOARD_HELPER) continue;
    const source = await readFile(path, 'utf8');
    assert.doesNotMatch(
      source,
      /capacitor-keyboard\.js/,
      `${relative(ROOT, path)} must not install the legacy global keyboard helper`,
    );
    assert.doesNotMatch(
      source,
      /Keyboard\.(?:setResizeMode|setScroll|setAccessoryBarVisible)\s*\(/,
      `${relative(ROOT, path)} must not mutate app-wide keyboard behaviour`,
    );
  }

  assert.doesNotMatch(productRootSource, /installIOSDictationInputSession/);
  assert.match(
    productAppSource,
    /const needsDictationSession = learningState\.screen === 'setup'\s*\|\|\s*learningState\.screen === 'practice';/s,
  );
  assert.match(productAppSource, /return installIOSDictationInputSession\(\);/);
  assert.match(productAppSource, /}, \[needsDictationSession\]\);/);
  assert.match(productAppSource, /id="bank-search-input"[\s\S]*?type="text"/);

  assert.match(
    sessionSource,
    /function park\(\)[\s\S]*?pointerEvents: 'none'[\s\S]*?translate\(-200vw, -200vh\)/,
  );
  assert.doesNotMatch(sessionSource, /Keyboard\.show|keyboardDisplayRequiresUserAction/);

  assert.match(
    nativeTestSource,
    /func testProductNicknameFieldRaisesSoftwareKeyboard\(\)/,
  );
  assert.match(nativeTestSource, /nickname\.tap\(\)/);
  assert.match(nativeTestSource, /application\.keyboards\.firstMatch/);
  assert.match(nativeTestSource, /keyboard\.waitForExistence\(timeout: 5\)/);
  assert.match(nativeTestSource, /nickname\.typeText\("Keyboard guard"\)/);
});
