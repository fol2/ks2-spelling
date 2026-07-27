---
module: product-dictation-keyboard
date: 2026-07-27
problem_type: bug
component: spelling_round_input
severity: high
applies_when:
  - "A dictation / practice round asks the learner to type a spelling on iOS"
  - "The software keyboard must appear without an extra tap on the answer field"
  - "WKWebView / Capacitor Keyboard is in use on a physical iPhone"
resolution_type: candidate_fix_pending_device_validation
related_components:
  - "product_ui"
  - "capacitor_keyboard"
  - "ios_webview"
tags:
  - "ios"
  - "keyboard"
  - "wkwebview"
  - "dictation"
  - "focus"
  - "gesture"
  - "incident"
---

# Incident: dictation round software keyboard does not appear on iOS 27

## Status

**Candidate fix implemented; physical-device validation required.** The candidate
starts from `96d39d60` and deliberately avoids `Keyboard.show()`, WebKit private
selectors and native method swizzling. It keeps one real text input alive across
Setup → Round, opens that input from the trusted **Set off** activation, and then
mirrors it into the existing React-controlled round field.

The incident remains open until the physical iPhone checklist below passes.

## Product symptom

On the product dictation round (physical iPhone, product Debug composition
`uk.eugnel.ks2spelling`):

- The answer field shows the familiar **“your spelling”** placeholder and
  **underline**.
- The iOS **software keyboard does not rise**, so the learner cannot type
  without somehow forcing focus (and even then behaviour is unreliable).
- Expected: after **Set off**, keys appear for the spelling field without an
  extra tap on the input.

Confirmed on **James’ iPhone** (iPhone 16 Pro Max, iOS 27.0,
UDID `00008140-000E79621407001C`) with product scheme `KS2Spelling` Debug,
Team `V45S7U2LZB`.

## Locked technical observations (device evidence, 2026-07-27)

1. **Programmatic `input.focus()` can succeed** (caret / `activeElement`) while
   **`keyboardDidShow` never fires** and soft keys stay down
   (`kbVisible=false`).
2. `@capacitor/keyboard@8.0.5` does **not** provide an iOS keyboard-summon API.
   Its public `Keyboard.show()` contract is Android-only and the iOS plugin
   implementation reports that method as unimplemented. On iOS the plugin can
   observe keyboard notifications and control resize, style, scrolling and the
   accessory bar; none of those operations creates a software-keyboard session.
3. Startup already calls `applyKeyboardChrome()` →
   `Keyboard.setAccessoryBarVisible({ isVisible: false })` and
   `Keyboard.setResizeMode({ mode: KeyboardResize.None })` so the WebView is
   **not** meant to shrink and walk the painted plate off-screen; inset is owned
   by `keyboard-inset.js` when wired.
4. **Gesture timing matters**: focus that is not inside the learner’s
   **Set off** pointer/click turn does not raise keys. Focus after
   `await startRound(...)` or after sentence autoplay is too late for a
   keyboard session.
5. **Same DOM node matters**: remounting a new `<input>` on the round screen
   cannot inherit a keyboard session opened on Setup. **Reparenting** a focused
   node (for example `createPortal`) and **proxy-then-transfer** focus both proved
   unreliable on device (keys dismiss; later `focus()` restores caret only).
6. `startRound()` publishes `saving`, awaits the repository transaction, and
   only then publishes the practice screen. Therefore
   `#product-spelling-input` cannot exist during the trusted Set off activation;
   the asynchronous screen boundary is the reproducible session break.

## Approaches tried before the candidate (all reverted)

| Attempt | Idea | Result on device |
| --- | --- | --- |
| A | Round `useEffect` / rAF `focus()` after mount / after autoplay | Caret only; no keys |
| B | Gesture **proxy** arm on Set off + claim on round field | Flaky; worked once under instrumentation, failed on clean build |
| C | Shared input + **`createPortal`** into answer line | Reparent dismissed keys |
| D | Shared input **parked** on Setup, **`position:fixed` dock** over answer line (no portal); focus on `pointerdown`/`click` of Set off | Briefly reported as keys up once; the experiment did not have a sealed lifecycle for React value mirroring, modal suspension, viewport ownership and cleanup. Follow-on backdrop/layout changes regressed both keyboard and display, so the whole experiment was reverted. |
| E | Pin scene plate on `data-keyboard=open` + `scrollTo(0,0)` while keys up | Did **not** restore backdrop; associated with further regression; reverted |

**Repo hygiene note:** none of A–E were committed or staged. A blanket
`git restore` to `HEAD` also temporarily dropped the separate Trail ↔ Codex
fix; that Trail fix was re-applied precisely and committed as `96d39d60`.

## Candidate F: persistent iOS input session

The candidate treats keyboard ownership as an integration lifecycle rather than
another focus retry:

1. `ProductRoot` mounts one body-level text input for the lifetime of the product
   app on native iOS. It is never portalled, reparented or replaced between
   Setup and Round.
