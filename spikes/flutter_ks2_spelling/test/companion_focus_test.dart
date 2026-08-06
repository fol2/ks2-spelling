import 'package:flame/game.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../lib/attempt_repository.dart';
import '../lib/companion_game.dart';
import '../lib/prompt_audio.dart';
import '../lib/spelling_spike_app.dart';

final class _FocusAttemptStore implements AttemptStore {
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
    throw UnimplementedError('answer saving is outside this focus test');
  }

  @override
  Future<void> close() async {}
}

final class _FocusPromptAudio implements PromptAudio {
  @override
  Future<void> play() async {}

  @override
  Future<void> dispose() async {}
}

void main() {
  testWidgets('the decorative Flame canvas stays out of keyboard traversal', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      SpellingSpikeApp(
        repository: _FocusAttemptStore(),
        audio: _FocusPromptAudio(),
      ),
    );

    final Finder gameFinder = find.byType(GameWidget<CompanionEvolutionGame>);
    for (int frame = 0; frame < 100 && gameFinder.evaluate().isEmpty; frame += 1) {
      await tester.pump(const Duration(milliseconds: 20));
    }

    expect(gameFinder, findsOneWidget);
    final GameWidget<CompanionEvolutionGame> game = tester.widget(gameFinder);
    expect(game.autofocus, isFalse);

    final Finder excluded = find.ancestor(
      of: gameFinder,
      matching: find.byType(ExcludeFocus),
    );
    expect(excluded, findsOneWidget);
    expect(tester.widget<ExcludeFocus>(excluded).excluding, isTrue);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
  });
}
