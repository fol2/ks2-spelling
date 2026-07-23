import { useEffect, useMemo, useRef, useState } from 'react';
import { B4_AUDIO_AUTHORITY } from './b4-round-contract.js';
import { createB4LearnerAction } from './b4-learner-action.js';
import { markB4, measureB4 } from './b4-performance-marks.js';

function B1App({ services }) {
  if (services.native.capabilities.mode !== 'prototype-only') {
    throw new TypeError('The B1 shell requires prototype-only application services.');
  }

  return (
    <main className="shell">
      <section className="hero" aria-labelledby="product-title">
        <p className="eyebrow">Local prototype</p>
        <h1 id="product-title">KS2 Spelling</h1>
        <p className="intro">
          A small, local-first foundation for practising statutory spelling.
        </p>
      </section>

      <section className="status-card" aria-labelledby="prototype-status">
        <div>
          <p className="label">Content available</p>
          <h2 id="prototype-status">
            Starter content: {services.starterContentCount} words
          </h2>
        </div>
        <span className="status-pill">Bundled locally</span>
      </section>

      <aside className="boundary" aria-label="B1 capability boundary">
        <p>Database / purchases / downloads: not enabled in B1</p>
      </aside>
    </main>
  );
}

function B2App({ services }) {
  const [proofState, setProofState] = useState(() =>
    services.controller.getState(),
  );

  useEffect(() => {
    const subscription = services.controller.subscribe(setProofState);
    void services.controller.start().catch(() => undefined);
    return () => subscription.remove();
  }, [services]);

  const complete = proofState.status === 'B2 proof complete';

  return (
    <main className="shell">
      <section className="hero" aria-labelledby="product-title">
        <p className="eyebrow">B2 persistence proof</p>
        <h1 id="product-title">KS2 Spelling</h1>
        <p className="intro">
          Local SQLite, transaction recovery and app lifecycle diagnostics.
        </p>
      </section>

      <section className="status-card proof-status" aria-live="polite">
        <div>
          <p className="label">Active proof phase</p>
          <h2>{proofState.status}</h2>
        </div>
        <span className="status-pill">{services.platformRequirement}</span>
      </section>

      <dl className="evidence-grid" aria-label="B2 persistence evidence">
        <div aria-label={`Database: ${services.databaseName}`}>
          <dt>Database</dt>
          <dd>{services.databaseName}</dd>
        </div>
        <div aria-label={`SQLite schema: ${services.schemaVersion}`}>
          <dt>SQLite schema</dt>
          <dd>{services.schemaVersion}</dd>
        </div>
        <div aria-label={`Learner isolation: ${proofState.learnerIsolation}`}>
          <dt>Learner isolation</dt>
          <dd>{proofState.learnerIsolation}</dd>
        </div>
        <div
          aria-label={`Lifecycle: ${
            complete ? 'pause, resume and relaunch verified' : 'proof in progress'
          }`}
        >
          <dt>Lifecycle</dt>
          <dd>{complete ? 'pause, resume and relaunch verified' : 'proof in progress'}</dd>
        </div>
      </dl>
    </main>
  );
}

function displayYearGroup(value) {
  return `Year ${value.slice(1)}`;
}

