import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as paths;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../lib/attempt_repository.dart';

void main() {
  sqfliteFfiInit();

  test('a correct answer survives repository close and reopen', () async {
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
    await first.open();
    final AttemptSnapshot recorded = await first.recordAnswer(correct: true);
    expect(recorded.attempts, 1);
    expect(recorded.correctCount, 1);
    expect(recorded.evolved, isTrue);
    await first.close();

    final AttemptRepository reopened = AttemptRepository(
      databaseFactory: databaseFactoryFfi,
      databasePath: databasePath,
    );
    addTearDown(reopened.close);
    final AttemptSnapshot recovered = await reopened.read();
    expect(recovered.learnerId, AttemptRepository.learnerId);
    expect(recovered.nickname, AttemptRepository.nickname);
    expect(recovered.attempts, 1);
    expect(recovered.correctCount, 1);
    expect(recovered.evolved, isTrue);
  });
}