2. While Setup is idle, that stable input is transparently docked over the real
   **Set off** button but kept out of the accessibility tree. An ordinary touch
   therefore lands directly on a genuine text control and opens the iOS input
   session; its click forwards only the product action to the underlying React
   button. Keyboard and assistive-technology activation retain a capture-listener
   fallback, still before `startRound()` crosses its async repository boundary.
3. While the transaction runs, early keystrokes remain buffered on that same
   node. When the round input mounts, the stable input is positioned over the
   visible answer line and its value is written through the native input setter
   plus a bubbling `input` event, preserving React’s controlled state.
4. The visible React field remains the visual/source-of-truth field for the
   form. The stable field carries first-responder ownership, pointer input,
   keyboard Return and software-keyboard continuity across Submit, feedback and
   auto-advance.
5. Opening **End round** parks and blurs the stable field so its top-level
   `z-index` cannot intercept the modal. **Keep practising** restores it at the
   end of the same trusted click, after the dialog focus-restoration cleanup.
6. `observeKeyboardInset()` is restored at the native-iOS product root. A
   separate compact round stylesheet consumes `--keyboard-inset` and `data-room`
   so the painted Scribe Downs scene, answer line, listening controls and Submit
   remain usable in the visual viewport without changing Capacitor’s
   `ResizeMode.None` rule.
7. Cleanup restores the original round field attributes, removes listeners,
   observers and the stable node, and clears document data attributes. React
   Strict Mode mount → cleanup → remount is supported.

This is intentionally a web/public-API fix. It does not ship a private WebKit
selector and does not pretend Capacitor can call an iOS `Keyboard.show()` method
that does not exist.

## Candidate files

- `src/app/ProductRoot.jsx` — owns inset observation and native-iOS session setup
- `src/platform/keyboard/ios-dictation-input-session.js` — stable input,
  first-responder lifecycle, React value bridge and modal handling
- `src/app/ios-dictation-input-session.css` — visual-viewport height and tight
  round layout
- `tests/ios-dictation-input-session.test.mjs` — stable-node, buffered typing,
  controlled-input event, Return-submit, modal pause/resume and cleanup contract

The existing round form and `#product-spelling-input` remain in
`src/app/ProductApp.jsx`; the candidate does not rewrite the learning flow.

## Validation completed before physical install

- [x] Stable input node survives Setup → asynchronous Round mount
- [x] Keystrokes entered before Round mount are adopted by the controlled field
- [x] Later input dispatches the bubbling event React expects
- [x] Keyboard Return requests the existing form submit control
- [x] A fast failed start releases the transparent shield for an immediate retry
- [x] End-round modal pauses the top-level transparent field
- [x] Keep-practising and Escape resume after modal focus restoration
- [x] A real answer-line tap reasserts first responder after app backgrounding
- [x] Round removal restores the original field and tears down the session
- [ ] Physical iPhone software-keyboard session (cannot be certified by Node/CI)

## Device QA checklist

Use a clean product Debug build from the candidate branch. Do not test a
B4Development or B3SandboxProof composition.

- [ ] Trail: unfound → empty meadow; found → matching Codex stage art
- [ ] Setup: one tap on **Set off** raises keys without tapping the answer line
- [ ] The first sentence still autoplays while the keyboard remains open
- [ ] “your spelling” placeholder + underline remain visible and aligned
- [ ] Typed letters appear in the visible answer field, including typing started
      immediately after Set off
- [ ] Keyboard Return and the visible Submit button both submit exactly once
- [ ] Correct and incorrect feedback display without dismissing the keyboard
- [ ] Auto-advance reaches the next card with an empty, typeable answer
- [ ] Manual Continue reaches the next card with the keyboard still available
- [ ] Scribe Downs plate remains visible with keys up
- [ ] Submit, replay and slow replay remain reachable in portrait
- [ ] Rotate to landscape with keys up; the round remains scrollable and Submit
      remains reachable
- [ ] End round opens an unobstructed confirmation dialog and hides the keyboard
- [ ] Keep practising returns to the same answer and raises/retains the keyboard
- [ ] Leave round reaches Results/Trail and leaves no invisible focus target
- [ ] Background/foreground the app during a round; tapping the answer line
      re-establishes typing normally

## If physical validation still fails

Capture `focus`, `blur`, `visualViewport`, `keyboardWillShow` and
`keyboardDidShow` timestamps around the single Set off activation, while keeping
repo-sealed logging policy unchanged. The next escalation should compare whether
the stable input itself ever receives a real iOS keyboard session; it should not
return to round-mount focus retries, portals or `Keyboard.show()` on iOS.

Only if the stable field is focused during the trusted event and iOS still
withholds keys should a native first-responder bridge be investigated. Any
private WebKit selector must be treated as a separate App Store/security decision,
not folded silently into this incident fix.

## Related retained notes

- `docs/solutions/workflow-issues/gating-physical-ios-installs-on-application-composition.md`
  — always gate physical installs on **product** vs proof composition.
