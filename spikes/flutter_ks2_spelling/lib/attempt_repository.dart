import 'dart:async';
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

abstract interface class AttemptStore {
  Future<AttemptSnapshot> read();

  Future<AttemptSnapshot> recordAnswer({required bool correct});

  Future<void> close();
}

final class _AttemptCounters {
  const _AttemptCounters({
    required this.attempts,
    required this.correctCount,
    required this.evolved,
  });

  final int attempts;
  final int correctCount;
  final bool evolved;
}

final class AttemptRepository implements AttemptStore {
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
  Future<void> _operationTail = Future<void>.value();
  Future<void>? _closeFuture;
  bool _closing = false;
  bool _closed = false;

  Future<T> _enqueue<T>(Future<T> Function() operation) {
    if (_closing || _closed) {
      return Future<T>.error(
        StateError('AttemptRepository is closing or closed.'),
      );
    }

    final Completer<T> completer = Completer<T>();
    _operationTail = _operationTail.then((_) async {
      // Operations accepted before close() began are drained in order. New
      // callers are rejected by the guard above as soon as shutdown starts.
      try {
        completer.complete(await operation());
      } on Object catch (error, stackTrace) {
        completer.completeError(error, stackTrace);
      }
    });
    return completer.future;
  }

  Future<void> open() => _enqueue<void>(_ensureOpen);

  Future<void> _ensureOpen() async {
    if (_database != null) {
      return;
    }

    sqfliteFfiInit();
    final DatabaseFactory factory = _requestedFactory ?? databaseFactoryFfi;
    final String path;
    if (_databasePath != null) {
      path = _databasePath;
    } else {
      final Directory directory = await _directoryProvider();
      await directory.create(recursive: true);
      path = paths.join(directory.path, 'ks2-spelling-flutter-spike.sqlite');
    }

    final Database database = await factory.openDatabase(
      path,
      options: OpenDatabaseOptions(
        version: 1,
        onCreate: (Database db, int version) async {
          await db.execute('''
            CREATE TABLE learner_state (
              learner_id TEXT PRIMARY KEY,
              nickname TEXT NOT NULL,
              attempts INTEGER NOT NULL CHECK (attempts >= 0),
              correct_count INTEGER NOT NULL
                CHECK (correct_count >= 0 AND correct_count <= attempts),
              evolved INTEGER NOT NULL CHECK (evolved IN (0, 1))
            )
          ''');
        },
      ),
    );

    try {
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
    } on Object {
      await database.close();
      rethrow;
    }
  }

  @override
  Future<AttemptSnapshot> read() => _enqueue<AttemptSnapshot>(() async {
    await _ensureOpen();
    return _readSnapshot(_requireDatabase());
  });

  @override
  Future<AttemptSnapshot> recordAnswer({required bool correct}) =>
      _enqueue<AttemptSnapshot>(() async {
        await _ensureOpen();
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
          final _AttemptCounters counters = _countersFromRow(rows.single);

          final int updated = await transaction.update(
            'learner_state',
            <String, Object>{
              'attempts': counters.attempts + 1,
              'correct_count': counters.correctCount + (correct ? 1 : 0),
              'evolved': (counters.evolved || correct) ? 1 : 0,
            },
            where: 'learner_id = ?',
            whereArgs: <Object>[learnerId],
          );
          if (updated != 1) {
            throw StateError('The bounded learner update was not singular.');
          }
        });
        return _readSnapshot(database);
      });

  Future<AttemptSnapshot> _readSnapshot(Database database) async {
    final List<Map<String, Object?>> rows = await database.query(
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

  @override
  Future<void> close() {
    final Future<void>? existing = _closeFuture;
    if (existing != null) {
      return existing;
    }

    _closing = true;
    final Future<void> closing = _closeOnce();
    _closeFuture = closing;
    return closing;
  }

  Future<void> _closeOnce() async {
    try {
      await _operationTail;
      final Database? database = _database;
      _database = null;
      await database?.close();
    } finally {
      _closed = true;
      _closing = false;
    }
  }

  Database _requireDatabase() {
    final Database? database = _database;
    if (database == null) {
      throw StateError('AttemptRepository has not opened.');
    }
    return database;
  }

  _AttemptCounters _countersFromRow(Map<String, Object?> row) {
    final Object? storedAttempts = row['attempts'];
    final Object? storedCorrectCount = row['correct_count'];
    final Object? storedEvolved = row['evolved'];
    if (
      storedAttempts is! int
      || storedCorrectCount is! int
      || storedAttempts < 0
      || storedCorrectCount < 0
      || storedCorrectCount > storedAttempts
    ) {
      throw StateError('The bounded learner counters are invalid.');
    }
    if (storedEvolved is! int || (storedEvolved != 0 && storedEvolved != 1)) {
      throw StateError('The bounded learner evolution flag is invalid.');
    }
    final bool evolved = storedEvolved == 1;
    if (evolved != (storedCorrectCount > 0)) {
      throw StateError(
        'The bounded learner evolution state contradicts its correct count.',
      );
    }
    return _AttemptCounters(
      attempts: storedAttempts,
      correctCount: storedCorrectCount,
      evolved: evolved,
    );
  }

  AttemptSnapshot _snapshotFromRow(Map<String, Object?> row) {
    final Object? storedLearnerId = row['learner_id'];
    final Object? storedNickname = row['nickname'];
    if (storedLearnerId is! String || storedLearnerId != learnerId) {
      throw StateError('The bounded learner identity is invalid.');
    }
    if (storedNickname is! String || storedNickname.trim().isEmpty) {
      throw StateError('The bounded learner nickname is invalid.');
    }
    final _AttemptCounters counters = _countersFromRow(row);
    return AttemptSnapshot(
      learnerId: storedLearnerId,
      nickname: storedNickname,
      attempts: counters.attempts,
      correctCount: counters.correctCount,
      evolved: counters.evolved,
    );
  }
}
