---
module: product-dictation-keyboard
date: 2026-07-29
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

The iPhone form accessory bar is intentionally left system-owned in the release
product. Capacitor's accessory-bar implementation is not a smaller public API
hidden inside the plugin: it replaces `inputAccessoryView` on WebKit's private
`WKContentView` and legacy `UIWebBrowserView` classes at runtime. Removing the
plugin's notification, resize and scroll work would narrow the side effects, but
would not make that private-class hook stable or App Store-safe.

## Product behaviour after the reset

1. The learner taps **Set off**.
2. The application completes the existing asynchronous repository transaction.
3. Practice renders the real `#product-spelling-input` field.
4. The learner taps that visible answer field.
5. WebKit/UIKit creates the ordinary text-input session.
6. Saving and feedback leave that same input mounted, enabled and focused. React
   blocks edits through `beforeinput`/controlled-state guards while the answer is
   locked; it does not set the HTML `disabled` or `readOnly` property.
7. The product command boundary applies the shared `spellingOnly()` contract
   before grading, so digits, spaces and unrelated punctuation cannot reach the
   spelling engine while letters, apostrophes and hyphens remain valid.
8. Continue/auto-advance reuses the same input element for the next card, so the
   operating-system keyboard is not intentionally dismissed between answers.

The additional first tap is intentional. Removing it would require either
mounting the real Practice field before the asynchronous transition or once again
owning a second input session. The latter is not an acceptable product
architecture.

## Why the previous design was retired

The earlier solution kept one real but visually hidden input alive across Setup
to Practice, placed it over different controls, buffered keystrokes and mirrored
its value into the React field. It also measured the visual viewport and changed
round layout around the keyboard.

That grew a small product requirement—automatically show keys after **Set off**—
into a second input subsystem spanning React, DOM focus, WebKit, Capacitor and
UIKit. Device evidence then showed failures outside dictation as well: learner
nickname, Word Bank search and Parent PIN could focus without usable key rows,
and one run produced the keyboard only after a long unexplained delay.

The full investigation, including the custom WKWebView/controller experiment, is
preserved in draft forensic PR #53. It is evidence, not mergeable product code.

## Locked observations

- Programmatic `input.focus()` can produce a caret or `activeElement` without a
  usable software-keyboard session on the affected physical device.
- `@capacitor/keyboard` provides keyboard observation and presentation settings;
  it does not provide a dependable iOS command that creates the required session.
- JavaScript callers are not the whole dependency boundary: an installed
  Capacitor plugin is linked and auto-loaded natively.
- Capacitor hides the iPhone form accessory by mutating the implementation of
  `inputAccessoryView` on private WebKit classes. An app-owned copy of only that
  code remains a private implementation dependency and a global mutation of all
  matching WebKit content views in the process.
- UIKit's public `UITextInputAssistantItem` can remove app shortcuts on iPad, but
  iPhone ignores that item; it is not a supported route to remove this bar.
- A launch-time one-shot is also timing-sensitive: it can run before WebKit has
  realised the private content-view class, silently leaving the bar unchanged.
- `startRound()` publishes a saving state, awaits repository work and only then
  mounts Practice. The visible spelling field therefore cannot own the original
  **Set off** activation without changing that product transaction boundary.
- Setting a focused HTML input to `disabled` can make WebKit resign first
  responder. Saving/feedback must therefore lock data semantically without
  disabling or remounting the real field.
- A delayed keyboard appearing without a fresh field tap is stale-session
  behaviour, not acceptable recovery.

## Production policy

- `#product-spelling-input` is the only spelling input and source of truth.
- Every submitted visible-field value crosses `spellingOnly()` at the product
  controller boundary before the command engine receives it.
- Ordinary nickname, search and PIN fields retain their own native WebKit input
  sessions.
- No transparent field may intercept **Set off**, answer-line or unrelated-screen
  pointer events.
- No app code may mirror typed text between two input elements.
- No product root may publish a custom keyboard inset or compact dictation around
  that inset.
- Saving, feedback and auto-advance may not set the visible spelling input to
  `disabled`, `readOnly`, hidden, inert or `tabIndex=-1`; the field remains mounted
  and focusable while mutation is rejected in event/state handling.
- The shipping App target may not resolve private WebKit content-view classes,
  replace `inputAccessoryView`, or use Objective-C runtime method mutation to hide
  the form accessory bar. Splitting private class names into string fragments does
  not make the implementation public.
- The standard iPhone form accessory remains system-owned. Its small visual cost
  is accepted rather than reopening a process-wide, OS-version-sensitive keyboard
  implementation.
- Any future automatic-keyboard proposal must first make the actual visible field
  exist during a trusted activation; it must not restore the retired bridge.

## Automated evidence on the reset branch

The reset branch verifies that:

- the visible `#product-spelling-input` remains one ordinary controlled JSX input;
- that field remains mounted, enabled and focusable through saving and feedback;
- `aria-readonly`, `beforeinput` and controlled-state guards lock an answered card
  without transferring keyboard ownership;
- the product controller normalises every submitted answer with the shared
  spelling-only contract before constructing `submit-answer`;
- Product root and startup code do not install keyboard ownership or chrome calls;
- the retired hidden-input and viewport files are absent;
- runtime source does not recreate a second input or import the Keyboard plugin;
- `@capacitor/keyboard` is absent from package, lock, SwiftPM, Android and policy
  graphs;
- App-target Objective-C/Swift sources contain no private accessory-view class
  dependency or runtime method replacement, and the Xcode project wires no
  accessory-bar helper;
- native sync is stable;
- the focused and fast test estate passes;
- resolved dependency evidence regenerates cleanly;
- lint passes;
- the unsigned iOS Simulator application compiles; and
- the native UI-test target compiles real-field probes which:
  - open **Add a learner** on a clean install and reuse an existing learner on a
    repeated run rather than exhausting the bounded profile list;
  - require actual hittable alphabet keys rather than accepting the input
    assistant strip as a keyboard;
  - travel through Trail and Setup **Set off**, then locate the actual visible
    Practice spelling field;
  - type a deliberately wrong spelling and submit through the keyboard action key;
  - require software letter rows to remain present while feedback rejects edits;
    and
  - wait for the real auto-advance before typing into the same field on the next
    card.

The UI probes are compilation evidence in CI. Their decisive keyboard assertions
must still be executed on a physical device with no external hardware keyboard
attached.

## Required physical-device acceptance

Use a clean product Debug build from the exact final reset head. Do not test PR
#53, B4Development or B3SandboxProof.

- [ ] Launch and leave the profile screen idle: no keyboard appears later by
      itself.
- [ ] Add learner, tap nickname: keys appear promptly and typing reaches the field.
- [ ] Open Words, tap Search spellings: keys appear promptly and filtering works.
- [ ] Open Parent PIN: numeric keys appear promptly.
- [ ] Tap **Set off**, wait for Practice, then tap the visible answer line: keys
      appear promptly.
- [ ] During Submit/save, the key rows remain present and the answer is submitted
      exactly once.
- [ ] During correct/incorrect feedback, the field remains focused but rejects
      edits until Continue/auto-advance.
- [ ] The next card accepts typing without another unexplained delay.
- [ ] End round, Keep practising and Leave round leave no invisible focus target.
- [ ] Portrait and landscape keep the authored dictation layout usable without a
      custom keyboard inset.
- [ ] Background/foreground, then tap the answer line: ordinary typing resumes.
- [ ] The standard previous/next/done form accessory may remain visible. It must
      stay system-owned and must not replace, delay or outlive the software key
      rows.
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