function ProductApp({ services }) {
  const [profileState, setProfileState] = useState(() =>
    services.controller.getState(),
  );
  const [nickname, setNickname] = useState('');

  useEffect(() => {
    const subscription = services.controller.subscribe(setProfileState);
    return () => subscription.remove();
  }, [services]);

  const busy = profileState.status === 'saving';
  const submitProfile = (event) => {
    event.preventDefault();
    const nextNickname = nickname.trim();
    if (!nextNickname || busy) return;
    void services.controller.createProfile({
      nickname: nextNickname,
      yearGroup: 'Y3',
      goal: 10,
      colour: '#2E7D8A',
    }).then(() => setNickname('')).catch(() => undefined);
  };

  if (profileState.status === 'failed') {
    return (
      <main className="shell product-shell">
        <section className="product-panel" aria-labelledby="product-data-title">
          <p className="eyebrow">KS2 Spelling</p>
          <h1 id="product-data-title">Your local data could not open</h1>
          <p>Close and reopen the app. Your saved learning has not been replaced.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="shell product-shell" aria-labelledby="profile-title">
      <header className="product-heading">
        <p className="eyebrow">KS2 Spelling</p>
        <h1 id="profile-title">Who is practising?</h1>
        <p>Choose a learner on this device, or add one to get started.</p>
      </header>

      {profileState.profiles.length > 0 && (
        <ul className="profile-list" aria-label="Learners on this device">
          {profileState.profiles.map((profile) => {
            const selected = profile.learnerId === profileState.selectedLearnerId;
            return (
              <li key={profile.learnerId} className="profile-card">
                <span
                  className="profile-colour"
                  style={{ backgroundColor: profile.colour }}
                  aria-hidden="true"
                />
                <div>
                  <h2>{profile.nickname}</h2>
                  <p>{displayYearGroup(profile.yearGroup)} · {profile.goal} words a week</p>
                </div>
                <div className="profile-actions">
                  <button
                    type="button"
                    disabled={busy || selected}
                    aria-pressed={selected}
                    onClick={() => {
                      void services.controller
                        .selectProfile(profile.learnerId)
                        .catch(() => undefined);
                    }}
                  >
                    {selected ? 'Selected' : 'Choose'}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <section className="product-panel" aria-labelledby="add-learner-title">
        <h2 id="add-learner-title">Add a learner</h2>
        <form className="profile-form" onSubmit={submitProfile}>
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
          <button type="submit" disabled={busy || nickname.trim() === ''}>
            {busy ? 'Saving' : 'Add learner'}
          </button>
        </form>
        {profileState.actionError && (
          <p role="alert">That change did not save. Please try again.</p>
        )}
      </section>
    </main>
  );
}

export function activateB4Audio({ event, method, runAudio, source }) {
  if (typeof runAudio !== 'function') {
    throw new TypeError('runAudio must be a function.');
  }
  const accepted = source === 'pointer-up'
    ? event?.isPrimary === true && event?.button === 0
    : source === 'click' && event?.detail === 0;
  if (!accepted) return false;
  runAudio(method);
  return true;
}

function B4App({ services }) {
  const [roundState, setRoundState] = useState(() => services.controller.getState());
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const stateRef = useRef(roundState);
  const answerRef = useRef(answer);

  const updateState = (next) => {
    stateRef.current = next;
    setRoundState(next);
    setActionError('');
  };
  const learnerAction = useMemo(() => createB4LearnerAction({
    controller: services.controller,
    readState: () => stateRef.current,
    readAnswer: () => answerRef.current,
    onState: updateState,
    onAnswer: (next) => {
      answerRef.current = next;
      setAnswer(next);
    },
    onBusy: setBusy,
    onError(error) {
      setActionError(error?.code === 'b4_round_answer_required'
        ? 'Type the spelling before submitting.'
        : 'That did not save. Please try again.');
    },
  }), [services]);

  useEffect(() => {
    const subscription = services.controller.subscribe(updateState);
    void services.controller.start().catch(() => {
      setActionError('Your round could not start. Please try again.');
    });
    return () => subscription.remove();
  }, [services]);

  const feedbackForPaint = roundState.feedback;
  useEffect(() => {
    if (!feedbackForPaint || typeof requestAnimationFrame !== 'function') return undefined;
    const frame = requestAnimationFrame(() => {
      markB4('b4:feedback-painted');
      measureB4('b4:action-to-paint', 'b4:action-start');
    });
    return () => cancelAnimationFrame(frame);
  }, [feedbackForPaint]);

  const starting = roundState.phase === 'ready';
  const runAudio = (method) => {
    if (busy || starting) return;
    void services.controller[method]().then(updateState).catch(() => {
      setActionError('Audio is unavailable just now. You can still continue.');
    });
  };
  const complete = roundState.phase === 'summary';
  const feedback = roundState.feedback;
  const visibleCard = Math.max(1, Math.min(
    roundState.completedCards + (roundState.awaitingAdvance ? 0 : 1),
    roundState.totalCards,
  ));
  const liveMessage = actionError || (
    roundState.audio.error
      ? 'Audio is unavailable just now. You can still continue.'
      : roundState.audio.status === 'playing' ? 'Audio playing'
        : roundState.audio.status === 'starting' ? 'Audio starting' : ''
  );
  const liveRegion = (
    <p className="b4-live-region" aria-live="polite" aria-atomic="true">
      {liveMessage}
    </p>
  );

  return (
    <main className="shell b4-learner-shell" aria-labelledby="b4-round-title">
      <header className="b4-round-heading">
        <p className="eyebrow">Starter spelling</p>
        <h1 id="b4-round-title">Listen, type, learn</h1>
        <p className="b4-progress">
          {complete
            ? 'Round complete'
            : starting
              ? 'Preparing your round'
              : `Card ${visibleCard} of ${roundState.totalCards}`}
        </p>
      </header>

      {complete ? (
        <section className="b4-practice-card" aria-labelledby="b4-summary-title">
          <h2 id="b4-summary-title">Well done</h2>
          <p>{roundState.summary?.message}</p>
          <form onSubmit={learnerAction.submit}>
            <button type="submit" disabled={busy}>Start a fresh round</button>
          </form>
          {liveRegion}
        </section>
      ) : (
        <section
          className="b4-practice-card"
          aria-labelledby="b4-practice-title"
          aria-busy={starting || busy}
        >
          <h2 id="b4-practice-title">Hear the word, then spell it</h2>
          <div className="b4-audio-actions" aria-label="Listening controls">
            <button
              type="button"
              disabled={busy || starting}
              onPointerUp={(event) => {
                activateB4Audio({ event, method: 'replay', runAudio, source: 'pointer-up' });
              }}
              onClick={(event) => {
                activateB4Audio({ event, method: 'replay', runAudio, source: 'click' });
              }}
            >
              Replay
            </button>
            <button
              type="button"
              disabled={busy || starting}
              onPointerUp={(event) => {
                activateB4Audio({ event, method: 'slowReplay', runAudio, source: 'pointer-up' });
              }}
              onClick={(event) => {
                activateB4Audio({ event, method: 'slowReplay', runAudio, source: 'click' });
              }}
            >
              Slow replay
            </button>
          </div>
          {liveRegion}
          <form className="b4-entry-form" onSubmit={learnerAction.submit}>
            <label htmlFor="b4-spelling-input">Type the spelling</label>
            <input
              id="b4-spelling-input"
              name="spelling"
              type="text"
              value={answer}
              disabled={busy || starting || roundState.awaitingAdvance}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck="false"
              enterKeyHint="done"
              onChange={(event) => {
                answerRef.current = event.target.value;
                setAnswer(event.target.value);
              }}
            />
            <button type="submit" disabled={busy || starting}>
              {starting ? 'Preparing' : roundState.awaitingAdvance ? 'Continue' : 'Submit'}
            </button>
          </form>
          {feedback && (
            <div
              className={`b4-feedback b4-feedback-${feedback.kind}`}
              role="status"
            >
              <h3>{feedback.headline}</h3>
              {feedback.answer && <p>Correct spelling: {feedback.answer}</p>}
              {feedback.body && <p>{feedback.body}</p>}
              {feedback.footer && <p>{feedback.footer}</p>}
            </div>
          )}
        </section>
      )}
      <aside className="b4-audio-disclosure" aria-label="Audio information">
        {B4_AUDIO_AUTHORITY.futureDisclosure}
      </aside>
    </main>
  );
}

function B3App({ services }) {
  const [proofState, setProofState] = useState(() =>
    services.controller.getState(),
  );
  const [actionPending, setActionPending] = useState(false);

  useEffect(() => {
    const subscription = services.controller.subscribe(setProofState);
    const start = services.runLiveProofCommand ?? (() => services.controller.start());
    void start().catch(() => undefined);
    return () => subscription.remove();
  }, [services]);

  const busy = actionPending ||
    proofState.status === 'purchasing' ||
    proofState.status === 'downloading';
  const runAction = (action) => {
    if (busy) return;
    setActionPending(true);
    void action()
      .catch(() => undefined)
      .finally(() => setActionPending(false));
  };

  return (
    <main className="shell b3-proof-shell">
      <section className="hero" aria-labelledby="b3-proof-title">
        <p className="eyebrow">Parent-only diagnostic</p>
        <h1 id="b3-proof-title">B3 sandbox proof</h1>
        <p className="intro">
          Store and signed spelling-pack checks for a grown-up tester.
        </p>
      </section>

      <section className="status-card proof-status" aria-live="polite">
        <div>
          <p className="label">Proof state</p>
          <h2>{proofState.status}</h2>
          <p className="proof-message">{proofState.message}</p>
        </div>
        <span className="status-pill">
          {proofState.packReady ? 'Pack ready' : 'Pack locked'}
        </span>
      </section>

      <section className="commerce-card" aria-labelledby="b3-product-title">
        <div>
          <p className="label">Sandbox product</p>
          <h2 id="b3-product-title">Full KS2 proof pack</h2>
          <p className="localised-price">{proofState.displayPrice}</p>
        </div>
        <div className="proof-actions" aria-label="Parent sandbox actions">
          <button
            type="button"
            disabled={busy || proofState.displayPrice === ''}
            onClick={() => runAction(services.controller.buy)}
          >
            Buy
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => runAction(services.controller.restore)}
          >
            Restore
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => runAction(services.controller.redownload)}
          >
            Redownload
          </button>
        </div>
      </section>

      <dl className="evidence-grid" aria-label="Signed pack evidence">
        <div>
          <dt>Manifest digest</dt>
          <dd>{proofState.digests.manifest}</dd>
        </div>
        <div>
          <dt>Archive digest</dt>
          <dd>{proofState.digests.archive}</dd>
        </div>
        <div>
          <dt>Install digest</dt>
          <dd>{proofState.digests.install ?? 'Not installed'}</dd>
        </div>
      </dl>
    </main>
  );
}

export default function App({ services }) {
  if (!services || typeof services !== 'object') {
    throw new TypeError('Application services are required.');
  }
  if (services.mode === 'product') return <ProductApp services={services} />;
  if (services.mode === 'b4-starter-product') return <B4App services={services} />;
  if (services.mode === 'b3-parent-proof') return <B3App services={services} />;
  if (services.mode === 'b2-native-proof') return <B2App services={services} />;
  return <B1App services={services} />;
}
