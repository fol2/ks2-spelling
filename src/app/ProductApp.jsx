import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { buildCodex, setupExpeditionCompanion, trailMeadowCompanions } from './codex-model.js';
import { learnerColour } from './learner-colour.js';
import { artUrl, regionArt } from './mastery-art.js';
import { autoAdvanceDelayMs } from './practice-feel.js';
import { downloadActionLabel } from './parent-commerce-controller.js';
import { milestoneLadder } from './records-model.js';
import { buildWordBank, buildWordDetail, hearWordRequest } from './word-bank-model.js';
import { CelebrationLayer } from './celebrations/CelebrationLayer.jsx';
import {
  achievementCelebration,
  campLevelCelebration,
  diffMonsterCelebrations,
  milestoneCelebration,
  primaryProgressedRewardTrackId,
  secureWordDelta,
} from './celebrations/celebration-model.js';
import { TrailMeadow } from './trail/TrailMeadow.jsx';
import { PrivacyNoticeCard } from './PrivacyNoticeCard.jsx';

// Phaser + the living Monster Stage load only when a caught codex entry is
// opened for a closer look.
const MonsterStage = lazy(() => import('./monster-stage/MonsterStage.jsx'));

const ROUND_LENGTHS = Object.freeze([5, 10, 20]);
const REGION = 'the-scribe-downs';
// The dictation voice a round falls back to. It is not a choice a learner
// makes any more, so this is the whole of the app's opinion about it.
const PACKAGED_VOICE = 'Iapetus';

