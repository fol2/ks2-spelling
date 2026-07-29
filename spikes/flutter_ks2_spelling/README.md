# KS2 Spelling Flutter + Flame spike

This directory is an isolated architecture comparison. It is not the shipping application and does not authorise a rewrite.

The slice proves one visible Flutter text field, recoverable local startup, serialized SQLite answer persistence, one owned prompt-audio backend and one bounded non-focusable Flame companion scene. Its committed native shells target Android, iOS, Linux, macOS and Windows.

The authoritative decision and physical-device gates are in `../../docs/spikes/flutter-flame-vertical-slice.md`.

## Run the committed slice

Use Flutter 3.44.7 at exact framework commit:

`84fc5cbb223bc12f83d65b647ff8a56caf779ffd`

Then keep the checked-in package graph exact:

```sh
flutter pub get --enforce-lockfile
flutter analyze
flutter test
flutter run --no-pub
```

To prove the generated platform shells still match the pinned Flutter template and the repository-owned audio source:

```sh
bash ../../scripts/scaffold-flutter-spike.sh
git diff --exit-code -- .
```

The scaffold command deliberately fails if committed Dart source has the wrong repository interface. It generates into a sibling staging directory and does not move the committed spike until generation, source restoration and audio verification succeed. A failed final replacement restores the original directory.

## Learner flow

1. Tap **Listen**.
2. Tap the actual **Your spelling** field.
3. Type `accident`.
4. Press Return or tap **Submit**.
5. The SQLite counters update and the Flame egg becomes a companion without taking focus from the spelling field.
6. Close and reopen the app to confirm the state remains.

An incorrect spelling remains selected for correction and does not evolve the egg. During a save, the real field stays mounted and writable at the Flutter widget/input-connection level, while a formatter rejects new edits until the transaction finishes. Return uses `TextInputAction.unspecified`, so Flutter calls `onSubmitted` without its normal `done`-action unfocus/restart. A successful save uses Flutter's ordinary controller clear and the widget contract proves its caret remains valid at offset `0`; a failed save preserves the answer and restores editing.

The companion `GameWidget` has autofocus disabled and sits inside `ExcludeFocus`, so the decorative canvas cannot enter desktop tab traversal or take the software-keyboard connection during egg evolution.

If local state cannot open, the app renders a non-destructive error and **Try opening again** action instead of remaining on a spinner. Persisted learner identity, nickname and counters are validated before use, and evolution must agree with whether at least one correct answer exists.

Repeated **Listen** actions reuse one bounded audio backend. The previous playback must stop before a replacement starts; a failed stop retains its handle for retry rather than allowing overlapping untracked playback. Page disposal drains accepted database/audio work and then closes the owned resources.
