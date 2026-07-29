import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));

async function source(path) {
  return readFile(join(root, path), 'utf8');
}

test('the product does not create a WebView first responder before a real field tap', async () => {
  const [configurationSource, sceneDelegate] = await Promise.all([
    source('capacitor.config.json'),
    source('ios/App/App/SceneDelegate.swift'),
  ]);
  const configuration = JSON.parse(configurationSource);

  assert.equal(
    configuration.ios?.initialFocus,
    false,
    'Capacitor must not make the whole WKWebView first responder at launch',
  );
  assert.match(
    sceneDelegate,
    /webView\?\.capacitor\s*\n?\s*\.setKeyboardShouldRequireUserInteraction\(nil\)/u,
    'the App must clear Capacitor Core\'s programmatic-focus override for this WKWebView',
  );
  assert.doesNotMatch(
    sceneDelegate,
    /becomeFirstResponder\s*\(/u,
    'the App must not recreate a keyboard session before a visible field is tapped',
  );
});
