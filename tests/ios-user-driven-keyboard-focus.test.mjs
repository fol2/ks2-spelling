import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));

async function source(path) {
  return readFile(join(root, path), 'utf8');
}

test('the product bridge waits for a real field before launch keyboard ownership', async () => {
  const [sceneDelegate, storyboard] = await Promise.all([
    source('ios/App/App/SceneDelegate.swift'),
    source('ios/App/App/Base.lproj/Main.storyboard'),
  ]);

  assert.match(
    sceneDelegate,
    /final class ProductBridgeViewController: CAPBridgeViewController/u,
  );
  assert.match(
    sceneDelegate,
    /override func instanceDescriptor\(\) -> InstanceDescriptor[\s\S]*descriptor\.hasInitialFocus = false/u,
    'the whole web view must not become first responder before a visible field is ready',
  );
  assert.match(
    sceneDelegate,
    /override func capacitorDidLoad\(\)[\s\S]*setKeyboardShouldRequireUserInteraction\(false\)/u,
    'Practice may raise keys via input.focus() after Set off, Hear it again and the next card',
  );
  assert.doesNotMatch(
    sceneDelegate,
    /setKeyboardShouldRequireUserInteraction\(nil\)/u,
    'clearing the Cap focus flag blocks Practice autofocus on iOS',
  );
  assert.doesNotMatch(sceneDelegate, /becomeFirstResponder\s*\(/u);
  assert.match(
    storyboard,
    /customClass="ProductBridgeViewController" customModule="App" customModuleProvider="target"/u,
    'the shipping storyboard must instantiate the product bridge host',
  );
});

test('Practice reclaims the visible spelling field for typing', async () => {
  const productApp = await source('src/app/ProductApp.jsx');

  assert.match(
    productApp,
    /const spellingInputRef = useRef\(null\)/u,
  );
  assert.match(
    productApp,
    /field\.focus\(\{\s*preventScroll:\s*true\s*\}\)/u,
    'Practice must focus the real visible spelling input',
  );
  assert.match(
    productApp,
    /focusSpellingField\(\);\s*try \{[\s\S]*audio\.play/u,
    'Hear it again must reclaim the spelling field in the replay gesture',
  );
  assert.match(
    productApp,
    /requestAnimationFrame\(\(\) => \{\s*focusSpellingField\(\);\s*\}\)/u,
    'a newly projected Practice card must raise the spelling field without an extra tap',
  );
  assert.match(
    productApp,
    /ref=\{spellingInputRef\}[\s\S]*id="product-spelling-input"/u,
  );
  assert.doesNotMatch(
    productApp,
    /id="product-spelling-input"[\s\S]{0,200}\bautoFocus\b/u,
    'do not use the HTML autoFocus attribute; focus the controlled field explicitly',
  );
});
