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

test('the product host restores a 1:1 WKWebView viewport after background without fighting live keys', async () => {
  const sceneDelegate = await source('ios/App/App/SceneDelegate.swift');
  const bridge = productBridge(sceneDelegate);

  assert.match(sceneDelegate, /enum WebViewViewportResumePolicy/u);
  assert.match(
    sceneDelegate,
    /static let identityZoomScale: CGFloat = 1/u,
  );
  assert.match(
    sceneDelegate,
    /static let identityPageZoom: CGFloat = 1/u,
  );
  assert.match(
    sceneDelegate,
    /static func applyHostZoom\(to webView: WKWebView\)/u,
  );
  assert.match(
    sceneDelegate,
    /static func applyGeometry\(to webView: WKWebView\)/u,
  );
  assert.match(
    sceneDelegate,
    /static func apply\(to webView: WKWebView\)/u,
  );
  assert.match(
    sceneDelegate,
    /scrollView\.setZoomScale\(identityZoomScale, animated: false\)/u,
  );
  assert.match(sceneDelegate, /webView\.pageZoom = identityPageZoom/u);
  assert.match(sceneDelegate, /scrollView\.contentInset = \.zero/u);
  assert.match(
    sceneDelegate,
    /scrollView\.setContentOffset\(\.zero, animated: false\)/u,
  );
  assert.match(sceneDelegate, /webView\.transform = \.identity/u);
  assert.match(sceneDelegate, /evaluateJavaScript\(resetScript/u);

  assert.match(
    bridge,
    /override func viewDidLoad\(\) \{[\s\S]*keyboardDidHideNotification/u,
    'keyboard hide must clear leftover native inset, not own a second keyboard plugin',
  );
  const keyboardHide = bridge.match(
    /func restoreViewportAfterKeyboardHide\(\) \{[\s\S]*?\n    \}/u,
  )?.[0];
  assert.ok(keyboardHide, 'keyboard hide must be a closed method');
  assert.match(keyboardHide, /applyGeometry\(to: webView\)/u);
  assert.doesNotMatch(
    keyboardHide,
    /evaluateJavaScript|restoreViewportAfterHostChange|apply\(to: webView\)/u,
    'hiding keys must not toggle the viewport meta or programmatic-focus a field',
  );

  assert.match(
    bridge,
    /override func viewWillTransition\(\s*to size: CGSize,\s*with coordinator: UIViewControllerTransitionCoordinator\s*\)/u,
  );
  const sizeChange = bridge.match(
    /override func viewWillTransition\([\s\S]*?\n    \}/u,
  )?.[0];
  assert.ok(sizeChange, 'scene size change must be a closed override');
  assert.match(sizeChange, /applyHostZoom\(to: webView\)/u);
  assert.doesNotMatch(sizeChange, /applyGeometry|evaluateJavaScript/u);

  assert.match(
    bridge,
    /descriptor\.hasInitialFocus = false/u,
    'resume restore must not reopen launch keyboard ownership',
  );
  assert.match(
    bridge,
    /setKeyboardShouldRequireUserInteraction\(false\)/u,
  );

  assert.match(
    sceneDelegate,
    /func sceneDidBecomeActive\(_ scene: UIScene\)/u,
  );
  assert.match(
    sceneDelegate,
    /func sceneWillEnterForeground\(_ scene: UIScene\)/u,
  );
  const becomeActive = sceneDelegate.match(
    /func sceneDidBecomeActive\(_ scene: UIScene\) \{[\s\S]*?\n    \}/u,
  )?.[0];
  assert.ok(becomeActive, 'sceneDidBecomeActive must be a closed method');
  assert.match(becomeActive, /applyHostZoom\(to: webView\)/u);
  assert.doesNotMatch(
    becomeActive,
    /restoreViewportAfterHostChange|applyGeometry|evaluateJavaScript/u,
    'Control Centre / app-switcher peek must not zero keyboard insets',
  );
  assert.match(
    sceneDelegate,
    /sceneWillEnterForeground[\s\S]*restoreViewportAfterHostChange\(\)/u,
  );

  const restore = sceneDelegate.match(
    /func restoreViewportAfterHostChange\(\) \{[\s\S]*?\n    \}/u,
  )?.[0];
  assert.ok(restore, 'the resume restore must be a closed method');
  assert.match(restore, /WebViewViewportResumePolicy\.apply\(to: webView\)/u);
  assert.doesNotMatch(
    restore,
    /loadWebView\(\)|becomeFirstResponder|hasInitialFocus = true/u,
    'resume must not reload the start URL or steal first responder',
  );
  assert.doesNotMatch(restore, /webView\.reload\(\)/u);
});

test('the native resume script only briefly pins maximum-scale, then restores viewport-fit=cover', async () => {
  const sceneDelegate = await source('ios/App/App/SceneDelegate.swift');
  const script = sceneDelegate.match(
    /static let resetScript = #"""([\s\S]*?)"""#/u,
  )?.[1];
  assert.ok(script, 'resetScript must be a raw Swift string the tests can read');
  assert.match(script, /__ks2ResetProductViewport/u);
  assert.match(script, /maximum-scale=1\.0/u);
  assert.match(script, /setAttribute\('content', original\)/u);
  assert.match(script, /scrollTo\(0, 0\)/u);
  assert.match(script, /setTimeout/u);
  assert.doesNotMatch(script, /\.focus\(/u);
  assert.doesNotMatch(script, /preventScroll/u);
  assert.doesNotMatch(script, /user-scalable=no/u);
  assert.doesNotMatch(script, /Keyboard\.(?:show|hide)|--keyboard-inset/u);
});

test('reverting the resume restore leaves the viewport contract red', async () => {
  const sceneDelegate = await source('ios/App/App/SceneDelegate.swift');
  const reverted = sceneDelegate
    .replace(/\nenum WebViewViewportResumePolicy \{[\s\S]*?\n\}\n/u, '\n')
    .replace(/\n    override func viewWillTransition\([\s\S]*?\n    \}\n/u, '\n')
    .replace(/\n    @objc private func restoreViewportAfterKeyboardHide\(\) \{[\s\S]*?\n    \}\n/u, '\n')
    .replace(/\n    func restoreViewportAfterHostChange\(\) \{[\s\S]*?\n    \}\n/u, '\n')
    .replace(/\n    func sceneDidBecomeActive\(_ scene: UIScene\) \{[\s\S]*?\n    \}\n/u, '\n')
    .replace(/\n    func sceneWillEnterForeground\(_ scene: UIScene\) \{[\s\S]*?\n    \}\n/u, '\n');

  assert.match(sceneDelegate, /WebViewViewportResumePolicy\.apply/u);
  assert.match(sceneDelegate, /sceneWillEnterForeground/u);
  assert.doesNotMatch(
    reverted,
    /WebViewViewportResumePolicy/u,
    'the contract is load-bearing only if removing the policy drops its name',
  );
  assert.doesNotMatch(reverted, /sceneWillEnterForeground/u);
  assert.match(
    reverted,
    /enum WebViewFirstPaintPolicy/u,
    'reverting resume must not be possible by deleting first-paint recovery',
  );
  assert.match(reverted, /hasInitialFocus = false/u);
});

test('first-paint, long-press and user-driven keyboard contracts remain in the same host', async () => {
  const sceneDelegate = await source('ios/App/App/SceneDelegate.swift');
  assert.match(sceneDelegate, /enum WebViewFirstPaintPolicy/u);
  assert.match(sceneDelegate, /enum WebViewNativeLongPressPolicy/u);
  assert.match(sceneDelegate, /WebViewFirstPaintPolicy\.initialFrame\(/u);
  assert.match(sceneDelegate, /UIScreen\.main\.bounds/u);
  assert.match(sceneDelegate, /needsStartURLLoad\(currentURL: webView\?\.url\)/u);
  assert.match(sceneDelegate, /allowsLinkPreview = false/u);
  assert.match(sceneDelegate, /descriptor\.hasInitialFocus = false/u);
  assert.match(
    sceneDelegate,
    /setKeyboardShouldRequireUserInteraction\(false\)/u,
  );
  assert.doesNotMatch(sceneDelegate, /setKeyboardShouldRequireUserInteraction\(nil\)/u);
});
