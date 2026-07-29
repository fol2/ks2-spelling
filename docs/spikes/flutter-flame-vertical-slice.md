# Flutter + Flame vertical-slice decision gate

Date: 2026-07-28  
Automated evidence updated: 2026-07-29

## Decision this spike must support

This is not authorisation to rewrite `ks2-spelling`. It is a bounded comparison against the simplified Capacitor product recovery.

The question is whether Flutter widgets for the application surfaces, with Flame used only for the living companion scene, materially reduce platform-specific fragility while preserving the local-first spelling contract.

## Current decision

**Automated platform gate: GREEN. Migration decision: HOLD.**

Flutter and Flame vertical-slice proof run #15 completed successfully before the generated shells were frozen. It established:

- strict `flutter analyze` and both repository/widget test files pass;
- concurrent SQLite opening is serialized, incorrect attempts do not evolve the egg, a correct attempt does, and state survives close/reopen;
- the real visible `TextField` handles correct and incorrect entry without a hidden proxy or autofocus;
- semantic state distinguishes the waiting egg from the evolved companion;
- Android APK and Linux debug builds pass;
- Windows debug builds pass;
- macOS and unsigned iOS Simulator debug builds pass; and
- the copied prompt audio is byte-identical to the existing repository asset.

The exact generated platform shells, audio copy and `pubspec.lock` were then committed. The one-use proof workflow was removed, and ordinary repository CI passed again after deterministic scaffold hardening.

This is enough to retain Flutter as a serious migration candidate. It is not enough to choose migration: physical keyboard, relaunch, audio and accessibility checks remain open.

## Slice

The spike contains exactly:

- one local learner (`Ada`);
- one published spelling (`accident`);
- one repository-owned, pre-generated audio asset;
- one ordinary visible Flutter `TextField` with no hidden proxy, no autofocus and no focus transfer;
- one correct/incorrect submission transaction;
- SQLite attempts, correct count and evolved state that survive repository close and reopen;
- one Flame-rendered egg that becomes an Inklet-like companion after a correct answer;
- semantic labels for the prompt, text field, feedback and companion stage; and
- generated Android, iOS, Linux, macOS and Windows platform shells.

No commerce, Parent area, packs, cloud service, full catalogue, imported production database or complete visual port belongs in this spike.

## Required evidence

Automated:

1. `flutter analyze` passes.
2. Repository tests prove a correct answer is committed and survives close/reopen.
3. Widget tests prove the product uses the visible keyed `TextField`, accepts typed input, persists the result and exposes the evolved stage semantically.
4. Android and Linux debug builds pass on Ubuntu.
5. iOS Simulator and macOS debug builds pass on macOS without signing.
6. Windows debug build passes on Windows.
7. The exact generated `pubspec.lock` and platform shells are committed to this branch.

All seven automated requirements are satisfied. Physical-device checks remain separate and must be performed before choosing a migration:

- iPhone on stable iOS: tap the visible field and type immediately;
- the affected iOS 27 device: repeat the same bare-field check;
- Android phone: type, submit, replay audio and relaunch;
- force-quit/relaunch preserves attempts and evolved state;
- VoiceOver and TalkBack reach the field, Listen, Submit, feedback and companion in a sensible order;
- desktop keyboard traversal works on macOS, Windows and Linux/SteamOS.

## Go / no-go rule

Proceed to a staged migration plan only when all of the following are true:

- the slice passes every automated platform build;
- the visible keyboard works promptly on the physical iPhone and Android checks;
- persistence and audio survive relaunch without platform-specific application code;
- accessibility is at least as good as the simplified Capacitor product;
- implementing the slice is demonstrably simpler than restoring equivalent reliability in the current stack; and
- the production migration can preserve the frozen spelling command/state semantics through fixtures rather than re-inventing them.

A failure on any item is evidence against a rewrite, not a reason to broaden the spike until it becomes a second unfinished product.

## Migration boundary if the spike is GREEN

Use Flutter widgets for profiles, Word Bank, setup, spelling input, results, Parent administration and accessibility. Use Flame only for the bounded close-up companion stage or future genuinely real-time play. Keep SQLite as the local source of truth and port behaviour from existing fixtures one vertical slice at a time.

Do not build separate SwiftUI and Android products, and do not turn the text-heavy application into a full-engine Godot UI unless the product itself is deliberately redesigned to be game-first.
