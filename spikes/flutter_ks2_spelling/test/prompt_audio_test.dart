import 'dart:async';

import 'package:flutter_test/flutter_test.dart';

import '../lib/prompt_audio.dart';

final class RecordingPromptAudioBackend implements PromptAudioBackend {
  final List<String> events = <String>[];
  int startCount = 0;

  @override
  Future<StopPlayback> start() async {
    startCount += 1;
    final int playbackId = startCount;
    events.add('start:$playbackId');
    bool stopped = false;
    return () async {
      if (stopped) {
        return;
      }
      stopped = true;
      events.add('stop:$playbackId');
    };
  }

  @override
  Future<void> dispose() async {
    events.add('dispose');
  }
}

final class GatedPromptAudioBackend implements PromptAudioBackend {
  final Completer<void> allowStart = Completer<void>();
  final List<String> events = <String>[];

  @override
  Future<StopPlayback> start() async {
    events.add('start-requested');
    await allowStart.future;
    events.add('start-completed');
    bool stopped = false;
    return () async {
      if (stopped) {
        return;
      }
      stopped = true;
      events.add('stop');
    };
  }

  @override
  Future<void> dispose() async {
    events.add('dispose');
  }
}

void main() {
  test('repeated playback reuses one backend and stops superseded audio', () async {
    final RecordingPromptAudioBackend backend = RecordingPromptAudioBackend();
    int factoryCalls = 0;
    final FlamePromptAudio audio = FlamePromptAudio(
      backendFactory: () async {
        factoryCalls += 1;
        return backend;
      },
    );

    await audio.play();
    await audio.play();
    final Future<void> firstDispose = audio.dispose();
    final Future<void> secondDispose = audio.dispose();
    await Future.wait(<Future<void>>[firstDispose, secondDispose]);

    expect(factoryCalls, 1);
    expect(
      backend.events,
      <String>[
        'start:1',
        'stop:1',
        'start:2',
        'stop:2',
        'dispose',
      ],
    );
    await expectLater(audio.play(), throwsStateError);
  });

  test('dispose drains playback accepted before shutdown', () async {
    final GatedPromptAudioBackend backend = GatedPromptAudioBackend();
    final FlamePromptAudio audio = FlamePromptAudio(
      backendFactory: () async => backend,
    );

    final Future<void> acceptedPlayback = audio.play();
    final Future<void> firstDispose = audio.dispose();
    final Future<void> secondDispose = audio.dispose();
    await Future<void>.delayed(Duration.zero);

    expect(backend.events, <String>['start-requested']);
    backend.allowStart.complete();
    await acceptedPlayback;
    await Future.wait(<Future<void>>[firstDispose, secondDispose]);

    expect(
      backend.events,
      <String>[
        'start-requested',
        'start-completed',
        'stop',
        'dispose',
      ],
    );
  });
}
