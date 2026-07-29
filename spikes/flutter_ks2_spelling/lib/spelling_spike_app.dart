import 'dart:async';

import 'package:flame/game.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'attempt_repository.dart';
import 'companion_game.dart';
import 'prompt_audio.dart';

Future<void> _reportCleanupFailure(
  Future<void> Function() operation,
  String context,
) async {
  try {
    await operation();
  } on Object catch (error, stackTrace) {
    FlutterError.reportError(
      FlutterErrorDetails(
        exception: error,
        stack: stackTrace,
        library: 'ks2_spelling_spike',
        context: ErrorDescription(context),
      ),
    );
  }
}

final class SpellingSpikeApp extends StatelessWidget {
  const SpellingSpikeApp({
    required this.repository,
    required this.audio,
    super.key,
  });

  final AttemptStore repository;
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

  final AttemptStore repository;
  final PromptAudio audio;

  @override
  State<SpellingPracticePage> createState() => _SpellingPracticePageState();
}

final class _SpellingPracticePageState extends State<SpellingPracticePage> {
  static const String target = 'accident';

  final TextEditingController _answerController = TextEditingController();
  AttemptSnapshot? _snapshot;
  String _feedback = 'Tap Listen, then type the spelling in the visible field.';
  String? _loadError;
  bool _loading = true;
  bool _loadInFlight = false;
  bool _playing = false;
  bool _saving = false;

  bool get _busy => _playing || _saving;

  @override
  void initState() {
    super.initState();
    unawaited(_load(initial: true));
  }

  @override
  void dispose() {
    _answerController.dispose();
    unawaited(
      _reportCleanupFailure(
        () => widget.audio.dispose(),
        'while disposing the prompt-audio backend',
      ),
    );
    unawaited(
      _reportCleanupFailure(
        () => widget.repository.close(),
        'while closing the learner-state repository',
      ),
    );
    super.dispose();
  }

  Future<void> _load({bool initial = false}) async {
    if (_loadInFlight) {
      return;
    }
    _loadInFlight = true;
    if (!initial && mounted) {
      setState(() {
        _loading = true;
        _loadError = null;
      });
    }

    AttemptSnapshot? snapshot;
    String? error;
    try {
      snapshot = await widget.repository.read();
    } on Object {
      error =
          'The local learner state could not open. '
          'Your existing data was not replaced.';
    } finally {
      _loadInFlight = false;
    }

    if (!mounted) {
      return;
    }
    setState(() {
      _snapshot = snapshot;
      _loadError = error;
      _loading = false;
    });
  }

  Future<void> _playPrompt() async {
    if (_busy) {
      return;
    }
    setState(() {
      _playing = true;
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
          _playing = false;
        });
      }
    }
  }

  Future<void> _submit() async {
    if (_busy) {
      return;
    }
    final String answer = _answerController.text.trim().toLowerCase();
    if (answer.isEmpty) {
      setState(() {
        _feedback = 'Type a spelling before submitting.';
      });
      return;
    }

    final bool correct = answer == target;
    final bool alreadyEvolved = _snapshot?.evolved ?? false;
    setState(() {
      _saving = true;
      _feedback = 'Saving your answer locally.';
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
            ? alreadyEvolved
                  ? 'Correct. Your companion remains safely evolved.'
                  : 'Correct. The egg has evolved into a companion.'
            : 'Not yet. Listen again and try once more.';
        if (correct) {
          _answerController.value = const TextEditingValue(
            text: '',
            selection: TextSelection.collapsed(offset: 0),
          );
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
          _saving = false;
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
                    'One ordinary text field, one local transaction, '
                    'and one bounded game scene.',
                  ),
                  const SizedBox(height: 24),
                  if (_loading)
                    const Center(
                      child: CircularProgressIndicator(
                        semanticsLabel: 'Opening local learner state',
                      ),
                    )
                  else if (snapshot == null)
                    _LoadFailureCard(
                      message:
                          _loadError ??
                          'The local learner state is unavailable.',
                      onRetry: () {
                        unawaited(_load());
                      },
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
                              style: Theme.of(context).textTheme.titleLarge
                                  ?.copyWith(fontWeight: FontWeight.w700),
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
                                enableIMEPersonalizedLearning: false,
                                autofillHints: const <String>[],
                                inputFormatters: <TextInputFormatter>[
                                  TextInputFormatter.withFunction(
                                    (
                                      TextEditingValue oldValue,
                                      TextEditingValue newValue,
                                    ) => _saving ? oldValue : newValue,
                                  ),
                                ],
                                smartDashesType: SmartDashesType.disabled,
                                smartQuotesType: SmartQuotesType.disabled,
                                textCapitalization: TextCapitalization.none,
                                textInputAction: TextInputAction.unspecified,
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
                              child: Text(_saving ? 'Saving…' : 'Submit'),
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
                      '${snapshot.correctCount} correct from '
                      '${snapshot.attempts} '
                      '${snapshot.attempts == 1 ? 'attempt' : 'attempts'} '
                      '· saved in SQLite',
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

final class _LoadFailureCard extends StatelessWidget {
  const _LoadFailureCard({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      liveRegion: true,
      child: Card(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Text(
                'Local learner state needs attention',
                key: const Key('load-error-title'),
                style: Theme.of(
                  context,
                ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: 8),
              Text(message, key: const Key('load-error-message')),
              const SizedBox(height: 16),
              FilledButton(
                key: const Key('retry-load-button'),
                onPressed: onRetry,
                child: const Text('Try opening again'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

final class _CompanionCard extends StatefulWidget {
  const _CompanionCard({required this.snapshot});

  final AttemptSnapshot snapshot;

  @override
  State<_CompanionCard> createState() => _CompanionCardState();
}

final class _CompanionCardState extends State<_CompanionCard> {
  late CompanionEvolutionGame _game;

  @override
  void initState() {
    super.initState();
    _game = CompanionEvolutionGame(evolved: widget.snapshot.evolved);
  }

  @override
  void didUpdateWidget(covariant _CompanionCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.snapshot.evolved != widget.snapshot.evolved) {
      _game = CompanionEvolutionGame(evolved: widget.snapshot.evolved);
    }
  }

  @override
  Widget build(BuildContext context) {
    final AttemptSnapshot snapshot = widget.snapshot;
    return Card(
      clipBehavior: Clip.antiAlias,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Text(
              snapshot.evolved ? 'Companion found' : 'Egg waiting',
              style: Theme.of(
                context,
              ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 12),
            Semantics(
              key: const Key('companion-semantics'),
              label: _game.semanticsLabel,
              image: true,
              child: ExcludeSemantics(
                child: SizedBox(
                  height: 180,
                  child: ExcludeFocus(
                    excluding: true,
                    child: GameWidget<CompanionEvolutionGame>(
                      key: ValueKey<String>(
                        'companion-game-${snapshot.evolved}',
                      ),
                      game: _game,
                      autofocus: false,
                    ),
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
