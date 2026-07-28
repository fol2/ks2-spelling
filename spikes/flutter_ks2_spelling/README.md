# KS2 Spelling Flutter + Flame spike

This directory is an isolated architecture comparison. It is not the shipping application and does not authorise a rewrite.

The slice proves one visible Flutter text field, one repository-owned audio prompt, one SQLite learner transaction and one bounded Flame companion scene. The generated native shells target Android, iOS, Linux, macOS and Windows.

The authoritative decision and physical-device gates are in `../../docs/spikes/flutter-flame-vertical-slice.md`.

After the generated platform files and lockfile exist:

```sh
flutter pub get
flutter analyze
flutter test
flutter run
```

The expected learner flow is:

1. Tap **Listen**.
2. Tap the actual **Your spelling** field.
3. Type `accident`.
4. Submit.
5. The SQLite counters update and the Flame egg becomes a companion.
6. Close and reopen the app to confirm the state remains.
