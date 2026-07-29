# KS2 Spelling Flutter + Flame spike

This directory is an isolated architecture comparison. It is not the shipping application and does not authorise a rewrite.

The slice proves one visible Flutter text field, recoverable local startup, serialized SQLite answer persistence, one owned prompt-audio backend and one bounded Flame companion scene. Its committed native shells target Android, iOS, Linux, macOS and Windows.

The authoritative decision and physical-device gates are in `../../docs/spikes/flutter-flame-vertical-slice.md`.

## Run the committed slice

Use Flutter 3.44.7, then keep the checked-in package graph exact:

```sh
flutter pub get --enforce-lockfile
flutter analyze
flutter test
flutter run
```

To prove the generated platform shells still match the pinned Flutter template and the repository-owned audio source:

```sh
bash ../../scripts/scaffold-flutter-spike.sh
git diff --exit-code -- .
```

The scaffold command deliberately fails if committed Dart source has the wrong repository interface. It does not repair source while generating shells.

## Learner flow

1. Tap **Listen**.
2. Tap the actual **Your spelling** field.
3. Type `accident`.
4. Submit.
5. The SQLite counters update and the Flame egg becomes a companion.
6. Close and reopen the app to confirm the state remains.

An incorrect spelling remains selected for correction and does not evolve the egg. If local state cannot open, the app renders a non-destructive error and **Try opening again** action instead of remaining on a spinner.

Repeated **Listen** actions reuse one bounded audio backend and stop the superseded playback before starting again. Page disposal drains accepted database/audio work and then closes the owned resources.
