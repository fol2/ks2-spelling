import { useEffect, useMemo, useState } from 'react';

const VOICES = Object.freeze([
  Object.freeze({
    id: 'Iapetus',
    label: 'Iapetus',
    description: 'A clear British-English voice',
  }),
  Object.freeze({
    id: 'Sulafat',
    label: 'Sulafat',
    description: 'A warm British-English voice',
  }),
]);
const ROUND_LENGTHS = Object.freeze([5, 10, 20]);

function displayYearGroup(value) {
  return `Year ${value.slice(1)}`;
}

function InkletArt({ stage = 0 }) {
  return (
    <svg
      className={`inklet-art inklet-stage-${Math.min(stage, 5)}`}
      viewBox="0 0 180 150"
      role="img"
      aria-label={`Inklet is at stage ${stage}`}
    >
      <path
        className="inklet-shadow"
        d="M34 126c21 17 91 18 116-1-21 25-94 26-116 1Z"
      />
      <path
        className="inklet-body"
        d="M91 20c24 0 46 20 47 50 1 16 13 28 5 43-10 19-34 22-52 22-25 0-54-7-58-29-3-16 10-25 11-41 2-27 22-45 47-45Z"
      />
      <path
        className="inklet-flourish"
        d="M58 39c-13-14-9-25 4-27-3 8 3 14 12 19M122 42c15-13 12-25 0-29 1 9-6 14-14 20"
      />
      <circle className="inklet-eye" cx="73" cy="76" r="7" />
      <circle className="inklet-eye" cx="111" cy="76" r="7" />
      <circle className="inklet-glint" cx="75" cy="73" r="2" />
      <circle className="inklet-glint" cx="113" cy="73" r="2" />
      <path className="inklet-smile" d="M78 96c8 8 19 8 27 0" />
      {stage > 0 && (
        <path
          className="inklet-badge"
          d="m91 7 5 9 10 2-7 8 1 11-9-5-10 5 2-11-8-8 11-2 5-9Z"
        />
      )}
    </svg>
  );
}

function CampArt({ level = 0 }) {
  return (
    <svg
      className="camp-art"
      viewBox="0 0 260 150"
      role="img"
      aria-label={`Expedition Camp is at level ${level}`}
    >
      <path className="camp-ground" d="M8 132c53-25 188-24 244 0H8Z" />
      <path className="camp-mountain" d="m34 111 52-80 49 80H34Z" />
      <path className="camp-mountain camp-mountain-far" d="m112 111 45-62 57 62H112Z" />
      <path className="camp-tent" d="m102 126 30-54 32 54h-62Z" />
      <path className="camp-door" d="m132 78 13 48h-26l13-48Z" />
      <path className="camp-flag" d="M132 72V35l28 10-28 10" />
      {level > 0 && <circle className="camp-sun" cx="218" cy="31" r="17" />}
    </svg>
  );
}

function AudioStatus({ audioState, onRecover, compact = false }) {
  const copy = {
    ready: [
      'Listening pack ready',
      'Verified pre-recorded audio is available on this device.',
    ],
    corrupt: [
      'Listening pack needs repair',
      'The local audio no longer matches its verified pack.',
    ],
    checking: [
      'Checking the listening pack',
      'Checking the local pre-recorded audio now.',
    ],
    unavailable: [
      'Listening pack could not be checked',
      'Your learning is still saved. Check the local pack again.',
    ],
    missing: [
      'Listening pack needs setup',
      'Pre-recorded audio is not ready on this device yet.',
    ],
  };
  const [title, body] = copy[audioState.status] ?? copy.missing;
  return (
    <section
      className={`audio-state audio-state-${audioState.status}${compact ? ' audio-state-compact' : ''}`}
      aria-labelledby="starter-audio-title"
      aria-live="polite"
    >
      <span className="audio-state-icon" aria-hidden="true">♪</span>
      <div>
        <h2 id="starter-audio-title">{title}</h2>
        {!compact && <p>{body}</p>}
      </div>
      {!['ready', 'checking'].includes(audioState.status) && (
        <button type="button" className="button-quiet" onClick={onRecover}>
          Check again
        </button>
      )}
    </section>
  );
}

