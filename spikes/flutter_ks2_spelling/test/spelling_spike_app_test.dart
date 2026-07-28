import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';

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

final class MemoryAttemptStore implements AttemptStore {
  AttemptSnapshot _snapshot = const AttemptSnapshot(
    learnerId: AttemptRepository.learnerId,
    nickname: AttemptRepository.nickname,
    attempts: 0,
    correctCount: 0,
    evolved: false,
  );

  @override
  Future<AttemptSnapshot> read() async => _snapshot;

  @override
  Future<AttemptSnapshot> recordAnswer({required bool correct}) async {
    _snapshot = AttemptSnapshot(
      learnerId: _snapshot.learnerId,
      nickname: _snapshot.nickname,
      attempts: _snapshot.attempts + 1,
      correctCount: _snapshot.correctCount + (correct ? 1 : 0),
      evolved: _snapshot.evolved || correct,
    );
    return _snapshot;
  }
}

Future<void> pumpUntilFound(
  WidgetTester tester,
  Finder finder,
) async {
  for (int frame = 0; frame < 100; frame += 1) {
    await tester.pump(const Duration(milliseconds: 20));
    if (finder.evaluate().isNotEmpty) {
      return;
    }
  }
  throw TestFailure('Timed out waiting for $finder.');
}

void main() {
  testWidgets('the visible field records and exposes a companion evolution', (
    WidgetTester tester,
  ) async {
    final MemoryAttemptStore repository = MemoryAttemptStore();
    final RecordingPromptAudio audio = RecordingPromptAudio();

    await tester.pumpWidget(
      SpellingSpikeApp(repository: repository, audio: audio),
    );

    final Finder inputFinder = find.byKey(const Key('spelling-input'));
    await pumpUntilFound(tester, inputFinder);
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
    await pumpUntilFound(
      tester,
      find.text('Correct. The egg has evolved into a companion.'),
    );

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

    final SemanticsHandle semantics = tester.ensureSemantics();
    await tester.pump();
    final SemanticsNode companion = tester.getSemantics(
      find.byKey(const Key('companion-semantics')),
    );
    semantics.dispose();
    expect(companion.label, contains('newly evolved'));

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
  });
}
