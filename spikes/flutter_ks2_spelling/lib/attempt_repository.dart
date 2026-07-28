import 'dart:io';

import 'package:path/path.dart' as paths;
import 'package:path_provider/path_provider.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

typedef DirectoryProvider = Future<Directory> Function();

final class AttemptSnapshot {
  const AttemptSnapshot({
    required this.learnerId,
    required this.nickname,
    required this.attempts,
    required this.correctCount,
    required this.evolved,
  });

  final String learnerId;
  final String nickname;
  final int attempts;
  final int correctCount;
  final bool evolved;
}

final class AttemptRepository {
  AttemptRepository({
    DatabaseFactory? databaseFactory,
    String? databasePath,
    DirectoryProvider? directoryProvider,
  }) : _requestedFactory = databaseFactory,
       _databasePath = databasePath,
       _directoryProvider = directoryProvider ?? getApplicationSupportDirectory;

  static const String learnerId = 'learner-a';
  static const String nickname = 'Ada';

  final DatabaseFactory? _requestedFactory;
  final String? _databasePath;
  final DirectoryProvider _directoryProvider;
  Database? _database;

  Future<void> open() async {
    if (_database != null) {
      return;
    }

    sqfliteFfiInit();
    final DatabaseFactory factory = _requestedFactory ?? databaseFactoryFfi;
    final String path = _databasePath ??
        paths.join(
          (await _directoryProvider()).path,
          'ks2-spelling-flutter-spike.sqlite',
        );

    final Database database = await factory.openDatabase(
      path,
      options: OpenDatabaseOptions(
        version: 1,
        onCreate: (Database db, int version) async {
          await db.execute('''
            CREATE TABLE learner_state (
              learner_id TEXT PRIMARY KEY,
              nickname TEXT NOT NULL,
              attempts INTEGER NOT NULL,
              correct_count INTEGER NOT NULL,
              evolved INTEGER NOT NULL CHECK (evolved IN (0, 1))
            )
          ''');
        },
      ),
    );

    await database.insert(
      'learner_state',
      <String, Object>{
        'learner_id': learnerId,
        'nickname': nickname,
        'attempts': 0,
        'correct_count': 0,
        'evolved': 0,
      },
      conflictAlgorithm: ConflictAlgorithm.ignore,
    );
    _database = database;
  }

  Future<AttemptSnapshot> read() async {
    await open();
    final List<Map<String, Object?>> rows = await _requireDatabase().query(
      'learner_state',
      where: 'learner_id = ?',
      whereArgs: <Object>[learnerId],
      limit: 1,
    );
    if (rows.length != 1) {
      throw StateError('The bounded learner state is unavailable.');
    }
    return _snapshotFromRow(rows.single);
  }

  Future<AttemptSnapshot> recordAnswer({required bool correct}) async {
    await open();
    final Database database = _requireDatabase();
    await database.transaction((Transaction transaction) async {
      final List<Map<String, Object?>> rows = await transaction.query(
        'learner_state',
        columns: <String>['attempts', 'correct_count', 'evolved'],
        where: 'learner_id = ?',
        whereArgs: <Object>[learnerId],
        limit: 1,
      );
      if (rows.length != 1) {
        throw StateError('The bounded learner state is unavailable.');
      }
      final Map<String, Object?> row = rows.single;
      final int attempts = row['attempts']! as int;
      final int correctCount = row['correct_count']! as int;
      final bool evolved = (row['evolved']! as int) == 1;

      await transaction.update(
        'learner_state',
        <String, Object>{
          'attempts': attempts + 1,
          'correct_count': correctCount + (correct ? 1 : 0),
          'evolved': (evolved || correct) ? 1 : 0,
        },
        where: 'learner_id = ?',
        whereArgs: <Object>[learnerId],
      );
    });
    return read();
  }

  Future<void> close() async {
    final Database? database = _database;
    _database = null;
    await database?.close();
  }

  Database _requireDatabase() {
    final Database? database = _database;
    if (database == null) {
      throw StateError('AttemptRepository has not opened.');
    }
    return database;
  }

  AttemptSnapshot _snapshotFromRow(Map<String, Object?> row) {
    return AttemptSnapshot(
      learnerId: row['learner_id']! as String,
      nickname: row['nickname']! as String,
      attempts: row['attempts']! as int,
      correctCount: row['correct_count']! as int,
      evolved: (row['evolved']! as int) == 1,
    );
  }
}
