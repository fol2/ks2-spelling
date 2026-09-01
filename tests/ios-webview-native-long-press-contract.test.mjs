import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function source(path) {
  return readFile(join(root, path), 'utf8');
}

function productBridge(sceneDelegate) {
  const match = sceneDelegate.match(
    /final class ProductBridgeViewController: CAPBridgeViewController \{[\s\S]*?\n\}\n\nclass SceneDelegate/u,
  );
  assert.ok(match, 'ProductBridgeViewController must remain the Capacitor host');
  return match[0];
}

test('the product web view turns off native image drag and link preview', async () => {
  const sceneDelegate = await source('ios/App/App/SceneDelegate.swift');
  const bridge = productBridge(sceneDelegate);

  assert.match(sceneDelegate, /enum WebViewNativeLongPressPolicy/u);
  assert.match(
    sceneDelegate,
    /webView\.allowsLinkPreview = false/u,
    'iOS link preview is the image callout path in WKWebView',
  );
  assert.match(sceneDelegate, /interaction is UIDragInteraction/u);
  assert.match(sceneDelegate, /interaction is UIDropInteraction/u);
  assert.doesNotMatch(
    sceneDelegate,
    /is UILongPressGestureRecognizer|gestureRecognizers\.remove/u,
    'stripping long-press recognisers would break caret and magnifier in real fields',
  );

  assert.match(
    bridge,
    /WebViewNativeLongPressPolicy\.apply\(to: webView\)/u,
  );
  assert.match(
    bridge,
    /override func webView\(\s*with frame: CGRect,\s*configuration: WKWebViewConfiguration\s*\) -> WKWebView[\s\S]*WebViewNativeLongPressPolicy\.apply\(to: webView\)/u,
  );
  assert.match(
    bridge,
    /override func viewDidLoad\(\) \{[\s\S]*WebViewNativeLongPressPolicy\.apply\(to: webView\)/u,
  );
  assert.match(
    bridge,
    /override func viewDidAppear\(_ animated: Bool\) \{[\s\S]*WebViewNativeLongPressPolicy\.apply\(to: webView\)/u,
  );
  assert.match(
    bridge,
    /override func capacitorDidLoad\(\) \{[\s\S]*WebViewNativeLongPressPolicy\.apply\(to: webView\)/u,
  );
  assert.match(
    bridge,
    /descriptor\.hasInitialFocus = false/u,
    'long-press suppression must not reopen launch keyboard ownership',
  );
  assert.match(
    bridge,
    /setKeyboardShouldRequireUserInteraction\(false\)/u,
  );
  assert.doesNotMatch(bridge, /setKeyboardShouldRequireUserInteraction\(nil\)/u);
  assert.doesNotMatch(
    bridge,
    /WKWebView\(frame: frame,/u,
    'the first-paint non-zero frame policy must stay in front of long-press suppression',
  );
});
