---
module: product-dictation-keyboard
date: 2026-07-28
problem_type: bug
component: ios_text_input_host
severity: high
applies_when:
  - "A Capacitor WKWebView text field is tapped on a physical iPhone running iOS 27"
  - "The field becomes focused but the software keyboard is absent or appears much later"
  - "The dictation round must retain one trusted input session across Setup to Practice"
resolution_type: native_host_fix_pending_device_validation
related_components:
  - "capacitor_core"
  - "ios_webview"
  - "product_ui"
  - "spelling_round_input"
tags:
  - "ios"
  - "keyboard"
  - "wkwebview"
  - "capacitor"
  - "dictation"
  - "focus"
  - "incident"
---

# Incident: iOS text fields focus without showing the software keyboard

## Status

**Native host correction implemented and compiled; clean physical-device validation remains required.**

The failure was broader than dictation. Learner nickname, Words search, Parent PIN and the spelling answer all became focused without usable software keys. After the native Keyboard plugin was removed, iOS showed only its previous / next / done assistant strip. On one device run, the software keyboard appeared roughly ten minutes later without a new field tap.

That delayed appearance is not acceptable recovery. It indicates that iOS retained a stale text-input session rather than creating the correct session from the user’s tap.

## Device evidence

Confirmed on the product Debug composition:

- bundle identifier: `uk.eugnel.ks2spelling`
- scheme: `KS2Spelling`
- device: James’ iPhone 16 Pro Max
- operating system: iOS 27.0

Observed sequence:

1. A genuine HTML text field is tapped.
2. The field receives focus and a caret.
3. The form assistant strip may appear, proving that UIKit has a text-input responder.
4. The software key rows remain absent.
5. In one run the keys appeared about ten minutes later, with no meaningful app transition.

## Root cause chain

### 1. The Capacitor Keyboard plugin was a real native side effect

Removing JavaScript calls was insufficient while `@capacitor/keyboard` remained linked. Capacitor auto-loaded its iOS implementation, which changed WKWebView keyboard behaviour for every field. The package is now removed from npm, SwiftPM, Android generated projects, dependency policy and runtime source.

### 2. Capacitor core also changes WKWebView focus behaviour

Capacitor 8.4.1 itself creates the WKWebView and calls:

```swift
aWebView.capacitor.setKeyboardShouldRequireUserInteraction(false)
```

Capacitor also installs a process-wide wrapper around WebKit’s internal element-focus callback. With the per-WebView flag set to `false`, the wrapper treats focus as user initiated even when the real WebKit callback says otherwise.

That compatibility behaviour is useful for programmatic autofocus on older systems, but on the physical iOS 27 device it produced the opposite of what this product needs: a field could look focused while the software-keyboard session was not established promptly.

### 3. The bridge controller initially focuses the whole WebView

`CAPBridgeViewController.viewDidAppear()` calls `webView.becomeFirstResponder()` by default. The product then asks individual HTML fields to become the text-input owner. On the affected device, the combination of container-level initial focus and forced user-interaction state could leave the field inheriting a stale host session. The ten-minute keyboard appearance is consistent with that session eventually being reconciled by the operating system rather than by the tap.

### 4. Dictation had a separate asynchronous screen boundary

`startRound()` publishes a saving state, awaits repository work, and only then mounts Practice. The visible `#product-spelling-input` therefore does not exist during the trusted **Set off** activation. A stable real input remains necessary across Setup → Practice so the dictation flow does not depend on late programmatic focus.

## Final host policy

### App-owned bridge and WebView

The storyboard now instantiates `ProductBridgeViewController`, which creates `ProductWebView`.

`ProductBridgeViewController.capacitorDidLoad()` clears only Capacitor’s per-WebView override:

```swift
webView?.capacitor.setKeyboardShouldRequireUserInteraction(nil)
```

The process-wide Capacitor wrapper remains installed, but `nil` makes it pass WebKit’s real user-interaction value through unchanged. A genuine tap remains genuine; delayed programmatic focus no longer masquerades as a trusted activation.

### Release container-level initial focus

After Capacitor’s `viewDidAppear()` has run, the product bridge releases the whole-WebView first-responder state once:

