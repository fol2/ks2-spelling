import 'dart:async';

import 'package:flame_audio/flame_audio.dart';

typedef StopPlayback = Future<void> Function();
typedef PromptAudioBackendFactory = Future<PromptAudioBackend> Function();

abstract interface class PromptAudio {
  Future<void> play();

  Future<void> dispose();
}

abstract interface class PromptAudioBackend {
  Future<StopPlayback> start();

  Future<void> dispose();
}

final class _FlamePromptAudioBackend implements PromptAudioBackend {
  const _FlamePromptAudioBackend(this.pool);

  final AudioPool pool;

  @override
  Future<StopPlayback> start() async {
    final StopFunction stop = await pool.start();
    return () => stop();
  }

  @override
  Future<void> dispose() => pool.dispose();
}

final class FlamePromptAudio implements PromptAudio {
  FlamePromptAudio({PromptAudioBackendFactory? backendFactory})
      : _backendFactory = backendFactory ?? _createBackend;

  static const String assetName = 'accident-word.m4a';

  final PromptAudioBackendFactory _backendFactory;
  PromptAudioBackend? _backend;
  StopPlayback? _activeStop;
  Future<void> _operationTail = Future<void>.value();
  Future<void>? _disposeFuture;
  bool _disposed = false;

  static Future<PromptAudioBackend> _createBackend() async {
    final AudioPool pool = await FlameAudio.createPool(
      assetName,
      minPlayers: 1,
      maxPlayers: 1,
    );
    return _FlamePromptAudioBackend(pool);
  }

  Future<T> _enqueue<T>(Future<T> Function() operation) {
    if (_disposed) {
      return Future<T>.error(StateError('FlamePromptAudio is disposed.'));
    }
    final Completer<T> completer = Completer<T>();
    _operationTail = _operationTail.then((_) async {
      // A play accepted before dispose() starts is allowed to acquire a player;
      // dispose then waits for it and stops it before releasing the pool.
      try {
        completer.complete(await operation());
      } on Object catch (error, stackTrace) {
        completer.completeError(error, stackTrace);
      }
    });
    return completer.future;
  }

  Future<PromptAudioBackend> _requireBackend() async {
    final PromptAudioBackend? existing = _backend;
    if (existing != null) {
      return existing;
    }
    final PromptAudioBackend created = await _backendFactory();
    _backend = created;
    return created;
  }

  @override
  Future<void> play() => _enqueue<void>(() async {
    final PromptAudioBackend backend = await _requireBackend();
    final StopPlayback? previous = _activeStop;
    if (previous != null) {
      // Keep the handle until stopping succeeds. If a platform player reports a
      // transient stop failure, the next replay or disposal must retry it rather
      // than starting an overlapping player whose predecessor is untracked.
      await previous();
      _activeStop = null;
    }
    _activeStop = await backend.start();
  });

  @override
  Future<void> dispose() {
    final Future<void>? existing = _disposeFuture;
    if (existing != null) {
      return existing;
    }

    _disposed = true;
    final Future<void> disposing = _disposeOnce();
    _disposeFuture = disposing;
    return disposing;
  }

  Future<void> _disposeOnce() async {
    await _operationTail;
    final StopPlayback? stop = _activeStop;
    _activeStop = null;
    final PromptAudioBackend? backend = _backend;
    _backend = null;
    try {
      await stop?.call();
    } finally {
      // A plugin/player stop failure must not leak the one owned pool.
      await backend?.dispose();
    }
  }
}

final class SilentPromptAudio implements PromptAudio {
  @override
  Future<void> play() async {}

  @override
  Future<void> dispose() async {}
}
