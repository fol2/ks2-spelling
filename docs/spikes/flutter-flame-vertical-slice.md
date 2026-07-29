# Flutter + Flame vertical-slice decision gate

Date: 2026-07-28  
Automated evidence updated: 2026-07-29

## Decision this spike must support

This is not authorisation to rewrite `ks2-spelling`. It is a bounded comparison against the simplified Capacitor product recovery.

The question is whether Flutter widgets for the application surfaces, with Flame used only for the living companion scene, materially reduce platform-specific fragility while preserving the local-first spelling contract.

## Current decision

**Automated platform gate: GREEN. Migration decision: HOLD.**

The exact-head matrix proves the same committed bytes on Android, Linux, Windows, macOS and unsigned iOS Simulator. The retained gate checks out the repository-owned pull request head SHA directly, verifies it, installs Flutter 3.44.7 at exact framework commit `84fc5cbb223bc12f83d65b647ff8a56caf779ffd`, enforces the committed package lock and then analyses, tests and builds the slice.

That evidence establishes:

- strict `flutter analyze`, repository tests, widget tests and prompt-audio lifecycle tests pass on every runner family;
- Flutter mounts a recovery-capable UI before SQLite is opened, so an initial local-data failure cannot prevent the application from rendering;
- a failed initial read produces an explicit, non-destructive message and a working retry path rather than a permanent spinner;
- SQLite open, reads, answer writes and shutdown are serialized through one repository queue;
- writes accepted before shutdown are drained durably, concurrent `close()` callers share the same close future, and new work is rejected once shutdown starts;
- database constraints and runtime validation reject impossible counters, malformed evolution flags, an unexpected learner identity and a blank persisted nickname;
- persisted evolution must agree with whether at least one correct answer exists, so contradictory rows fail at the read boundary instead of rendering impossible progress;
- incorrect attempts do not evolve the egg, a correct attempt does, later incorrect attempts cannot undo evolution, and state survives close/reopen;
- the real visible `TextField` has no hidden proxy, autofocus or focus transfer and remains `readOnly: false` while an answer is saved;
- a formatter rejects attempted edits only during the SQLite transaction, preserving the active input connection; a failed save preserves the answer and unlocks editing;
- Return uses Flutter's cross-platform `TextInputAction.unspecified`, so `onSubmitted` runs without the framework's `done` action unfocusing and restarting the input connection;
- a successful save clears the field with an explicit valid caret position rather than the invalid `-1` selection produced by a bare controller clear;
- the decorative Flame canvas is explicitly excluded from focus traversal, so replacing the egg scene on evolution cannot steal focus or dismiss the spelling keyboard;
- personalised IME learning, suggestions, autocorrect, smart quotes/dashes and autofill are disabled for the spelling field;
- semantic state distinguishes startup failure, waiting egg, evolved companion and live feedback;
- unrelated Listen and feedback rebuilds reuse the same Flame game instance; only the egg/evolved transition replaces it;
- prompt playback reuses one bounded audio backend, stops superseded playback and drains accepted playback before disposal;
- a failed replay stop retains its stop handle, prevents overlapping replacement playback and is retried by the next replay or disposal;
- backend disposal still runs when a player stop throws;
- synchronous and asynchronous repository/audio cleanup failures cross one closure-based boundary and are reported through `FlutterError` rather than escaping as unhandled failures;
- Android APK, Linux, Windows, macOS and unsigned iOS Simulator debug builds pass;
- every platform build uses the already-resolved locked graph with `--no-pub` rather than silently resolving again;
- deterministic shell regeneration is byte-stable and leaves committed source, shells, lockfile and audio unchanged;
- shell generation happens in a sibling staging directory and restores the original committed spike if replacement fails; and
- the copied prompt audio remains byte-identical to the repository-owned asset.

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
- one non-focusable Flame-rendered egg that becomes an Inklet-like companion after a correct answer;
- semantic labels for the prompt, text field, feedback and companion stage; and
- committed Android, iOS, Linux, macOS and Windows platform shells plus `pubspec.lock`.

No commerce, Parent area, packs, cloud service, full catalogue, imported production database or complete visual port belongs in this spike.

## Continuous automated evidence

The retained `.github/workflows/flutter-flame-spike.yml` is intentionally read-only. For changes to the spike it:

1. accepts only the repository's own spike head, then checks out and proves its exact SHA rather than GitHub's synthetic merge commit;
2. installs Flutter 3.44.7 at exact framework commit `84fc5cbb223bc12f83d65b647ff8a56caf779ffd` and cross-checks the generated metadata;
3. resolves with `--enforce-lockfile` and proves the committed lockfile remains unchanged;
4. runs strict analysis and all tests, including workflow policy, evolution consistency, desktop focus and Return/save focus contracts;
5. builds Android, Linux, macOS, unsigned iOS Simulator and Windows with `--no-pub`;
6. regenerates the platform shells through `scripts/scaffold-flutter-spike.sh`; and
7. fails unless regeneration leaves the committed spike byte-for-byte unchanged.

The scaffold script validates its target path and required tools, archives the lockfile with source/tests, refuses to repair committed Dart source, generates into a sibling staging directory, verifies the copied audio bytes, and restores the original spike if the final replacement cannot complete.

## Physical go/no-go checks

These remain required before choosing a migration:

- stable-iOS iPhone: tap the visible field and type immediately;
- affected iOS 27 device: repeat the same bare-field check;
- Android phone: type, submit, replay audio and relaunch;
- press Return during a deliberately delayed save and confirm keys remain present while edits are rejected, then resume normally after success or failure and after egg evolution;
- confirm the bundled prompt is audible and repeated Listen taps stop/restart cleanly on iOS, Android and desktop;
- force-quit/relaunch preserves attempts and evolved state;
- simulate or induce a local database-open failure and confirm the retry surface is usable on a packaged build;
- VoiceOver and TalkBack reach the field, Listen, Submit, feedback, retry and companion in a sensible order; and
- desktop keyboard traversal reaches only meaningful controls on macOS, Windows and Linux/SteamOS.

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
