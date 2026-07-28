import 'dart:async';

import 'package:flame/game.dart';
import 'package:flutter/material.dart';

import 'attempt_repository.dart';
import 'companion_game.dart';
import 'prompt_audio.dart';

final class SpellingSpikeApp extends StatelessWidget {
  const SpellingSpikeApp({
    required this.repository,
    required this.audio,
    super.key,
  });

  final AttemptRepository repository;
  final PromptAudio audio;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'KS2 Spelling Flutter spike',
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF466C68),
          brightness: Brightness.light,
        ),
        scaffoldBackgroundColor: const Color(0xFFF4F0E6),
      ),
      home: SpellingPracticePage(repository: repository, audio: audio),
    );
  }
}

final class SpellingPracticePage extends StatefulWidget {
  const SpellingPracticePage({
    required this.repository,
    required this.audio,
    super.key,
  });

  final AttemptRepository repository;
  final PromptAudio audio;

  @override
  State<SpellingPracticePage> createState() => _SpellingPracticePageState();
}

final class _SpellingPracticePageState extends State<SpellingPracticePage> {
  static const String target = 'accident';

  final TextEditingController _answerController = TextEditingController();
  AttemptSnapshot? _snapshot;
  String _feedback = 'Tap Listen, then type the spelling in the visible field.';
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void dispose() {
    _answerController.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final AttemptSnapshot snapshot = await widget.repository.read();
      if (!mounted) {
        return;
      }
      setState(() {
        _snapshot = snapshot;
      });
    } on Object {
      if (!mounted) {
        return;
      }
      setState(() {
        _feedback = 'The local learner state could not open.';
      });
    }
  }

  Future<void> _playPrompt() async {
    setState(() {
      _busy = true;
      _feedback = 'Playing the spelling prompt.';
    });
    try {
      await widget.audio.play();
      if (!mounted) {
        return;
      }
      setState(() {
        _feedback = 'Type the word you heard.';
      });
    } on Object {
      if (!mounted) {
        return;
      }
      setState(() {
        _feedback = 'The bundled prompt could not play.';
      });
    } finally {
      if (mounted) {
        setState(() {
          _busy = false;
        });
      }
    }
  }

  Future<void> _submit() async {
    final String answer = _answerController.text.trim().toLowerCase();
    if (answer.isEmpty || _busy) {
      setState(() {
        _feedback = answer.isEmpty
            ? 'Type a spelling before submitting.'
            : _feedback;
      });
      return;
    }

    final bool correct = answer == target;
    setState(() {
      _busy = true;
    });
    try {
      final AttemptSnapshot snapshot = await widget.repository.recordAnswer(
        correct: correct,
      );
      if (!mounted) {
        return;
      }
      setState(() {
        _snapshot = snapshot;
        _feedback = correct
            ? 'Correct. The egg has evolved into a companion.'
            : 'Not yet. Listen again and try once more.';
        if (correct) {
          _answerController.clear();
        } else {
          _answerController.selection = TextSelection(
            baseOffset: 0,
            extentOffset: _answerController.text.length,
          );
        }
      });
    } on Object {
      if (!mounted) {
        return;
      }
      setState(() {
        _feedback = 'The answer could not be saved locally.';
      });
    } finally {
      if (mounted) {
        setState(() {
          _busy = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final AttemptSnapshot? snapshot = _snapshot;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 680),
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(24),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  Text(
                    'Flutter + Flame decision slice',
                    style: Theme.of(context).textTheme.labelLarge,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'Ada’s spelling trail',
                    style: Theme.of(context).textTheme.headlineMedium?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 8),
                  const Text(
                    'One ordinary text field, one local transaction, and one bounded game scene.',
                  ),
                  const SizedBox(height: 24),
                  if (snapshot == null)
                    const Center(
                      child: CircularProgressIndicator(
                        semanticsLabel: 'Opening local learner state',
                      ),
                    )
                  else ...<Widget>[
                    _CompanionCard(snapshot: snapshot),
                    const SizedBox(height: 20),
                    Card(
                      child: Padding(
                        padding: const EdgeInsets.all(20),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: <Widget>[
                            Text(
                              'Spell the word you hear',
                              style: Theme.of(context).textTheme.titleLarge?.copyWith(
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                            const SizedBox(height: 12),
                            OutlinedButton.icon(
                              key: const Key('listen-button'),
                              onPressed: _busy
                                  ? null
                                  : () {
                                      unawaited(_playPrompt());
                                    },
                              icon: const Icon(Icons.volume_up_rounded),
                              label: const Text('Listen'),
                            ),
                            const SizedBox(height: 16),
                            Semantics(
                              label: 'Type the spelling',
                              textField: true,
                              child: TextField(
                                key: const Key('spelling-input'),
                                controller: _answerController,
                                autofocus: false,
                                autocorrect: false,
                                enableSuggestions: false,
                                smartDashesType: SmartDashesType.disabled,
                                smartQuotesType: SmartQuotesType.disabled,
                                textCapitalization: TextCapitalization.none,
                                textInputAction: TextInputAction.done,
                                decoration: const InputDecoration(
                                  border: OutlineInputBorder(),
                                  hintText: 'Your spelling',
                                ),
                                onSubmitted: (_) {
                                  unawaited(_submit());
                                },
                              ),
                            ),
                            const SizedBox(height: 12),
                            FilledButton(
                              key: const Key('submit-button'),
                              onPressed: _busy
                                  ? null
                                  : () {
                                      unawaited(_submit());
                                    },
                              child: const Text('Submit'),
                            ),
                            const SizedBox(height: 12),
                            Semantics(
                              liveRegion: true,
                              child: Text(
                                _feedback,
                                key: const Key('feedback'),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(height: 16),
                    Text(
                      '${snapshot.correctCount} correct from ${snapshot.attempts} attempts · saved in SQLite',
                      key: const Key('saved-progress'),
                      textAlign: TextAlign.center,
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

final class _CompanionCard extends StatelessWidget {
  const _CompanionCard({required this.snapshot});

  final AttemptSnapshot snapshot;

  @override
  Widget build(BuildContext context) {
    final CompanionEvolutionGame game = CompanionEvolutionGame(
      evolved: snapshot.evolved,
    );
    return Card(
      clipBehavior: Clip.antiAlias,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Text(
              snapshot.evolved ? 'Companion found' : 'Egg waiting',
              style: Theme.of(context).textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 12),
            Semantics(
              key: const Key('companion-semantics'),
              label: game.semanticsLabel,
              image: true,
              child: ExcludeSemantics(
                child: SizedBox(
                  height: 180,
                  child: GameWidget<CompanionEvolutionGame>(
                    key: ValueKey<bool>(snapshot.evolved),
                    game: game,
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