function prefersReducedMotion() {
  return (
    typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

// One drawing hand: 24px box, 1.8 stroke, round cap and join, no fills.
function Glyph({ size = 22, children, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

const IconTrail = (props) => (
  <Glyph {...props}>
    <path d="M6.5 20.5V4" />
    <path d="M6.5 4.8h11l-2.4 3.9 2.4 3.9h-11" />
  </Glyph>
);
const IconWords = (props) => (
  <Glyph {...props}><path d="M4 7.5h16M4 12h16M4 16.5h9" /></Glyph>
);
const IconCodex = (props) => (
  <Glyph {...props}>
    <path d="M12 7.2v12.6" />
    <path d="M12 7.2C10.1 5.7 7.3 5 4.2 5v12.6c3.1 0 5.9.7 7.8 2.2 1.9-1.5 4.7-2.2 7.8-2.2V5c-3.1 0-5.9.7-7.8 2.2Z" />
  </Glyph>
);
const IconCamp = (props) => (
  <Glyph {...props}>
    <path d="M12 4.4 4 19h16L12 4.4Z" />
    <path d="M12 11.4 8.6 19M12 11.4 15.4 19" />
    <path d="M2.4 19h19.2" />
  </Glyph>
);
const IconBack = (props) => (
  <Glyph {...props}><path d="M14.5 5 8 12l6.5 7" /></Glyph>
);
const IconForward = (props) => (
  <Glyph {...props}><path d="M4 12h15M13 6l6 6-6 6" /></Glyph>
);
const IconChevron = (props) => (
  <Glyph {...props}><path d="m9 6 6 6-6 6" /></Glyph>
);
const IconChevronDown = (props) => (
  <Glyph {...props}><path d="m6 10 6 6 6-6" /></Glyph>
);
const IconLock = (props) => (
  <Glyph {...props}>
    <rect x="4.5" y="10.5" width="15" height="9.5" rx="2.6" />
    <path d="M8.2 10.5V7.8a3.8 3.8 0 0 1 7.6 0v2.7" />
  </Glyph>
);
const IconSpeaker = (props) => (
  <Glyph {...props}>
    <path d="M11 5 6 9H3v6h3l5 4Z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
  </Glyph>
);
const IconSpeakerSlow = (props) => (
  <Glyph {...props}>
    <path d="M11 5 6 9H3v6h3l5 4Z" />
    <path d="M15.5 10a3 3 0 0 1 0 4" />
  </Glyph>
);
const IconTick = (props) => (
  <Glyph {...props}><path d="m5 13 4.5 4.5L19 7" /></Glyph>
);
const IconReturn = (props) => (
  <Glyph {...props}>
    <path d="M3.2 12a8.8 8.8 0 1 0 3.4-7" />
    <path d="M3 4.6V10h5.4" />
  </Glyph>
);
const IconPlus = (props) => (
  <Glyph {...props}><path d="M12 5v14M5 12h14" /></Glyph>
);
const IconNote = (props) => (
  <Glyph {...props}>
    <path d="M9 18V6l10-2v12" />
    <circle cx="7" cy="18" r="2" />
    <circle cx="17" cy="16" r="2" />
  </Glyph>
);
const IconWarning = (props) => (
  <Glyph {...props}>
    <path d="M12 8.6v5" />
    <path d="M12 17h.01" />
    <path d="M10.3 4.2 2.9 17.4A1.9 1.9 0 0 0 4.6 20.2h14.8a1.9 1.9 0 0 0 1.7-2.8L13.7 4.2a1.9 1.9 0 0 0-3.4 0Z" />
  </Glyph>
);
const IconGuardian = (props) => (
  <Glyph {...props}>
    <path d="M12 3.2 19.1 6v6.1c0 4.2-3 7.3-7.1 8.7-4.1-1.4-7.1-4.5-7.1-8.7V6L12 3.2Z" />
    <path d="m9 11.9 2.1 2.2 3.9-4.2" />
  </Glyph>
);

function displayYearGroup(value) {
  return `Year ${value.slice(1)}`;
}

function initialOf(nickname) {
  return nickname.slice(0, 1).toUpperCase();
}

/**
 * One painted scene. `plate` and `veil` drive the backdrop through custom
 * properties so every screen mixes the same recipe rather than its own. When
 * `waypoints` is set, this scene owns the place foot in normal document flow.
 */
function Scene({
  className = '',
  dusk = false,
  plate = null,
  plateY,
  plateOpacity,
  veil,
  waypoints = false,
  waypointScreen,
  onScreen,
  children,
  ...rest
}) {
  const style = {};
  if (plate) style['--plate'] = artUrl(plate);
  if (plateY) style['--plate-y'] = plateY;
  if (plateOpacity !== undefined) style['--plate-opacity'] = String(plateOpacity);
  if (veil) style['--veil'] = veil;
  return (
    <div
      className={[
        'product-scene',
        dusk ? 'scene-dusk' : '',
        waypoints ? 'has-waypoints' : '',
        className,
      ].filter(Boolean).join(' ')}
      style={style}
      {...rest}
    >
      {plate && <span className="scene-plate" />}
      {veil && <span className="scene-veil" />}
      {children}
      {waypoints && (
        <WaypointBar screen={waypointScreen} onScreen={onScreen} />
      )}
    </div>
  );
}

const WAYPOINTS = Object.freeze([
  Object.freeze({ screen: 'home', label: 'Trail', Icon: IconTrail }),
  Object.freeze({ screen: 'progress', label: 'Words', Icon: IconWords }),
  Object.freeze({ screen: 'monster', label: 'Codex', Icon: IconCodex }),
  Object.freeze({ screen: 'camp', label: 'Camp', Icon: IconCamp }),
]);

function WaypointBar({ screen, onScreen }) {
  return (
    <nav className="waypoint-bar" aria-label="Places on the trail">
      {WAYPOINTS.map(({ screen: target, label, Icon }) => (
        <button
          key={target}
          type="button"
          className="press-soft press"
          aria-current={screen === target ? 'page' : undefined}
          onClick={() => onScreen(target)}
        >
          <Icon size={23} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}

const AUDIO_COPY = Object.freeze({
  ready: Object.freeze([
    'Listening pack ready',
    'Verified pre-recorded audio is available on this device.',
  ]),
  corrupt: Object.freeze([
    'Listening pack needs repair',
    'The local audio no longer matches its verified pack.',
  ]),
  checking: Object.freeze([
    'Checking the listening pack',
    'Checking the local pre-recorded audio now.',
  ]),
  unavailable: Object.freeze([
    'Listening pack could not be checked',
    'Your learning is still saved. Check the local pack again.',
  ]),
  missing: Object.freeze([
    'Listening pack needs setup',
    'Pre-recorded audio is not ready on this device yet.',
  ]),
});

function AudioStatus({ audioState, onRecover, compact = false, dusk = false }) {
  const [title, body] = AUDIO_COPY[audioState.status] ?? AUDIO_COPY.missing;
  return (
    <section
      className={[
        'audio-state',
        `audio-state-${audioState.status}`,
        dusk ? 'audio-state-dusk' : '',
      ].filter(Boolean).join(' ')}
      aria-labelledby="starter-audio-title"
      aria-live="polite"
    >
      <span className="audio-state-icon"><IconNote size={18} /></span>
      <div>
        <h2 id="starter-audio-title">{title}</h2>
        {!compact && <p>{body}</p>}
      </div>
      {!['ready', 'checking'].includes(audioState.status) && (
        <button type="button" className="button-quiet press" onClick={onRecover}>
          Check again
        </button>
      )}
    </section>
  );
}

function ProductTopBar({ title = 'KS2 Spelling', action }) {
  return (
    <header className="product-topbar">
      <p>{title}</p>
      {action ?? <span />}
    </header>
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
  if (state.actionError === 'parent_device_authentication_unavailable') {
    return 'Set a screen lock on this device, then try again. Parent access remains locked.';
  }
  if (state.actionError === 'parent_device_authentication_rejected') {
    return 'The device did not confirm its owner. Parent access remains locked.';
  }
  if (
    state.actionError === 'parent_pin_setup_failed'
    || state.actionError === 'parent_pin_reset_failed'
  ) {
    return 'The Parent PIN was not changed. Your saved learning and purchases stay unchanged.';
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
    } catch (error) {
      if (error?.postCommit === true) {
        setActionError('That learning was reset, but the app could not refresh the view. Close and reopen the app.');
        setConfirmingReset(false);
        setResetConfirmation('');
      } else {
        setActionError('That learning was not reset. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <li>
      <div className="parent-learner-summary">
        <span
          className="learner-avatar parent-learner-avatar"
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
        </span>
      </div>
      <div className="parent-learner-actions">
        <button
          type="button"
          className="button-quiet press-soft press"
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
        <button
          type="button"
          className="button-warning press-soft press"
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
          className="button-destructive press-soft press"
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
          <button type="submit" className="button-primary press" disabled={busy}>
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
            className="button-danger press"
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
            className="button-danger press"
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
                {(attempts > 0 ||
                  summary.secureItemCount > 0 ||
                  summary.dueItemCount > 0 ||
                  summary.troubleItemCount > 0) && (
                  <small>
                    {summary.secureItemCount} secure · {summary.dueItemCount} due ·{' '}
                    {summary.troubleItemCount} needing support
                  </small>
                )}
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
        className="button-quiet press-soft press"
        disabled={state.status === 'checking'}
        onClick={() => void onRefresh().catch(() => undefined)}
      >
        {state.status === 'checking' ? 'Checking…' : 'Refresh progress'}
      </button>
    </section>
  );
}

const isInstalling = (state) =>
  state.status === 'working' && state.action === 'download';
// Whole shards only, so the count of finished ones is also the index of the
// one in flight — except after the last, where there is nothing beyond 15.
const installingShard = ({ completedShards, totalShards }) =>
  Math.min(completedShards + 1, totalShards);

// `fullCatalogueActive` is what this running session actually composed. The
// learning catalogue is chosen once, at startup, so an install that finishes
// while the app is open leaves the child on the 20 Starter words until the
// next launch. Saying "installed" and nothing else would be a lie the family
// could not act on.
function commerceMessage(state, fullCatalogueActive) {
  // A running download owns the message. `packState` still reads whatever the
  // last snapshot said — 'downloading' for an interrupted install — so without
  // this branch an install in progress reads as an install that stopped.
  if (isInstalling(state)) {
    const progress = state.downloadProgress;
    return progress
      ? `Installing word pack ${installingShard(progress)} of ${progress.totalShards}.`
      : 'Starting the word pack download.';
  }
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
    return fullCatalogueActive
      ? 'Purchased and installed. The full word list is available offline on this device.'
      : 'Purchased and installed. The app restarts once to put the full word list in front of your child.';
  }
  if (state.packState === 'failed') {
    return 'Access is verified, but the local pack needs another download attempt.';
  }
  if (state.packState === 'downloading') {
    return 'The spelling pack download did not finish. Resume it to install the rest.';
  }
  return 'Access is verified. Download the spelling pack to use it offline.';
}

// Exported so the card can be rendered and its download button exercised
// directly: a regex over this file's source text is not a guard — deleting the
// button entirely left the suite green.
export function ParentCommerceCard({
  state,
  fullCatalogueActive = false,
  onPurchase,
  onRestore,
  onDownload,
  onRecover,
  // A reload re-runs the whole startup composition, which is what choosing the
  // installed catalogue actually takes; it is the same call the boot-failure
  // recovery button makes. Injectable so the wiring can be exercised.
  onActivateFullCatalogue = () => globalThis.location?.reload(),
}) {
  const busy = state.status === 'checking' || state.status === 'working';
  const canBuy =
    state.entitlementState === 'none' &&
    state.displayPrice !== '' &&
    !['offline', 'failed'].includes(state.status);
  const downloadLabel = downloadActionLabel(state);
  const installing = isInstalling(state);
  const progress = installing ? state.downloadProgress ?? null : null;
  const canActivateFullCatalogue =
    state.entitlementState === 'active' &&
    state.packState === 'installed' &&
    !fullCatalogueActive;
  return (
    <section className="paper-card parent-card" aria-labelledby="parent-commerce-title">
      <p className="product-kicker">Packs and purchases</p>
      <h2 id="parent-commerce-title">Full KS2 spelling</h2>
      {state.displayPrice && state.entitlementState === 'none' && (
        <p className="parent-commerce-price">{state.displayPrice}</p>
      )}
      <p aria-live="polite">{commerceMessage(state, fullCatalogueActive)}</p>
      {progress && (
        <div className="parent-commerce-install">
          {/* The count in the message above is the text equivalent, and it is
              already a polite live region; announcing these steps a second
              time would say the same thing twice per shard. */}
          <span className="parent-commerce-steps" aria-hidden="true">
            {Array.from({ length: progress.totalShards }, (unused, index) => (
              <span
                // eslint-disable-next-line react/no-array-index-key
                key={index}
                data-state={
                  index < progress.completedShards
                    ? 'done'
                    : index === progress.completedShards ? 'here' : 'todo'
                }
              />
            ))}
          </span>
          <p className="parent-note">
            Keep the app open until every word pack is installed. A download
            that stops picks up where it left off.
          </p>
        </div>
      )}
      <div className="parent-commerce-actions">
        {canActivateFullCatalogue && (
          <button
            type="button"
            className="button-primary press"
            disabled={busy}
            onClick={() => onActivateFullCatalogue()}
          >
            Use the full word list now
          </button>
        )}
        {state.entitlementState === 'none' && (
          <button
            type="button"
            className="button-primary press"
            disabled={busy || !canBuy}
            onClick={() => void onPurchase().catch(() => undefined)}
          >
            Buy Full KS2{state.displayPrice ? ` — ${state.displayPrice}` : ''}
          </button>
        )}
        {downloadLabel && (
          <button
            type="button"
            className="button-primary press"
            disabled={busy}
            onClick={() => void onDownload().catch(() => undefined)}
          >
            {installing ? 'Installing…' : downloadLabel}
          </button>
        )}
        <button
          type="button"
          className="button-quiet press-soft press"
          disabled={busy}
          onClick={() => void onRestore().catch(() => undefined)}
        >
          Restore purchases
        </button>
        <button
          type="button"
          className="button-quiet press-soft press"
          disabled={busy}
          onClick={() => void onRecover().catch(() => undefined)}
        >
          {busy ? 'Checking…' : 'Check again'}
        </button>
      </div>
      {state.actionError && (
        <p className="inline-error" role="alert">
          That purchase action did not complete. Local access was not changed.
          {state.actionErrorDetail ? <> <code>{state.actionErrorDetail}</code></> : null}
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
  fullCatalogueActive = false,
  onClose,
  onSetPin,
  onResetPin,
  onUnlockPin,
  onUnlockBiometrics,
  onSetBiometricsEnabled,
  onEditProfile,
  onRemoveProfile,
  onResetLearning,
  onRefreshProgress,
  onPurchase,
  onRestore,
  onDownload,
  onRecoverCommerce,
}) {
  const [pin, setPin] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [resettingPin, setResettingPin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState('');
  const biometric = biometricName(state.biometric.type);

  async function run(action) {
    if (busy) return;
    setBusy(true);
    setLocalError('');
    try {
      await action();
      setPin('');
      setConfirmation('');
      setResettingPin(false);
    } catch (error) {
      if (typeof error?.code !== 'string' || !error.code.startsWith('parent_')) {
        setLocalError('That did not work. Check the details and try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  if (state.status === 'unlocked') {
    return (
      <main className="product-app product-page parent-page" aria-labelledby="parent-title">
        <ProductTopBar
          title="Parent area"
          action={(
            <button type="button" className="topbar-action press-soft press" onClick={onClose}>
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
                  className="button-quiet press-soft press"
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
            fullCatalogueActive={fullCatalogueActive}
            onPurchase={onPurchase}
            onRestore={onRestore}
            onDownload={onDownload}
            onRecover={onRecoverCommerce}
          />

          <PrivacyNoticeCard />
        </div>
      </main>
    );
  }

  const settingUp = state.status === 'setup-required';
  const choosingPin = settingUp || resettingPin;
  const title = settingUp
    ? 'Set a Parent PIN'
    : resettingPin ? 'Reset Parent PIN' : 'Enter Parent PIN';
  const instructions = settingUp
    ? 'Choose six digits that are not repeated or in a simple sequence. Your device will confirm its owner before the PIN is saved.'
    : resettingPin
      ? 'Choose a new six-digit PIN. Your device will confirm its owner before replacing the old PIN. Learners and purchases stay unchanged.'
      : 'Enter the six-digit Parent PIN to continue.';
  return (
    <main className="product-app product-page parent-page" aria-labelledby="parent-access-title">
      <ProductTopBar
        title="Parent access"
        action={(
          <button type="button" className="topbar-action press-soft press" onClick={onClose}>
            Back
          </button>
        )}
      />
      <section className="paper-card parent-gate-card">
        <p className="product-kicker">Grown-ups only</p>
        <h1 id="parent-access-title">{title}</h1>
        <p>{instructions}</p>
        {choosingPin && state.deviceOwnerAuthenticationAvailable === false && (
          <p className="parent-note">
            A device screen lock is required. Set one in device settings, then
            try again. Learning stays available while Parent access is locked.
          </p>
        )}
        <form
          className="parent-pin-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => settingUp
              ? onSetPin({ pin, confirmation })
              : resettingPin
                ? onResetPin({ pin, confirmation })
                : onUnlockPin(pin));
          }}
        >
          <label htmlFor="parent-pin">
            {choosingPin ? 'New Parent PIN' : 'Parent PIN'}
          </label>
          <input
            id="parent-pin"
            name="parent-pin"
            type="password"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength="6"
            autoComplete={choosingPin ? 'new-password' : 'current-password'}
            value={pin}
            disabled={busy}
            onChange={(event) => setPin(event.target.value)}
          />
          {choosingPin && (
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
            className="button-primary press"
            disabled={
              busy ||
              pin.length !== 6 ||
              (choosingPin && confirmation.length !== 6)
            }
          >
            {busy
              ? 'Checking…'
              : settingUp
                ? 'Confirm owner and set PIN'
                : resettingPin ? 'Confirm owner and reset PIN' : 'Unlock'}
          </button>
        </form>

        {!settingUp && !resettingPin && (
          <button
            type="button"
            className="button-quiet parent-biometric-button press-soft press"
            disabled={busy}
            onClick={() => {
              setPin('');
              setConfirmation('');
              setLocalError('');
              setResettingPin(true);
            }}
          >
            Forgot Parent PIN?
          </button>
        )}
        {resettingPin && (
          <button
            type="button"
            className="button-quiet parent-biometric-button press-soft press"
            disabled={busy}
            onClick={() => {
              setPin('');
              setConfirmation('');
              setLocalError('');
              setResettingPin(false);
            }}
          >
            Cancel PIN reset
          </button>
        )}
        {!settingUp && !resettingPin &&
          state.biometric.available &&
          state.biometric.enabled && (
            <button
              type="button"
              className="button-quiet parent-biometric-button press-soft press"
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

export function LeaveRoundDialog({
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
      aria-labelledby="leave-round-title"
      aria-describedby={
        error
          ? 'leave-round-description leave-round-error'
          : 'leave-round-description'
      }
      aria-busy={leaving}
    >
      <div>
        <h2 id="leave-round-title">Leave this round?</h2>
        <p id="leave-round-description">
          Your earlier saved learning stays safe. This round will be marked unfinished.
        </p>
        {error && (
          <p id="leave-round-error" className="inline-error" role="alert">
            {error}
          </p>
        )}
        <div>
          <button
            ref={keepButton}
            type="button"
            className="button-quiet press-soft press"
            disabled={leaving}
            onClick={onKeep}
          >
            Keep practising
          </button>
          <button
            ref={leaveButton}
            type="button"
            className="button-danger press"
            disabled={leaving}
            onClick={onLeave}
          >
            {leaving ? 'Leaving…' : 'Leave round'}
          </button>
        </div>
      </div>
    </section>
  );
}

// A drag past a third of the sheet, or a quick flick in that direction, closes
// it. Anything shorter settles back so a mis-grab never loses the screen.
const SHEET_DISMISS_FRACTION = 0.33;
const SHEET_FLICK_SPEED = 0.5;
const SHEET_FLICK_TRAVEL = 24;

/**
 * Drag-to-dismiss for a bottom sheet. The sheet follows the pointer downwards
 * only, because it is anchored to the bottom edge and cannot be lifted off it.
 * Returns null when the sheet has nowhere to go, so the caller can leave the
 * grip out rather than offer a gesture that does nothing.
 */
function useSheetDrag(onDismiss, haptics, sfx) {
  const sheetRef = useRef(null);
  const dragRef = useRef(null);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = useCallback((event) => {
    const sheet = sheetRef.current;
    if (!sheet || event.button !== 0) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startedAt: event.timeStamp,
      height: sheet.getBoundingClientRect().height,
    };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const onPointerMove = useCallback((event) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setOffset(Math.max(0, event.clientY - drag.startY));
  }, []);

  const onPointerUp = useCallback((event) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    setOffset(0);
    const travel = Math.max(0, event.clientY - drag.startY);
    const speed = travel / Math.max(1, event.timeStamp - drag.startedAt);
    const flicked = travel >= SHEET_FLICK_TRAVEL && speed >= SHEET_FLICK_SPEED;
    if (flicked || travel >= drag.height * SHEET_DISMISS_FRACTION) {
      haptics?.uiTick?.();
      sfx?.play('sheet');
      onDismiss();
    }
  }, [haptics, sfx, onDismiss]);

  if (!onDismiss) return null;
  return {
    sheetRef,
    dragging,
    style: offset === 0 ? undefined : { translate: `0 ${offset}px` },
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
    },
  };
}

/* The one place a learner is created. First run opens it inline, because
   creating the first learner is that screen's whole purpose; the picker keeps
   it behind a disclosure so the learners already there stay the subject. */
function LearnerForm({ busy, onCreate, onSaved }) {
  const [nickname, setNickname] = useState('');
  const [yearGroup, setYearGroup] = useState('Y3');
  const [goal, setGoal] = useState(10);

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
        onSaved?.();
      })
      .catch(() => undefined);
  }

  return (
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
        className="button-primary press"
        disabled={busy || nickname.trim() === ''}
      >
        {busy ? 'Saving…' : 'Add learner'}
      </button>
    </form>
  );
}

/* First run is its own composition, not the picker with the list missing. The
   authority's reference layout asks for a welcome, a local-data reassurance
   region and Add learner as the primary action; a bottom sheet whose subject is
   "which of these learners" cannot carry any of the three when there are none.
   The learner form is open on arrival, so the primary action is the filled
   submit rather than a dashed disclosure in front of it. */
export function FirstRunScene({
  profileState,
  audioState,
  onCreate,
  onOpenParent,
  onRecoverAudio,
}) {
  const busy = profileState.status === 'saving';

  return (
    <main className="product-app" aria-labelledby="first-run-title">
      <Scene
        className="first-run-scene"
        plate={regionArt(REGION, 'a1')}
        plateY="26%"
        // The gradient itself is in app.css beside the rest of the first-run
        // rules; Scene only paints the veil layer when it is given one.
        veil="var(--first-run-veil)"
      >
        <div className="scene-body">
          <div className="scene-scroll first-run-column">
            <section className="first-run-welcome">
              <p className="product-kicker">Welcome</p>
              <h1 id="first-run-title">Spelling Camp</h1>
              <p className="body-copy">
                Offline KS2 spelling practice for Years 3 to 6. Hear the word,
                type it, and make it stick.
              </p>
            </section>

            <section className="vellum first-run-setup" aria-labelledby="first-run-setup-title">
              <p className="product-kicker">Set up on this device</p>
              <h2 id="first-run-setup-title">Add the first learner</h2>
              <LearnerForm busy={busy} onCreate={onCreate} />
              {profileState.actionError && (
                <p className="inline-error" role="alert">
                  That change did not save. Please try again.
                </p>
              )}
            </section>

            <section
              className="first-run-local"
              aria-labelledby="first-run-local-title"
            >
              <h2 id="first-run-local-title">Everything stays on this device</h2>
              <ul>
                <li>
                  <span className="first-run-local-mark"><IconTick size={13} /></span>
                  Names, weekly goals and progress are saved here, not to an
                  account.
                </li>
                <li>
                  <span className="first-run-local-mark"><IconTick size={13} /></span>
                  No advertising, no analytics, no tracking.
                </li>
                {audioState.status === 'ready' ? (
                  <li>
                    <span className="first-run-local-mark"><IconNote size={13} /></span>
                    Listening pack ready · practice works offline.
                  </li>
                ) : null}
              </ul>
            </section>

            {audioState.status === 'ready' ? null : (
              <AudioStatus audioState={audioState} onRecover={onRecoverAudio} />
            )}

            <button
              type="button"
              className="button-quiet first-run-parent press-soft press"
              onClick={onOpenParent}
            >
              <IconLock size={16} />
              For parents
            </button>
          </div>
        </div>
      </Scene>
    </main>
  );
}

export function SwitchScreen({
  profileState,
  audioState,
  onChoose,
  onCreate,
  onOpenParent,
  onRecoverAudio,
  onDismiss,
  haptics,
  sfx,
}) {
  const drag = useSheetDrag(onDismiss, haptics, sfx);
  const [adding, setAdding] = useState(false);
  const busy = profileState.status === 'saving';

  return (
    <main className="product-app" aria-labelledby="switch-title">
      <Scene
        className="switch-scene"
        plate={regionArt(REGION, 'a1')}
        veil="rgba(29,43,58,.38)"
      >
        <div className="scene-body">
          {drag && (
            <button
              type="button"
              className="sheet-scrim"
              aria-label="Close the learner list"
              onClick={onDismiss}
            />
          )}
          <div
            className="switch-sheet"
            ref={drag?.sheetRef}
            data-dragging={drag?.dragging ? 'true' : undefined}
            style={drag?.style}
          >
            {drag && (
              <div
                className="sheet-grip"
                aria-hidden="true"
                {...drag.handlers}
              />
            )}
            <div className="switch-head">
              <p id="switch-title">Who is practising?</p>
              <button
                type="button"
                className="topbar-action press-soft press"
                onClick={onOpenParent}
              >
                For parents
              </button>
            </div>

            {profileState.profiles.length > 0 && (
              <ul className="switch-list" aria-label="Learners on this device">
                {profileState.profiles.map((profile) => {
                  const selected =
                    profile.learnerId === profileState.selectedLearnerId;
                  return (
                    <li key={profile.learnerId}>
                      <button
                        type="button"
                        className="learner-card press"
                        style={{ '--learner-colour': profile.colour }}
                        disabled={busy}
                        onClick={() => onChoose(profile.learnerId)}
                      >
                        <span className="learner-avatar" aria-hidden="true">
                          {initialOf(profile.nickname)}
                        </span>
                        <span>
                          <strong>{profile.nickname}</strong>
                          <small>
                            {displayYearGroup(profile.yearGroup)} · {profile.goal} words a week
                            {selected ? ' · here now' : ''}
                          </small>
                        </span>
                        {selected ? (
                          <span className="learner-selected">
                            <IconTick size={14} />
                            <span className="visually-hidden">Selected</span>
                          </span>
                        ) : (
                          <IconChevron size={18} />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            {adding ? (
              <LearnerForm
                busy={busy}
                onCreate={onCreate}
                onSaved={() => setAdding(false)}
              />
            ) : (
              <button
                type="button"
                className="learner-add press-soft press"
                onClick={() => setAdding(true)}
              >
                <IconPlus size={18} />
                Add a learner
              </button>
            )}

            {profileState.actionError && (
              <p className="inline-error" role="alert">
                That change did not save. Please try again.
              </p>
            )}

            {audioState.status === 'ready' ? (
              <p className="switch-note">
                <span className="switch-note-mark"><IconNote size={12} /></span>
                Listening pack ready · everything works offline
              </p>
            ) : (
              <AudioStatus audioState={audioState} onRecover={onRecoverAudio} />
            )}
          </div>
        </div>
      </Scene>
    </main>
  );
}

function TrailScreen({
  profile,
  learningState,
  audioState,
  dueCount,
  onScreen,
  onSwitchLearner,
  onOpenParent,
  onRecoverAudio,
}) {
  const companions = useMemo(
    () => trailMeadowCompanions(buildCodex(learningState.monsters).roster),
    [learningState.monsters],
  );
  const meadowSeed = `${learningState.learnerId}:${profile.yearGroup}`;

  const dueLabel = dueCount === 1 ? 'word due today' : 'words due today';

  return (
    <main className="product-app" aria-labelledby="home-title">
      <Scene
        className="trail-scene"
        dusk
        waypoints
        waypointScreen="home"
        onScreen={onScreen}
        plate={regionArt(REGION, 'a1')}
        veil={[
          'radial-gradient(110% 58% at 66% 30%,rgba(8,12,18,.02),rgba(8,12,18,.54) 58%,rgba(8,12,18,.92))',
          'linear-gradient(180deg,rgba(8,12,18,.68) 0%,rgba(8,12,18,.1) 16%,rgba(8,12,18,.22) 44%,rgba(8,12,18,.62) 74%,rgba(8,12,18,.92) 100%)',
        ].join(',')}
      >
        <div className="scene-body">
          <div className="trail-chrome">
            <button
              type="button"
              className="glass-button press-soft press"
              onClick={onSwitchLearner}
            >
              <span
                className="learner-chip"
                style={{ '--learner-colour': profile.colour }}
                aria-hidden="true"
              >
                {initialOf(profile.nickname)}
              </span>
              <strong>{profile.nickname}</strong>
              <IconChevronDown size={15} />
            </button>
            <button
              type="button"
              className="glass-button icon-button press-soft press"
              onClick={onOpenParent}
            >
              <IconLock size={21} />
              <span className="visually-hidden">For parents</span>
            </button>
          </div>

          <p className="trail-topline">
            The Scribe Downs
            <span aria-hidden="true" />
            {displayYearGroup(profile.yearGroup)}
          </p>

          <h1 id="home-title" className="visually-hidden">
            {profile.nickname}&apos;s spelling trail
          </h1>

          <div className="meadow">
            <TrailMeadow companions={companions} seed={meadowSeed} />
          </div>

          {audioState.status !== 'ready' && (
            <AudioStatus
              audioState={audioState}
              onRecover={onRecoverAudio}
              dusk
              compact
            />
          )}

          <p className="trail-due">
            <span className="figure">{dueCount}</span>
            {dueLabel}
          </p>

          <div className="trail-launch">
            <button
              type="button"
              className="button-primary press"
              onClick={() => onScreen('setup')}
            >
              Set off
              <IconForward size={19} />
            </button>
            <p>Smart Review · pick your length</p>
          </div>
        </div>
      </Scene>
    </main>
  );
}

const FILTER_DOTS = Object.freeze({
  all: 'rgba(29,43,58,.3)',
  due: 'var(--brass)',
  trouble: 'var(--retry)',
  learning: 'var(--brand)',
  secure: 'var(--good)',
});

// The word bank's own scene dressing, shared with the word a learner opens
// from it so the detail reads as the same place rather than a new one.
const BANK_PLATE_Y = '30%';
const BANK_VEIL =
  'linear-gradient(180deg,rgba(246,245,241,.44),rgba(246,245,241,.9) 42%,#f8f5ec 62%)';

function WordDetailScreen({
  detail,
  audioState,
  audio,
  voiceId,
  busy,
  onBack,
  onScreen,
  onPractise,
  onPlaybackFailure,
}) {
  const [localError, setLocalError] = useState('');
  const listening = audioState.status === 'ready';

  async function hearIt() {
    try {
      await audio.play(hearWordRequest({
        runtimeItemId: detail.runtimeItemId,
        version: audioState.activeVersion,
        voiceId: voiceId ?? PACKAGED_VOICE,
      }));
      setLocalError('');
    } catch (error) {
      if (error?.name === 'NotAllowedError') {
        setLocalError('Tap Hear it again to listen.');
        return;
      }
      setLocalError('That word would not play. Check the listening pack and try again.');
      onPlaybackFailure?.();
    }
  }

  return (
    <main className="product-app" aria-labelledby="word-title">
      <Scene
        className="word-scene"
        waypoints
        waypointScreen="progress"
        onScreen={onScreen}
        plate={regionArt(REGION, 'a1')}
        plateY={BANK_PLATE_Y}
        veil={BANK_VEIL}
      >
        <div className="scene-body">
          <div className="word-chrome">
            <button
              type="button"
              className="icon-button press-soft press"
              onClick={onBack}
            >
              <IconBack size={21} />
              <span className="visually-hidden">Back to your words</span>
            </button>
            <span>Word bank</span>
            <span className="icon-button" aria-hidden="true" />
          </div>

          <div className="scene-scroll">
            <article className="word-card vellum" data-status={detail.status}>
              <p className="product-kicker">{detail.yearLabel}</p>
              <h1 id="word-title">{detail.word}</h1>

              <p className="word-progress">
                <span className="bank-rungs" aria-hidden="true">
                  {detail.rungs.map((lit, index) => (
                    // eslint-disable-next-line react/no-array-index-key
                    <span key={index} data-lit={lit ? 'true' : 'false'} />
                  ))}
                </span>
                {detail.note}
              </p>

              <button
                type="button"
                className="word-listen press"
                disabled={!listening}
                onClick={() => void hearIt()}
              >
                <IconSpeaker size={21} />
                Hear it
              </button>

              {localError && (
                <p className="inline-error" role="alert">{localError}</p>
              )}

              <h2 className="product-kicker">What it means</h2>
              <p className="body-copy">{detail.explanation}</p>

              <h2 className="product-kicker">Used like this</h2>
              <p className="word-sentence">{detail.sentence}</p>

              {detail.familyWords.length > 0 && (
                <>
                  <h2 className="product-kicker">Word family</h2>
                  <ul className="word-family">
                    {detail.familyWords.map((relative) => (
                      <li key={relative}>{relative}</li>
                    ))}
                  </ul>
                </>
              )}
            </article>

            <div className="word-actions">
              <button
                type="button"
                className="button-primary press"
                disabled={busy}
                onClick={() => {
                  void onPractise(detail.runtimeItemId).catch(() => {
                    setLocalError('That practice could not start. Please try again.');
                  });
                }}
              >
                Practise this word
                <IconForward size={19} />
              </button>
              <p className="word-actions-note">
                One word on its own. Your trail keeps its place.
              </p>
            </div>
          </div>
        </div>
      </Scene>
    </main>
  );
}

function WordBankScreen({
  progress,
  vocabularySets,
  onScreen,
  onStart,
  wordMaterial,
  onPractise,
  audio,
  audioState,
  voiceId,
  busy,
  onPlaybackFailure,
}) {
  const [filter, setFilter] = useState('all');
  const [vocabSet, setVocabSet] = useState('core');
  const [query, setQuery] = useState('');
  const [openWordId, setOpenWordId] = useState(null);
  const bank = useMemo(
    () => buildWordBank({
      progress,
      filter,
      vocabSet,
      vocabularySets,
      query,
    }),
    [progress, filter, vocabSet, vocabularySets, query],
  );
  const detail = useMemo(
    () => (openWordId === null ? null : buildWordDetail({
      material: wordMaterial(openWordId),
      row: bank.rows.find(({ runtimeItemId }) => runtimeItemId === openWordId)
        ?? null,
    })),
    [openWordId, bank.rows, wordMaterial],
  );

  if (detail) {
    return (
      <WordDetailScreen
        detail={detail}
        audioState={audioState}
        audio={audio}
        voiceId={voiceId}
        busy={busy}
        onBack={() => setOpenWordId(null)}
        onScreen={onScreen}
        onPractise={onPractise}
        onPlaybackFailure={onPlaybackFailure}
      />
    );
  }

  return (
    <main className="product-app" aria-labelledby="bank-title">
      <Scene
        className="bank-scene"
        waypoints
        waypointScreen="progress"
        onScreen={onScreen}
        plate={regionArt(REGION, 'a1')}
        plateY={BANK_PLATE_Y}
        veil={BANK_VEIL}
      >
        <div className="scene-body">
          <div className="bank-head">
            <div>
              <p className="product-kicker">Word bank</p>
              <h1 id="bank-title">Your words</h1>
            </div>
            <span
              id="bank-result-count"
              className="figure"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {bank.countLabel}
            </span>
          </div>

          <div className="bank-search">
            <label htmlFor="bank-search-input" className="visually-hidden">
              Search the word bank
            </label>
            <input
              id="bank-search-input"
              name="bank-search"
              type="text"
              inputMode="search"
              value={query}
              placeholder="Search spellings"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck="false"
              writingsuggestions="false"
              enterKeyHint="search"
              maxLength={64}
              aria-describedby="bank-result-count"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && query) {
                  event.preventDefault();
                  setQuery('');
                }
              }}
            />
          </div>

          <div className="rail bank-filters bank-vocab-sets" role="group" aria-label="Vocabulary set">
            {bank.vocabSets.map((option) => (
              <button
                key={option.id}
                type="button"
                className="pill press-soft press"
                aria-pressed={option.selected}
                aria-label={`${option.label}, ${option.count} ${option.count === 1 ? 'word' : 'words'}`}
                onClick={() => setVocabSet(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div className="rail bank-filters" role="group" aria-label="Filter words">
            {bank.filters.map((option) => (
              <button
                key={option.id}
                type="button"
                className="pill press-soft press"
                aria-pressed={option.selected}
                aria-label={`${option.label}, ${option.count} ${option.count === 1 ? 'word' : 'words'}`}
                onClick={() => setFilter(option.id)}
              >
                <span
                  className="bank-dot"
                  style={{ '--dot': FILTER_DOTS[option.id] }}
                  aria-hidden="true"
                />
                {option.label}
              </button>
            ))}
          </div>

          <div className="scene-scroll">
            <ul className="bank-list">
              {bank.rows.map((row) => (
                <li key={row.runtimeItemId}>
                  <button
                    type="button"
                    className="bank-row press-soft press"
                    data-status={row.status}
                    data-due={row.due ? 'true' : 'false'}
                    onClick={() => setOpenWordId(row.runtimeItemId)}
                  >
                    <span className="bank-row-bar" aria-hidden="true" />
                    <strong>{row.word}</strong>
                    <small>{row.note}</small>
                    <span className="bank-rungs" aria-hidden="true">
                      {row.rungs.map((lit, index) => (
                        // eslint-disable-next-line react/no-array-index-key
                        <span key={index} data-lit={lit ? 'true' : 'false'} />
                      ))}
                    </span>
                    <IconChevron size={18} className="bank-row-open" />
                  </button>
                </li>
              ))}
              {bank.empty && (
                <li className="bank-empty">
                  <strong>{bank.emptyHeading}</strong>
                  <small className="body-copy">{bank.emptyBody}</small>
                  {bank.total === 0 ? (
                    <button
                      type="button"
                      className="button-quiet press-soft press"
                      onClick={onStart}
                    >
                      Set off on a round
                    </button>
                  ) : query.trim() ? (
                    <button
                      type="button"
                      className="button-quiet press-soft press"
                      onClick={() => setQuery('')}
                    >
                      Clear search
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="button-quiet press-soft press"
                      onClick={() => {
                        setFilter('all');
                        setVocabSet('core');
                      }}
                    >
                      Show every word in the bank
                    </button>
                  )}
                </li>
              )}
            </ul>
          </div>
        </div>
      </Scene>
    </main>
  );
}

function CodexScreen({ monsters, progress, onScreen }) {
  const [selected, setSelected] = useState(null);
  const [zoomed, setZoomed] = useState(false);
  const codex = useMemo(
    () => buildCodex(monsters, selected),
    [monsters, selected],
  );
  // The ladder advertises the engine's mastery milestones, so it must count
  // the way the engine does: every word at the secure stage or beyond. The
  // companion evidence beneath the hero card deliberately counts only words
  // sitting exactly at the secure stage, and a word promoted past it would
  // otherwise un-light a milestone the learner has already been celebrated
  // for.
  const secureWordTotal = useMemo(
    () => (Array.isArray(progress)
      ? progress.filter((row) => row.stage >= 4).length
      : 0),
    [progress],
  );
  const hero = codex.hero;

  return (
    <main className="product-app" aria-labelledby="codex-title">
      <Scene
        className="codex-scene"
        dusk
        waypoints
        waypointScreen="monster"
        onScreen={onScreen}
        plate={regionArt(REGION, 'd3')}
        plateOpacity={0.42}
        veil="linear-gradient(180deg,rgba(9,15,23,.8) 0%,rgba(9,15,23,.5) 32%,rgba(9,15,23,.94) 100%)"
      >
        <div className="scene-body">
          <div className="codex-head">
            <div>
              <p className="product-kicker">The Codex</p>
              <h1 id="codex-title">Companions</h1>
            </div>
            <span className="codex-count">
              <span className="figure">{codex.foundCount}</span>
              <span className="figure figure-total">/ {codex.rosterCount}</span>
              <span className="label">Found</span>
            </span>
          </div>

          {hero && (
            <>
              <section
                className="codex-hero"
                data-found={hero.found ? 'true' : 'false'}
                data-near={hero.nearNextStage ? 'true' : 'false'}
                style={{ '--accent': hero.accent }}
              >
                <span className="codex-hero-glow" aria-hidden="true" />
                <span className="codex-hero-sheen" aria-hidden="true" />
                {['tl', 'tr', 'bl', 'br'].map((corner) => (
                  <span key={corner} className="codex-corner" data-corner={corner} aria-hidden="true" />
                ))}
                <span className="codex-no">NO. {hero.number}</span>
                <span className="codex-band">{hero.band}</span>

                {/* Unfound companion is withheld everywhere, so it gets no closer look. */}
                {hero.found ? (
                  <button
                    type="button"
                    className="codex-stage press"
                    onClick={() => setZoomed(true)}
                  >
                    <span className="codex-stage-shadow" aria-hidden="true" />
                    <img src={hero.art ?? undefined} alt="" />
                    <span className="visually-hidden">Look closer at {hero.title}</span>
                  </button>
                ) : (
                  <div className="codex-stage">
                    <span className="codex-stage-shadow" aria-hidden="true" />
                    <img src={hero.art ?? undefined} alt="" />
                  </div>
                )}

                <div className="codex-hero-foot">
                  <div className="codex-hero-title">
                    <h2>{hero.title}</h2>
                    <span>{hero.stageLabel}</span>
                  </div>
                  <p>{hero.blurb}</p>
                  <div className="codex-meter">
                    <span className="codex-meter-track">
                      <span style={{ '--percent': `${hero.percent}%` }} />
                    </span>
                    <span className="figure">{hero.count}</span>
                  </div>
                  <p className="codex-next">{hero.next}</p>
                </div>
              </section>

              <p className="codex-rule label">
                Growth line<span aria-hidden="true" />
              </p>
              <ul className="codex-growth" style={{ '--accent': hero.accent }}>
                {hero.growth.map((stage) => (
                  <li
                    key={stage.key}
                    data-reached={stage.reached ? 'true' : 'false'}
                    data-here={stage.here ? 'true' : 'false'}
                  >
                    <img src={stage.art ?? undefined} alt="" />
                    <span>{stage.label}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <p className="codex-rule label">
            Roster<span aria-hidden="true" />
          </p>
          <div className="codex-roster">
            {codex.roster.map((companion) => (
              <button
                key={companion.rewardTrackId}
                type="button"
                className="press"
                data-found={companion.found ? 'true' : 'false'}
                aria-pressed={companion.rewardTrackId === hero?.rewardTrackId}
                style={{ '--accent': companion.accent }}
                onClick={() => {
                  setSelected(companion.rewardTrackId);
                  setZoomed(false);
                }}
              >
                <span className="codex-roster-no">{companion.number}</span>
                <img src={companion.art ?? undefined} alt="" />
                <strong>{companion.name}</strong>
                <span className="codex-pips" aria-hidden="true">
                  {companion.pips.map((lit, index) => (
                    // eslint-disable-next-line react/no-array-index-key
                    <span key={index} data-lit={lit ? 'true' : 'false'} />
                  ))}
                </span>
              </button>
            ))}
          </div>

          <div className="codex-stats">
            <div>
              <span className="figure">{codex.secureWords}</span>
              <span className="label">Secure words</span>
            </div>
            <div>
              <span className="figure">{codex.highestStage}</span>
              <span className="label">Highest stage</span>
            </div>
            <div>
              <span className="figure">{codex.leftToFind}</span>
              <span className="label">Left to find</span>
            </div>
          </div>

          {/* The engine's mastery milestones, read straight from the engine so
              the Codex can never advertise a number it would not celebrate.
              Lit rungs are behind the learner; the marked one is next. */}
          <ol className="codex-ladder" aria-label="Spelling milestones">
            {milestoneLadder(secureWordTotal).map((rung) => (
              <li
                key={rung.milestone}
                data-reached={rung.reached ? 'true' : 'false'}
                data-next={rung.next ? 'true' : 'false'}
              >
                <span className="figure">{rung.milestone}</span>
              </li>
            ))}
          </ol>

          {zoomed && hero?.found && (
            <button
              type="button"
              className="codex-zoom"
              style={{ '--accent': hero.accent }}
              onClick={() => setZoomed(false)}
            >
              <span className="codex-hero-glow" aria-hidden="true" />
              <span>
                {/* Looking closer is where a living creature belongs: the
                    roster and the hero card stay still plates, and only the
                    one companion a child has chosen to look at costs a
                    renderer. Phaser rides in its own chunk behind this lazy
                    import, so a child who never opens the Codex never pays
                    for it, and the still plate is the fallback for the load,
                    for reduced motion and for a lost WebGL context. */}
                <Suspense fallback={<img src={hero.art ?? undefined} alt="" />}>
                  <MonsterStage
                    monsterId={hero.monsterId}
                    branch={hero.branch}
                    stage={hero.stage}
                    secureCount={hero.secureCount}
                    reducedMotion={prefersReducedMotion()}
                  />
                </Suspense>
                <div>
                  <strong>{hero.title}</strong>
                  <small>{hero.count} secure · tap to close</small>
                </div>
              </span>
            </button>
          )}
        </div>
      </Scene>
    </main>
  );
}

/* --- Guardian ------------------------------------------------------------
   Guardian is the engine's endgame: it stays asleep until every core word is
   Mega, so most learners meet the teaser for months before they meet the
   mission. Setup and Camp read the same projection through these helpers so
   the two surfaces can never disagree about what Guardian is doing today. */

const MEGA_STAGE = 4;

function countMegaWords(progress = []) {
  return progress.filter((row) => (row?.stage ?? 0) >= MEGA_STAGE).length;
}

/**
 * One of five readings of `state.revisionMission`:
 * `locked` (not on this trail), `asleep` (the pre-Mega teaser), `due` (a
 * mission is waiting), `rested` (nothing to guard yet) and `done` (credited
 * today, an unrewarded patrol still allowed).
 */
function guardianPhase(mission) {
  if (!mission || mission.campCreditState === 'unavailable') return 'locked';
  if (mission.canStartRewardBearing) return 'due';
  if (mission.canContinueUnrewarded) return 'done';
  if (mission.missionState === 'rested') return 'rested';
  return 'asleep';
}

// The Guardian day turns at 01:00 BST, so every promise the app makes is
// counted in days and spoken as today or tomorrow. Never a clock time.
function guardianDaysAway(mission) {
  const next = mission?.nextGuardianDueDay;
  const today = mission?.todayGuardianDay;
  if (!Number.isFinite(next) || !Number.isFinite(today)) return 1;
  return Math.max(1, next - today);
}

function guardianNextLine(mission, noun) {
  const days = guardianDaysAway(mission);
  return days === 1
    ? `Next ${noun} tomorrow.`
    : `Next ${noun} in ${days} days.`;
}

function guardianDueLine(mission) {
  const due = mission?.guardianDueCount ?? 0;
  const wobbling = mission?.wobblingDueCount ?? 0;
  // Zero due + zero wobbling only reaches here in phase === 'due' — first patrol.
  if (due === 0 && wobbling === 0) return 'First patrol';
  return wobbling > 0 ? `${due} due · ${wobbling} wobbling` : `${due} due`;
}

function CampScreen({
  camp,
  revisionMission = null,
  megaWords = 0,
  packSize = 0,
  audioState,
  busy = false,
  onScreen,
  onStartGuardian,
  onRecoverAudio,
  achievements = [],
}) {
  const phase = guardianPhase(revisionMission);
  const awake = phase !== 'locked' && phase !== 'asleep';
  const level = camp?.campHighWater ?? 0;
  // A banner for every ten days guarded: the ring reads the run in progress,
  // never the whole climb, so it is honest at level 10 and at level 70.
  const intoBanner = level % 10;
  const circumference = 333;
  const offset = Math.max(0, circumference * (1 - intoBanner / 10));
  const megaLeft = Math.max(0, packSize - megaWords);
  const megaPercent = packSize > 0
    ? Math.min(100, Math.round((megaWords / packSize) * 100))
    : 0;
  const dueCount = revisionMission?.guardianDueCount ?? 0;
  const audioReady = audioState?.status === 'ready';

  return (
    <main className="product-app" aria-labelledby="camp-title">
      <Scene
        className="camp-scene"
        waypoints
        waypointScreen="camp"
        onScreen={onScreen}
        plate={regionArt(REGION, 'd1')}
        veil="linear-gradient(180deg,rgba(248,245,236,.34) 0%,rgba(248,245,236,.2) 26%,rgba(248,245,236,.66) 68%,rgba(248,245,236,.9) 100%)"
      >
        <div className="scene-body">
          <p className="product-kicker">The Scribe Downs · Camp</p>

          {awake ? (
            <div className="camp-ring">
              <svg viewBox="0 0 120 120" aria-hidden="true">
                <circle cx="60" cy="60" r="53" fill="none" stroke="rgba(29,43,58,.13)" strokeWidth="7" />
                <circle
                  className="camp-ring-progress"
                  cx="60"
                  cy="60"
                  r="53"
                  fill="none"
                  strokeWidth="7"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={offset}
                />
              </svg>
              <div className="camp-ring-face">
                <div>
                  <IconCamp size={30} />
                  <span className="figure">{level}</span>
                  <span className="label">Camp level</span>
                </div>
              </div>
            </div>
          ) : (
            /* Before Guardian wakes there is no camp fire to draw, so the
               screen shows the climb that lights it instead of a ring at
               zero. The Mega count is the whole promise. */
            <div className="camp-mega">
              <p className="camp-mega-figure">
                <span className="figure">{megaWords}</span>
                <span>of {packSize}</span>
              </p>
              <p className="label">words at Mega</p>
              <div
                className="camp-mega-track"
                role="img"
                aria-label={`${megaWords} of ${packSize} words at Mega`}
              >
                <span style={{ '--percent': `${megaPercent}%` }} />
              </div>
              <p className="camp-mega-left">
                <span className="figure">{megaLeft}</span> still to reach Mega
              </p>
            </div>
          )}

          {awake && (
            <p className="camp-banner-note">
              <span className="figure">{10 - intoBanner}</span> to the next
              banner
            </p>
          )}

          <section className="vellum camp-card">
            <p className="product-kicker camp-card-kicker">
              <IconGuardian size={15} />
              Guardian
            </p>

            {phase === 'due' && dueCount === 0 && (
              <>
                <h1 id="camp-title">The first patrol awaits</h1>
                <p className="body-copy">
                  Every core word is Mega. Walk the first patrol today and the
                  camp fire is lit.
                </p>
              </>
            )}

            {phase === 'due' && dueCount > 0 && (
              <>
                <h1 id="camp-title">
                  {dueCount === 1
                    ? '1 word due for guarding today'
                    : `${dueCount} words due for guarding today`}
                </h1>
                <p className="body-copy">
                  Guardian walks the camp with you. Hold these today and the
                  fire climbs a little higher.
                </p>
              </>
            )}

            {phase === 'rested' && (
              <>
                <h1 id="camp-title">All guarded</h1>
                <p className="body-copy">
                  {guardianNextLine(revisionMission, 'mission')} Nothing is
                  slipping — this is what a kept camp looks like.
                </p>
              </>
            )}

            {phase === 'done' && (
              <>
                <h1 id="camp-title">Done today</h1>
                <p className="body-copy">
                  Camp rose today. The next mission that raises the fire comes
                  tomorrow.
                </p>
              </>
            )}

            {!awake && (
              <>
                <h1 id="camp-title">Guardian sleeps here</h1>
                <p className="body-copy">
                  Guardian wakes when every core word is Mega. Then it walks
                  the camp with you every day, and every ten days you keep
                  watch raises a new banner over the fire.
                </p>
              </>
            )}

            {awake && phase === 'due' && !audioReady && (
              <AudioStatus
                audioState={audioState}
                onRecover={onRecoverAudio}
                compact
              />
            )}

            <div className="camp-actions">
              {phase === 'due' && (
                <button
                  type="button"
                  className="button-primary press"
                  disabled={busy || !audioReady}
                  onClick={() => void onStartGuardian().catch(() => undefined)}
                >
                  {busy ? 'Preparing…' : 'Begin the patrol'}
                  <IconForward size={18} />
                </button>
              )}

              {phase !== 'due' && (
                <button
                  type="button"
                  className="button-primary press"
                  onClick={() => onScreen('setup')}
                >
                  Set off on a round
                  <IconForward size={18} />
                </button>
              )}

              {/* Camp is credited once a day. Another patrol is allowed, and
                  the offer has to say plainly what it no longer carries. */}
              {phase === 'done' && (
                <button
                  type="button"
                  className="button-quiet press-soft press"
                  disabled={busy || !audioReady}
                  onClick={() => void onStartGuardian({ intent: 'unrewarded' })
                    .catch(() => undefined)}
                >
                  Patrol again — no Camp credit
                </button>
              )}
            </div>
          </section>

          {achievements.length > 0 && (
            <section className="vellum camp-records" aria-label="Records of the watch">
              <p className="product-kicker camp-card-kicker">Records of the watch</p>
              <ul>
                {achievements.map((chip) => (
                  <li key={chip.id} className="camp-record-chip">{chip.title}</li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </Scene>
    </main>
  );
}

const QUESTS = Object.freeze([
  Object.freeze({
    id: 'smart',
    short: 'Smart',
    name: 'Smart Review',
    tag: 'Adaptive',
    plate: 'a1',
    line: 'Inklet picks the words your memory is about to drop, then slips one new spelling in at the end.',
  }),
  Object.freeze({
    id: 'trouble',
    short: 'Trouble',
    name: 'Trouble Drill',
    tag: 'Targeted',
    plate: 'd1',
    line: 'Nothing but the spellings that keep slipping. Short, steep, and over quickly.',
  }),
  Object.freeze({
    id: 'test',
    short: 'SATs',
    name: 'SATs Test',
    tag: 'Assessed',
    plate: 'e1',
    line: 'One attempt per word, with marks held back until the end.',
  }),
  Object.freeze({
    id: 'guardian',
    short: 'Guardian',
    name: 'Guardian Mission',
    tag: 'Daily',
    plate: 'b3',
    line: 'A night patrol over the words you have already mastered, so they stay yours.',
  }),
]);

function guardianQuestLine(phase, { mission, megaWords, packSize }) {
  if (phase === 'asleep') {
    return `Guardian wakes when every core word is Mega — ${megaWords} of ${packSize}.`;
  }
  if (phase === 'rested') {
    return `All guarded. ${guardianNextLine(mission, 'check')}`;
  }
  if (phase === 'done') return 'Done today. The camp fire is banked until tomorrow.';
  if (phase === 'due') {
    return 'The words you have already mastered are asking to be checked.';
  }
  return 'Guardian keeps watch over mastered words. Not on this trail yet.';
}

function SetupScreen({
  audioState,
  actionError,
  onStart,
  onBack,
  onScreen,
  onRecoverAudio,
  busy,
  dueCount,
  troubleCount,
  bankTotal,
  vocabularySets = [],
  monsters = [],
  sfxEnabled = true,
  onSetSfxEnabled,
  revisionMission = null,
  megaWords = 0,
  packSize = 0,
  onStartGuardian,
}) {
  const [length, setLength] = useState(5);
  // Guardian is the day's errand on the days it is waiting, and this screen
  // calls itself Today's quest — so a waiting mission opens selected. One tap
  // still moves to any walk.
  const [quest, setQuest] = useState(
    () => guardianPhase(revisionMission) === 'due' ? 'guardian' : 'smart',
  );
  // The walking quest Set off falls back to while Guardian is only a preview.
  // A learner can sit on the Guardian tile for months; Set off must never
  // become a button that cannot go anywhere.
  const [practiceQuest, setPracticeQuest] = useState('smart');
  const [yearFilter, setYearFilter] = useState(vocabularySets[0]?.id ?? 'core');
  const [soundOn, setSoundOn] = useState(sfxEnabled === true);
  const phase = guardianPhase(revisionMission);
  const active = QUESTS.find(({ id }) => id === quest) ?? QUESTS[0];
  // What Set off actually starts. Only a Guardian with a mission waiting takes
  // the button; every other Guardian reading hands it back to the walk.
  const runQuest = quest !== 'guardian'
    ? quest
    : phase === 'due' ? 'guardian' : practiceQuest;
  const runQuestName = QUESTS.find(({ id }) => id === runQuest)?.short ?? 'Smart';
  const guardianRuns = runQuest === 'guardian';
  const effectiveYearFilter = runQuest === 'test' ? 'core' : yearFilter;
  const effectiveLength = runQuest === 'test' ? 20 : length;
  const companion = useMemo(
    () => setupExpeditionCompanion(monsters, guardianRuns ? null : effectiveYearFilter),
    [monsters, guardianRuns, effectiveYearFilter],
  );

  useEffect(() => {
    setSoundOn(sfxEnabled === true);
  }, [sfxEnabled]);

  return (
    <main className="product-app" aria-labelledby="setup-title">
      <Scene
        className="setup-scene"
        dusk
        waypoints
        waypointScreen="home"
        onScreen={onScreen}
        plate={regionArt(REGION, active.plate)}
        plateY="32%"
        veil={[
          'radial-gradient(118% 66% at 50% 4%,rgba(10,15,22,.06),rgba(9,14,20,.6) 56%,rgba(8,12,18,.94))',
          'linear-gradient(180deg,rgba(9,14,20,.74) 0%,rgba(9,14,20,.08) 22%,rgba(8,12,18,.72) 62%,#080c12 92%)',
        ].join(',')}
      >
        <div className="scene-body">
          <div className="setup-chrome">
            <button
              type="button"
              className="glass-button icon-button press-soft press"
              onClick={onBack}
            >
              <IconBack size={21} />
              <span className="visually-hidden">Back to the trail</span>
            </button>
            <span>New expedition</span>
            <span className="icon-button" aria-hidden="true" />
          </div>

          <div className="setup-quest">
            {companion?.art && (
              <img
                src={companion.art}
                alt=""
                className={companion.found ? undefined : 'companion-asleep'}
              />
            )}
            {companion && !companion.found && (
              <p className="setup-companion-hint">Secure spellings here to wake this companion.</p>
            )}
            <p className="product-kicker">
              Today&apos;s quest<span aria-hidden="true" />
            </p>
            <h1 id="setup-title">{active.name}</h1>
            <p>
              {quest === 'guardian'
                ? guardianQuestLine(phase, {
                  mission: revisionMission,
                  megaWords,
                  packSize,
                })
                : active.line}
            </p>
            {quest === 'guardian' ? (
              <>
                {phase === 'due' && (
                  <p className="setup-guardian-due">
                    {guardianDueLine(revisionMission)}
                  </p>
                )}
                {/* The climb to Mega, drawn rather than counted again: the
                    line above already says how far. */}
                {phase === 'asleep' && packSize > 0 && (
                  <div className="setup-guardian-meter" aria-hidden="true">
                    <span
                      style={{
                        '--percent': `${Math.min(100, Math.round((megaWords / packSize) * 100))}%`,
                      }}
                    />
                  </div>
                )}
              </>
            ) : (
              <div className="setup-tally">
                <div>
                  <span className="figure">{dueCount}</span>
                  <span className="label">due</span>
                </div>
                <div>
                  <span className="figure">{troubleCount}</span>
                  <span className="label">trouble</span>
                </div>
                <div>
                  <span className="figure">{bankTotal}</span>
                  <span className="label">in bank</span>
                </div>
              </div>
            )}
          </div>

          <div className="quest-tiles" role="group" aria-label="Choose a quest">
            {QUESTS.map((option) => {
              const locked = option.id === 'guardian' && phase === 'locked';
              return (
                <button
                  key={option.id}
                  type="button"
                  className="quest-tile press"
                  data-locked={locked ? 'true' : undefined}
                  disabled={locked}
                  aria-pressed={quest === option.id}
                  onClick={() => {
                    setQuest(option.id);
                    if (option.id !== 'guardian') setPracticeQuest(option.id);
                  }}
                >
                  <span style={{ '--plate': artUrl(regionArt(REGION, option.plate)) }}>
                    <span className="quest-tile-art" aria-hidden="true" />
                    <span className="quest-tile-tint" aria-hidden="true" />
                    {quest === option.id && !locked && (
                      <span className="quest-tile-sheen" aria-hidden="true" />
                    )}
                    <span className="quest-tile-tag">{option.tag}</span>
                    <span className="quest-tile-name">{option.short}</span>
                    {locked && (
                      <span className="quest-tile-lock" aria-hidden="true">
                        <IconLock size={17} />
                      </span>
                    )}
                    {option.id === 'guardian'
                      && phase === 'due'
                      && (revisionMission?.guardianDueCount ?? 0) > 0 && (
                      <span className="quest-tile-count figure">
                        {revisionMission.guardianDueCount}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>

          {phase === 'locked' && (
            <p className="quest-note">
              <IconLock size={13} />
              Guardian · Not on this trail yet
            </p>
          )}
        </div>

        <div className="setup-tray">
          {/* The engine publishes the sets it can actually draw a round from.
              Until it publishes any, there is no rail: a set picker that
              cannot change what a round contains is a control that lies.
              A Guardian mission has no options at all — the engine chooses
              its words and its length — so both rails leave with it. */}
          {vocabularySets.length > 0 && !guardianRuns && (
            <>
              <p className="label">Vocabulary set</p>
              <div className="rail setup-pools">
                {vocabularySets.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className="pill press-soft press"
                    aria-pressed={effectiveYearFilter === option.id}
                    disabled={runQuest === 'test' && option.id !== 'core'}
                    /* The noun rides in the accessible name only. Spelled out
                       on all three pills the row ran 378px wide and sliced its
                       last set at every supported width (#111); the bare count
                       fits 320px, and "VOCABULARY SET" above already says what
                       is being counted. Same shape as the Words filters. */
                    aria-label={`${option.label}, ${option.count} ${option.count === 1 ? 'word' : 'words'}`}
                    onClick={() => setYearFilter(option.id)}
                  >
                    {option.label}
                    <span>{option.count}</span>
                  </button>
                ))}
              </div>
            </>
          )}

          {!guardianRuns && (
            <div className="setup-lengths">
              <p className="label">Round length</p>
              <div className="length-choice">
                {ROUND_LENGTHS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    className="press"
                    aria-pressed={effectiveLength === value}
                    disabled={runQuest === 'test' && value !== 20}
                    onClick={() => setLength(value)}
                  >
                    <strong className="figure">{value}</strong>
                  </button>
                ))}
              </div>
            </div>
          )}

          {guardianRuns && (
            <p className="setup-guardian-note">
              Guardian chooses its own words. No set, no length — just the
              patrol.
            </p>
          )}

          {audioState.status !== 'ready' && (
            <AudioStatus audioState={audioState} onRecover={onRecoverAudio} dusk />
          )}

          <div className="setup-sfx">
            <span id="setup-sfx-label">Sound effects</span>
            <button
              type="button"
              role="switch"
              className="pill press-soft press"
              aria-checked={soundOn}
              aria-labelledby="setup-sfx-label"
              onClick={() => {
                const next = !soundOn;
                setSoundOn(next);
                onSetSfxEnabled?.(next);
              }}
            >
              {soundOn ? 'On' : 'Off'}
            </button>
          </div>

          <button
            type="button"
            className="button-primary press"
            disabled={busy || audioState.status !== 'ready'}
            onClick={() => void (guardianRuns
              ? onStartGuardian()
              : onStart({
                length: effectiveLength,
                mode: runQuest,
                yearFilter: effectiveYearFilter,
              })).catch(() => undefined)}
          >
            {busy ? 'Preparing…' : guardianRuns ? (
              <>
                Begin the patrol
                <IconForward size={18} />
              </>
            ) : (
              <>
                Set off
                {quest === 'guardian' && ` on ${runQuestName}`}
                <span aria-hidden="true" className="dot-sep">·</span>
                <span className="figure">{effectiveLength}</span>
                words
                <IconForward size={18} />
              </>
            )}
          </button>

          {/* Camp is credited once a day. A learner who wants another patrol
              may have one, but the offer has to say what it does not carry. */}
          {quest === 'guardian' && phase === 'done' && (
            <button
              type="button"
              className="button-quiet press-soft press setup-guardian-again"
              disabled={busy || audioState.status !== 'ready'}
              onClick={() => void onStartGuardian({ intent: 'unrewarded' })
                .catch(() => undefined)}
            >
              Patrol again — no Camp credit
            </button>
          )}

          {actionError && (
            <p className="inline-error" role="alert">
              That trail could not start. Please try again.
            </p>
          )}
        </div>
      </Scene>
    </main>
  );
}

// The round engine reports four feedback kinds. `success` and `info` both mean
// the learner spelled it correctly — `info` only adds that the word returns —
// so both must read as a win. Only `error` is a wrong answer.
const FEEDBACK_TONE = Object.freeze({
  success: 'success',
  info: 'success',
  warn: 'notice',
  error: 'retry',
});

function feedbackTone(kind) {
  return FEEDBACK_TONE[kind] ?? 'notice';
}

function clozeParts(cloze) {
  const match = /_{2,}/u.exec(cloze ?? '');
  if (!match) return { before: cloze ?? '', after: '' };
  return {
    before: cloze.slice(0, match.index).trimEnd(),
    after: cloze.slice(match.index + match[0].length).trimStart(),
  };
}

function RoundScreen({
  state,
  audioState,
  audio,
  haptics,
  sfx,
  onSubmit,
  onContinue,
  onSkip,
  onEnd,
  onPlaybackFailure,
  entitlementState,
}) {
  const [answer, setAnswer] = useState('');
  const [localError, setLocalError] = useState('');
  const [confirmExit, setConfirmExit] = useState(false);
  const [exitError, setExitError] = useState('');
  const [leaving, setLeaving] = useState(false);
  const advanceTimerRef = useRef(null);
  const spellingInputRef = useRef(null);
  const lastCueKeyRef = useRef('');
  const closeExit = useCallback(() => {
    setExitError('');
    setConfirmExit(false);
  }, []);
  const practice = state.practice;
  const busy = state.status === 'saving';
  const answered = Boolean(practice?.awaitingAdvance);

  const focusSpellingField = useCallback(() => {
    if (busy || answered) return;
    const field = spellingInputRef.current;
    if (!field || typeof field.focus !== 'function') return;
    field.focus({ preventScroll: true });
  }, [busy, answered]);

  // The voice is not a round setting a learner chooses, but the pack is
  // recorded twice and the player still has to be told which recording to
  // reach for. Saved preferences name one; a round that arrives without them
  // still has a voice to be read in rather than a card that cannot speak.
  const audioRequest = useMemo(() => practice ? Object.freeze({
    version: audioState.activeVersion,
    runtimeItemId: practice.runtimeItemId,
    sentence: practice.sentence,
    voiceId: state.prefs?.voiceId ?? PACKAGED_VOICE,
  }) : null, [
    audioState.activeVersion,
    practice?.runtimeItemId,
    practice?.sentence,
    state.prefs?.voiceId,
  ]);

  async function play(kind) {
    if (!audioRequest || audioState.status !== 'ready' || busy) return;
    // Replay buttons are real taps: reclaim the visible field in the same
    // gesture so the software keyboard returns with the spelling input.
    focusSpellingField();
    try {
      if (!audio || typeof audio.play !== 'function') {
        throw new Error('product_audio_player_unavailable');
      }
      sfx?.noteSpeechStarted(6000);
      await audio.play({ ...audioRequest, kind });
      setLocalError('');
    } catch (error) {
      if (error?.name === 'NotAllowedError') {
        setLocalError('Tap Hear it again to listen.');
      // A revoked purchase removed the shards, so telling that family to check
      // the listening pack is advice they cannot act on. The branch below is
      // asserted by tests/product-audio-policy-refusal.test.mjs as source text,
      // so a comment inside it breaks that match — it lives out here instead.
      } else {
        if (entitlementState === 'revoked') {
          setLocalError('The full word list needs the purchase to be restored.');
        } else {
          setLocalError('Audio needs attention. Check the listening pack and try again.');
        }
        onPlaybackFailure();
      }
    } finally {
      focusSpellingField();
    }
  }

  useEffect(() => {
    if (!audioRequest || audioState.status !== 'ready') return;
    void play('sentence');
  // Autoplay exactly once for a newly projected card.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioRequest]);

  // After Set off / next card mount, raise the ordinary visible field so the
  // learner can type without an extra tap on "your spelling".
  useEffect(() => {
    if (!practice || busy || answered) return undefined;
    const frame = requestAnimationFrame(() => {
      focusSpellingField();
    });
    return () => cancelAnimationFrame(frame);
  }, [
    practice?.sessionId,
    practice?.runtimeItemId,
    answered,
    busy,
    focusSpellingField,
  ]);

  useEffect(() => {
    const kind = practice?.feedback?.kind;
    if (!kind || !practice?.runtimeItemId) return;
    const cueKey = `${practice.runtimeItemId}:${kind}`;
    if (lastCueKeyRef.current === cueKey) return;
    lastCueKeyRef.current = cueKey;
    const tone = feedbackTone(kind);
    if (tone === 'success') {
      haptics?.answerCorrect?.();
      sfx?.play('correct');
    } else if (tone === 'retry') {
      sfx?.play('retry');
    }
  }, [practice?.runtimeItemId, practice?.feedback?.kind, haptics, sfx]);

  useEffect(() => {
    if (advanceTimerRef.current != null) {
      clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    }
    if (!practice?.awaitingAdvance || state.actionError) return undefined;
    advanceTimerRef.current = setTimeout(() => {
      advanceTimerRef.current = null;
      void onContinue()
        .then(() => setAnswer(''))
        .catch(() => setLocalError('That answer did not save. Please try again.'));
    }, autoAdvanceDelayMs());
    return () => {
      if (advanceTimerRef.current != null) {
        clearTimeout(advanceTimerRef.current);
        advanceTimerRef.current = null;
      }
    };
  // onContinue is an inline service call whose identity changes per render;
  // keying on it would restart the timer on unrelated updates.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    practice?.sessionId,
    practice?.runtimeItemId,
    practice?.awaitingAdvance,
    state.actionError,
  ]);

  if (!practice) return null;
  const total = practice.progress.total;
  const done = practice.progress.done;
  const visibleCard = Math.min(total, done + 1);
  const { before, after } = clozeParts(practice.cloze);
  const feedbackKind = feedbackTone(practice.feedback?.kind);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    try {
      if (answered) {
        if (advanceTimerRef.current != null) {
          clearTimeout(advanceTimerRef.current);
          advanceTimerRef.current = null;
        }
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
    <main className="product-app" aria-labelledby="practice-title">
      <Scene
        className="round-scene"
        dusk
        plate={regionArt(REGION, 'a2')}
        veil="linear-gradient(180deg,rgba(14,21,29,.6) 0%,rgba(14,21,29,.3) 42%,rgba(14,21,29,.66) 100%)"
      >
        <div className="scene-body">
          <ol
            className="round-dots"
            aria-label={`Card ${visibleCard} of ${total}`}
          >
            {Array.from({ length: total }, (_, index) => {
              const complete = index < done || (index === done && answered);
              const here = index === done && !answered;
              return (
                <li
                  // eslint-disable-next-line react/no-array-index-key
                  key={index}
                  data-state={complete ? 'done' : here ? 'here' : 'ahead'}
                />
              );
            })}
            <span className="round-flag" aria-hidden="true"><IconTrail size={15} /></span>
          </ol>
          <p className="round-attempts">
            Answered {practice.progress.checked} of {practice.progress.total ?? total}
          </p>

          <section
            className="round-card"
            aria-labelledby="practice-title"
            aria-busy={busy}
          >
            {/* A Guardian round is a different errand from a walk, and the
                card is otherwise identical, so it says so above the kicker. */}
            {practice.mode === 'guardian' && (
              <p className="round-mission">
                <IconGuardian size={14} />
                {practice.label}
              </p>
            )}

            <h1 id="practice-title" className="product-kicker">
              Spell the word you hear
            </h1>

            <p className="cloze-line">
              <span>{before}</span>
              <span className="cloze-blank" aria-hidden="true" />
              <span>{after}</span>
            </p>

            <form className="answer-form" onSubmit={(event) => void submit(event)}>
              <div className="answer-line">
                <label htmlFor="product-spelling-input" className="visually-hidden">
                  Type the spelling
                </label>
                <input
                  ref={spellingInputRef}
                  id="product-spelling-input"
                  name="spelling"
                  type="text"
                  value={answer}
                  placeholder="your spelling"
                  aria-readonly={busy || answered}
                  // A spelling test must not be told the answer: no
                  // autocomplete, no autocorrect, no spellcheck and no writing
                  // suggestions, which together also take away the predictive
                  // strip above the keys.
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck="false"
                  writingsuggestions="false"
                  enterKeyHint="done"
                  style={{
                    '--line-colour': answered
                      ? (feedbackKind === 'success' ? 'var(--good-bright)' : 'var(--retry-soft)')
                      : undefined,
                  }}
                  onBeforeInput={(event) => {
                    if (busy || answered) event.preventDefault();
                  }}
                  onChange={(event) => {
                    if (!busy && !answered) setAnswer(event.target.value);
                  }}
                />
              </div>

              <div className="listen-row" aria-label="Listening controls">
                <button
                  type="button"
                  className="press"
                  disabled={busy || audioState.status !== 'ready'}
                  onClick={() => void play('sentence')}
                >
                  <IconSpeaker size={21} />
                  Hear it again
                </button>
                <button
                  type="button"
                  className="slow-replay press"
                  aria-label="Replay slowly"
                  disabled={busy || audioState.status !== 'ready'}
                  onClick={() => void play('slow-sentence')}
                >
                  <IconSpeakerSlow size={21} />
                  <span aria-hidden="true">0.5×</span>
                </button>
              </div>

              <button type="submit" className="button-brand press" disabled={busy}>
                {busy ? 'Saving…' : answered ? 'Continue' : 'Submit'}
                <IconForward size={19} />
              </button>
            </form>

            {(localError || state.actionError) && (
              <p className="inline-error" role="alert">
                {localError || 'That answer did not save. Please try again.'}
              </p>
            )}

            {practice.feedback && (
              <div
                className="round-feedback"
                data-kind={feedbackKind}
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                <span className="round-feedback-mark" aria-hidden="true">
                  {feedbackKind === 'success' ? <IconTick size={18} />
                    : feedbackKind === 'notice' ? <IconWarning size={18} />
                      : <IconReturn size={18} />}
                </span>
                <div>
                  <h2>{practice.feedback.headline}</h2>
                  {practice.feedback.answer && (
                    <p>Correct spelling: <strong>{practice.feedback.answer}</strong></p>
                  )}
                  {practice.feedback.body && <p>{practice.feedback.body}</p>}
                  {practice.feedback.footer && <p>{practice.feedback.footer}</p>}
                </div>
              </div>
            )}
          </section>

          <footer className="round-foot">
            <p>AI-generated dictation voice</p>
            <div className="round-foot-actions">
              {!answered && (
                <button
                  type="button"
                  className="button-quiet press-soft press"
                  disabled={busy}
                  onClick={() => {
                    focusSpellingField();
                    sfx?.play('tick');
                    haptics?.uiTick?.();
                    void onSkip()
                      .then(() => setAnswer(''))
                      .catch(() => setLocalError(
                        'That word could not be skipped. Please try again.',
                      ));
                  }}
                >
                  {/* On a Guardian patrol a skip is recorded as a wobble, so
                      the label has to be the honest thing to press. */}
                  {practice.mode === 'guardian' ? 'I don’t know' : 'Skip for now'}
                </button>
              )}
              <button
                type="button"
                className="button-quiet press-soft press"
                disabled={busy}
                onClick={() => {
                  setExitError('');
                  setConfirmExit(true);
                }}
              >
                End round
              </button>
            </div>
          </footer>
        </div>

        {confirmExit && (
          <LeaveRoundDialog
            error={exitError}
            leaving={leaving || busy}
            onKeep={() => {
              closeExit();
              focusSpellingField();
            }}
            onLeave={() => void leaveRound()}
          />
        )}
      </Scene>
    </main>
  );
}

function mistakeWord(mistake) {
  if (typeof mistake === 'string') return mistake;
  return mistake?.target ?? mistake?.word ?? mistake?.slug ?? '';
}

function ResultsScreen({
  summary,
  monsters,
  camp,
  onScreen,
  celebrationEvents = [],
  secureGain = 0,
  campGain = 0,
  haptics,
  sfx,
  onCelebrationDone,
  preferredRewardTrackId = null,
}) {
  // Field Record prefers the companion this round progressed, then mirrors
  // Trail: only a caught or evolved companion is painted — no phantom egg.
  const companion = useMemo(() => {
    const roster = buildCodex(monsters).roster;
    const preferred = roster.find(
      (entry) => entry.rewardTrackId === preferredRewardTrackId && entry.found,
    ) ?? null;
    return preferred ?? setupExpeditionCompanion(monsters);
  }, [monsters, preferredRewardTrackId]);
  const accuracy = summary?.accuracy ?? 0;
  const total = summary?.totalWords ?? 0;
  const correct = summary?.correct ?? 0;
  const mistakes = (summary?.mistakes ?? []).map(mistakeWord).filter(Boolean);
  const clean = mistakes.length === 0;
  // A wobbled Guardian word is not queued vaguely: it is due again on the
  // next Guardian day, so the record says tomorrow and means it.
  const guardian = summary?.mode === 'guardian';
  const stampedRef = useRef(false);

  // Timed with .record-stamp's stampIn delay (280ms) so the thud lands with the ink.
  useEffect(() => {
    if (!summary || stampedRef.current) return undefined;
    stampedRef.current = true;
    const timer = setTimeout(() => {
      sfx?.play('stamp');
      haptics?.uiTick?.();
    }, 280);
    return () => clearTimeout(timer);
  }, [summary, sfx, haptics]);

  return (
    <main className="product-app" aria-labelledby="summary-title">
      <Scene
        className="results-scene"
        dusk
        plate={regionArt(REGION, 'a3')}
        plateY="26%"
        veil={[
          'radial-gradient(96% 52% at 50% 20%,rgba(7,11,16,.05),rgba(7,11,16,.66) 58%,rgba(7,11,16,.96))',
          'linear-gradient(180deg,rgba(7,11,16,.7) 0%,rgba(7,11,16,.1) 18%,rgba(7,11,16,.86) 56%,#070b10 84%)',
        ].join(',')}
      >
        {/* The one screen a growth is allowed to interrupt. It sits above the
            record rather than inside it, so the record is already written and
            waiting underneath when the last card is tapped away. */}
        <CelebrationLayer
          events={celebrationEvents}
          haptics={haptics}
          sfx={sfx}
          onDone={onCelebrationDone}
        />
        <div className="scene-body">
          <div className="results-halo">
            <p className="product-kicker">Expedition logged</p>
            {companion?.art && (
              <img src={companion.art} alt={companion.displayName ?? companion.name} />
            )}
            {secureGain > 0 && (
              <p className="results-gain">
                {secureGain === 1
                  ? '1 word is now secure'
                  : `${secureGain} words are now secure`}
              </p>
            )}
          </div>

          <div className="field-record">
            <div className="field-record-sheet">
              <div className="field-record-head">
                <div>
                  <p className="product-kicker">
                    Field record<span aria-hidden="true" />
                  </p>
                  <h1 id="summary-title">{clean ? 'Clean sweep' : 'Well done'}</h1>
                  <p>{summary?.message}</p>
                </div>
                <span className="record-stamp">
                  <span className="figure">{accuracy}</span>
                  <small>percent</small>
                </span>
              </div>

              <div className="record-tally">
                <div>
                  <span className="figure figure-good">{correct}</span>
                  <span className="label">correct</span>
                </div>
                <div>
                  <span className="figure figure-retry">{mistakes.length}</span>
                  <span className="label">return</span>
                </div>
                <div>
                  <span className="figure figure-brass">{total}</span>
                  <span className="label">words walked</span>
                </div>
              </div>

              {campGain > 0 && (
                <p className="record-camp">
                  <IconGuardian size={17} />
                  The camp fire rises — Camp level {camp?.campHighWater ?? 0}
                </p>
              )}

              {clean ? (
                <p className="record-roll-clean body-copy">
                  Every word held on the first try.
                </p>
              ) : (
                <>
                  <p className="product-kicker record-roll-kicker">
                    {guardian ? 'Back tomorrow' : 'Coming back'}
                    <span className="figure"> {mistakes.length}</span>
                  </p>
                  <ul className="record-roll">
                    {mistakes.map((word) => (
                      <li key={word} data-ok="false">
                        <strong>{word}</strong>
                        <span className="record-roll-rule" aria-hidden="true" />
                        <span className="record-roll-status">
                          {guardian ? 'comes back tomorrow' : 'comes back'}
                        </span>
                        <span className="record-roll-mark" aria-hidden="true">
                          <IconReturn size={12} />
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {companion && (
                <div className="record-growth">
                  <span>
                    <span className="record-growth-name">
                      <strong>{companion.displayName}</strong>
                      <span>{companion.stageLabel}</span>
                    </span>
                    <span className="record-growth-bars" aria-hidden="true">
                      {companion.pips.map((filled, index) => (
                        <span
                          // eslint-disable-next-line react/no-array-index-key
                          key={index}
                          data-filled={filled ? 'true' : 'false'}
                          data-latest={filled && index === companion.stage ? 'true' : 'false'}
                        />
                      ))}
                    </span>
                  </span>
                  <span className="record-growth-secure">
                    <span className="figure">{companion.secureCount}</span>
                    <span className="label">words secure</span>
                  </span>
                </div>
              )}
            </div>
          </div>

          <div className="results-actions">
            <button
              type="button"
              className="button-primary press"
              onClick={() => onScreen('setup')}
            >
              Walk again
            </button>
            <button
              type="button"
              className="button-quiet press"
              onClick={() => onScreen('home')}
            >
              Trail
            </button>
          </div>
        </div>
      </Scene>
    </main>
  );
}

// Named so the record can be rendered on its own in tests. The declaration
// itself stays a plain function: the round contract reads this file as text
// and finds the round by the two function headings around it.
export { ResultsScreen, WordBankScreen, WordDetailScreen };

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
  // Opening the learner sheet is a presentation decision, not a learning one.
  // Clearing the selected learner to reach it would throw away the loaded
  // snapshot and leave the sheet with nothing to return to.
  const [switchOpen, setSwitchOpen] = useState(false);
  // What a round actually grew, worked out by comparing the roster the round
  // started on with the roster it ended on. The reward track publishes totals,
  // not events, so the difference is the event. The round-start roster is
  // captured by the controller so it survives relaunch.
  const [celebrationEvents, setCelebrationEvents] = useState([]);
  const [secureGain, setSecureGain] = useState(0);
  // Camp only ever rises on a rewarded Guardian mission, so the round-start
  // camp is the only honest thing to compare the ending camp with.
  const [campGain, setCampGain] = useState(0);
  const [preferredTrack, setPreferredTrack] = useState(null);
  const learningScreenRef = useRef(learningState.screen);
  const clearCelebrations = useCallback(() => setCelebrationEvents([]), []);

  useEffect(() => {
    const profileSubscription = services.controller.subscribe(setProfileState);
    const learningSubscription = services.learning.subscribe((next) => {
      const previousScreen = learningScreenRef.current;
      if (previousScreen !== 'summary' && next.screen === 'summary') {
        const before = next.roundBaseline?.monsters ?? [];
        const monsterEvents = diffMonsterCelebrations(before, next.monsters);
        const raisedCamp =
          (next.camp?.campHighWater ?? 0)
          - (next.roundBaseline?.camp?.campHighWater
            ?? next.camp?.campHighWater
            ?? 0);
        const roundSessionId = next.roundBaseline?.sessionId ?? null;
        const milestoneCards = roundSessionId
          ? (next.records?.milestones ?? [])
            .filter((record) => record.sessionId === roundSessionId)
            .map(milestoneCelebration)
          : [];
        const baselineAchievementIds = next.roundBaseline?.achievementIds ?? [];
        const achievementCards = (next.achievements ?? [])
          .filter((chip) => !baselineAchievementIds.includes(chip.id))
          .map(achievementCelebration);
        const events = [
          ...monsterEvents,
          ...milestoneCards,
          ...achievementCards,
          ...(raisedCamp > 0 ? [campLevelCelebration(next.camp?.campHighWater)] : []),
        ];
        setCelebrationEvents(events);
        setSecureGain(secureWordDelta(before, next.monsters));
        setCampGain(
          (next.camp?.campHighWater ?? 0)
          - (next.roundBaseline?.camp?.campHighWater
            ?? next.camp?.campHighWater
            ?? 0),
        );
        setPreferredTrack(
          primaryProgressedRewardTrackId(monsterEvents, next.monsters)
            ?? next.roundBaseline?.companionRewardTrackId
            ?? null,
        );
        // Warm the Phaser chunk before CelebrationLayer lazy-mounts it.
        if (events.some((event) => event.kind === 'caught' || event.kind === 'evolve')) {
          void import('./celebrations/CelebrationStage.jsx');
        }
      }
      learningScreenRef.current = next.screen;
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

  const bank = useMemo(
    () => buildWordBank({ progress: learningState.progress }),
    [learningState.progress],
  );
  const megaWords = useMemo(
    () => countMegaWords(learningState.progress),
    [learningState.progress],
  );

  if (profileState.status === 'failed') {
    return (
      <main className="product-app">
        <Scene className="parent-scene">
          <div className="scene-body">
            <ProductTopBar />
            <section className="vellum" aria-labelledby="product-data-title">
              <p className="product-kicker">Local data</p>
              <h1 id="product-data-title">Your saved learning could not open</h1>
              <p className="body-copy">Your local data has not been replaced.</p>
              {profileState.startupFailureDetail ? (
                <p className="body-copy">
                  <code>{profileState.startupFailureDetail}</code>
                </p>
              ) : null}
              <button
                type="button"
                className="button-primary press"
                onClick={() => globalThis.location?.reload()}
              >
                Try opening again
              </button>
            </section>
          </div>
        </Scene>
      </main>
    );
  }

  const selectedProfile = profileState.profiles.find(
    ({ learnerId }) => learnerId === learningState.learnerId,
  );
  const recoverAudio = () => {
    void services.audioAvailability.recover().catch(() => undefined);
  };
  const showScreen = (screen) => {
    if (screen !== learningState.screen) {
      services.haptics?.uiTick?.();
    }
    services.learning.showScreen(screen);
  };
  const closeParent = () => {
    services.parent.lock();
    setParentOpen(false);
  };
  const filterCount = (id) =>
    bank.filters.find((option) => option.id === id)?.count ?? 0;
  const startGuardian = (options) =>
    services.learning.startGuardianMission(options);

  if (parentOpen) {
    return (
      <ParentArea
        state={parentState}
        profiles={profileState.profiles}
        progressState={parentProgressState}
        commerceState={parentCommerceState}
        fullCatalogueActive={services.catalogueId === 'ks2-core:full'}
        onClose={closeParent}
        onSetPin={(candidate) => services.parent.setPin(candidate)}
        onResetPin={(candidate) => services.parent.resetPin(candidate)}
        onUnlockPin={(candidate) => services.parent.unlockWithPin(candidate)}
        onUnlockBiometrics={() => services.parent.unlockWithBiometrics()}
        onSetBiometricsEnabled={(enabled) =>
          services.parent.setBiometricsEnabled(enabled)}
        onEditProfile={(draft) => services.controller.editProfile(draft)}
        onRemoveProfile={async (learnerId) => {
          await services.controller.removeProfile(learnerId);
          // A committed removal must not be reported as failed because the
          // auxiliary summary could not be rebuilt; it carries its own notice.
          await services.parentProgress.refresh().catch(() => undefined);
        }}
        onResetLearning={(learnerId) =>
          services.parentAdministration.resetLearning(learnerId)}
        onRefreshProgress={() => services.parentProgress.refresh()}
        onPurchase={() => services.parentCommerce.purchase()}
        onRestore={() => services.parentCommerce.restore()}
        onDownload={() => services.parentCommerce.download()}
        onRecoverCommerce={() => services.parentCommerce.recover()}
      />
    );
  }

  if (switchOpen || learningState.screen === 'profiles' || !selectedProfile) {
    // No learners means nothing to pick between, so first run is its own
    // screen rather than the picker with an empty list (#110).
    if (profileState.profiles.length === 0) {
      return (
        <FirstRunScene
          profileState={profileState}
          audioState={audioState}
          onCreate={(draft) => services.controller.createProfile(draft)}
          onOpenParent={() => setParentOpen(true)}
          onRecoverAudio={recoverAudio}
        />
      );
    }
    return (
      <SwitchScreen
        profileState={profileState}
        audioState={audioState}
        onChoose={(learnerId) =>
          services.controller
            .selectProfile(learnerId)
            .then(() => setSwitchOpen(false))
            .catch(() => undefined)}
        onCreate={(draft) => services.controller.createProfile(draft)}
        onOpenParent={() => setParentOpen(true)}
        onRecoverAudio={recoverAudio}
        haptics={services.haptics}
        sfx={services.sfx}
        // Until a learner is chosen this is the only screen there is, so the
        // sheet stays put and shows no grip to drag.
        onDismiss={selectedProfile ? () => setSwitchOpen(false) : undefined}
      />
    );
  }

  if (learningState.screen === 'setup') {
    return (
      <SetupScreen
        audioState={audioState}
        actionError={learningState.actionError}
        onStart={(options) => services.learning.startRound(options)}
        onBack={() => showScreen('home')}
        onScreen={showScreen}
        onRecoverAudio={recoverAudio}
        busy={learningState.status === 'saving'}
        dueCount={filterCount('due')}
        troubleCount={filterCount('trouble')}
        bankTotal={bank.total}
        vocabularySets={learningState.vocabularySets}
        monsters={learningState.monsters}
        sfxEnabled={services.sfx?.isEnabled?.() !== false}
        onSetSfxEnabled={(enabled) => services.setSfxEnabled?.(enabled)}
        revisionMission={learningState.revisionMission}
        megaWords={megaWords}
        packSize={learningState.packSize ?? 0}
        onStartGuardian={startGuardian}
      />
    );
  }
  if (learningState.screen === 'practice') {
    return (
      <RoundScreen
        state={learningState}
        audioState={audioState}
        audio={services.audio}
        haptics={services.haptics}
        sfx={services.sfx}
        onSubmit={(typed) => services.learning.submitAnswer(typed)}
        onContinue={() => services.learning.continueRound()}
        onSkip={() => services.learning.skipWord()}
        onEnd={() => services.learning.endRound()}
        onPlaybackFailure={() =>
          services.audioAvailability.reportPlaybackFailure()}
        entitlementState={parentCommerceState.entitlementState}
      />
    );
  }
  if (learningState.screen === 'summary') {
    return (
      <ResultsScreen
        summary={learningState.summary}
        monsters={learningState.monsters}
        camp={learningState.camp}
        onScreen={showScreen}
        celebrationEvents={celebrationEvents}
        secureGain={secureGain}
        campGain={campGain}
        preferredRewardTrackId={preferredTrack}
        haptics={services.haptics}
        sfx={services.sfx}
        onCelebrationDone={clearCelebrations}
      />
    );
  }
  if (learningState.screen === 'progress') {
    return (
      <WordBankScreen
        progress={learningState.progress}
        vocabularySets={learningState.vocabularySets}
        onScreen={showScreen}
        onStart={() => showScreen('setup')}
        wordMaterial={services.learning.wordMaterial}
        onPractise={(runtimeItemId) =>
          services.learning.practiseWord(runtimeItemId)}
        audio={services.audio}
        audioState={audioState}
        voiceId={learningState.prefs?.voiceId}
        busy={learningState.status === 'saving'}
        onPlaybackFailure={() =>
          services.audioAvailability.reportPlaybackFailure()}
      />
    );
  }
  if (learningState.screen === 'monster') {
    return (
      <CodexScreen
        monsters={learningState.monsters}
        progress={learningState.progress}
        onScreen={showScreen}
      />
    );
  }
  if (learningState.screen === 'camp') {
    return (
      <CampScreen
        camp={learningState.camp}
        revisionMission={learningState.revisionMission}
        megaWords={megaWords}
        packSize={learningState.packSize ?? 0}
        audioState={audioState}
        busy={learningState.status === 'saving'}
        achievements={learningState.achievements}
        onScreen={showScreen}
        onStartGuardian={startGuardian}
        onRecoverAudio={recoverAudio}
      />
    );
  }
  return (
    <TrailScreen
      profile={selectedProfile}
      learningState={learningState}
      audioState={audioState}
      dueCount={filterCount('due')}
      onScreen={showScreen}
      onSwitchLearner={() => setSwitchOpen(true)}
      onOpenParent={() => setParentOpen(true)}
      onRecoverAudio={recoverAudio}
    />
  );
}
