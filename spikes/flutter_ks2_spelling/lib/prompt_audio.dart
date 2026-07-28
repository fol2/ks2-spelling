import 'package:flame_audio/flame_audio.dart';

abstract interface class PromptAudio {
  Future<void> play();
}

final class FlamePromptAudio implements PromptAudio {
  static const String assetName = 'accident-word.m4a';

  @override
  Future<void> play() async {
    await FlameAudio.play(assetName);
  }
}

final class SilentPromptAudio implements PromptAudio {
  @override
  Future<void> play() async {}
}
