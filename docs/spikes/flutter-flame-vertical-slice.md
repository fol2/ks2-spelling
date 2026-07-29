# Flutter + Flame vertical-slice decision gate

Date: 2026-07-28  
Automated evidence updated: 2026-07-29

## Decision this spike must support

This is not authorisation to rewrite `ks2-spelling`. It is a bounded comparison against the simplified Capacitor product recovery.

The question is whether Flutter widgets for the application surfaces, with Flame used only for the living companion scene, materially reduce platform-specific fragility while preserving the local-first spelling contract.

## Current decision

**Automated platform gate: GREEN. Migration decision: HOLD.**

The hardened code matrix passed on Android, Linux, Windows, macOS and unsigned iOS Simulator in Flutter and Flame vertical-slice gate run #21. The same exact code head also passed ordinary repository CI.

That evidence now establishes:

- strict `flutter analyze`, repository tests, widget tests and prompt-audio lifecycle tests pass on every runner family;
- Flutter mounts a recovery-capable UI before SQLite is opened, so an initial local-data failure cannot prevent the application from rendering;
- a failed initial read produces an explicit, non-destructive message and a working retry path rather than a permanent spinner;
- SQLite open, reads and answer writes are serialized through one repository queue;
- writes accepted before shutdown are drained durably, concurrent `close()` callers share the same close future, and new work is rejected once shutdown starts;
- database constraints and runtime checks reject impossible attempt/correct counters;
- incorrect attempts do not evolve the egg, a correct attempt does, later incorrect attempts cannot undo evolution, and state survives close/reopen;
- the real visible `TextField` handles correct and incorrect entry without a hidden proxy, autofocus or focus transfer;
- personalised IME learning, suggestions, autocorrect, smart quotes/dashes and autofill are disabled for the spelling field;
- semantic state distinguishes startup failure, waiting egg, evolved companion and live feedback;
- prompt playback reuses one bounded audio backend, stops superseded playback, drains an accepted play before disposal and releases its backend exactly once;
- Android APK, Linux, Windows, macOS and unsigned iOS Simulator debug builds pass;
- deterministic shell regeneration is byte-stable and leaves the committed source, platform shells, lockfile and audio copy unchanged; and
- the copied prompt audio remains byte-identical to the existing repository asset.

This is enough to retain Flutter as a serious migration candidate. It is not enough to choose migration: physical keyboard, real audio output, relaunch and accessibility checks remain open.

## Slice

The spike contains exactly:

- one local learner (`Ada`);
- one published spelling (`accident`);
- one repository-owned, pre-generated audio asset;
- one ordinary visible Flutter `TextField` with no hidden proxy, no autofocus and no focus transfer;
- correct and incorrect answer transactions;
- SQLite attempts, correct count and evolved state that survive close and reopen;
- recoverable startup failure and retry UI;
- one owned, reusable prompt-audio backend;
- one Flame-rendered egg that becomes an Inklet-like companion after a correct answer;
- semantic labels for the prompt, text field, feedback and companion stage; and
- committed Android, iOS, Linux, macOS and Windows platform shells plus `pubspec.lock`.

No commerce, Parent area, packs, cloud service, full catalogue, imported production database or complete visual port belongs in this spike.

## Continuous automated evidence

The retained `.github/workflows/flutter-flame-spike.yml` is intentionally a read-only decision gate rather than a source-generating workflow. For changes to the spike it:

1. installs the pinned Flutter 3.44.7 toolchain;
2. resolves with `--enforce-lockfile`;
3. runs strict analysis and all tests;
4. builds Android and Linux on Ubuntu, macOS and unsigned iOS Simulator on macOS, and Windows on Windows;
5. regenerates the platform shells through `scripts/scaffold-flutter-spike.sh`; and
6. fails unless regeneration leaves the committed spike byte-for-byte unchanged.

The scaffold script validates its target path and required tools, archives the lockfile with source/tests, refuses to repair committed Dart source, cleans temporary material through a trap and verifies the copied audio bytes with `cmp`.

## Physical go/no-go checks

These remain required before choosing a migration:

- stable-iOS iPhone: tap the visible field and type immediately;
- affected iOS 27 device: repeat the same bare-field check;
- Android phone: type, submit, replay audio and relaunch;
- confirm the bundled prompt is audible and repeated Listen taps stop/restart cleanly on iOS, Android and desktop;
- force-quit/relaunch preserves attempts and evolved state;
- simulate or induce a local database-open failure and confirm the retry surface is usable on a packaged build;
- VoiceOver and TalkBack reach the field, Listen, Submit, feedback, retry and companion in a sensible order;
- desktop keyboard traversal works on macOS, Windows and Linux/SteamOS.

## Go / no-go rule

Proceed to a staged migration plan only when all of the following are true:

- the slice continues to pass every automated platform build;
- the visible keyboard works promptly on the physical iPhone and Android checks;
- persistence and audio survive relaunch without platform-specific application code;
- accessibility is at least as good as the simplified Capacitor product;
- implementing the slice is demonstrably simpler than restoring equivalent reliability in the current stack; and
- the production migration can preserve the frozen spelling command/state semantics through fixtures rather than re-inventing them.

A failure on any item is evidence against a rewrite, not a reason to broaden the spike until it becomes a second unfinished product.

## Migration boundary if the physical gate is GREEN

Use Flutter widgets for profiles, Word Bank, setup, spelling input, results, Parent administration and accessibility. Use Flame only for the bounded close-up companion stage or future genuinely real-time play. Keep SQLite as the local source of truth and port behaviour from existing fixtures one vertical slice at a time.

Do not build separate SwiftUI and Android products, and do not turn the text-heavy application into a full-engine Godot UI unless the product itself is deliberately redesigned to be game-first.
