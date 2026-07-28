import 'package:flutter/material.dart';

import 'attempt_repository.dart';
import 'prompt_audio.dart';
import 'spelling_spike_app.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final AttemptRepository repository = AttemptRepository();
  await repository.open();
  runApp(
    SpellingSpikeApp(
      repository: repository,
      audio: FlamePromptAudio(),
    ),
  );
}
