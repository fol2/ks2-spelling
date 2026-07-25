import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
import { HeroBackdrop } from './HeroBackdrop.jsx';
import {
  heroBgForMode,
  heroPreloadUrlsForMode,
  heroToneForProgress,
} from './backdrop-model.js';
import { countWords, dueCopy, heroWelcomeLine } from './hero-copy.js';
import { observeKeyboardInset } from './keyboard-inset.js';
import { learnerColour } from './learner-colour.js';
import { whereYouStand } from './where-you-stand.js';
import { CelebrationLayer } from './celebrations/CelebrationLayer.jsx';
import {
  diffMonsterCelebrations,
  monsterDisplayName,
  secureWordDelta,
} from './celebrations/celebration-model.js';
import {
  MEADOW_EMPTY_BODY,
  MEADOW_EMPTY_TITLE,
  buildCodexEntries,
  buildMeadowSlots,
  pickFeaturedCodexEntry,
} from './meadow/meadow-model.js';
import { stageArtUrl } from './monster-stage/monster-stage-model.js';
import {
  autoAdvanceDelayMs,
  roundProgressDots,
  spellingOnly,
} from './practice-feel.js';

// Phaser + the living Monster Stage load only when a caught codex entry is open.
const MonsterStage = lazy(() => import('./monster-stage/MonsterStage.jsx'));

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

/* The codex growth track: five stages, the last of which is the mega form. */
const CODEX_STAGES = Object.freeze([1, 2, 3, 4, 5]);
const CODEX_FINAL_STAGE = 5;
/* A word's own ladder, and the rung the engine calls secure (`SECURE_STAGE` in
   where-you-stand.js). Shown as pips rather than a numeral: "4" alone never
   said what it was four out of. */
const WORD_STAGES = Object.freeze([1, 2, 3, 4, 5]);
const SECURE_STAGE = 4;
// The web session scene carries the same disclosure under its voice controls.
const VOICE_NOTE = 'AI-generated dictation voice';
// Home and setup sit in the daylight Downs; the round walks tone 1 → 3.
const HOME_HERO_TONE = '1';
const WORKSHOP_MODES = Object.freeze([
  Object.freeze({
    id: 'smart',
    label: 'Smart Review',
    description: 'Due words, weak words and one fresh word',
  }),
  Object.freeze({
    id: 'trouble',
    label: 'Trouble Drill',
    description: 'Words that need rescue from earlier mistakes',
    emptyDescription:
      'Starts as a Smart Review until some words need rescue',
  }),
  Object.freeze({
    id: 'test',
    label: 'SATs Test',
    description: 'The full 20 words, one try each. Answers shown at the end.',
  }),
]);

function displayYearGroup(value) {
  return `Year ${value.slice(1)}`;
}

function runViewTransition(update) {
  if (
    typeof document !== 'undefined'
    && typeof document.startViewTransition === 'function'
    && typeof matchMedia === 'function'
    && !matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    // flushSync commits the React update inside the snapshot callback, so the
    // transition captures the real before/after frames.
    document.startViewTransition(() => {
      flushSync(update);
    });
    return;
  }
  update();
}

function preloadHeroToneUrls(mode) {
  if (typeof Image === 'undefined') return;
  for (const url of heroPreloadUrlsForMode(mode)) {
    const image = new Image();
    image.src = url;
  }
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

/* The app bar. Fixed, not in the flow: a bar that scrolls takes the status
   bar's space with it on the way past, which is what left the brand mark and
   the switch control sitting under the Dynamic Island. Content passes beneath
   it now, and the bar carries a wash so both stay legible while it does.
   `lead` is a slot rather than a fixed brand mark, because on a screen you are
   already inside, the app's own name is the least useful thing it could say. */
function ProductTopBar({ lead, title, action }) {
  return (
    <header className="product-topbar">
      {lead ?? <span />}
      {title && <p>{title}</p>}
      {action ?? <span />}
    </header>
  );
}

function ChevronDownIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 10 6 6 6-6" />
    </svg>
  );
}

function BackIcon({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14.5 5 8 12l6.5 7" />
    </svg>
  );
}

/* Who is practising, and the way to change it, in one control — because they
   are one question. A name in the bar also answers it without being asked,
   which a "Switch learner" button never did. */
function LearnerChip({ profile, onClick }) {
  return (
    <button
      type="button"
      className="learner-chip"
      style={{ '--learner-colour': learnerColour(profile.nickname) }}
      aria-label={`Switch learner — ${profile.nickname} is practising`}
      onClick={onClick}
    >
      <span className="learner-chip-dot" aria-hidden="true" />
      <span className="learner-chip-name">{profile.nickname}</span>
      <ChevronDownIcon />
    </button>
  );
}

/* Tab glyphs, drawn in the same stroke language as the listening controls:
   24px box, 1.8 stroke, round joins. The three text glyphs these replace
   (↗ ✦ ⌂) came from three different type families and sat at three different
   weights, which is why the old navigation rows never looked like a set. */
function TrailIcon({ size = 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6.5 20.5V4" />
      <path d="M6.5 4.8h11l-2.4 3.9 2.4 3.9h-11" />
    </svg>
  );
}

function WordsIcon({ size = 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7.5h16M4 12h16M4 16.5h9" />
    </svg>
  );
}

function CodexIcon({ size = 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 7.2v12.6" />
      <path d="M12 7.2C10.1 5.7 7.3 5 4.2 5v12.6c3.1 0 5.9.7 7.8 2.2 1.9-1.5 4.7-2.2 7.8-2.2V5c-3.1 0-5.9.7-7.8 2.2Z" />
    </svg>
  );
}

function CampIcon({ size = 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4.4 4 19h16L12 4.4Z" />
      <path d="M12 11.4 8.6 19M12 11.4 15.4 19" />
      <path d="M2.4 19h19.2" />
    </svg>
  );
}

const TRAIL_TABS = Object.freeze([
  Object.freeze({ screen: 'home', label: 'Trail', Icon: TrailIcon }),
  Object.freeze({ screen: 'progress', label: 'Words', Icon: WordsIcon }),
  Object.freeze({ screen: 'monster', label: 'Codex', Icon: CodexIcon }),
  Object.freeze({ screen: 'camp', label: 'Camp', Icon: CampIcon }),
]);

/* The four places a learner moves between, always on screen and always in the
   same order. They used to be three list rows below the fold on the home
   screen, reachable only from there and left only by a Back button in the
   far top corner — the one place a thumb cannot go.
   On a wide screen the same strip becomes a rail down the leading edge, which
   is where iPad puts its sections; the markup does not change, only the axis. */
