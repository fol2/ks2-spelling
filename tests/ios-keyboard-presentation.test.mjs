import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('the iOS host gives direct taps native keyboard ownership without assistant chrome', async () => {
  const [sceneDelegate, storyboard, packageJsonSource, packageLockSource] = await Promise.all([
    readFile(join(ROOT, 'ios/App/App/SceneDelegate.swift'), 'utf8'),
    readFile(join(ROOT, 'ios/App/App/Base.lproj/Main.storyboard'), 'utf8'),
    readFile(join(ROOT, 'package.json'), 'utf8'),
    readFile(join(ROOT, 'package-lock.json'), 'utf8'),
  ]);
  const packageJson = JSON.parse(packageJsonSource);
  const packageLock = JSON.parse(packageLockSource);

  assert.equal(Object.hasOwn(packageJson.dependencies ?? {}, '@capacitor/keyboard'), false);
  assert.equal(
    Object.hasOwn(packageLock.packages ?? {}, 'node_modules/@capacitor/keyboard'),
    false,
  );

  assert.match(storyboard, /customClass="ProductBridgeViewController"/);
  assert.match(sceneDelegate, /final class ProductBridgeViewController: CAPBridgeViewController/);
  assert.match(sceneDelegate, /override func webView\([\s\S]*?ProductWebView\(frame: frame, configuration: configuration\)/);
  assert.match(sceneDelegate, /override var inputAssistantItem: UITextInputAssistantItem/);
  assert.match(sceneDelegate, /assistantItem|let item = super\.inputAssistantItem/);
  assert.match(sceneDelegate, /item\.leadingBarButtonGroups = \[\]/);
  assert.match(sceneDelegate, /item\.trailingBarButtonGroups = \[\]/);
  assert.match(sceneDelegate, /item\.allowsHidingShortcuts = true/);

  assert.match(sceneDelegate, /override func capacitorDidLoad\(\)/);
  assert.match(
    sceneDelegate,
    /setKeyboardShouldRequireUserInteraction\(nil\)/,
    'Capacitor core must pass WebKit the real user-interaction value',
  );
  assert.doesNotMatch(
    sceneDelegate,
    /setKeyboardShouldRequireUserInteraction\((?:true|false)\)/,
    'the host must not force every focus into either interaction state',
  );
  assert.match(sceneDelegate, /override func viewDidAppear\(_ animated: Bool\)/);
  assert.match(sceneDelegate, /releasedInitialWebViewFocus = true/);
  assert.match(sceneDelegate, /webView\?\.resignFirstResponder\(\)/);

  assert.doesNotMatch(
    sceneDelegate,
    /WKContentView|method_setImplementation|class_getInstanceMethod|NSClassFromString|inputAccessoryView/,
    'app-owned keyboard policy must use public UIKit and Capacitor APIs only',
  );
});

test('dictation keeps the authored round geometry instead of measuring and squeezing it', async () => {
  const [productRoot, insetSource] = await Promise.all([
    readFile(join(ROOT, 'src/app/ProductRoot.jsx'), 'utf8'),
    readFile(join(ROOT, 'src/app/keyboard-inset.js'), 'utf8'),
  ]);

  assert.match(productRoot, /return observeKeyboardInset\(\);/);
  assert.match(insetSource, /export function observeKeyboardInset\(\)/);
  assert.match(insetSource, /return \(\) => \{\};/);
  assert.doesNotMatch(insetSource, /style\.setProperty\(/);
  assert.doesNotMatch(insetSource, /dataset\.room\s*=/);
  assert.doesNotMatch(insetSource, /visualViewport\.(?:addEventListener|removeEventListener)\(/);
  assert.doesNotMatch(insetSource, /addEventListener\(['"](?:resize|scroll)['"]/);
});
