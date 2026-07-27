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
resolution_type: unresolved_incident
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

**Open / unresolved.** Working tree was restored to `origin/main` at
`790375dc` plus the unrelated Trail ↔ Codex meadow alignment only. No keyboard
workaround remains in product code. This note is for a second pair of eyes.

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
2. Capacitor’s usual “no user interaction required” WKWebView swizzle /
   `Keyboard` plugin behaviour appears **ineffective for raising keys** on this
   iOS 27 path; sealed `capacitor.config.json` uses `loggingBehavior: "none"`
   (JS console silent unless temporarily overridden on the synced iOS copy only).
3. Startup already calls `applyKeyboardChrome()` →
   `Keyboard.setAccessoryBarVisible({ isVisible: false })` and
   `Keyboard.setResizeMode({ mode: KeyboardResize.None })` so the WebView is
   **not** meant to shrink and walk the painted plate off-screen; inset is
   owned by `keyboard-inset.js` when wired.
4. **Gesture timing matters**: focus that is not inside the learner’s
   **Set off** pointer/click turn does not raise keys. Focus after
   `await startRound(...)` or after sentence autoplay is too late for a
   keyboard session.
5. **Same DOM node matters**: remounting a new `<input>` on the round screen
   cannot inherit a keyboard session opened on Setup. **Reparenting** a focused
   node (e.g. `createPortal`) and **proxy-then-transfer** focus both proved
   unreliable on device (keys dismiss; later `focus()` restores caret only).

## Approaches tried (all reverted)

| Attempt | Idea | Result on device |
| --- | --- | --- |
| A | Round `useEffect` / rAF `focus()` after mount / after autoplay | Caret only; no keys |
| B | Gesture **proxy** arm on Set off + claim on round field | Flaky; worked once under instrumentation, failed on clean build |
| C | Shared input + **`createPortal`** into answer line | Reparent dismissed keys |
| D | Shared input **parked** on Setup, **`position:fixed` dock** over answer line (no portal); focus on `pointerdown`/`click` of Set off | Briefly reported as keys up once; follow-on backdrop / layout experiments then left **keyboard gone** and at one point **display broken**; full revert performed |
| E | Pin scene plate on `data-keyboard=open` + `scrollTo(0,0)` while keys up | Did **not** restore backdrop; associated with further regression; reverted |

**Repo hygiene note:** none of A–E were committed or staged. A blanket
`git restore` to `HEAD` also temporarily dropped the separate Trail ↔ Codex
fix; that Trail fix has been **re-applied precisely** afterwards (see below).

## Current tree after cleanup (2026-07-27)

**Base:** `790375dc` (`fix(product): auto-advance dictation and document safeguards`).

**Kept (unrelated, verified intent):** Trail meadow aligns with Codex Companions:

- `src/app/codex-model.js` — `trailMeadowCompanions()` filters to `found` only
- `src/app/ProductApp.jsx` — Trail meadow uses that helper
- `tests/codex-model.test.mjs`, `tests/app-shell.test.mjs`

**Not kept:** any shared spelling-input park/dock/portal, gesture proxy,
keyboard debug HUD, or backdrop pin.

Pre-fix dictation UI behaviour remains: placeholder + underline visible;
software keyboard still missing.

## Relevant code pointers (HEAD + Trail-only)

- Round answer field: `src/app/ProductApp.jsx` (`RoundScreen`,
  `#product-spelling-input`)
- Setup start control: `SetupScreen` **Set off** button (`onClick` →
  `startRound`)
- Keyboard chrome: `src/platform/keyboard/capacitor-keyboard.js`
- Inset helper (present; not all screens may subscribe): `src/app/keyboard-inset.js`
- Capacitor Keyboard plugin: `@capacitor/keyboard@8.0.5`

## Suggested investigation directions (for reviewers)

1. Confirm on a **second physical device / iOS version** whether the failure is
   iOS 27–specific.
2. With temporary Capacitor `loggingBehavior: "debug"` **only on the synced iOS
   config** (do not seal into repo policy hash), capture a timeline of
   `focus` / `keyboardWillShow` / `keyboardDidShow` around Set off → first card
   autoplay.
3. Decide product rule: **must** keys rise from Set off alone, or is a visible
   “tap to type” affordance acceptable for v1?
4. Revisit native options: `keyboardDisplayRequiresUserAction`, Capacitor
   `Keyboard.show()` after a **same-turn** gesture focus on a **stable** field,
   or a native first-responder hand-off that does not remount the web input.
5. Keep Trail ↔ Codex changes out of any keyboard experiment branch so a
   keyboard `git restore` cannot erase them again; commit Trail separately when
   James authorises.

## Device QA checklist when a candidate returns

- [ ] Product composition (no B4Development / B3SandboxProof markers)
- [ ] Trail: unfound → empty meadow; found → matching Codex stage art
- [ ] Dictation: Set off → keys up **without** tapping the field
- [ ] “your spelling” + underline still visible and aligned
- [ ] Scribe Downs plate still visible with keys up
- [ ] Submit / auto-advance / next card still usable

## Related retained notes

- `docs/solutions/workflow-issues/gating-physical-ios-installs-on-application-composition.md`
  — always gate physical installs on **product** vs proof composition.
