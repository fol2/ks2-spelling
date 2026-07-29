import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';

import '../lib/attempt_repository.dart';
import '../lib/prompt_audio.dart';
import '../lib/spelling_spike_app.dart';

class RecordingPromptAudio implements PromptAudio {
  int playCount = 0;
  int disposeCount = 0;

  @override
  Future<void> play() async {
    playCount += 1;
  }

  @override
  Future<void> dispose() async {
    disposeCount += 1;
  }
}

class MemoryAttemptStore implements AttemptStore {
  AttemptSnapshot _snapshot = const AttemptSnapshot(
    learnerId: AttemptRepository.learnerId,
    nickname: AttemptRepository.nickname,
    attempts: 0,
    correctCount: 0,
    evolved: false,
  );
  int closeCount = 0;

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

  @override
  Future<void> close() async {
    closeCount += 1;
  }
}

final class FailOnceAttemptStore implements AttemptStore {
  FailOnceAttemptStore(this.delegate);

  final MemoryAttemptStore delegate;
  bool _shouldFail = true;

  @override
  Future<AttemptSnapshot> read() async {
    if (_shouldFail) {
      _shouldFail = false;
      throw StateError('simulated open failure');
    }
    return delegate.read();
  }

  @override
  Future<AttemptSnapshot> recordAnswer({required bool correct}) =>
      delegate.recordAnswer(correct: correct);

  @override
  Future<void> close() => delegate.close();
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

Future<Finder> mountVisibleField(
  WidgetTester tester,
  AttemptStore repository,
  PromptAudio audio,
) async {
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
  expect(input.enableIMEPersonalizedLearning, isFalse);
  expect(input.autofillHints, isEmpty);
  return inputFinder;
}

Future<void> unmountAndVerifyCleanup(
  WidgetTester tester,
  MemoryAttemptStore repository,
  RecordingPromptAudio audio,
) async {
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump();
  expect(repository.closeCount, 1);
  expect(audio.disposeCount, 1);
}

void main() {
  testWidgets('the visible field records and exposes a companion evolution', (
    WidgetTester tester,
  ) async {
    final MemoryAttemptStore repository = MemoryAttemptStore();
    final RecordingPromptAudio audio = RecordingPromptAudio();
    final Finder inputFinder = await mountVisibleField(tester, repository, audio);

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
      find.text('1 correct from 1 attempt · saved in SQLite'),
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

    await unmountAndVerifyCleanup(tester, repository, audio);
  });

  testWidgets('an incorrect spelling stays editable and does not evolve the egg', (
    WidgetTester tester,
  ) async {
    final MemoryAttemptStore repository = MemoryAttemptStore();
    final RecordingPromptAudio audio = RecordingPromptAudio();
    final Finder inputFinder = await mountVisibleField(tester, repository, audio);

    await tester.enterText(inputFinder, 'accidant');
    final Finder submit = find.byKey(const Key('submit-button'));
    await tester.ensureVisible(submit);
    await tester.tap(submit);
    await pumpUntilFound(
      tester,
      find.text('Not yet. Listen again and try once more.'),
    );

    final AttemptSnapshot saved = await repository.read();
    expect(saved.attempts, 1);
    expect(saved.correctCount, 0);
    expect(saved.evolved, isFalse);
    expect(tester.widget<TextField>(inputFinder).controller?.text, 'accidant');

    final SemanticsHandle semantics = tester.ensureSemantics();
    await tester.pump();
    final SemanticsNode egg = tester.getSemantics(
      find.byKey(const Key('companion-semantics')),
    );
    semantics.dispose();
    expect(egg.label, contains('waiting to hatch'));

    await unmountAndVerifyCleanup(tester, repository, audio);
  });

  testWidgets('a startup failure is visible, preserves data wording and can retry', (
    WidgetTester tester,
  ) async {
    final MemoryAttemptStore delegate = MemoryAttemptStore();
    final FailOnceAttemptStore repository = FailOnceAttemptStore(delegate);
    final RecordingPromptAudio audio = RecordingPromptAudio();

    await tester.pumpWidget(
      SpellingSpikeApp(repository: repository, audio: audio),
    );
    await pumpUntilFound(
      tester,
      find.byKey(const Key('load-error-title')),
    );

    expect(find.text('Local learner state needs attention'), findsOneWidget);
    expect(
      find.textContaining('Your existing data was not replaced.'),
      findsOneWidget,
    );
    expect(find.byKey(const Key('spelling-input')), findsNothing);

    await tester.tap(find.byKey(const Key('retry-load-button')));
    await pumpUntilFound(tester, find.byKey(const Key('spelling-input')));
    expect(find.byKey(const Key('spelling-input')), findsOneWidget);

    await unmountAndVerifyCleanup(tester, delegate, audio);
  });
}