function TrailTabs({ current, onScreen }) {
  return (
    <nav className="trail-tabs" aria-label="Sections">
      {TRAIL_TABS.map(({ screen, label, Icon }) => {
        const here = screen === current;
        return (
          <button
            key={screen}
            type="button"
            className="trail-tab"
            aria-current={here ? 'page' : undefined}
            onClick={() => {
              if (!here) onScreen(screen);
            }}
          >
            <Icon />
            <span>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}

function biometricName(type) {
  if (type === 'face') return 'Face ID';
  if (type === 'fingerprint') return 'fingerprint';
  return 'device biometrics';
}

function parentErrorCopy(state, localError) {
  if (localError) return localError;
  if (state.actionError === 'parent_pin_incorrect') {
    return `That PIN was not recognised. ${state.attemptsRemaining} attempts remain.`;
  }
  if (state.actionError === 'parent_pin_temporarily_locked') {
    return 'Too many attempts. Wait five minutes, then try again.';
  }
  return state.actionError
    ? 'Parent access needs attention. Please try again.'
    : '';
}

function ParentLearnerManager({ profile, onEdit, onRemove, onReset }) {
  const [editing, setEditing] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [nickname, setNickname] = useState(profile.nickname);
  const [yearGroup, setYearGroup] = useState(profile.yearGroup);
  const [goal, setGoal] = useState(profile.goal);
  const [resetConfirmation, setResetConfirmation] = useState('');
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');

  async function save(event) {
    event.preventDefault();
    if (busy || nickname.trim() === '') return;
    setBusy(true);
    setActionError('');
    try {
      await onEdit({
        learnerId: profile.learnerId,
        nickname: nickname.trim(),
        yearGroup,
        goal,
        colour: profile.colour,
      });
      setEditing(false);
    } catch {
      setActionError('That learner change did not save. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy || deleteConfirmation !== profile.nickname) return;
    setBusy(true);
    setActionError('');
    try {
      await onRemove(profile.learnerId);
    } catch {
      setActionError('That learner was not deleted. Please try again.');
      setBusy(false);
    }
  }

  async function resetLearning() {
    if (busy || resetConfirmation !== profile.nickname) return;
    setBusy(true);
    setActionError('');
    try {
      await onReset(profile.learnerId);
      setConfirmingReset(false);
      setResetConfirmation('');
    } catch {
      setActionError('That learning was not reset. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <li>
      <div className="parent-learner-summary">
        <span
          className="learner-avatar parent-learner-avatar"
          style={{ '--learner-colour': learnerColour(profile.nickname) }}
          aria-hidden="true"
        >
          {profile.nickname.slice(0, 1).toUpperCase()}
        </span>
        <span>
          <strong>{profile.nickname}</strong>
          <small>
            {displayYearGroup(profile.yearGroup)} · {profile.goal} words a week
          </small>
        </span>
      </div>
      <div className="parent-learner-actions">
        <button
          type="button"
          className="button-quiet"
          disabled={busy}
          onClick={() => {
            setEditing((value) => !value);
            setConfirmingReset(false);
            setConfirmingDelete(false);
            setActionError('');
          }}
        >
          Edit {profile.nickname}
        </button>
        {/* All three of these were the same lavender pill, so wiping a
            child's learning and deleting a child looked exactly like editing
            one — three identical targets, one of them irreversible, on a
            screen a parent taps through quickly. The two that destroy
            something say so before they are pressed. */}
        <button
          type="button"
          className="button-warning"
          disabled={busy}
          onClick={() => {
            setConfirmingReset((value) => !value);
            setEditing(false);
            setConfirmingDelete(false);
            setResetConfirmation('');
            setActionError('');
          }}
        >
          Reset learning
        </button>
        <button
          type="button"
          className="button-destructive"
          disabled={busy}
          onClick={() => {
            setConfirmingDelete((value) => !value);
            setEditing(false);
            setConfirmingReset(false);
            setDeleteConfirmation('');
            setActionError('');
          }}
        >
          Delete learner
        </button>
      </div>

      {editing && (
        <form className="parent-edit-form" onSubmit={(event) => void save(event)}>
          <label>
            Name or nickname
            <input
              type="text"
              maxLength="40"
              autoComplete="off"
              value={nickname}
              disabled={busy}
              onChange={(event) => setNickname(event.target.value)}
            />
          </label>
          <div className="field-pair">
            <label>
              Year group
              <select
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
          <button type="submit" className="button-primary" disabled={busy}>
            Save learner
          </button>
        </form>
      )}

      {confirmingReset && (
        <section className="parent-reset-confirmation" aria-label={`Reset ${profile.nickname}`}>
          <p>
            This clears {profile.nickname}&apos;s spelling progress, active
            round, Inklet and Camp. The learner profile remains. Type{' '}
            <strong>{profile.nickname}</strong> to confirm.
          </p>
          <label>
            Confirmation
            <input
              type="text"
              autoComplete="off"
              value={resetConfirmation}
              disabled={busy}
              onChange={(event) => setResetConfirmation(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="button-danger"
            disabled={busy || resetConfirmation !== profile.nickname}
            onClick={() => void resetLearning()}
          >
            Reset {profile.nickname}&apos;s learning
          </button>
        </section>
      )}

      {confirmingDelete && (
        <section className="parent-delete-confirmation" aria-label={`Delete ${profile.nickname}`}>
          <p>
            This permanently deletes {profile.nickname}&apos;s local learning.
            Type <strong>{profile.nickname}</strong> to confirm.
          </p>
          <label>
            Confirmation
            <input
              type="text"
              autoComplete="off"
              value={deleteConfirmation}
              disabled={busy}
              onChange={(event) => setDeleteConfirmation(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="button-danger"
            disabled={busy || deleteConfirmation !== profile.nickname}
            onClick={() => void remove()}
          >
            Permanently delete {profile.nickname}
          </button>
        </section>
      )}

      {actionError && (
        <p className="inline-error" role="alert">{actionError}</p>
      )}
    </li>
  );
}

function ParentProgressCard({ state, onRefresh }) {
  return (
    <section className="paper-card parent-card" aria-labelledby="parent-progress-title">
      <p className="product-kicker">Learning on this device</p>
      <h2 id="parent-progress-title">Spelling progress</h2>
      <p>
        A private summary of spelling practice. Inklet and Camp rewards stay
        separate from these learning figures.
      </p>
      {state.learners.length === 0 ? (
        <p>
          {state.status === 'checking'
            ? 'Checking saved progress…'
            : 'No learner progress has been saved yet.'}
        </p>
      ) : (
        <ul className="parent-progress-list">
          {state.learners.map((summary) => {
            const attempts = summary.correctCount + summary.wrongCount;
            return (
              <li key={summary.learnerId}>
                <strong>{summary.nickname}</strong>
                <span>
                  {attempts === 0
                    ? 'No spelling attempts saved yet.'
                    : `${summary.correctCount} of ${attempts} attempts correct${
                        summary.accuracyPercent === null
                          ? ''
                          : ` · ${summary.accuracyPercent}%`
                      }`}
                </span>
                <small>
                  {summary.secureItemCount} secure · {summary.dueItemCount} due ·{' '}
                  {summary.troubleItemCount} needing support
                </small>
              </li>
            );
          })}
        </ul>
      )}
      {state.status === 'unavailable' && (
        <p className="inline-error" role="alert">
          Progress could not be checked. Saved learning was not changed.
        </p>
      )}
      <button
        type="button"
        className="button-quiet"
        disabled={state.status === 'checking'}
        onClick={() => void onRefresh().catch(() => undefined)}
      >
        {state.status === 'checking' ? 'Checking…' : 'Refresh progress'}
      </button>
    </section>
  );
}

function commerceMessage(state) {
  if (state.status === 'offline') {
    return state.entitlementState === 'active'
      ? 'The store is unavailable. Last verified access and installed data remain unchanged.'
      : 'The store is unavailable. No local purchase has been changed.';
  }
  if (state.status === 'failed') {
    return 'Purchase status could not be checked. Local access and installed data were not changed.';
  }
  if (state.entitlementState === 'revoked') {
    return 'The store has verified that access ended. Installed files have not been deleted.';
  }
  if (state.entitlementState !== 'active') {
    return 'Unlock the complete statutory spelling catalogue for this family device.';
  }
  if (state.packState === 'installed') {
    return 'Purchased and installed. The pack is available offline on this device.';
  }
  if (state.packState === 'failed') {
    return 'Access is verified, but the local pack needs another download attempt.';
  }
  if (['queued', 'downloading'].includes(state.packState)) {
    return 'Access is verified and the spelling pack is being prepared locally.';
  }
  return 'Access is verified. Download the spelling pack to use it offline.';
}

function ParentCommerceCard({
  state,
  onPurchase,
  onRestore,
  onDownload,
  onRecover,
}) {
  const busy = state.status === 'checking' || state.status === 'working';
  const canBuy =
    state.entitlementState === 'none' &&
    state.displayPrice !== '' &&
    !['offline', 'failed'].includes(state.status);
  const canDownload =
    state.entitlementState === 'active' &&
    ['missing', 'failed'].includes(state.packState);
  return (
    <section className="paper-card parent-card" aria-labelledby="parent-commerce-title">
      <p className="product-kicker">Packs and purchases</p>
      <h2 id="parent-commerce-title">Full KS2 spelling</h2>
      {state.displayPrice && state.entitlementState === 'none' && (
        <p className="parent-commerce-price">{state.displayPrice}</p>
      )}
      <p aria-live="polite">{commerceMessage(state)}</p>
      <div className="parent-commerce-actions">
        {state.entitlementState === 'none' && (
          <button
            type="button"
            className="button-primary"
            disabled={busy || !canBuy}
            onClick={() => void onPurchase().catch(() => undefined)}
          >
            Buy Full KS2{state.displayPrice ? ` — ${state.displayPrice}` : ''}
          </button>
        )}
        {canDownload && (
          <button
            type="button"
            className="button-primary"
            disabled={busy}
            onClick={() => void onDownload().catch(() => undefined)}
          >
            {state.packState === 'failed' ? 'Retry download' : 'Download pack'}
          </button>
        )}
        <button
          type="button"
          className="button-quiet"
          disabled={busy}
          onClick={() => void onRestore().catch(() => undefined)}
        >
          Restore purchases
        </button>
        <button
          type="button"
          className="button-quiet"
          disabled={busy}
          onClick={() => void onRecover().catch(() => undefined)}
        >
          {busy ? 'Checking…' : 'Check again'}
        </button>
      </div>
      {state.actionError && (
        <p className="inline-error" role="alert">
          That purchase action did not complete. Local access was not changed.
        </p>
      )}
    </section>
  );
}

export function ParentArea({
  state,
  profiles,
  progressState,
  commerceState,
  onClose,
  onSetPin,
  onUnlockPin,
  onUnlockBiometrics,
  onSetBiometricsEnabled,
  onEditProfile,
  onRemoveProfile,
  onResetLearning,
  onExportBackup,
  onImportBackup,
  onRefreshProgress,
  onPurchase,
  onRestore,
  onDownload,
  onRecoverCommerce,
}) {
  const [pin, setPin] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState('');
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupMessage, setBackupMessage] = useState('');
  const [backupError, setBackupError] = useState('');
  const [confirmingImport, setConfirmingImport] = useState(false);
  const [importConfirmation, setImportConfirmation] = useState('');
  const biometric = biometricName(state.biometric.type);

  async function run(action) {
    if (busy) return;
    setBusy(true);
    setLocalError('');
    try {
      await action();
      setPin('');
      setConfirmation('');
    } catch {
      setLocalError('That did not work. Check the details and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function runBackup(action, successMessage) {
    if (backupBusy) return;
    setBackupBusy(true);
    setBackupMessage('');
    setBackupError('');
    try {
      const result = await action();
      setBackupMessage(
        result?.cancelled === true
          ? 'No backup was imported.'
          : successMessage,
      );
      setConfirmingImport(false);
      setImportConfirmation('');
    } catch {
      setBackupError('The backup did not complete. No learning was replaced.');
    } finally {
      setBackupBusy(false);
    }
  }

  if (state.status === 'unlocked') {
    return (
      <main
        className="product-app product-page parent-page"
        aria-labelledby="parent-title"
        data-chrome="bar"
      >
        {/* A sheet's bar carries the way out of the sheet. The title was
            saying "Parent area" at the same moment the large title below it
            said "Parent area". */}
        <ProductTopBar
          action={(
            <button type="button" className="topbar-action" onClick={onClose}>
              Done
            </button>
          )}
        />
        <section className="welcome-panel parent-heading">
          <p className="product-kicker">Grown-ups only</p>
          <h1 id="parent-title">Parent area</h1>
          <p>Manage local learners and device security.</p>
        </section>

        <div className="parent-grid">
          <section className="paper-card parent-card" aria-labelledby="manage-learners-title">
            <p className="product-kicker">This device</p>
            <h2 id="manage-learners-title">Manage learners</h2>
            {profiles.length === 0 ? (
              <p>No learners have been added yet.</p>
            ) : (
              <ul className="parent-learner-list">
                {profiles.map((profile) => (
                  <ParentLearnerManager
                    key={profile.learnerId}
                    profile={profile}
                    onEdit={onEditProfile}
                    onRemove={onRemoveProfile}
                    onReset={onResetLearning}
                  />
                ))}
              </ul>
            )}
          </section>

          <section className="paper-card parent-card" aria-labelledby="parent-security-title">
            <p className="product-kicker">Device security</p>
            <h2 id="parent-security-title">Quick unlock</h2>
            {state.biometric.available ? (
              <>
                <p>
                  {state.biometric.enabled
                    ? `${biometric} is on.`
                    : `${biometric} is off.`}
                  {' '}The Parent PIN still works at any time.
                </p>
                <button
                  type="button"
                  className="button-quiet"
                  disabled={busy}
                  onClick={() => void run(
                    () => onSetBiometricsEnabled(!state.biometric.enabled),
                  )}
                >
                  {state.biometric.enabled
                    ? `Turn off ${biometric}`
                    : `Turn on ${biometric}`}
                </button>
              </>
            ) : (
              <p>Biometric unlock is not available on this device.</p>
            )}
            {parentErrorCopy(state, localError) && (
              <p className="inline-error" role="alert">
                {parentErrorCopy(state, localError)}
              </p>
            )}
          </section>

          <ParentProgressCard
            state={progressState}
            onRefresh={onRefreshProgress}
          />

          <ParentCommerceCard
            state={commerceState}
            onPurchase={onPurchase}
            onRestore={onRestore}
            onDownload={onDownload}
            onRecover={onRecoverCommerce}
          />

          <section className="paper-card parent-card" aria-labelledby="parent-backup-title">
            <p className="product-kicker">Move or recover learning</p>
            <h2 id="parent-backup-title">Learning backup</h2>
            <p>
              Export saves learner profiles and learning to a file you control.
              Deleting a learner here does not delete copies exported elsewhere.
            </p>
            <div className="parent-backup-actions">
              <button
                type="button"
                className="button-quiet"
                disabled={backupBusy}
                onClick={() => void runBackup(
                  onExportBackup,
                  'The learning backup is ready to save.',
                )}
              >
                Export learning backup
              </button>
            </div>
            {/* The caution comes before the control it is about, and the control
                looks like what it does. Import replaces every learner on the
                device, and it was a lavender pill identical to Export with the
                warning printed underneath — read after the tap, if at all. */}
            <p className="parent-backup-warning">
              Import replaces every learner and learning snapshot on this
              device. The Parent PIN, purchases and installed packs stay
              unchanged.
            </p>
            {!confirmingImport && (
              <div className="parent-backup-actions">
                <button
                  type="button"
                  className="button-warning"
                  disabled={backupBusy}
                  onClick={() => {
                    setBackupMessage('');
                    setBackupError('');
                    setConfirmingImport(true);
                  }}
                >
                  Import learning backup
                </button>
              </div>
            )}
            {confirmingImport && (
              <section
                className="parent-import-confirmation"
                aria-label="Confirm learning backup import"
              >
                <label htmlFor="parent-backup-confirmation">
                  Type <strong>REPLACE</strong> to continue
                </label>
                <input
                  id="parent-backup-confirmation"
                  type="text"
                  value={importConfirmation}
                  autoComplete="off"
                  disabled={backupBusy}
                  onChange={(event) =>
                    setImportConfirmation(event.target.value)}
                />
                <div className="parent-backup-actions">
                  <button
                    type="button"
                    className="button-danger"
                    disabled={
                      backupBusy || importConfirmation !== 'REPLACE'
                    }
                    onClick={() => void runBackup(
                      onImportBackup,
                      'The learning backup was imported.',
                    )}
                  >
                    Choose backup and replace learners
                  </button>
                  <button
                    type="button"
                    className="button-quiet"
                    disabled={backupBusy}
                    onClick={() => {
                      setConfirmingImport(false);
                      setImportConfirmation('');
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </section>
            )}
            {backupMessage && (
              <p className="inline-status" role="status">{backupMessage}</p>
            )}
            {backupError && (
              <p className="inline-error" role="alert">{backupError}</p>
            )}
          </section>

          <section className="paper-card parent-card" aria-labelledby="parent-privacy-title">
            <p className="product-kicker">About this app</p>
            <h2 id="parent-privacy-title">Privacy &amp; app information</h2>
            <p>
              Learner nicknames, year groups, spelling progress and Parent
              settings stay on this device. A Parent-controlled backup leaves
              the app only when you choose where to save or share it.
            </p>
            <p>
              <strong>No advertising, analytics or tracking.</strong> The app
              does not create child accounts or send learner profiles or
              spelling progress to a purchase service.
            </p>
            <p>
              Delete a learner in Manage learners to remove that learner&apos;s
              local data. Removing the app removes its remaining local data;
              exported backup copies remain under your control.
            </p>
            <details>
              <summary>Third-party notices</summary>
              <p>
                KS2 Spelling uses audited open-source application and platform
                libraries. The release distribution includes their identity,
                source and licence notice inventory.
              </p>
            </details>
          </section>
        </div>
      </main>
    );
  }

  const settingUp = state.status === 'setup-required';
  return (
    <main
      className="product-app product-page parent-page"
      aria-labelledby="parent-access-title"
      data-chrome="bar"
    >
      <ProductTopBar
        title="Parent access"
        action={(
          <button type="button" className="topbar-action" onClick={onClose}>
            Back
          </button>
        )}
      />
      <section className="paper-card parent-gate-card">
        <p className="product-kicker">Grown-ups only</p>
        <h1 id="parent-access-title">
          {settingUp ? 'Set a Parent PIN' : 'Enter Parent PIN'}
        </h1>
        <p>
          {settingUp
            ? 'Choose six digits that are not repeated or in a simple sequence.'
            : 'Enter the six-digit Parent PIN to continue.'}
        </p>
        <form
          className="parent-pin-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => settingUp
              ? onSetPin({ pin, confirmation })
              : onUnlockPin(pin));
          }}
        >
          <label htmlFor="parent-pin">
            {settingUp ? 'New Parent PIN' : 'Parent PIN'}
          </label>
          <input
            id="parent-pin"
            name="parent-pin"
            type="password"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength="6"
            autoComplete={settingUp ? 'new-password' : 'current-password'}
            value={pin}
            disabled={busy}
            onChange={(event) => setPin(event.target.value)}
          />
          {settingUp && (
            <>
              <label htmlFor="parent-pin-confirmation">Confirm Parent PIN</label>
              <input
                id="parent-pin-confirmation"
                name="parent-pin-confirmation"
                type="password"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength="6"
                autoComplete="new-password"
                value={confirmation}
                disabled={busy}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </>
          )}
          <button
            type="submit"
            className="button-primary"
            disabled={
              busy ||
              pin.length !== 6 ||
              (settingUp && confirmation.length !== 6)
            }
          >
            {busy ? 'Checking…' : settingUp ? 'Set Parent PIN' : 'Unlock'}
          </button>
        </form>

        {!settingUp &&
          state.biometric.available &&
          state.biometric.enabled && (
            <button
              type="button"
              className="button-quiet parent-biometric-button"
              disabled={busy}
              onClick={() => void run(onUnlockBiometrics)}
            >
              Use {biometric}
            </button>
          )}
        {parentErrorCopy(state, localError) && (
          <p className="inline-error" role="alert">
            {parentErrorCopy(state, localError)}
          </p>
        )}
      </section>
    </main>
  );
}

function ProfilePicker({
  profileState,
  audioState,
  onChoose,
  onCreate,
  onOpenParent,
  onRecoverAudio,
}) {
  const [nickname, setNickname] = useState('');
  const [yearGroup, setYearGroup] = useState('Y3');
  const [goal, setGoal] = useState(10);
  const busy = profileState.status === 'saving';
  const hasLearners = profileState.profiles.length > 0;
  // The form is the whole job on a device with nobody on it, and a once-ever
  // task after that. It opens itself only while it is the job.
  const [addOpen, setAddOpen] = useState(!hasLearners);

  function submit(event) {
    event.preventDefault();
    const nextNickname = nickname.trim();
    if (!nextNickname || busy) return;
    void onCreate({
      nickname: nextNickname,
      yearGroup,
      goal,
      colour: learnerColour(nextNickname),
    })
      .then(() => {
        setNickname('');
        setAddOpen(false);
      })
      .catch(() => undefined);
  }

  return (
    <main
      className="product-app product-page picker-page"
      aria-labelledby="profile-title"
      data-chrome="bar"
      data-hero-tone={HOME_HERO_TONE}
    >
      {/* Every other screen stands on the Downs; this one was the only card
          floating on nothing. It takes the same land as the home screen it
          opens onto, deliberately: the trailhead and the trail are one place,
          so walking through the door does not change the view. */}
      <HeroBackdrop url={heroBgForMode('smart', { tone: HOME_HERO_TONE })} />
      {/* The one screen where the app's own name belongs in the bar: it is the
          front door, reached from the home screen rather than from inside. */}
      <ProductTopBar
        lead={<div className="brand-mark" aria-hidden="true">KS2</div>}
        title="KS2 Spelling"
        action={(
          <button type="button" className="topbar-action" onClick={onOpenParent}>
            For parents
          </button>
        )}
      />
      {/* On a device that already knows its learners the heading is a question
          they have read a hundred times, and their own name is what they came
          for — so the heading steps down and the names become the largest type
          on the screen. With nobody here yet it stays the headline, because
          then there is nothing else to look at. */}
      <section className="trailhead" data-state={hasLearners ? 'known' : 'empty'}>
        <p className="product-kicker">The Scribe Downs</p>
        <h1 id="profile-title">Who is practising?</h1>
        {!hasLearners && (
          <p>Add the first learner to open a spelling trail on this device.</p>
        )}
      </section>

      {hasLearners && (
        <ul className="learner-grid" aria-label="Learners on this device">
          {profileState.profiles.map((profile) => {
            const selected =
              profile.learnerId === profileState.selectedLearnerId;
            return (
              <li key={profile.learnerId}>
                <button
                  type="button"
                  className="learner-card"
                  style={{ '--learner-colour': learnerColour(profile.nickname) }}
                  disabled={busy}
                  onClick={() => onChoose(profile.learnerId)}
                >
                  <span className="learner-name">{profile.nickname}</span>
                  {/* "Last opened", not "last practised": the flag is the
                      device's saved selection, which says who was open here and
                      nothing about whether they answered anything. */}
                  <span className="learner-meta">
                    {displayYearGroup(profile.yearGroup)} · {profile.goal} words a week
                    {selected && <em>Last opened</em>}
                  </span>
                  <span className="learner-arrow" aria-hidden="true">→</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {hasLearners && !addOpen && (
        <button
          type="button"
          className="add-learner-toggle"
          aria-expanded="false"
          aria-controls="add-learner-panel"
          onClick={() => setAddOpen(true)}
        >
          <span aria-hidden="true">+</span> Add a learner
        </button>
      )}

      {addOpen && (
      <section
        id="add-learner-panel"
        className="paper-card add-learner-card"
        aria-labelledby="add-learner-title"
      >
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
      )}

      {/* A status panel should be quiet when the status is fine and loud when it
          is not: ready is one line at the foot of the page, anything else keeps
          the full panel and its repair action. */}
      <AudioStatus
        audioState={audioState}
        onRecover={onRecoverAudio}
        compact={audioState.status === 'ready'}
      />
    </main>
  );
}

function MonsterMeadow({ monsters }) {
  const slots = buildMeadowSlots(monsters);
  if (slots.length === 0) {
    return (
      <div className="monster-meadow-empty" role="status">
        <strong>{MEADOW_EMPTY_TITLE}</strong>
        <p>{MEADOW_EMPTY_BODY}</p>
      </div>
    );
  }
  const caughtCount = slots.filter((slot) => slot.kind === 'caught').length;
  return (
    <div
      className="monster-meadow"
      aria-label={`${caughtCount} codex creatures in the hero meadow`}
    >
      {slots.map((slot) => (
        <div
          key={slot.monsterId}
          className={`meadow-slot is-${slot.kind}`}
          // Locked Full-pack slots are inert on purpose: purchase stays behind
          // the existing Parent PIN gate, never on a child-facing tap target.
          aria-label={
            slot.kind === 'caught'
              ? `${slot.name}, stage ${slot.stage}`
              : `${slot.name} locked`
          }
        >
          {/* A silhouette of the creature you have not met was `brightness(0)`
              at 42% — a flat grey lump, and the loudest thing in the strip. An
              uncaught slot is drawn as what it is instead: an empty space in a
              collection, which is a shape every child who has ever filled a
              sticker album already reads. */}
          {slot.kind === 'caught' ? (
            <img
              className="meadow-slot-art"
              src={slot.artUrl}
              alt=""
              width={128}
              height={128}
              decoding="async"
            />
          ) : (
            <span className="meadow-slot-empty" aria-hidden="true">◆</span>
          )}
          {slot.kind === 'caught' ? (
            <p>
              <strong>{slot.name}</strong>
              <span>{countWords(slot.secureCount)} secure</span>
            </p>
          ) : (
            /* "Locked · More of the roster" read as a shop window to a child,
               and naming the species would promise one the Starter pack cannot
               reach. The slot says only that it is empty and worth filling. */
            <p>
              <strong>Not yet</strong>
              <span>Room to grow</span>
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function ChildHome({
  profile,
  learningState,
  audioState,
  onScreen,
  onSwitchLearner,
  onOpenParent,
  onRecoverAudio,
}) {
  // Until C7.5 lands a due projection, "due" is the words that wobbled last
  // time — the same signal Trouble Drill already reads.
  const dueCount = learningState.progress.filter(
    (item) => item.lastResult !== 'correct',
  ).length;
  return (
    <main
      className="product-app product-page child-home"
      aria-labelledby="home-title"
      data-chrome="bar tabs"
      data-hero-tone={HOME_HERO_TONE}
    >
      <HeroBackdrop url={heroBgForMode('smart', { tone: HOME_HERO_TONE })} />
      <ProductTopBar
        lead={<LearnerChip profile={profile} onClick={onSwitchLearner} />}
        action={(
          <button type="button" className="topbar-action" onClick={onOpenParent}>
            For parents
          </button>
        )}
      />
      {/* The screen now reads in the order the job runs in: who is here, what
          today asks, then the one way to begin. The companion strip used to be
          first, which gave the most prominent slot on a new learner's very
          first screen to a panel saying nothing had happened yet. */}
      <section className="trail-hero">
        <p className="product-kicker">
          The Scribe Downs · {displayYearGroup(profile.yearGroup)}
        </p>
        <p className="hero-greet">{heroWelcomeLine(profile.nickname)}</p>
        <h1 id="home-title">
          Today&apos;s words are <em>waiting.</em>
        </h1>
        {/* `dueCopy` is today's status, and it was being read as the second
            half of the headline: "words are waiting" and "nothing due today"
            then contradicted each other inside one sentence. Same string,
            given the weight it actually carries. */}
        <p className="hero-due" data-due={dueCount > 0 ? 'some' : 'none'}>
          {dueCopy(dueCount)}
        </p>
        <button
          type="button"
          className="button-primary button-large"
          onClick={() => onScreen('setup')}
        >
          Start a Smart Review
          <span aria-hidden="true"> →</span>
        </button>
      </section>

      <section className="companions" aria-labelledby="companions-title">
        <h2 id="companions-title" className="section-label">Your companions</h2>
        <MonsterMeadow monsters={learningState.monsters} />
      </section>

      {/* A device-status panel earns a place on a child's home screen only when
          something is wrong with it. Working audio is not news, and it was
          taking a full row above the sections. The picker and the parent area
          both still report it either way. */}
      {audioState.status !== 'ready' && (
        <AudioStatus audioState={audioState} onRecover={onRecoverAudio} />
      )}

      <TrailTabs current="home" onScreen={onScreen} />
    </main>
  );
}

function ToggleChip({ label, checked, onChange }) {
  return (
    <button
      type="button"
      className="toggle-chip"
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-box" aria-hidden="true">{checked ? '✓' : ''}</span>
      {label}
    </button>
  );
}

function PracticeSetup({
  audioState,
  actionError,
  progress,
  packSize,
  prefs,
  onPrefs,
  onStart,
  onBack,
  onRecoverAudio,
  busy,
}) {
  const [length, setLength] = useState(5);
  const [mode, setMode] = useState('smart');
  // The clock is read here, not inside the model, so the model stays pure and
  // the deterministic proofs can pin the day.
  const standCells = useMemo(
    () => whereYouStand(progress, packSize, Math.floor(Date.now() / 86400000)),
    [progress, packSize],
  );
  const heroTone = HOME_HERO_TONE;
  const heroUrl = heroBgForMode(mode, { tone: heroTone });
  const hasTroubleWords = (progress ?? []).some(
    (item) => Number(item.wrong) > 0,
  );

  useEffect(() => {
    preloadHeroToneUrls(mode);
  }, [mode]);

  return (
    <main
      className="product-app product-page setup-page"
      aria-labelledby="setup-title"
      data-chrome="bar action"
      data-hero-tone={heroTone}
    >
      <HeroBackdrop url={heroUrl} />
      {/* Setting up a round is a task you are inside, so it gets a way out on
          the leading edge rather than a section tab: this screen is not a place
          on the trail, it is the door to one. */}
      <ProductTopBar
        lead={(
          <button
            type="button"
            className="topbar-back"
            aria-label="Back to the trail"
            onClick={onBack}
          >
            <BackIcon />
          </button>
        )}
        title="New expedition"
      />
      <section className="setup-card">
        <p className="product-kicker">The Scribe Downs · round setup</p>
        <h1 id="setup-title">Choose today&apos;s trail</h1>

        {/* Upstream keeps a standing panel beside the round setup so the
            learner can see the shape of the pack before choosing. */}
        <section className="stand-panel" aria-labelledby="stand-title">
          <p className="product-kicker" id="stand-title">Where you stand</p>
          <dl className="stand-grid">
            {standCells.map((cell) => (
              <div key={cell.label} className={cell.warn ? 'is-warn' : undefined}>
                <dt>{cell.label}</dt>
                <dd>{cell.value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <fieldset className="choice-group">
          {/* "Workshop mode" is a word from inside the app. This is the one
              decision the screen exists to take, and it is named as one. */}
          <legend>Round type</legend>
          <div className="mode-choice">
            {WORKSHOP_MODES.map((option) => {
              const description = option.id === 'trouble' && !hasTroubleWords
                ? option.emptyDescription
                : option.description;
              return (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={mode === option.id}
                  className="mode-choice-card"
                  onClick={() => setMode(option.id)}
                >
                  <img
                    className="mode-choice-thumb"
                    src={heroBgForMode(option.id, { tone: '1' })}
                    alt=""
                  />
                  <span>
                    <strong>{option.label}</strong>
                    <small>{description}</small>
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>

        {mode === 'test' && (
          <p className="length-note">
            A SATs test always covers the full 20 Starter words.
          </p>
        )}

        {/* Length, voice and the two reading aids are set once and then left
            alone for months, and they were between a child and the button that
            starts the round: six stat cells, three round types, three length
            chips, two voices, two toggles and a status panel to scroll past.
            They fold away, with the current choices named on the summary line
            so nothing is hidden — only put down. */}
        <details className="setup-more">
          <summary>
            <span className="setup-more-label">Round settings</span>
            <span className="setup-more-value">
              {mode === 'test' ? '20 words' : `${length} words`}
              {' · '}
              {prefs.voiceId}
            </span>
          </summary>

          {mode !== 'test' && (
            <fieldset className="choice-group">
              <legend>How many words</legend>
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
          )}

          <fieldset className="choice-group">
            <legend>Reading voice</legend>
            <div className="voice-choice">
              {VOICES.map((voice) => (
                <button
                  key={voice.id}
                  type="button"
                  aria-pressed={prefs.voiceId === voice.id}
                  onClick={() => onPrefs({ voiceId: voice.id })}
                >
                  <span className="voice-symbol" aria-hidden="true">♪</span>
                  <span>
                    <strong>{voice.label}</strong>
                    <small>{voice.description}</small>
                  </span>
                </button>
              ))}
            </div>
            <p className="voice-note">{VOICE_NOTE}</p>
          </fieldset>

          <fieldset className="choice-group">
            {/* "Options" names nothing. These two decide how much help the
                round gives, which is what a parent or a child is choosing. */}
            <legend>Help during the round</legend>
            <div className="toggle-choice">
              <ToggleChip
                label="Show the sentence"
                checked={prefs.showCloze}
                onChange={(showCloze) => onPrefs({ showCloze })}
              />
              <ToggleChip
                label="Read it out straight away"
                checked={prefs.autoSpeak}
                onChange={(autoSpeak) => onPrefs({ autoSpeak })}
              />
            </div>
          </fieldset>
        </details>

        {/* A working pack is not news, and it was the last thing between the
            settings and the button. A broken one stops the round, so it stays
            loud and keeps its repair action. */}
        {audioState.status !== 'ready' && (
          <AudioStatus audioState={audioState} onRecover={onRecoverAudio} />
        )}
        {actionError && (
          <p className="inline-error" role="alert">
            That trail could not start. Please try again.
          </p>
        )}
      </section>

      {/* The one thing this screen is for, always within reach of a thumb
          rather than at the far end of a scroll. */}
      <div className="page-action">
        <button
          type="button"
          className="button-primary button-large"
          disabled={busy || audioState.status !== 'ready'}
          onClick={() => void onStart({ mode, length }).catch(() => undefined)}
        >
          {busy ? 'Preparing…' : 'Start trail'}
          {!busy && <span aria-hidden="true"> →</span>}
        </button>
      </div>
    </main>
  );
}

export function EndRoundDialog({
  onKeep,
  onLeave,
  error = '',
  leaving = false,
}) {
  const keepButton = useRef(null);
  const leaveButton = useRef(null);
  const leavingRef = useRef(leaving);
  leavingRef.current = leaving;

  useEffect(() => {
    const previousFocus = document.activeElement;
    const handleKeyDown = (event) => {
      if (leavingRef.current) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onKeep();
        return;
      }
      if (event.key !== 'Tab') return;
      if (event.shiftKey && document.activeElement === keepButton.current) {
        event.preventDefault();
        leaveButton.current?.focus();
      } else if (
        !event.shiftKey &&
        document.activeElement === leaveButton.current
      ) {
        event.preventDefault();
        keepButton.current?.focus();
      }
    };
    keepButton.current?.focus();
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (typeof previousFocus?.focus === 'function') previousFocus.focus();
    };
  }, [onKeep]);

  return (
    <section
      className="exit-confirmation"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="end-round-title"
      aria-describedby={
        error
          ? 'end-round-description end-round-error'
          : 'end-round-description'
      }
      aria-busy={leaving}
    >
      <div>
        <h2 id="end-round-title">End this round now?</h2>
        <p id="end-round-description">
          Every word you have answered is saved. The words you have not reached
          stay due for next time.
        </p>
        {error && (
          <p id="end-round-error" className="inline-error" role="alert">
            {error}
          </p>
        )}
        <div>
          <button
            ref={keepButton}
            type="button"
            className="button-quiet"
            disabled={leaving}
            onClick={onKeep}
          >
            Keep practising
          </button>
          <button
            ref={leaveButton}
            type="button"
            className="button-danger"
            disabled={leaving}
            onClick={onLeave}
          >
            {leaving ? 'Ending…' : 'End round'}
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * The web feedback ribbon: tone symbol, headline, the word in quotes — struck
 * through while it is only the learner's attempt — then the reason, then the
 * footer note under the card.
 */
function AnswerFeedback({ feedback }) {
  const tone = feedback.kind === 'error'
    ? 'bad'
    : feedback.kind === 'warn' ? 'warn' : 'good';
  const attempt = String(feedback.attemptedAnswer ?? '').trim();
  // The word beside the headline is only ever the spelling being taught. The
  // learner's own attempt used to appear there struck through whenever the
  // engine gave no target — which reads as the app crossing out the correct
  // answer — under the line "Your answer — ", whose second half came from a
  // body the engine had not filled in, so it read "Your answer — No answer
  // shown yet." while showing one. What they wrote belongs in the sentence
  // about what they wrote.
  const word = String(feedback.answer ?? '').trim();
  const body = feedback.body ?? '';
  const reason = attempt ? `You wrote “${attempt}”. ${body}`.trim() : body;
  return (
    <div
      className={`answer-feedback answer-feedback-${tone}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="answer-feedback-ribbon">
        <span className="feedback-symbol" aria-hidden="true">
          {tone === 'good' ? '✓' : tone === 'warn' ? '!' : '×'}
        </span>
        <div>
          <h2>
            {feedback.headline}
            {word && <em className="feedback-word">{`“${word}”`}</em>}
          </h2>
          {reason && <p>{reason}</p>}
        </div>
      </div>
      {feedback.footer && <small>{feedback.footer}</small>}
    </div>
  );
}

// Listening-control glyphs, ported from ks2-mastery
// `src/subjects/spelling/components/spelling-icons.jsx`. The round card's
// audio controls are icon-only there — the label lives in `aria-label`, so
// the row stays quiet and the sentence keeps the eye.
//
// The full read: the word inside its sentence. KS2 spelling is dictated in
// context — the administrator reads the sentence, not a bare word — so this
// is the primary cue here, where upstream leads with the word.
function SpeakerSentenceIcon({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 5 6 9H3v6h3l5 4Z" fill="currentColor" fillOpacity="0.12" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
    </svg>
  );
}

function SpeakerSlowIcon({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 5 6 9H3v6h3l5 4Z" fill="currentColor" fillOpacity="0.12" />
      <path d="M15.5 10a3 3 0 0 1 0 4" />
      <text x="15.5" y="20" fontSize="5.5" fontFamily="Inter,system-ui" fontWeight="800" fill="currentColor" stroke="none">0.5x</text>
    </svg>
  );
}

// The vendored cloze spells its gap as a run of underscores. Upstream draws
// it instead: a brand-coloured rule the width of the missing word, which is
// what a child is actually looking at while they listen.
function clozeParts(cloze) {
  const text = typeof cloze === 'string' ? cloze : '';
  const parts = text.split(/(_{2,})/u);
  return parts.map((part, index) => (
    /^_{2,}$/u.test(part)
      ? <span className="cloze-blank" key={index} aria-label="missing word" />
      : <span key={index}>{part}</span>
  ));
}

function PracticeScreen({
  state,
  audioState,
  prefs,
  audio,
  haptics,
  onSubmit,
  onContinue,
  onSkip,
  onEnd,
  onPlaybackFailure,
}) {
  const [answer, setAnswer] = useState('');
  const [localError, setLocalError] = useState('');
  const [confirmExit, setConfirmExit] = useState(false);
  const [exitError, setExitError] = useState('');
  const [leaving, setLeaving] = useState(false);
  const answerInputRef = useRef(null);
  const advanceTimerRef = useRef(null);
  const closeExit = useCallback(() => {
    setExitError('');
    setConfirmExit(false);
  }, []);
  const practice = state.practice;
  const busy = state.status === 'saving';

  const audioRequest = useMemo(() => practice ? Object.freeze({
    version: audioState.activeVersion,
    runtimeItemId: practice.runtimeItemId,
    sentence: practice.sentence,
    voiceId: prefs.voiceId,
  }) : null, [
    audioState.activeVersion,
    practice?.runtimeItemId,
    practice?.sentence,
    prefs.voiceId,
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
    if (!audioRequest || audioState.status !== 'ready' || !prefs.autoSpeak) {
      return;
    }
    // The sentence is the dictation, matching how a KS2 spelling test is
    // administered. A card with no sentence prompt falls back to the word so
    // autoplay never lands on a cue the pack cannot resolve.
    void play(practice?.sentence ? 'sentence' : 'word');
  // Autoplay exactly once for a newly projected card or voice.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioRequest, prefs.autoSpeak]);

  useEffect(() => {
    if (advanceTimerRef.current != null) {
      clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    }
    if (!practice?.awaitingAdvance || state.actionError) return undefined;
    const delayMs = autoAdvanceDelayMs(practice.mode);
    advanceTimerRef.current = setTimeout(() => {
      advanceTimerRef.current = null;
      void Promise.resolve(onContinue())
        .then(() => {
          setAnswer('');
        })
        .catch(() => {
          setLocalError('That answer did not save. Please try again.');
        });
    }, delayMs);
    return () => {
      if (advanceTimerRef.current != null) {
        clearTimeout(advanceTimerRef.current);
        advanceTimerRef.current = null;
      }
    };
  // onContinue is an inline service call whose identity changes per render;
  // keying on it would restart the pending advance timer on unrelated updates.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    practice?.sessionId,
    practice?.runtimeItemId,
    practice?.awaitingAdvance,
    practice?.mode,
    state.actionError,
  ]);

  useEffect(() => {
    if (!practice?.runtimeItemId || practice.awaitingAdvance) return;
    answerInputRef.current?.focus();
  // The phase belongs in here: a retry and a correction keep the same word, so
  // without it a learner who taps Check has to tap the field again to answer.
  }, [
    practice?.sessionId,
    practice?.runtimeItemId,
    practice?.phase,
    practice?.awaitingAdvance,
  ]);

  const feedbackKind = practice?.feedback?.kind ?? null;
  useEffect(() => {
    if (feedbackKind === 'success') haptics?.answerCorrect();
    // haptics is an injected fire-and-forget adapter; identity is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedbackKind, practice?.runtimeItemId]);

  if (!practice) return null;
  const practiceMode = practice.mode || 'smart';
  const isTestMode = practiceMode === 'test';
  const heroTone = heroToneForProgress(practice.progress, {
    awaitingAdvance: practice.awaitingAdvance,
  });
  const heroUrl = heroBgForMode(practiceMode, {
    tone: heroTone,
    seed: practice.sessionId,
  });
  const { total, done } = practice.progress;
  const canSkip =
    !isTestMode && !practice.awaitingAdvance && practice.phase === 'question';

  async function skip() {
    if (busy || !canSkip) return;
    try {
      await onSkip();
      setAnswer('');
      setLocalError('');
    } catch {
      setLocalError('That word could not be skipped. Please try again.');
    }
  }

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    try {
      if (practice.awaitingAdvance) {
        if (advanceTimerRef.current != null) {
          clearTimeout(advanceTimerRef.current);
          advanceTimerRef.current = null;
        }
        await onContinue();
        setAnswer('');
        return;
      }
      if (answer.trim() === '') {
        setLocalError('Type the spelling before you submit it.');
        return;
      }
      await onSubmit(answer);
      setAnswer('');
      setLocalError('');
    } catch {
      setLocalError('That answer did not save. Please try again.');
    }
  }

  async function leaveRound() {
    if (leaving || busy) return;
    setExitError('');
    setLeaving(true);
    try {
      await onEnd();
    } catch {
      setExitError(
        'This round could not be saved as unfinished. Please try again or keep practising.',
      );
      setLeaving(false);
    }
  }

  return (
    <main
      className="product-app practice-page"
      aria-labelledby="practice-title"
      data-hero-tone={heroTone}
    >
      <HeroBackdrop url={heroUrl} />
      {/* No topbar in a round: the brand mark and the mode name are known by
          the time a word is being dictated, and the height they cost is height
          the card needs once the keyboard is up. Leaving the round lives in the
          footer instead. */}
      {/* The web session head: a dot per word in the round. The dots already
          say how far along the round is, so the sentence that used to spell it
          out is gone — the label on the strip is what a screen reader reads,
          and it announces as the round moves. */}
      <div className="practice-progress">
        {/* The round drawn as what the app calls it: a trail. The marks used to
            be a loose row of identical dots with nothing joining them, which
            said how many but never that they went anywhere. They stand on a
            chalk line now, spread along its length, and the line ends at the
            same flag that marks this section in the tab strip. */}
        <div
          className="round-path"
          role="img"
          aria-live="polite"
          aria-label={`${done} of ${total} words secured`}
        >
          {/* The index is the identity here — a mark is a position in the
              round, not a word. */}
          {roundProgressDots(practice.progress).map((step, index) => (
            <span
              key={index}
              className={`round-step${step ? ` is-${step}` : ''}`}
            />
          ))}
          <span className="round-goal" aria-hidden="true">
            <TrailIcon size={15} />
          </span>
        </div>
      </div>

      <section className="practice-card" aria-labelledby="practice-title" aria-busy={busy}>
        {/* Upstream leads with a quiet instruction, not a headline — the
            sentence is what the child should be reading. Kept as the h1 so
            the round still has a document heading. */}
        <h1 id="practice-title" className="prompt-instr">Spell the word you hear.</h1>
        {practice.fallbackToSmart && (
          <p className="practice-mode-note" role="status" aria-live="polite">
            Not enough tricky words yet — this round is a Smart Review.
          </p>
        )}
        {/* Keyed on the prompt so React remounts it when the word changes:
            the sentence is the only thing that differs between cards, so it
            is the only thing that should re-enter. */}
        {!isTestMode && prefs.showCloze && (
          <p className="cloze-prompt" key={practice.cloze}>{clozeParts(practice.cloze)}</p>
        )}

        <form className="answer-form" onSubmit={(event) => void submit(event)}>
          {/* No visible label: upstream names the field through `aria-label`
              and lets the italic placeholder carry the instruction, so the
              card stays a sentence and an answer line. */}
          <div className="word-input-wrap">
            <input
              ref={answerInputRef}
              id="product-spelling-input"
              className="word-input"
              name="spelling"
              type="text"
              aria-label="Type the spelling"
              // The card's own heading already says what to do, so the line
              // itself only has to say what goes on it.
              placeholder="your spelling"
              value={answer}
              disabled={busy || practice.awaitingAdvance}
              // A spelling test must not be told the answer: no autocomplete,
              // no autocorrect, no spellcheck and no writing suggestions, which
              // together also take away the predictive strip above the keys.
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck="false"
              writingsuggestions="false"
              // The pack is a British English word list, so name the language:
              // iOS reads it when it decides which keyboard to open.
              lang="en-GB"
              // "go" is the submit key. `done` asked iOS to dismiss instead,
              // which left a typed answer sitting unsubmitted.
              enterKeyHint="go"
              onChange={(event) => setAnswer(spellingOnly(event.target.value))}
              onFocus={(event) => {
                event.currentTarget.scrollIntoView({ block: 'nearest' });
              }}
            />
          </div>

          {/* Below the answer line, as upstream has it: you type first and
              replay only if you need to. */}
          {/* Two controls, as upstream has: the dictation and a slower repeat
              of it. KS2 spelling is examined in context, so both are the
              sentence — the word on its own is not a cue this test gives. */}
          {/* Hearing the sentence again is the verb this whole screen turns on,
              and it was two unlabelled outline circles. They are named while
              there is room for a name, and fall back to the glyph alone once
              the keyboard has taken the height — the aria-label carries the
              full instruction either way. */}
          <div className="audio-row" role="group" aria-label="Listening controls">
            <button
              type="button"
              className="btn-icon"
              aria-label="Replay the sentence"
              disabled={busy || audioState.status !== 'ready'}
              onClick={() => void play('sentence')}
            >
              <SpeakerSentenceIcon />
              <span className="btn-icon-label">Hear it again</span>
            </button>
            <button
              type="button"
              className="btn-icon"
              aria-label="Replay the sentence slowly"
              disabled={busy || audioState.status !== 'ready'}
              onClick={() => void play('slow-sentence')}
            >
              <SpeakerSlowIcon />
              <span className="btn-icon-label">Slower</span>
            </button>
          </div>

          <div className="answer-actions">
            <button type="submit" className="button-primary button-submit" disabled={busy}>
              {busy ? 'Saving…' : practice.awaitingAdvance ? 'Continue' : 'Submit'}
              {!busy && <span aria-hidden="true"> →</span>}
            </button>
            {canSkip && (
              <button
                type="button"
                className="button-link"
                disabled={busy}
                onClick={() => void skip()}
              >
                Skip for now
              </button>
            )}
          </div>
        </form>

        {(localError || state.actionError) && (
          <div className="answer-notice is-warn" role="alert">
            <span className="feedback-symbol" aria-hidden="true">!</span>
            <div>
              <p className="answer-notice-head">
                {localError || 'That answer did not save.'}
              </p>
              <p className="answer-notice-body">
                {localError
                  ? 'The spelling box is still empty.'
                  : 'Your earlier saved learning is safe. Please try again.'}
              </p>
            </div>
          </div>
        )}

        {/* A SATs test says up front that answers are shown at the end, so the
            round cannot report one. It cannot report a tone either: a green
            tick or a red cross is the result, said without words. The test
            confirms only that the answer went in. */}
        {practice.feedback && (isTestMode ? (
          <p className="answer-recorded" role="status" aria-live="polite">
            Answer saved. Every word is shown at the end.
          </p>
        ) : (
          <AnswerFeedback feedback={practice.feedback} />
        ))}
      </section>

      {/* Upstream keeps the round's housekeeping outside the card: the voice
          disclosure sits quietly at one end and leaving the round at the
          other, so the card itself holds nothing but the spelling. */}
      <footer className="session-footer">
        <p className="voice-note">{VOICE_NOTE}</p>
        <button
          type="button"
          className="button-quiet"
          disabled={busy}
          onClick={() => {
            setExitError('');
            setConfirmExit(true);
          }}
        >
          End round early
        </button>
      </footer>

      {confirmExit && (
        <EndRoundDialog
          error={exitError}
          leaving={leaving || busy}
          onKeep={closeExit}
          onLeave={() => void leaveRound()}
        />
      )}
    </main>
  );
}

function SummaryScreen({
  summary,
  monster,
  celebrationEvents,
  secureGain,
  haptics,
  onCelebrationDone,
  onScreen,
}) {
  const practiceMode = summary?.mode || 'smart';
  const heroTone = '3';
  const heroUrl = heroBgForMode(practiceMode, {
    tone: heroTone,
    seed: summary?.sessionId ?? null,
  });
  const rewardName = monsterDisplayName(monster?.monsterId ?? 'inklet');
  return (
    <main
      className="product-app product-page summary-page"
      aria-labelledby="summary-title"
      data-chrome="bar"
      data-hero-tone={heroTone}
    >
      <HeroBackdrop url={heroUrl} />
      <CelebrationLayer
        events={celebrationEvents}
        haptics={haptics}
        onDone={onCelebrationDone}
      />
      <ProductTopBar title="Results" />
      <section className="summary-hero">
        <div className="summary-medal" aria-hidden="true">✓</div>
        <p className="product-kicker">
          {summary?.endedEarly ? 'Round ended early' : 'Trail complete'}
        </p>
        <h1 id="summary-title">
          {summary?.endedEarly ? 'Saved so far' : 'Well done'}
        </h1>
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
      {/* The engine already names the words that needed a correction; the
          port only ever showed the count. Upstream lists them as chips so a
          child leaves the round knowing which spellings to look at again. */}
      {(summary?.mistakes?.length ?? 0) > 0 && (
        <section className="summary-drill" aria-labelledby="summary-drill-title">
          <h2 id="summary-drill-title">Words that slipped today</h2>
          <p>These came back for a second look. They stay due for next time.</p>
          <ul className="summary-drill-chips">
            {summary.mistakes.map((entry) => (
              <li key={entry.slug ?? entry.word}>{entry.word ?? entry.slug}</li>
            ))}
          </ul>
        </section>
      )}
      {/* The painted companion, not a stand-in for one. This panel drew a flat
          blue SVG blob while the same creature at the same growth stage was
          already on the home screen and in the codex as painted art — so the
          one screen that hands out the reward showed the placeholder. And it
          called every companion Inklet regardless of which one it had. */}
      <section className="paper-card reward-summary">
        <img
          className="reward-art"
          src={stageArtUrl(
            monster?.monsterId ?? 'inklet',
            monster?.branch ?? 'b1',
            monster?.derivedStage ?? 0,
          )}
          alt=""
          width={320}
          height={320}
          decoding="async"
        />
        <div>
          <h2>{`${rewardName} noticed your practice`}</h2>
          <p>
            {countWords(monster?.secureCount ?? 0)} now secure, helping
            {` ${rewardName}`} grow.
          </p>
          {secureGain > 0 && (
            <p className="reward-secure-toast" role="status" aria-live="polite">
              {`+${secureGain} words secure`}
            </p>
          )}
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

function ProgressScreen({ progress, onScreen, onStart }) {
  return (
    <main
      className="product-app product-page"
      aria-labelledby="progress-title"
      data-chrome="tabs"
    >
      {/* No bar and no Back: the page's own title says where you are, and the
          tabs say how to leave. Two of the three were saying the same thing. */}
      {/* The eyebrow used to say "Saved on this device" and the line under the
          heading "Each row comes from this learner's local spelling progress" —
          both true, both written about the app rather than about the words. A
          child opening this screen wants to know how many words they have and
          what the marks beside them mean. */}
      <section className="page-heading">
        <p className="product-kicker">
          {progress.length === 0
            ? 'Nothing practised yet'
            : `${countWords(progress.length)} practised`}
        </p>
        <h1 id="progress-title">Your word trail</h1>
        <p>
          Four marks means a word is yours. Five means it is not going anywhere.
        </p>
      </section>
      {progress.length === 0 ? (
        <section className="paper-card empty-state">
          <h2>Your trail is ready</h2>
          <p>Finish a Smart Review and your practised words will appear here.</p>
          <button type="button" className="button-primary" onClick={onStart}>
            Start a Smart Review
          </button>
        </section>
      ) : (
        /* The word is the subject of a spelling app, so it leads the row. The
           stage was a numeral in a filled circle — a number out of an unstated
           total — beside a status word that said the same thing again in prose,
           and on a phone that third column wrapped onto its own line and made
           every row 135px tall for one word. Five pips say the stage and its
           ceiling at once, and the row is a row. */
        <ul className="word-progress-list">
          {progress.map((item) => (
            <li key={item.runtimeItemId}>
              <strong>{item.target}</strong>
              <small>
                {item.correct} correct · {item.wrong} to revisit
              </small>
              <span
                className="word-progress-stage"
                role="img"
                aria-label={
                  item.stage >= SECURE_STAGE
                    ? `Secure — stage ${item.stage} of ${WORD_STAGES.length}`
                    : `Stage ${item.stage} of ${WORD_STAGES.length}`
                }
              >
                {WORD_STAGES.map((step) => (
                  <span
                    key={step}
                    className={step <= item.stage ? 'is-reached' : undefined}
                  />
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
      <TrailTabs current="progress" onScreen={onScreen} />
    </main>
  );
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(
    () => typeof matchMedia === 'function'
      && matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== 'function') return undefined;
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  return reduced;
}

function CodexScreen({ monsters, onScreen }) {
  const reducedMotion = useReducedMotion();
  const entries = useMemo(() => buildCodexEntries(monsters), [monsters]);
  const featured = useMemo(() => pickFeaturedCodexEntry(entries), [entries]);
  const [selectedId, setSelectedId] = useState(
    () => featured?.monsterId ?? null,
  );
  const selected = entries.find(
    (entry) => entry.monsterId === selectedId && entry.caught,
  ) ?? featured;
  const nextThreshold = selected?.thresholds.find(
    (threshold) => threshold > selected.secureCount,
  );

  return (
    <main
      className="product-app product-page companion-page codex-page"
      aria-labelledby="codex-title"
      data-chrome="tabs"
    >
      <section className="page-heading">
        {/* One word for one thing. This screen called them monsters in the
            eyebrow, creatures in the heading and companions in the body, while
            the home screen called them companions and the tab calls the place
            the Codex. Companions everywhere; the Codex is where they live.
            The sentence about purchases was written for a reviewer, not for a
            child, and it took four lines of a child's screen to say it. It is
            true and it belongs in the parent area. */}
        <p className="product-kicker">The Codex</p>
        <h1 id="codex-title">Your companions</h1>
        <p>Each one grows as your spellings become secure.</p>
      </section>

      <ul className="codex-grid">
        {entries.map((entry) => {
          if (!entry.caught) {
            return (
              <li
                key={entry.monsterId}
                className="codex-card is-locked"
                // Inert on purpose: Full KS2 purchase stays in the Parent
                // area behind the existing PIN gate.
                aria-label={entry.imageAlt}
              >
                <span className="codex-card-empty" aria-hidden="true">◆</span>
                <strong>Not found yet</strong>
                <small>An empty slot</small>
              </li>
            );
          }
          const selectedCaught = selected?.monsterId === entry.monsterId;
          return (
            <li key={entry.monsterId}>
              <button
                type="button"
                className={`codex-card is-caught${selectedCaught ? ' is-selected' : ''}`}
                aria-pressed={selectedCaught}
                aria-label={`View ${entry.name}`}
                onClick={() => setSelectedId(entry.monsterId)}
              >
                <img
                  className="codex-card-art"
                  src={entry.artUrl}
                  alt=""
                  width={160}
                  height={160}
                  decoding="async"
                />
                <strong>{entry.name}</strong>
                <small>Stage {entry.stage}</small>
                {/* The growth track the web codex card carries. The stage is
                    already named above for assistive tech, so the dots are
                    decoration and stay hidden from it. */}
                <span className="codex-stage-track" aria-hidden="true">
                  {CODEX_STAGES.map((stage) => (
                    <span
                      key={stage}
                      className={[
                        'codex-stage-dot',
                        stage <= entry.stage ? 'is-lit' : '',
                        stage === entry.stage ? 'is-current' : '',
                        stage === CODEX_FINAL_STAGE ? 'is-mega' : '',
                      ].filter(Boolean).join(' ')}
                    />
                  ))}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {selected ? (
        <section className="companion-hero" aria-labelledby="codex-stage-title">
          <Suspense
            fallback={(
              <div className="monster-stage is-static" aria-hidden="true">
                <img
                  className="monster-stage-img"
                  src={stageArtUrl(
                    selected.monsterId,
                    selected.branch,
                    selected.stage,
                  )}
                  alt=""
                  width={640}
                  height={640}
                  decoding="async"
                />
              </div>
            )}
          >
            <MonsterStage
              monsterId={selected.monsterId}
              branch={selected.branch}
              stage={selected.stage}
              secureCount={selected.secureCount}
              reducedMotion={reducedMotion}
            />
          </Suspense>
          <p className="product-kicker">Trail companion</p>
          <h2 id="codex-stage-title">Meet {selected.name}</h2>
          <p>{selected.blurb}</p>
          <dl>
            <div>
              <dt>Secure words</dt>
              <dd>{selected.secureCount}</dd>
            </div>
            <div>
              <dt>Growth stage</dt>
              <dd>{selected.stage}</dd>
            </div>
          </dl>
          <p className="next-reward">
            {nextThreshold
              ? `${countWords(nextThreshold - selected.secureCount)} more until the next change.`
              : `${selected.name} has reached the final stage on this trail.`}
          </p>
        </section>
      ) : (
        <section className="paper-card empty-state" role="status">
          <h2>Codex is empty</h2>
          <p>
            Codex is empty. Progress is stored safely. Complete a round to
            unlock your first entry.
          </p>
        </section>
      )}
      <TrailTabs current="monster" onScreen={onScreen} />
    </main>
  );
}

function CampScreen({ camp, onScreen }) {
  const level = camp?.campHighWater ?? 0;
  return (
    <main
      className="product-app product-page camp-page"
      aria-labelledby="camp-title"
      // The camp stands on the Downs like everywhere else does. This was the one
      // screen with no land under it at all: a flat vector tent in a visual
      // language the app uses nowhere else, on bare paper.
      data-chrome="tabs"
      data-hero-tone={HOME_HERO_TONE}
    >
      <HeroBackdrop url={heroBgForMode('trouble', { tone: HOME_HERO_TONE })} />
      <section className="camp-hero">
        {/* The level is the one fact this screen holds, so it is the headline
            rather than a pill underneath a heading that said "Camp" directly
            below an eyebrow that also said "Expedition Camp". The figure is
            spanned out of the display face: Georgia's numerals are old-style,
            so "3" set in the heading dropped below its own baseline. */}
        <p className="product-kicker">The Scribe Downs · Camp</p>
        <h1 id="camp-title">
          Camp level <span className="camp-level-figure">{level}</span>
        </h1>
        {/* "Camp grows only from eligible revision missions. Ordinary practice
            still helps spelling and Inklet, but does not invent Camp credit."
            was the rule as an engineer would state it, on a child's screen —
            and it named a companion that may not be theirs. The rule itself is
            worth keeping: coming back to old words is what raises camp, and a
            child who does not know that cannot aim for it. */}
        <p>
          Camp rises when you come back to words you met a while ago — not from
          fresh practice, however much of it you do.
        </p>
        {level === 0 && (
          <p className="camp-note">
            Nothing pitched yet. Your first revision round starts it.
          </p>
        )}
      </section>
      <TrailTabs current="camp" onScreen={onScreen} />
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
  const [parentState, setParentState] = useState(() =>
    services.parent.getState(),
  );
  const [parentProgressState, setParentProgressState] = useState(() =>
    services.parentProgress.getState(),
  );
  const [parentCommerceState, setParentCommerceState] = useState(() =>
    services.parentCommerce.getState(),
  );
  const [parentOpen, setParentOpen] = useState(false);
  const [celebrationEvents, setCelebrationEvents] = useState([]);
  const [secureGain, setSecureGain] = useState(0);
  const learningScreenRef = useRef(learningState.screen);
  const monstersAtRoundStartRef = useRef(null);

  // Every screen that takes typing needs the keyboard's height, so the watch
  // lives once at the root rather than per form.
  useEffect(() => observeKeyboardInset(), []);

  useEffect(() => {
    const profileSubscription = services.controller.subscribe(setProfileState);
    const learningSubscription = services.learning.subscribe((next) => {
      const previousScreen = learningScreenRef.current;
      const screenChanged = previousScreen !== next.screen;
      if (previousScreen !== 'practice' && next.screen === 'practice') {
        monstersAtRoundStartRef.current = next.monsters;
      }
      if (previousScreen !== 'summary' && next.screen === 'summary') {
        const before = monstersAtRoundStartRef.current ?? [];
        setCelebrationEvents(diffMonsterCelebrations(before, next.monsters));
        setSecureGain(secureWordDelta(before, next.monsters));
      }
      learningScreenRef.current = next.screen;
      if (screenChanged) {
        runViewTransition(() => setLearningState(next));
        return;
      }
      setLearningState(next);
    });
    const audioSubscription =
      services.audioAvailability.subscribe(setAudioState);
    const parentSubscription = services.parent.subscribe(setParentState);
    const parentProgressSubscription =
      services.parentProgress.subscribe(setParentProgressState);
    const parentCommerceSubscription =
      services.parentCommerce.subscribe(setParentCommerceState);
    return () => {
      profileSubscription.remove();
      learningSubscription.remove();
      audioSubscription.remove();
      parentSubscription.remove();
      parentProgressSubscription.remove();
      parentCommerceSubscription.remove();
    };
  }, [services]);

  useEffect(() => {
    if (!parentOpen || parentState.status !== 'unlocked') return;
    void services.parentProgress.refresh().catch(() => undefined);
    void services.parentCommerce.recover().catch(() => undefined);
  }, [parentOpen, parentState.status, services]);

  if (profileState.status === 'failed') {
    return (
      <main className="product-app product-page" data-chrome="bar">
        <ProductTopBar title="KS2 Spelling" />
        <section className="paper-card empty-state" aria-labelledby="product-data-title">
          <p className="product-kicker">Local data</p>
          <h1 id="product-data-title">Your saved learning could not open</h1>
          <p>Your local data has not been replaced.</p>
          <button
            type="button"
            className="button-primary"
            onClick={() => globalThis.location?.reload()}
          >
            Try opening again
          </button>
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
  const closeParent = () => {
    services.parent.lock();
    setParentOpen(false);
  };

  if (parentOpen) {
    return (
      <ParentArea
        state={parentState}
        profiles={profileState.profiles}
        progressState={parentProgressState}
        commerceState={parentCommerceState}
        onClose={closeParent}
        onSetPin={(candidate) => services.parent.setPin(candidate)}
        onUnlockPin={(candidate) => services.parent.unlockWithPin(candidate)}
        onUnlockBiometrics={() => services.parent.unlockWithBiometrics()}
        onSetBiometricsEnabled={(enabled) =>
          services.parent.setBiometricsEnabled(enabled)}
        onEditProfile={(draft) => services.controller.editProfile(draft)}
        onRemoveProfile={async (learnerId) => {
          await services.controller.removeProfile(learnerId);
          await services.parentProgress.refresh();
        }}
        onResetLearning={(learnerId) =>
          services.parentAdministration.resetLearning(learnerId)}
        onExportBackup={() => services.parentBackup.exportBackup()}
        onImportBackup={() => services.parentBackup.importBackup()}
        onRefreshProgress={() => services.parentProgress.refresh()}
        onPurchase={() => services.parentCommerce.purchase()}
        onRestore={() => services.parentCommerce.restore()}
        onDownload={() => services.parentCommerce.download()}
        onRecoverCommerce={() => services.parentCommerce.recover()}
      />
    );
  }

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
        onOpenParent={() => setParentOpen(true)}
        onRecoverAudio={recoverAudio}
      />
    );
  }

  if (learningState.screen === 'setup') {
    return (
      <PracticeSetup
        audioState={audioState}
        actionError={learningState.actionError}
        progress={learningState.progress}
        packSize={learningState.packSize}
        prefs={learningState.prefs}
        onPrefs={(patch) => {
          void services.learning.savePrefs(patch).catch(() => undefined);
        }}
        onStart={(options) => services.learning.startRound(options)}
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
        prefs={learningState.prefs}
        audio={services.audio}
        haptics={services.haptics}
        onSubmit={(typed) => services.learning.submitAnswer(typed)}
        onContinue={() => services.learning.continueRound()}
        onSkip={() => services.learning.skipWord()}
        onEnd={() => services.learning.endRound()}
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
        celebrationEvents={celebrationEvents}
        secureGain={secureGain}
        haptics={services.haptics}
        onCelebrationDone={() => setCelebrationEvents([])}
        onScreen={showScreen}
      />
    );
  }
  if (learningState.screen === 'progress') {
    return (
      <ProgressScreen
        progress={learningState.progress}
        onScreen={showScreen}
        onStart={() => showScreen('setup')}
      />
    );
  }
  if (learningState.screen === 'monster') {
    return (
      <CodexScreen monsters={learningState.monsters} onScreen={showScreen} />
    );
  }
  if (learningState.screen === 'camp') {
    return <CampScreen camp={learningState.camp} onScreen={showScreen} />;
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
      onOpenParent={() => setParentOpen(true)}
      onRecoverAudio={recoverAudio}
    />
  );
}
