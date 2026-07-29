import 'dart:async';

import 'package:flame_audio/flame_audio.dart';

abstract interface class PromptAudio {
  Future<void> play();

  Future<void> dispose();
}

final class FlamePromptAudio implements PromptAudio {
  static const String assetName = 'accident-word.m4a';

  AudioPool? _pool;
  StopFunction? _activeStop;
  Future<void> _operationTail = Future<void>.value();
  bool _disposed = false;

  Future<T> _enqueue<T>(Future<T> Function() operation) {
    if (_disposed) {
      return Future<T>.error(StateError('FlamePromptAudio is disposed.'));
    }
    final Completer<T> completer = Completer<T>();
    _operationTail = _operationTail.then((_) async {
      if (_disposed) {
        completer.completeError(StateError('FlamePromptAudio is disposed.'));
        return;
      }
      try {
        completer.complete(await operation());
      } on Object catch (error, stackTrace) {
        completer.completeError(error, stackTrace);
      }
    });
    return completer.future;
  }

  Future<AudioPool> _requirePool() async {
    final AudioPool? existing = _pool;
    if (existing != null) {
      return existing;
    }
    final AudioPool created = await FlameAudio.createPool(
      assetName,
      minPlayers: 1,
      maxPlayers: 1,
    );
    _pool = created;
    return created;
  }

  @override
  Future<void> play() => _enqueue<void>(() async {
    final AudioPool pool = await _requirePool();
    final StopFunction? previous = _activeStop;
    _activeStop = null;
    if (previous != null) {
      await previous();
    }
    _activeStop = await pool.start();
  });

  @override
  Future<void> dispose() async {
    if (_disposed) {
      return;
    }
    _disposed = true;
    await _operationTail;
    final StopFunction? stop = _activeStop;
    _activeStop = null;
    await stop?.call();
    final AudioPool? pool = _pool;
    _pool = null;
    await pool?.dispose();
  }
}

final class SilentPromptAudio implements PromptAudio {
  @override
  Future<void> play() async {}

  @override
  Future<void> dispose() async {}
}
