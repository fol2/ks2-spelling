import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../lib/attempt_repository.dart';
import '../lib/prompt_audio.dart';
import '../lib/spelling_spike_app.dart';

final class SynchronousCleanupAttemptStore implements AttemptStore {
  int closeCount = 0;

  @override
  Future<AttemptSnapshot> read() async => const AttemptSnapshot(
    learnerId: AttemptRepository.learnerId,
    nickname: AttemptRepository.nickname,
    attempts: 0,
    correctCount: 0,
    evolved: false,
  );

  @override
  Future<AttemptSnapshot> recordAnswer({required bool correct}) {
    throw UnimplementedError('answer recording is outside this cleanup test');
  }

  @override
  Future<void> close() {
    closeCount += 1;
    throw StateError('synchronous repository cleanup failure');
  }
}

final class SynchronousCleanupPromptAudio implements PromptAudio {
  int disposeCount = 0;

  @override
  Future<void> play() {
    throw UnimplementedError('playback is outside this cleanup test');
  }

  @override
  Future<void> dispose() {
    disposeCount += 1;
    throw StateError('synchronous audio cleanup failure');
  }
}

Future<void> pumpUntilField(WidgetTester tester) async {
  final Finder field = find.byKey(const Key('spelling-input'));
  for (int frame = 0; frame < 100 && field.evaluate().isEmpty; frame += 1) {
    await tester.pump(const Duration(milliseconds: 20));
  }
  expect(field, findsOneWidget);
}

void main() {
  testWidgets('synchronous cleanup failures cross the reporting boundary', (
    WidgetTester tester,
  ) async {
    final SynchronousCleanupAttemptStore repository =
        SynchronousCleanupAttemptStore();
    final SynchronousCleanupPromptAudio audio =
        SynchronousCleanupPromptAudio();
    final List<FlutterErrorDetails> reported = <FlutterErrorDetails>[];
    final previousHandler = FlutterError.onError;
    FlutterError.onError = reported.add;
    addTearDown(() {
      FlutterError.onError = previousHandler;
    });

    await tester.pumpWidget(
      SpellingSpikeApp(repository: repository, audio: audio),
    );
    await pumpUntilField(tester);
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();

    expect(repository.closeCount, 1);
    expect(audio.disposeCount, 1);
    expect(reported, hasLength(2));
    expect(
      reported.map((FlutterErrorDetails details) => details.exceptionAsString()),
      containsAll(<String>[
        'Bad state: synchronous repository cleanup failure',
        'Bad state: synchronous audio cleanup failure',
      ]),
    );
  });
}
