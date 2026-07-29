import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as paths;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../lib/attempt_repository.dart';

void main() {
  sqfliteFfiInit();

  test('answers are serialized and survive repository close and reopen', () async {
    final Directory directory = await Directory.systemTemp.createTemp(
      'ks2-spelling-flutter-spike-',
    );
    final String databasePath = paths.join(directory.path, 'learner.sqlite');
    addTearDown(() async {
      await directory.delete(recursive: true);
    });

    final AttemptRepository first = AttemptRepository(
      databaseFactory: databaseFactoryFfi,
      databasePath: databasePath,
    );
    addTearDown(first.close);

    // Concurrent first use must share one ordered lifecycle rather than racing
    // two database handles into the same path.
    final List<AttemptSnapshot> initial = await Future.wait(<Future<AttemptSnapshot>>[
      first.read(),
      first.read(),
    ]);
    expect(initial.map((AttemptSnapshot value) => value.attempts), everyElement(0));

    await Future.wait(<Future<AttemptSnapshot>>[
      first.recordAnswer(correct: false),
      first.recordAnswer(correct: true),
    ]);
    final AttemptSnapshot afterConcurrentAnswers = await first.read();
    expect(afterConcurrentAnswers.attempts, 2);
    expect(afterConcurrentAnswers.correctCount, 1);
    expect(afterConcurrentAnswers.evolved, isTrue);

    final AttemptSnapshot laterIncorrect = await first.recordAnswer(correct: false);
    expect(laterIncorrect.attempts, 3);
    expect(laterIncorrect.correctCount, 1);
    expect(laterIncorrect.evolved, isTrue);

    // A write already accepted by the queue must finish durably even when two
    // shutdown callers arrive before it starts. Both close futures represent
    // the same actual database close.
    final Future<AttemptSnapshot> acceptedBeforeClose =
        first.recordAnswer(correct: false);
    final Future<void> firstClose = first.close();
    final Future<void> secondClose = first.close();
    final AttemptSnapshot drained = await acceptedBeforeClose;
    expect(drained.attempts, 4);
    expect(drained.correctCount, 1);
    await Future.wait(<Future<void>>[firstClose, secondClose]);

    await expectLater(first.read(), throwsStateError);

    final AttemptRepository reopened = AttemptRepository(
      databaseFactory: databaseFactoryFfi,
      databasePath: databasePath,
    );
    addTearDown(reopened.close);
    final AttemptSnapshot recovered = await reopened.read();
    expect(recovered.learnerId, AttemptRepository.learnerId);
    expect(recovered.nickname, AttemptRepository.nickname);
    expect(recovered.attempts, 4);
    expect(recovered.correctCount, 1);
    expect(recovered.evolved, isTrue);
  });
}
