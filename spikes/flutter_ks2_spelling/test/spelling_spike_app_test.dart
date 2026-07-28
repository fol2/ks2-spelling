import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../lib/attempt_repository.dart';
import '../lib/prompt_audio.dart';
import '../lib/spelling_spike_app.dart';

final class RecordingPromptAudio implements PromptAudio {
  int playCount = 0;

  @override
  Future<void> play() async {
    playCount += 1;
  }
}

void main() {
  sqfliteFfiInit();

  testWidgets('the visible field records and exposes a companion evolution', (
    WidgetTester tester,
  ) async {
    final AttemptRepository repository = AttemptRepository(
      databaseFactory: databaseFactoryFfi,
      databasePath: inMemoryDatabasePath,
    );
    final RecordingPromptAudio audio = RecordingPromptAudio();
    final SemanticsHandle semantics = tester.ensureSemantics();
    addTearDown(semantics.dispose);
    addTearDown(repository.close);

    await tester.pumpWidget(
      SpellingSpikeApp(repository: repository, audio: audio),
    );
    for (int frame = 0; frame < 5; frame += 1) {
      await tester.pump(const Duration(milliseconds: 20));
    }

    final Finder inputFinder = find.byKey(const Key('spelling-input'));
    expect(inputFinder, findsOneWidget);
    final TextField input = tester.widget<TextField>(inputFinder);
    expect(input.autofocus, isFalse);
    expect(input.autocorrect, isFalse);
    expect(input.enableSuggestions, isFalse);

    await tester.tap(find.byKey(const Key('listen-button')));
    await tester.pump();
    expect(audio.playCount, 1);

    await tester.enterText(inputFinder, 'accident');
    final Finder submit = find.byKey(const Key('submit-button'));
    await tester.ensureVisible(submit);
    await tester.tap(submit);
    for (int frame = 0; frame < 6; frame += 1) {
      await tester.pump(const Duration(milliseconds: 20));
    }

    expect(
      find.text('Correct. The egg has evolved into a companion.'),
      findsOneWidget,
    );
    expect(
      find.text('1 correct from 1 attempts · saved in SQLite'),
      findsOneWidget,
    );
    final AttemptSnapshot saved = await repository.read();
    expect(saved.attempts, 1);
    expect(saved.correctCount, 1);
    expect(saved.evolved, isTrue);

    final SemanticsNode companion = tester.getSemantics(
      find.byKey(const Key('companion-semantics')),
    );
    expect(companion.label, contains('newly evolved'));

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
  });
}
