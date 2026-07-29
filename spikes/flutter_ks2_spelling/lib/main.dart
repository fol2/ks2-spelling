import 'package:flutter/material.dart';

import 'attempt_repository.dart';
import 'prompt_audio.dart';
import 'spelling_spike_app.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(
    SpellingSpikeApp(
      repository: AttemptRepository(),
      audio: FlamePromptAudio(),
    ),
  );
}
