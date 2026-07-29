import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));

async function source(path) {
  return readFile(join(root, path), 'utf8');
}

test('the product bridge waits for a real field tap before keyboard ownership', async () => {
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
    'the whole web view must not become first responder before a visible field is tapped',
  );
  assert.match(
    sceneDelegate,
    /override func capacitorDidLoad\(\)[\s\S]*setKeyboardShouldRequireUserInteraction\(nil\)/u,
    'the product host must clear Capacitor Core\'s programmatic-focus override',
  );
  assert.doesNotMatch(sceneDelegate, /becomeFirstResponder\s*\(/u);
  assert.match(
    storyboard,
    /customClass="ProductBridgeViewController" customModule="App" customModuleProvider="target"/u,
    'the shipping storyboard must instantiate the product bridge host',
  );
});