function ProductTopBar({ title = 'KS2 Spelling', action }) {
  return (
    <header className="product-topbar">
      <div className="brand-mark" aria-hidden="true">KS2</div>
      <p>{title}</p>
      {action ?? <span />}
    </header>
  );
}

function ProfilePicker({
  profileState,
  audioState,
  onChoose,
  onCreate,
  onRecoverAudio,
}) {
  const [nickname, setNickname] = useState('');
  const [yearGroup, setYearGroup] = useState('Y3');
  const [goal, setGoal] = useState(10);
  const busy = profileState.status === 'saving';

  function submit(event) {
    event.preventDefault();
    const nextNickname = nickname.trim();
    if (!nextNickname || busy) return;
    void onCreate({
      nickname: nextNickname,
      yearGroup,
      goal,
      colour: '#157A76',
    }).then(() => setNickname(''));
  }

  return (
    <main className="product-app product-page" aria-labelledby="profile-title">
      <ProductTopBar />
      <section className="welcome-panel">
        <p className="product-kicker">Your pocket expedition</p>
        <h1 id="profile-title">Who is practising?</h1>
        <p>Choose a learner on this device, or add one to begin a spelling trail.</p>
      </section>

      {profileState.profiles.length > 0 && (
        <ul className="learner-grid" aria-label="Learners on this device">
          {profileState.profiles.map((profile) => {
            const selected =
              profile.learnerId === profileState.selectedLearnerId;
            return (
              <li key={profile.learnerId}>
                <button
                  type="button"
                  className="learner-card"
                  disabled={busy}
                  onClick={() => onChoose(profile.learnerId)}
                >
                  <span
                    className="learner-avatar"
                    style={{ '--learner-colour': profile.colour }}
                    aria-hidden="true"
                  >
                    {profile.nickname.slice(0, 1).toUpperCase()}
                  </span>
                  <span>
                    <strong>{profile.nickname}</strong>
                    <small>
                      {displayYearGroup(profile.yearGroup)} · {profile.goal} words a week
                    </small>
                    {selected && <em>Selected</em>}
                  </span>
                  <span className="learner-arrow" aria-hidden="true">→</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <AudioStatus audioState={audioState} onRecover={onRecoverAudio} />

      <section className="paper-card add-learner-card" aria-labelledby="add-learner-title">
        <div>
          <p className="product-kicker">Local to this device</p>
          <h2 id="add-learner-title">Add a learner</h2>
        </div>
        <form className="learner-form" onSubmit={submit}>
          <label htmlFor="profile-nickname">First name or nickname</label>
          <input
            id="profile-nickname"
            name="nickname"
            type="text"
            value={nickname}
            maxLength="40"
            autoComplete="off"
            disabled={busy}
            onChange={(event) => setNickname(event.target.value)}
          />
          <div className="field-pair">
            <label>
              Year group
              <select
                name="yearGroup"
                value={yearGroup}
                disabled={busy}
                onChange={(event) => setYearGroup(event.target.value)}
              >
                {['Y3', 'Y4', 'Y5', 'Y6'].map((year) => (
                  <option key={year} value={year}>{displayYearGroup(year)}</option>
                ))}
              </select>
            </label>
            <label>
              Weekly goal
              <select
                name="goal"
                value={goal}
                disabled={busy}
                onChange={(event) => setGoal(Number(event.target.value))}
              >
                {[5, 10, 15, 20].map((value) => (
                  <option key={value} value={value}>{value} words</option>
                ))}
              </select>
            </label>
          </div>
          <button
            type="submit"
            className="button-primary"
            disabled={busy || nickname.trim() === ''}
          >
            {busy ? 'Saving…' : 'Add learner'}
          </button>
        </form>
        {profileState.actionError && (
          <p className="inline-error" role="alert">
            That change did not save. Please try again.
          </p>
        )}
      </section>
    </main>
  );
}

function ChildHome({
  profile,
  learningState,
  audioState,
  onScreen,
  onSwitchLearner,
  onRecoverAudio,
}) {
  const monster = learningState.monsters[0];
  return (
    <main className="product-app product-page child-home" aria-labelledby="home-title">
      <ProductTopBar
        action={(
          <button type="button" className="topbar-action" onClick={onSwitchLearner}>
            Switch learner
          </button>
        )}
      />
      <section className="trail-hero">
        <div>
          <p className="product-kicker">{displayYearGroup(profile.yearGroup)} trail</p>
          <h1 id="home-title">{profile.nickname}&apos;s spelling trail</h1>
          <p>
            A short Smart Review chooses the right Starter words from saved
            progress on this device.
          </p>
          <button
            type="button"
            className="button-primary button-large"
            onClick={() => onScreen('setup')}
          >
            Start a Smart Review
          </button>
        </div>
        <div className="hero-inklet">
          <InkletArt stage={monster?.derivedStage ?? 0} />
          <p>
            <strong>Inklet</strong>
            <span>{monster?.secureCount ?? 0} secure words</span>
          </p>
        </div>
      </section>

      <AudioStatus
        audioState={audioState}
        onRecover={onRecoverAudio}
        compact={audioState.status === 'ready'}
      />

      <nav className="trail-navigation" aria-label="Spelling trail">
        <button type="button" onClick={() => onScreen('progress')}>
          <span aria-hidden="true">↗</span>
          <strong>Progress</strong>
          <small>{learningState.progress.length} words practised</small>
        </button>
        <button type="button" onClick={() => onScreen('monster')}>
          <span aria-hidden="true">✦</span>
          <strong>Monster</strong>
          <small>Visit Inklet</small>
        </button>
        <button type="button" onClick={() => onScreen('camp')}>
          <span aria-hidden="true">⌂</span>
          <strong>Camp</strong>
          <small>Expedition level {learningState.camp?.campHighWater ?? 0}</small>
        </button>
      </nav>
    </main>
  );
}

function PracticeSetup({
  audioState,
  voiceId,
  onVoice,
  onStart,
  onBack,
  onRecoverAudio,
  busy,
}) {
  const [length, setLength] = useState(5);
  return (
    <main className="product-app product-page" aria-labelledby="setup-title">
      <ProductTopBar
        title="New expedition"
        action={(
          <button type="button" className="topbar-action" onClick={onBack}>
            Back
          </button>
        )}
      />
      <section className="paper-card setup-card">
        <p className="product-kicker">Smart Review</p>
        <h1 id="setup-title">Choose today&apos;s trail</h1>
        <p>
          The Starter trail covers Years 3–4 words and adapts from learning
          already saved on this device.
        </p>

        <fieldset className="choice-group">
          <legend>Round length</legend>
          <div className="segmented-choice">
            {ROUND_LENGTHS.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={length === value}
                onClick={() => setLength(value)}
              >
                <strong>{value}</strong>
                <span>words</span>
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="choice-group">
          <legend>Listening voice</legend>
          <div className="voice-choice">
            {VOICES.map((voice) => (
              <button
                key={voice.id}
                type="button"
                aria-pressed={voiceId === voice.id}
                onClick={() => onVoice(voice.id)}
              >
                <span className="voice-symbol" aria-hidden="true">♪</span>
                <span>
                  <strong>{voice.label}</strong>
                  <small>{voice.description}</small>
                </span>
              </button>
            ))}
          </div>
        </fieldset>

        <AudioStatus audioState={audioState} onRecover={onRecoverAudio} />
        <button
          type="button"
          className="button-primary button-large"
          disabled={busy || audioState.status !== 'ready'}
          onClick={() => onStart(length)}
        >
          {busy ? 'Preparing…' : 'Start trail'}
        </button>
      </section>
    </main>
  );
}

function PracticeScreen({
  state,
  audioState,
  voiceId,
  audio,
  onSubmit,
  onContinue,
  onEnd,
  onPlaybackFailure,
}) {
  const [answer, setAnswer] = useState('');
  const [localError, setLocalError] = useState('');
  const [confirmExit, setConfirmExit] = useState(false);
  const practice = state.practice;
  const busy = state.status === 'saving';

  const audioRequest = useMemo(() => practice ? Object.freeze({
    version: audioState.activeVersion,
    runtimeItemId: practice.runtimeItemId,
    sentence: practice.sentence,
    voiceId,
  }) : null, [
    audioState.activeVersion,
    practice?.runtimeItemId,
    practice?.sentence,
    voiceId,
  ]);

  async function play(kind) {
    if (!audioRequest || audioState.status !== 'ready' || busy) return;
    try {
      if (!audio || typeof audio.play !== 'function') {
        throw new Error('product_audio_player_unavailable');
      }
      await audio.play({ ...audioRequest, kind });
      setLocalError('');
    } catch {
      setLocalError('Audio needs attention. Check the listening pack and try again.');
      onPlaybackFailure();
    }
  }

  useEffect(() => {
    if (!audioRequest || audioState.status !== 'ready') return;
    void play('word');
  // Autoplay exactly once for a newly projected card or voice.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioRequest]);

  if (!practice) return null;
  const visibleCard = Math.min(
    practice.progress.total,
    practice.progress.done + 1,
  );

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    if (practice.awaitingAdvance) {
      await onContinue();
      setAnswer('');
      return;
    }
    if (answer.trim() === '') {
      setLocalError('Type the spelling before checking it.');
      return;
    }
    await onSubmit(answer);
    setAnswer('');
    setLocalError('');
  }

  return (
    <main className="product-app practice-page" aria-labelledby="practice-title">
      <ProductTopBar
        title={practice.label}
        action={(
          <button
            type="button"
            className="topbar-action"
            onClick={() => setConfirmExit(true)}
          >
            Leave
          </button>
        )}
      />
      <div className="practice-progress" aria-label={`Card ${visibleCard} of ${practice.progress.total}`}>
        <span style={{ '--round-progress': `${(visibleCard / practice.progress.total) * 100}%` }} />
        <p>Card {visibleCard} of {practice.progress.total}</p>
      </div>

      <section className="practice-card" aria-labelledby="practice-title" aria-busy={busy}>
        <p className="product-kicker">Listen · spell · learn</p>
        <h1 id="practice-title">Hear the word, then spell it</h1>
        <p className="cloze-prompt">{practice.cloze}</p>

        <div className="listening-controls" aria-label="Listening controls">
          <button
            type="button"
            disabled={busy || audioState.status !== 'ready'}
            onClick={() => void play('word')}
          >
            <span aria-hidden="true">▶</span>
            Hear word
          </button>
          <button
            type="button"
            disabled={busy || audioState.status !== 'ready'}
            onClick={() => void play('sentence')}
          >
            <span aria-hidden="true">♪</span>
            Hear sentence
          </button>
          <button
            type="button"
            disabled={busy || audioState.status !== 'ready'}
            onClick={() => void play('slow-sentence')}
          >
            <span aria-hidden="true">½</span>
            Slow sentence
          </button>
        </div>

        <form className="answer-form" onSubmit={(event) => void submit(event)}>
          <label htmlFor="product-spelling-input">Type the spelling</label>
          <input
            id="product-spelling-input"
            name="spelling"
            type="text"
            value={answer}
            disabled={busy || practice.awaitingAdvance}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck="false"
            enterKeyHint="done"
            onChange={(event) => setAnswer(event.target.value)}
          />
          <button type="submit" className="button-primary" disabled={busy}>
            {busy
              ? 'Saving…'
              : practice.awaitingAdvance ? 'Continue' : 'Check spelling'}
          </button>
        </form>

        {(localError || state.actionError) && (
          <p className="inline-error" role="alert">
            {localError || 'That answer did not save. Please try again.'}
          </p>
        )}

        {practice.feedback && (
          <div
            className={`answer-feedback answer-feedback-${practice.feedback.kind}`}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <span className="feedback-symbol" aria-hidden="true">
              {practice.feedback.kind === 'success' ? '✓' : '↻'}
            </span>
            <div>
              <h2>{practice.feedback.headline}</h2>
              {practice.feedback.answer && (
                <p>
                  Correct spelling: <strong>{practice.feedback.answer}</strong>
                </p>
              )}
              {practice.feedback.body && <p>{practice.feedback.body}</p>}
              {practice.feedback.footer && <small>{practice.feedback.footer}</small>}
            </div>
          </div>
        )}
      </section>

      {confirmExit && (
        <section className="exit-confirmation" role="alertdialog" aria-labelledby="leave-round-title">
          <div>
            <h2 id="leave-round-title">Leave this round?</h2>
            <p>Your earlier saved learning stays safe. This round will be marked unfinished.</p>
            <div>
              <button
                type="button"
                className="button-quiet"
                onClick={() => setConfirmExit(false)}
              >
                Keep practising
              </button>
              <button type="button" className="button-danger" onClick={onEnd}>
                Leave round
              </button>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}

function SummaryScreen({ summary, monster, onScreen }) {
  return (
    <main className="product-app product-page summary-page" aria-labelledby="summary-title">
      <ProductTopBar title="Results" />
      <section className="summary-hero">
        <div className="summary-medal" aria-hidden="true">✓</div>
        <p className="product-kicker">Trail complete</p>
        <h1 id="summary-title">Well done</h1>
        <p>{summary?.message}</p>
        <strong className="accuracy-score">{summary?.accuracy ?? 0}%</strong>
        <span>round accuracy</span>
      </section>
      <dl className="summary-grid">
        {(summary?.cards ?? []).map((card) => (
          <div key={card.label}>
            <dt>{card.label}</dt>
            <dd>{card.value}</dd>
            <p>{card.sub}</p>
          </div>
        ))}
      </dl>
      <section className="paper-card reward-summary">
        <InkletArt stage={monster?.derivedStage ?? 0} />
        <div>
          <h2>Inklet noticed your practice</h2>
          <p>{monster?.secureCount ?? 0} secure words are now helping Inklet grow.</p>
        </div>
      </section>
      <div className="summary-actions">
        <button type="button" className="button-primary" onClick={() => onScreen('setup')}>
          Practise again
        </button>
        <button type="button" className="button-quiet" onClick={() => onScreen('home')}>
          Back to trail
        </button>
      </div>
    </main>
  );
}

function ProgressScreen({ progress, onBack }) {
  return (
    <main className="product-app product-page" aria-labelledby="progress-title">
      <ProductTopBar
        title="Progress"
        action={<button type="button" className="topbar-action" onClick={onBack}>Back</button>}
      />
      <section className="page-heading">
        <p className="product-kicker">Saved on this device</p>
        <h1 id="progress-title">Your word trail</h1>
        <p>Each row comes from this learner&apos;s local spelling progress.</p>
      </section>
      {progress.length === 0 ? (
        <section className="paper-card empty-state">
          <h2>Your trail is ready</h2>
          <p>Finish a Smart Review and your practised words will appear here.</p>
        </section>
      ) : (
        <ul className="word-progress-list">
          {progress.map((item) => (
            <li key={item.runtimeItemId}>
              <span className={`word-stage word-stage-${Math.min(item.stage, 5)}`}>
                {item.stage}
              </span>
              <div>
                <strong>{item.target}</strong>
                <small>
                  {item.correct} correct · {item.wrong} to revisit
                </small>
              </div>
              <span>{item.lastResult === 'correct' ? 'On trail' : 'Practising'}</span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function MonsterScreen({ monster, onBack }) {
  const nextThreshold = monster?.thresholds.find(
    (threshold) => threshold > (monster?.secureCount ?? 0),
  );
  return (
    <main className="product-app product-page companion-page" aria-labelledby="monster-title">
      <ProductTopBar
        title="Monster"
        action={<button type="button" className="topbar-action" onClick={onBack}>Back</button>}
      />
      <section className="companion-hero">
        <InkletArt stage={monster?.derivedStage ?? 0} />
        <p className="product-kicker">Trail companion</p>
        <h1 id="monster-title">Meet Inklet</h1>
        <p>
          Inklet grows from secure spelling progress, never from purchases or
          time spent tapping.
        </p>
        <dl>
          <div>
            <dt>Secure words</dt>
            <dd>{monster?.secureCount ?? 0}</dd>
          </div>
          <div>
            <dt>Growth stage</dt>
            <dd>{monster?.derivedStage ?? 0}</dd>
          </div>
        </dl>
        <p className="next-reward">
          {nextThreshold
            ? `${nextThreshold - (monster?.secureCount ?? 0)} more secure words until the next change.`
            : 'Inklet has reached the final Starter stage.'}
        </p>
      </section>
    </main>
  );
}

function CampScreen({ camp, onBack }) {
  return (
    <main className="product-app product-page camp-page" aria-labelledby="camp-title">
      <ProductTopBar
        title="Camp"
        action={<button type="button" className="topbar-action" onClick={onBack}>Back</button>}
      />
      <section className="camp-hero">
        <CampArt level={camp?.campHighWater ?? 0} />
        <p className="product-kicker">Expedition Camp</p>
        <h1 id="camp-title">A quiet place to see progress</h1>
        <p>
          Camp grows only from eligible revision missions. Ordinary practice
          still helps spelling and Inklet, but does not invent Camp credit.
        </p>
        <div className="camp-level">
          <span>Camp level</span>
          <strong>{camp?.campHighWater ?? 0}</strong>
        </div>
      </section>
    </main>
  );
}

export default function ProductApp({ services }) {
  const [profileState, setProfileState] = useState(() =>
    services.controller.getState(),
  );
  const [learningState, setLearningState] = useState(() =>
    services.learning.getState(),
  );
  const [audioState, setAudioState] = useState(() =>
    services.audioAvailability.getState(),
  );
  const [voiceId, setVoiceId] = useState('Iapetus');

  useEffect(() => {
    const profileSubscription = services.controller.subscribe(setProfileState);
    const learningSubscription = services.learning.subscribe(setLearningState);
    const audioSubscription =
      services.audioAvailability.subscribe(setAudioState);
    return () => {
      profileSubscription.remove();
      learningSubscription.remove();
      audioSubscription.remove();
    };
  }, [services]);

  if (profileState.status === 'failed') {
    return (
      <main className="product-app product-page">
        <ProductTopBar />
        <section className="paper-card empty-state" aria-labelledby="product-data-title">
          <p className="product-kicker">Local data</p>
          <h1 id="product-data-title">Your saved learning could not open</h1>
          <p>Close and reopen the app. Your local data has not been replaced.</p>
        </section>
      </main>
    );
  }

  const selectedProfile = profileState.profiles.find(
    ({ learnerId }) => learnerId === learningState.learnerId,
  );
  const recoverAudio = () => {
    void services.audioAvailability.recover().catch(() => undefined);
  };
  const showScreen = (screen) => services.learning.showScreen(screen);

  if (
    learningState.screen === 'profiles' ||
    !selectedProfile
  ) {
    return (
      <ProfilePicker
        profileState={profileState}
        audioState={audioState}
        onChoose={(learnerId) =>
          services.controller.selectProfile(learnerId).catch(() => undefined)}
        onCreate={(draft) => services.controller.createProfile(draft)}
        onRecoverAudio={recoverAudio}
      />
    );
  }

  if (learningState.screen === 'setup') {
    return (
      <PracticeSetup
        audioState={audioState}
        voiceId={voiceId}
        onVoice={setVoiceId}
        onStart={(length) => {
          void services.learning.startSmartRound({ length }).catch(() => undefined);
        }}
        onBack={() => showScreen('home')}
        onRecoverAudio={recoverAudio}
        busy={learningState.status === 'saving'}
      />
    );
  }
  if (learningState.screen === 'practice') {
    return (
      <PracticeScreen
        state={learningState}
        audioState={audioState}
        voiceId={voiceId}
        audio={services.audio}
        onSubmit={(typed) => services.learning.submitAnswer(typed)}
        onContinue={() => services.learning.continueRound()}
        onEnd={() => {
          void services.learning.endRound().catch(() => undefined);
        }}
        onPlaybackFailure={() =>
          services.audioAvailability.reportPlaybackFailure()}
      />
    );
  }
  if (learningState.screen === 'summary') {
    return (
      <SummaryScreen
        summary={learningState.summary}
        monster={learningState.monsters[0]}
        onScreen={showScreen}
      />
    );
  }
  if (learningState.screen === 'progress') {
    return (
      <ProgressScreen
        progress={learningState.progress}
        onBack={() => showScreen('home')}
      />
    );
  }
  if (learningState.screen === 'monster') {
    return (
      <MonsterScreen
        monster={learningState.monsters[0]}
        onBack={() => showScreen('home')}
      />
    );
  }
  if (learningState.screen === 'camp') {
    return (
      <CampScreen
        camp={learningState.camp}
        onBack={() => showScreen('home')}
      />
    );
  }
  return (
    <ChildHome
      profile={selectedProfile}
      learningState={learningState}
      audioState={audioState}
      onScreen={showScreen}
      onSwitchLearner={() => {
        void services.learning.selectLearner(null).catch(() => undefined);
      }}
      onRecoverAudio={recoverAudio}
    />
  );
}
