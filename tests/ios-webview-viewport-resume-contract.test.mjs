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

test('the product host restores a 1:1 WKWebView viewport after background, keyboard hide and scene size change', async () => {
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
    'keyboard hide must reuse the same resume restore, not a second inset owner',
  );
  assert.match(
    bridge,
    /override func viewWillTransition\(\s*to size: CGSize,\s*with coordinator: UIViewControllerTransitionCoordinator\s*\)/u,
  );
  assert.match(bridge, /restoreViewportAfterHostChange\(\)/u);
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
  assert.match(
    sceneDelegate,
    /sceneDidBecomeActive[\s\S]*restoreViewportAfterHostChange\(\)/u,
  );
  assert.match(
    sceneDelegate,
    /sceneWillEnterForeground[\s\S]*restoreViewportAfterHostChange\(\)/u,
  );

  const restore = sceneDelegate.match(
    /func restoreViewportAfterHostChange\(\) \{[\s\S]*?\n    \}/u,
  )?.[0];
  assert.ok(restore, 'the resume restore must be a closed method');
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
  assert.match(script, /preventScroll:\s*true/u);
  assert.doesNotMatch(script, /user-scalable=no/u);
  assert.doesNotMatch(script, /Keyboard\.(?:show|hide)|--keyboard-inset/u);
});

test('reverting the resume restore leaves the viewport contract red', async () => {
  const sceneDelegate = await source('ios/App/App/SceneDelegate.swift');
  const reverted = sceneDelegate
    .replace(/\nenum WebViewViewportResumePolicy \{[\s\S]*?\n\}\n/u, '\n')
    .replace(/\n    func restoreViewportAfterHostChange\(\) \{[\s\S]*?\n    \}\n/u, '\n')
    .replace(/\n    func sceneDidBecomeActive\(_ scene: UIScene\) \{[\s\S]*?\n    \}\n/u, '\n')
    .replace(/\n    func sceneWillEnterForeground\(_ scene: UIScene\) \{[\s\S]*?\n    \}\n/u, '\n');

  assert.match(sceneDelegate, /WebViewViewportResumePolicy\.apply/u);
  assert.match(sceneDelegate, /sceneDidBecomeActive/u);
  assert.doesNotMatch(
    reverted,
    /WebViewViewportResumePolicy/u,
    'the contract is load-bearing only if removing the policy drops its name',
  );
  assert.doesNotMatch(reverted, /sceneDidBecomeActive/u);
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
