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

test('the product web view refuses a zero frame and reloads the start URL when the first navigation never commits', async () => {
  const sceneDelegate = await source('ios/App/App/SceneDelegate.swift');
  const bridge = productBridge(sceneDelegate);

  assert.match(sceneDelegate, /import WebKit/u);
  assert.match(sceneDelegate, /enum WebViewFirstPaintPolicy/u);
  assert.match(
    sceneDelegate,
    /static let uncommittedRecoveryDelay: TimeInterval = 2/u,
    'recovery must wait long enough for a healthy commit and short of the observed hang',
  );
  assert.match(
    sceneDelegate,
    /if requested\.width >= 1, requested\.height >= 1/u,
    'a non-zero requested frame must be kept',
  );
  assert.match(
    sceneDelegate,
    /return screenBounds/u,
    'a zero frame must be replaced with the screen bounds, not left at .zero',
  );
  assert.match(
    sceneDelegate,
    /value\.isEmpty \|\| value == "about:blank"/u,
    'an uncommitted navigation is nil, empty or about:blank',
  );

  assert.match(
    bridge,
    /override func webView\(\s*with frame: CGRect,\s*configuration: WKWebViewConfiguration\s*\) -> WKWebView/u,
  );
  assert.match(bridge, /WebViewFirstPaintPolicy\.initialFrame\(/u);
  assert.match(bridge, /UIScreen\.main\.bounds/u);
  assert.doesNotMatch(
    bridge,
    /WKWebView\(frame: frame,/u,
    'passing Capacitor\'s .zero frame through unchanged reintroduces the iPad hang',
  );

  assert.match(
    bridge,
    /override func viewDidLoad\(\) \{[\s\S]*webView\?\.isOpaque = true/u,
    'opacity must be restored or an unfinished first load paints black',
  );
  assert.match(bridge, /webView\?\.backgroundColor = \.systemBackground/u);
  assert.match(
    bridge,
    /scheduleUncommittedFirstPaintRecovery\(\)/u,
  );
  assert.match(
    bridge,
    /WebViewFirstPaintPolicy\.needsStartURLLoad\(currentURL: webView\?\.url\)/u,
  );
  assert.match(
    bridge,
    /loadWebView\(\)/u,
    'recovery must re-issue the start URL; Capacitor reload() is a no-op when url is nil',
  );
  assert.doesNotMatch(
    bridge,
    /webView\.reload\(\)/u,
    'reload() of an uncommitted WKWebView is the Capacitor hang this ticket closes',
  );

  assert.match(
    sceneDelegate,
    /window\?\.backgroundColor = \.systemBackground/u,
    'the window behind a transparent first load must not default to black',
  );
});

test('the C5 first-activation probe uses activate without terminate so a black hang cannot hide', async () => {
  const layoutTests = await source('ios/App/B3ProofUITests/C5ProductLayoutTests.swift');

  assert.match(layoutTests, /func testProductFirstActivationPaintsContent\(\)/u);
  assert.match(
    layoutTests,
    /func testProductFirstActivationPaintsContent\(\) \{[\s\S]*application\.activate\(\)/u,
  );
  assert.match(
    layoutTests,
    /waitForFirstProductSurface\(in: application\)/u,
  );
  assert.match(layoutTests, /staticTexts\["Getting ready"\]/u);
  assert.match(layoutTests, /staticTexts\["Who is practising\?"\]/u);
  assert.match(layoutTests, /buttons\["Set off"\]/u);

  const firstActivation = layoutTests.match(
    /func testProductFirstActivationPaintsContent\(\) \{[\s\S]*?\n    \}/u,
  )?.[0];
  assert.ok(firstActivation, 'the first-activation test body must be closed');
  assert.doesNotMatch(
    firstActivation,
    /application\.terminate\(\)/u,
    'terminate-and-relaunch is the workaround that hid the iPad 8 hang',
  );
  assert.doesNotMatch(
    firstActivation,
    /application\.launch\(\)/u,
    'launch() after terminate is the path that already painted; activate() is the failing path',
  );
});

test('reverting the uncommitted start-URL load leaves the first-paint contract red', async () => {
  const sceneDelegate = await source('ios/App/App/SceneDelegate.swift');
  const reverted = sceneDelegate
    .replace(/\n    func recoverUncommittedFirstPaint\(\) \{[\s\S]*?\n    \}\n/u, '\n')
    .replace(/\n    private func scheduleUncommittedFirstPaintRecovery\(\) \{[\s\S]*?\n    \}\n/u, '\n')
    .replace(/\n        scheduleUncommittedFirstPaintRecovery\(\)\n/u, '\n')
    .replace(/\n        webView\?\.isOpaque = true\n/u, '\n');

  assert.match(sceneDelegate, /loadWebView\(\)/u);
  assert.match(sceneDelegate, /webView\?\.isOpaque = true/u);
  assert.doesNotMatch(
    reverted,
    /loadWebView\(\)/u,
    'the contract is load-bearing only if removing recovery drops loadWebView()',
  );
  assert.doesNotMatch(
    reverted,
    /webView\?\.isOpaque = true/u,
    'the contract is load-bearing only if removing the opaque restore drops isOpaque = true',
  );
});