```swift
_ = webView?.resignFirstResponder()
```

The first actual HTML-field tap can then own a fresh input session immediately.

### Remove the assistant strip with public UIKit API

`ProductWebView` overrides `inputAssistantItem` and empties the public leading and trailing button groups:

```swift
item.leadingBarButtonGroups = []
item.trailingBarButtonGroups = []
item.allowsHidingShortcuts = true
```

This removes the previous / next / done strip without reintroducing `@capacitor/keyboard`, naming a private WebKit class, or replacing a private selector.

### Keep the stable dictation input narrowly scoped

The persistent input session remains mounted only while the learning screen is Setup or Practice. It is never carried into Words, learner switching, Camp, Codex or Parent forms.

It preserves:

- the trusted Set off activation across the asynchronous repository transaction;
- typing begun before Practice finishes mounting;
- React controlled-input updates;
- Return-to-submit behaviour;
- modal pause/resume and teardown.

### Do not squeeze the authored dictation layout

The round already reserves the intended keyboard area. The former visual-viewport observer and `data-room="tight"` path compressed the same layout a second time.

`keyboard-inset.js` is now a deliberate no-op and the retained dictation stylesheet has no declarations. It cannot publish `--keyboard-inset`, set `data-room`, listen to visual-viewport resize/scroll events, or shrink the prompt, answer line, replay controls, Submit button or footer.

## Regression protection

`tests/ios-keyboard-presentation.test.mjs` requires:

- the storyboard-owned `ProductBridgeViewController`;
- `ProductWebView` and its public input-assistant cleanup;
- Capacitor interaction passthrough using `nil`, never forced `true` or `false`;
- one-time release of initial WebView focus;
- no app-owned private WebKit selector/runtime replacement;
- no runtime visual-viewport compaction.

`tests/ios-keyboard-ownership.test.mjs` prevents reintroducing the native Keyboard package through npm, SwiftPM, Android, dependency policy or application runtime.

`tests/ios-dictation-input-session.test.mjs` retains the Setup → Practice node, value, submit, modal and cleanup contracts.

The installed iOS UI test taps the real learner nickname field, requires a software keyboard, types text and verifies the field receives it.

## Verification completed

- [x] Focused keyboard and dictation source contracts
- [x] Stable Setup → Practice input-session tests
- [x] Capacitor native-sync drift check
- [x] Unsigned `KS2Spelling` iOS Simulator compile on Xcode 26
- [x] Fast PR test lane, deterministic proof, lint and topology checks
- [ ] Clean physical iPhone acceptance

## Physical-device acceptance checklist

Delete the installed app, clean build, install the latest product Debug head, and verify:

- [ ] Leaving the profile screen idle does not summon a keyboard later.
- [ ] Add learner → nickname: keys appear promptly from the field tap.
- [ ] Words → Search spellings: keys appear promptly and filtering works.
- [ ] Parent PIN: numeric keys appear promptly.
- [ ] The previous / next / done assistant strip is absent.
- [ ] Set off → Practice retains one keyboard session across the async transition.
- [ ] The first sentence still autoplays while typing remains available.
- [ ] Dictation keeps its normal authored geometry; no compact/tight variant appears.
- [ ] Typed letters, Return submit, visible Submit, replay and slow replay all work.
- [ ] Feedback and auto-advance retain or restore typing correctly.
- [ ] End round hides the input session and leaves the dialog unobstructed.
- [ ] Leaving the round does not block any later ordinary text field.

## Escalation boundary

Do not return to repeated `focus()` retries, portals, `Keyboard.show()` on iOS, or another private WebKit selector.

If the corrected physical build still shows a focused field without keys, first compare the same device in Notes or Safari and record:

- field tap time;
- DOM `focus` and `blur` time;
- `keyboardWillShow` / `keyboardDidShow` notifications;
- whether a hardware keyboard or remote-control session is active;
- whether the assistant strip exists;
- whether the keys appear after background/foreground.

That evidence distinguishes a device-wide hardware-keyboard state from a remaining app-owned responder defect.

## Related retained note

- `docs/solutions/workflow-issues/gating-physical-ios-installs-on-application-composition.md` — always gate physical installs on product versus proof composition.
