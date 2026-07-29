---
module: product-dictation-keyboard
date: 2026-07-28
problem_type: bug
component: ios_text_input
severity: high
applies_when:
  - "A Capacitor WKWebView field receives focus without prompt software keys"
  - "Dictation crosses the asynchronous Setup to Practice boundary"
resolution_type: product_simplification_pending_physical_device_validation
related_components:
  - "product_ui"
  - "capacitor_core"
  - "ios_webview"
tags:
  - "ios"
  - "keyboard"
  - "wkwebview"
  - "dictation"
  - "focus"
  - "incident"
---

# Incident: iOS software keyboard is delayed or absent

## Current status

**The custom keyboard-ownership design is retired.** The product now leaves text
input ownership with each real visible HTML field. The learner deliberately taps
the visible spelling answer after Practice appears.

The recovery removes:

- the body-level hidden dictation input;
- the transparent input over **Set off** and the visible answer line;
- value mirroring into React's controlled field;
- custom visual-viewport keyboard inset ownership;
- keyboard-driven round compaction;
- startup keyboard-chrome mutation; and
- `@capacitor/keyboard` from npm, SwiftPM and Android native plugin graphs.

The physical-iPhone incident remains open until the checklist below passes on a
clean product Debug build. Automated tests and an unsigned Simulator compile can
prove composition and build integrity; they cannot prove software-keyboard
creation on the affected device.

## Product behaviour after the reset

1. The learner taps **Set off**.
2. The application completes the existing asynchronous repository transaction.
3. Practice renders the real `#product-spelling-input` field.
4. The learner taps that visible answer field.
5. WebKit/UIKit creates the ordinary text-input session.

The additional tap is intentional. Removing it would require either mounting the
real Practice field before the asynchronous transition or once again owning a
second input session. The latter is not an acceptable product architecture.

## Why the previous design was retired

The earlier solution kept one real but visually hidden input alive across Setup
to Practice, placed it over different controls, buffered keystrokes and mirrored
its value into the React field. It also measured the visual viewport and changed
round layout around the keyboard.

That grew a small product requirement—automatically show keys after **Set off**—
into a second input subsystem spanning React, DOM focus, WebKit, Capacitor and
UIKit. Device evidence then showed failures outside dictation as well: learner
nickname, Word Bank search and Parent PIN could focus without usable key rows, and
one run produced the keyboard only after a long unexplained delay.

The full investigation, including the custom WKWebView/controller experiment, is
preserved in draft forensic PR #53. It is evidence, not mergeable product code.

## Locked observations

- Programmatic `input.focus()` can produce a caret or `activeElement` without a
  usable software-keyboard session on the affected physical device.
- `@capacitor/keyboard` provides keyboard observation and presentation settings;
  it does not provide a dependable iOS command that creates the required session.
- JavaScript callers are not the whole dependency boundary: an installed
  Capacitor plugin is linked and auto-loaded natively.
- `startRound()` publishes a saving state, awaits repository work and only then
  mounts Practice. The visible spelling field therefore cannot own the original
  **Set off** activation without changing that product transaction boundary.
- A delayed keyboard appearing without a fresh field tap is stale-session
  behaviour, not acceptable recovery.

## Production policy

- `#product-spelling-input` is the only spelling input and source of truth.
- Ordinary nickname, search and PIN fields retain their own native WebKit input
  sessions.
- No transparent field may intercept **Set off**, answer-line or unrelated-screen
  pointer events.
- No app code may mirror typed text between two input elements.
- No product root may publish a custom keyboard inset or compact dictation around
  that inset.
- The application does not hide the standard iOS input assistant at the cost of
  another native keyboard mutation.
- Any future automatic-keyboard proposal must first make the actual visible field
  exist during a trusted activation; it must not restore the retired bridge.

## Automated evidence on the reset branch

The reset branch verifies that:

- the visible `#product-spelling-input` remains one ordinary controlled JSX input;
- that field is not hidden, read-only, inert, autofocus-driven or removed from the
  tab order;
- Product root and startup code do not install keyboard ownership or chrome calls;
- the retired hidden-input and viewport files are absent;
- runtime source does not recreate a second input or import the Keyboard plugin;
- `@capacitor/keyboard` is absent from package, lock, SwiftPM, Android and policy
  graphs;
- native sync is stable;
- the focused and fast test estate passes;
- resolved dependency evidence regenerates cleanly;
- lint passes;
- the unsigned iOS Simulator application compiles; and
- the native UI-test target compiles a real-field probe which taps the visible
  nickname field, requires software keys within five seconds and types through
  that same field.

The UI probe is compilation evidence in CI. Its decisive keyboard assertion must
still be executed on the clean physical device.

## Required physical-device acceptance

Use a clean product Debug build from the exact final reset head. Do not test PR
#53, B4Development or B3SandboxProof.

- [ ] Launch and leave the profile screen idle: no keyboard appears later by
      itself.
- [ ] Add learner, tap nickname: keys appear promptly and typing reaches the field.
- [ ] Open Words, tap Search spellings: keys appear promptly and filtering works
      when the Words feature is included.
- [ ] Open Parent PIN: numeric keys appear promptly.
- [ ] Tap **Set off**, wait for Practice, then tap the visible answer line: keys
      appear promptly.
- [ ] Typed letters, Return and visible Submit each affect the real answer exactly
      once.
- [ ] Correct/incorrect feedback and the next card leave the visible field usable.
- [ ] End round, Keep practising and Leave round leave no invisible focus target.
- [ ] Portrait and landscape keep the authored dictation layout usable without a
      custom keyboard inset.
- [ ] Background/foreground, then tap the answer line: ordinary typing resumes.
- [ ] If the standard previous/next/done assistant strip appears, it remains
      system-owned and does not replace or delay the software key rows. The app
      makes no native attempt to suppress it in this recovery.
- [ ] Repeat the bare visible-field checks on stable iOS 26 and the affected iOS
      27 device when both are available.

## If the visible field still fails

Reduce the case further before changing product architecture:

1. Build one screen with one visible HTML input.
2. Use no Keyboard plugin, hidden input, autofocus, viewport observer or custom
   bridge controller.
3. Compare the same bytes on stable iOS and the affected iOS 27 device.
4. Capture focus/blur and UIKit keyboard-notification timing only after the bare
   case reproduces.

A failure isolated to the beta operating system should be retained as a minimal
framework/OS reproduction. A failure on stable iOS is evidence for reconsidering
the WebView architecture through the separate Flutter + Flame decision spike,
not for rebuilding the hidden session.

## Related records

- Draft PR #53 — preserved forensic keyboard investigation; do not merge.
- Draft PR #55 — visible-input production reset and device gate.
- `docs/solutions/workflow-issues/gating-physical-ios-installs-on-application-composition.md`
  — always gate physical installs on product versus proof composition.
