import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as paths;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../lib/attempt_repository.dart';

void main() {
  sqfliteFfiInit();

  test('answers are atomic and survive repository close and reopen', () async {
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

    // Concurrent first use must share one opening lifecycle rather than racing
    // two database handles into the same path.
    final List<AttemptSnapshot> initial = await Future.wait(<Future<AttemptSnapshot>>[
      first.read(),
      first.read(),
    ]);
    expect(initial.map((AttemptSnapshot value) => value.attempts), everyElement(0));

    final AttemptSnapshot incorrect = await first.recordAnswer(correct: false);
    expect(incorrect.attempts, 1);
    expect(incorrect.correctCount, 0);
    expect(incorrect.evolved, isFalse);

    final AttemptSnapshot correct = await first.recordAnswer(correct: true);
    expect(correct.attempts, 2);
    expect(correct.correctCount, 1);
    expect(correct.evolved, isTrue);

    final AttemptSnapshot laterIncorrect = await first.recordAnswer(correct: false);
    expect(laterIncorrect.attempts, 3);
    expect(laterIncorrect.correctCount, 1);
    expect(laterIncorrect.evolved, isTrue);
    await first.close();

    final AttemptRepository reopened = AttemptRepository(
      databaseFactory: databaseFactoryFfi,
      databasePath: databasePath,
    );
    addTearDown(reopened.close);
    final AttemptSnapshot recovered = await reopened.read();
    expect(recovered.learnerId, AttemptRepository.learnerId);
    expect(recovered.nickname, AttemptRepository.nickname);
    expect(recovered.attempts, 3);
    expect(recovered.correctCount, 1);
    expect(recovered.evolved, isTrue);
  });
}
