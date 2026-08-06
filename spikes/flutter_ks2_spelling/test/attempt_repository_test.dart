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

  test('malformed persisted learner data is rejected at the read boundary', () async {
    final Directory directory = await Directory.systemTemp.createTemp(
      'ks2-spelling-flutter-corrupt-',
    );
    final String databasePath = paths.join(directory.path, 'learner.sqlite');
    addTearDown(() async {
      await directory.delete(recursive: true);
    });

    final AttemptRepository seeded = AttemptRepository(
      databaseFactory: databaseFactoryFfi,
      databasePath: databasePath,
    );
    await seeded.read();
    await seeded.close();

    final Database raw = await databaseFactoryFfi.openDatabase(databasePath);
    final int changed = await raw.update(
      'learner_state',
      <String, Object>{'nickname': '   '},
      where: 'learner_id = ?',
      whereArgs: <Object>[AttemptRepository.learnerId],
    );
    expect(changed, 1);
    await raw.close();

    final AttemptRepository corrupted = AttemptRepository(
      databaseFactory: databaseFactoryFfi,
      databasePath: databasePath,
    );
    await expectLater(corrupted.read(), throwsStateError);
    await corrupted.close();
  });

  test('evolution must agree with whether a correct answer exists', () async {
    final Directory directory = await Directory.systemTemp.createTemp(
      'ks2-spelling-flutter-evolution-',
    );
    addTearDown(() async {
      await directory.delete(recursive: true);
    });

    final List<Map<String, Object>> contradictions = <Map<String, Object>>[
      <String, Object>{'attempts': 1, 'correct_count': 1, 'evolved': 0},
      <String, Object>{'attempts': 1, 'correct_count': 0, 'evolved': 1},
    ];

    for (int index = 0; index < contradictions.length; index += 1) {
      final String databasePath = paths.join(
        directory.path,
        'learner-$index.sqlite',
      );
      final AttemptRepository seeded = AttemptRepository(
        databaseFactory: databaseFactoryFfi,
        databasePath: databasePath,
      );
      await seeded.read();
      await seeded.close();

      final Database raw = await databaseFactoryFfi.openDatabase(databasePath);
      final int changed = await raw.update(
        'learner_state',
        contradictions[index],
        where: 'learner_id = ?',
        whereArgs: <Object>[AttemptRepository.learnerId],
      );
      expect(changed, 1);
      await raw.close();

      final AttemptRepository corrupted = AttemptRepository(
        databaseFactory: databaseFactoryFfi,
        databasePath: databasePath,
      );
      await expectLater(corrupted.read(), throwsStateError);
      await corrupted.close();
    }
  });
}
