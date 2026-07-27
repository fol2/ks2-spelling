import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { buildCodex, trailMeadowCompanions } from './codex-model.js';
import { artUrl, monsterArt, regionArt } from './mastery-art.js';
import { autoAdvanceDelayMs } from './practice-feel.js';
import { buildWordBank } from './word-bank-model.js';
import { CelebrationLayer } from './celebrations/CelebrationLayer.jsx';
import {
  diffMonsterCelebrations,
  secureWordDelta,
} from './celebrations/celebration-model.js';

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

function displayYearGroup(value) {
  return `Year ${value.slice(1)}`;
}

function initialOf(nickname) {
  return nickname.slice(0, 1).toUpperCase();
}

/**
 * One painted scene. `plate` and `veil` drive the backdrop through custom
 * properties so every screen mixes the same recipe rather than its own.
 */
function Scene({
  className = '',
  dusk = false,
  plate = null,
  plateY,
  plateOpacity,
  veil,
  waypoints = false,
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
      <main className="product-app product-page parent-page" aria-labelledby="parent-title">
        <ProductTopBar
          title="Parent area"
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
            {/* The caution stands above the control it is about. Printed
                underneath, it was read after the tap, if at all — and the tap
                it followed replaces every learner on the device. */}
            <p className="parent-backup-warning">
              Import replaces every learner and learning snapshot on this
              device. The Parent PIN, purchases and installed packs stay
              unchanged.
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
              {!confirmingImport && (
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
              )}
            </div>
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
    <main className="product-app product-page parent-page" aria-labelledby="parent-access-title">
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
function useSheetDrag(onDismiss) {
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
    if (flicked || travel >= drag.height * SHEET_DISMISS_FRACTION) onDismiss();
  }, [onDismiss]);

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

function SwitchScreen({
  profileState,
  audioState,
  onChoose,
  onCreate,
  onOpenParent,
  onRecoverAudio,
  onDismiss,
}) {
  const drag = useSheetDrag(onDismiss);
  const [nickname, setNickname] = useState('');
  const [yearGroup, setYearGroup] = useState('Y3');
  const [goal, setGoal] = useState(10);
  const [adding, setAdding] = useState(false);
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
    })
      .then(() => {
        setNickname('');
        setAdding(false);
      })
      .catch(() => undefined);
  }

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

// Four painted positions on the downs, nearest and largest first so a single
// companion still stands where the eye expects it.
const MEADOW_SLOTS = Object.freeze([
  Object.freeze({
    left: '8%', top: '44%', size: '46%', zIndex: 14, face: -1, bob: '6px',
    roam: 'roamG 25s ease-in-out -6s infinite',
    gait: 'bob 4.8s ease-in-out .9s infinite',
    emerge: '80ms', shadow: '0.5rem',
  }),
  Object.freeze({
    left: '60%', top: '34%', size: '34%', zIndex: 13, face: -1, bob: '5px',
    roam: 'roamG 27s ease-in-out -11s infinite',
    gait: 'bob 5.2s ease-in-out .3s infinite',
    emerge: '360ms', shadow: '0.4rem',
  }),
  Object.freeze({
    left: '3%', top: '18%', size: '36%', zIndex: 12, face: 1, bob: '9px',
    roam: 'roamA 19.6s ease-in-out -8s infinite',
    gait: 'flap 4.6s ease-in-out 1.4s infinite',
    emerge: '220ms', shadow: '-1.6rem',
  }),
  Object.freeze({
    left: '64%', top: '6%', size: '24%', zIndex: 11, face: -1, bob: '8px',
    roam: 'roamA 16.4s ease-in-out -5s infinite',
    gait: 'flap 3.4s ease-in-out .8s infinite',
    emerge: '300ms', shadow: '-2rem',
  }),
]);

const ROAM_VARIABLES = Object.freeze([
  Object.freeze({ '--fwd': '-32px', '--back': '24px' }),
  Object.freeze({ '--fwd': '-26px', '--back': '20px' }),
  Object.freeze({ '--fwd': '36px', '--back': '-26px', '--fy': '-9px', '--by': '14px' }),
  Object.freeze({ '--fwd': '-38px', '--back': '24px', '--fy': '-7px', '--by': '12px' }),
]);

function MeadowPet({ companion, slot, roam, poked, onPoke }) {
  return (
    <button
      type="button"
      className="meadow-pet press-soft press"
      aria-label={companion.found ? companion.name : 'An undiscovered companion'}
      style={{
        '--pet-left': slot.left,
        '--pet-top': slot.top,
        '--pet-size': slot.size,
        '--pet-roam': slot.roam,
        '--pet-gait': slot.gait,
        '--shadow-bottom': slot.shadow,
        zIndex: slot.zIndex,
        ...roam,
      }}
      onClick={onPoke}
    >
      <span className="meadow-shadow" aria-hidden="true" />
      <span
        className="meadow-emerge"
        style={{ animationDelay: slot.emerge }}
      >
        <img
          src={companion.art ?? undefined}
          alt=""
          style={{ '--face': slot.face, '--bob': slot.bob }}
        />
      </span>
      {poked && (
        <span className="meadow-tag">
          <span>
            {companion.found ? companion.name : '???'}
            <small>{companion.band}</small>
          </span>
        </span>
      )}
    </button>
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
  const [poked, setPoked] = useState(null);
  const codex = useMemo(
    () => buildCodex(learningState.monsters),
    [learningState.monsters],
  );

  useEffect(() => {
    if (!poked) return undefined;
    const timer = setTimeout(() => setPoked(null), 2600);
    return () => clearTimeout(timer);
  }, [poked]);

  const dueLabel = dueCount === 1 ? 'word due today' : 'words due today';

  return (
    <main className="product-app" aria-labelledby="home-title">
      <Scene
        className="trail-scene"
        dusk
        waypoints
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
              style={{ marginLeft: 'auto' }}
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
            <span className="meadow-halo" aria-hidden="true" />
            {trailMeadowCompanions(codex.roster, MEADOW_SLOTS.length).map(
              (companion, index) => (
                <MeadowPet
                  key={companion.rewardTrackId}
                  companion={companion}
                  slot={MEADOW_SLOTS[index]}
                  roam={ROAM_VARIABLES[index]}
                  poked={poked === companion.rewardTrackId}
                  onPoke={() => setPoked(companion.rewardTrackId)}
                />
              ),
            )}
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
        <WaypointBar screen="home" onScreen={onScreen} />
      </Scene>
    </main>
  );
}

const FILTER_DOTS = Object.freeze({
  all: 'rgba(29,43,58,.3)',
  due: '#a06b22',
  trouble: '#c0603f',
  learning: '#3e6fa8',
  secure: '#1f7a4f',
});

function WordBankScreen({ progress, onScreen, onStart }) {
  const [filter, setFilter] = useState('all');
  const bank = useMemo(
    () => buildWordBank({ progress, filter }),
    [progress, filter],
  );

  return (
    <main className="product-app" aria-labelledby="bank-title">
      <Scene
        className="bank-scene"
        waypoints
        plate={regionArt(REGION, 'a1')}
        plateY="30%"
        veil="linear-gradient(180deg,rgba(246,245,241,.44),rgba(246,245,241,.9) 42%,#f8f5ec 62%)"
      >
        <div className="scene-body">
          <div className="bank-head">
            <div>
              <p className="product-kicker">Word bank</p>
              <h1 id="bank-title">Your words</h1>
            </div>
            <span className="figure">{bank.countLabel}</span>
          </div>

          <div className="rail bank-filters" role="group" aria-label="Filter words">
            {bank.filters.map((option) => (
              <button
                key={option.id}
                type="button"
                className="pill press-soft press"
                aria-pressed={option.selected}
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
                <li
                  key={row.runtimeItemId}
                  className="bank-row"
                  data-status={row.status}
                  data-due={row.due ? 'true' : 'false'}
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
                  ) : (
                    <button
                      type="button"
                      className="button-quiet press-soft press"
                      onClick={() => setFilter('all')}
                    >
                      Show every word in the bank
                    </button>
                  )}
                </li>
              )}
            </ul>
          </div>
        </div>
        <WaypointBar screen="progress" onScreen={onScreen} />
      </Scene>
    </main>
  );
}

function CodexScreen({ monsters, onScreen }) {
  const [selected, setSelected] = useState(null);
  const [zoomed, setZoomed] = useState(false);
  const codex = useMemo(
    () => buildCodex(monsters, selected),
    [monsters, selected],
  );
  const hero = codex.hero;

  return (
    <main className="product-app" aria-labelledby="codex-title">
      <Scene
        className="codex-scene"
        dusk
        waypoints
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
                style={{ '--accent': hero.accent }}
              >
                <span className="codex-hero-glow" aria-hidden="true" />
                <span className="codex-hero-sheen" aria-hidden="true" />
                {['tl', 'tr', 'bl', 'br'].map((corner) => (
                  <span key={corner} className="codex-corner" data-corner={corner} aria-hidden="true" />
                ))}
                <span className="codex-no">NO. {hero.number}</span>
                <span className="codex-band">{hero.band}</span>

                <button
                  type="button"
                  className="codex-stage press"
                  onClick={() => setZoomed(true)}
                >
                  <span className="codex-stage-shadow" aria-hidden="true" />
                  <img src={hero.art ?? undefined} alt="" />
                  <span className="visually-hidden">Look closer at {hero.title}</span>
                </button>

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

          {zoomed && hero && (
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
        <WaypointBar screen="monster" onScreen={onScreen} />
      </Scene>
    </main>
  );
}

function CampScreen({ camp, revisitsWaiting, onScreen }) {
  const level = camp?.campHighWater ?? 0;
  const circumference = 333;
  const offset = Math.max(0, circumference * (1 - Math.min(level, 10) / 10));

  return (
    <main className="product-app" aria-labelledby="camp-title">
      <Scene
        className="camp-scene"
        waypoints
        plate={regionArt(REGION, 'd1')}
        veil="linear-gradient(180deg,rgba(248,245,236,.34) 0%,rgba(248,245,236,.2) 26%,rgba(248,245,236,.66) 68%,rgba(248,245,236,.9) 100%)"
      >
        <div className="scene-body">
          <p className="product-kicker">The Scribe Downs · Camp</p>

          <div className="camp-ring">
            <svg viewBox="0 0 120 120" aria-hidden="true">
              <circle cx="60" cy="60" r="53" fill="none" stroke="rgba(29,43,58,.13)" strokeWidth="7" />
              <circle
                cx="60"
                cy="60"
                r="53"
                fill="none"
                stroke="#a06b22"
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

          <section className="vellum camp-card">
            <h1 id="camp-title">
              {revisitsWaiting > 0
                ? 'Words are waiting to return'
                : 'Camp is steady for now'}
            </h1>
            <p className="body-copy">
              Camp rises when you come back to words you met a while ago — not
              from fresh practice, however much of it you do.
            </p>
            <div className="camp-figures">
              <div>
                <span className="figure">{level}</span>
                <span className="label">Camp level</span>
              </div>
              <div>
                <span className="figure">{revisitsWaiting}</span>
                <span className="label">Words waiting to return</span>
              </div>
            </div>
            <button
              type="button"
              className="button-primary press"
              onClick={() => onScreen('setup')}
            >
              Set off on a round
              <IconForward size={18} />
            </button>
          </section>
        </div>
        <WaypointBar screen="camp" onScreen={onScreen} />
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
]);

function SetupScreen({
  audioState,
  actionError,
  onStart,
  onBack,
  onRecoverAudio,
  busy,
  dueCount,
  troubleCount,
  bankTotal,
  vocabularySets = [],
}) {
  const [length, setLength] = useState(5);
  const [quest, setQuest] = useState('smart');
  const [yearFilter, setYearFilter] = useState(vocabularySets[0]?.id ?? 'core');
  const active = QUESTS.find(({ id }) => id === quest) ?? QUESTS[0];
  const effectiveYearFilter = quest === 'test' ? 'core' : yearFilter;
  const effectiveLength = quest === 'test' ? 20 : length;
  const companion = monsterArt('inklet', 3);

  return (
    <main className="product-app" aria-labelledby="setup-title">
      <Scene
        className="setup-scene"
        dusk
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
            {companion && <img src={companion} alt="" />}
            <p className="product-kicker">
              Today&apos;s quest<span aria-hidden="true" />
            </p>
            <h1 id="setup-title">{active.name}</h1>
            <p>{active.line}</p>
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
          </div>

          <div className="quest-tiles" role="group" aria-label="Choose a quest">
            {QUESTS.map((option) => (
              <button
                key={option.id}
                type="button"
                className="quest-tile press"
                aria-pressed={quest === option.id}
                onClick={() => setQuest(option.id)}
              >
                <span style={{ '--plate': artUrl(regionArt(REGION, option.plate)) }}>
                  <span className="quest-tile-art" aria-hidden="true" />
                  <span className="quest-tile-tint" aria-hidden="true" />
                  {quest === option.id && (
                    <span className="quest-tile-sheen" aria-hidden="true" />
                  )}
                  <span className="quest-tile-tag">{option.tag}</span>
                  <span className="quest-tile-name">{option.short}</span>
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="setup-tray">
          {/* The engine publishes the sets it can actually draw a round from.
              Until it publishes any, there is no rail: a set picker that
              cannot change what a round contains is a control that lies. */}
          {vocabularySets.length > 0 && (
            <>
              <p className="label">Vocabulary set</p>
              <div className="rail setup-pools">
                {vocabularySets.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className="pill press-soft press"
                    aria-pressed={effectiveYearFilter === option.id}
                    disabled={quest === 'test' && option.id !== 'core'}
                    onClick={() => setYearFilter(option.id)}
                  >
                    {option.label}
                    <span>{option.count} words</span>
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="setup-lengths">
            <p className="label">Round length</p>
            <div className="length-choice">
              {ROUND_LENGTHS.map((value) => (
                <button
                  key={value}
                  type="button"
                  className="press"
                  aria-pressed={effectiveLength === value}
                  disabled={quest === 'test' && value !== 20}
                  onClick={() => setLength(value)}
                >
                  <strong className="figure">{value}</strong>
                </button>
              ))}
            </div>
          </div>

          {audioState.status !== 'ready' && (
            <AudioStatus audioState={audioState} onRecover={onRecoverAudio} dusk />
          )}

          <button
            type="button"
            className="button-primary press"
            disabled={busy || audioState.status !== 'ready'}
            onClick={() => void onStart({
              length: effectiveLength,
              mode: quest,
              yearFilter: effectiveYearFilter,
            }).catch(() => undefined)}
          >
            {busy ? 'Preparing…' : (
              <>
                Set off
                <span aria-hidden="true" style={{ opacity: 0.4 }}>·</span>
                <span className="figure">{effectiveLength}</span>
                words
                <IconForward size={18} />
              </>
            )}
          </button>

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
  onSubmit,
  onContinue,
  onEnd,
  onPlaybackFailure,
}) {
  const [answer, setAnswer] = useState('');
  const [localError, setLocalError] = useState('');
  const [confirmExit, setConfirmExit] = useState(false);
  const [exitError, setExitError] = useState('');
  const [leaving, setLeaving] = useState(false);
  const advanceTimerRef = useRef(null);
  const closeExit = useCallback(() => {
    setExitError('');
    setConfirmExit(false);
  }, []);
  const practice = state.practice;
  const busy = state.status === 'saving';

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
    void play('sentence');
  // Autoplay exactly once for a newly projected card.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioRequest]);

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
  const answered = practice.awaitingAdvance;
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

          <section
            className="round-card"
            aria-labelledby="practice-title"
            aria-busy={busy}
          >
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
                  id="product-spelling-input"
                  name="spelling"
                  type="text"
                  value={answer}
                  placeholder="your spelling"
                  disabled={busy || answered}
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
                      ? (feedbackKind === 'success' ? '#2f9e6a' : '#d25757')
                      : undefined,
                  }}
                  onChange={(event) => setAnswer(event.target.value)}
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
          </footer>
        </div>

        {confirmExit && (
          <LeaveRoundDialog
            error={exitError}
            leaving={leaving || busy}
            onKeep={closeExit}
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
  onScreen,
  celebrationEvents = [],
  secureGain = 0,
  haptics,
  onCelebrationDone,
}) {
  const codex = useMemo(() => buildCodex(monsters), [monsters]);
  const hero = codex.hero;
  const accuracy = summary?.accuracy ?? 0;
  const total = summary?.totalWords ?? 0;
  const correct = summary?.correct ?? 0;
  const mistakes = (summary?.mistakes ?? []).map(mistakeWord).filter(Boolean);
  const clean = mistakes.length === 0;

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
          onDone={onCelebrationDone}
        />
        <div className="scene-body">
          <div className="results-halo">
            <p className="product-kicker">Expedition logged</p>
            {hero?.art && <img src={hero.art} alt={hero.name} />}
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
                  <span className="figure" style={{ color: '#1f7a4f' }}>{correct}</span>
                  <span className="label">correct</span>
                </div>
                <div>
                  <span className="figure" style={{ color: '#a2472a' }}>{mistakes.length}</span>
                  <span className="label">return</span>
                </div>
                <div>
                  <span className="figure" style={{ color: '#9e6a19' }}>{total}</span>
                  <span className="label">words walked</span>
                </div>
              </div>

              {clean ? (
                <p className="record-roll-clean body-copy">
                  Every word held on the first try.
                </p>
              ) : (
                <>
                  <p className="product-kicker" style={{ margin: '0.7rem 0 0.35rem' }}>
                    Coming back<span className="figure"> {mistakes.length}</span>
                  </p>
                  <ul className="record-roll">
                    {mistakes.map((word) => (
                      <li key={word} data-ok="false">
                        <strong>{word}</strong>
                        <span className="record-roll-rule" aria-hidden="true" />
                        <span className="record-roll-status">comes back</span>
                        <span className="record-roll-mark" aria-hidden="true">
                          <IconReturn size={12} />
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {hero && (
                <div className="record-growth">
                  <span>
                    <span className="record-growth-name">
                      <strong>{hero.displayName}</strong>
                      <span>{hero.stageLabel}</span>
                    </span>
                    <span className="record-growth-bars" aria-hidden="true">
                      {hero.pips.map((filled, index) => (
                        <span
                          // eslint-disable-next-line react/no-array-index-key
                          key={index}
                          data-filled={filled ? 'true' : 'false'}
                          data-latest={filled && index === hero.stage ? 'true' : 'false'}
                        />
                      ))}
                    </span>
                  </span>
                  <span className="record-growth-secure">
                    <span className="figure">{hero.secureCount}</span>
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
  // not events, so the difference is the event.
  const [celebrationEvents, setCelebrationEvents] = useState([]);
  const [secureGain, setSecureGain] = useState(0);
  const monstersAtRoundStartRef = useRef(null);
  const learningScreenRef = useRef(learningState.screen);
  const clearCelebrations = useCallback(() => setCelebrationEvents([]), []);

  useEffect(() => {
    const profileSubscription = services.controller.subscribe(setProfileState);
    const learningSubscription = services.learning.subscribe((next) => {
      const previousScreen = learningScreenRef.current;
      if (previousScreen !== 'practice' && next.screen === 'practice') {
        monstersAtRoundStartRef.current = next.monsters;
      }
      if (previousScreen !== 'summary' && next.screen === 'summary') {
        const before = monstersAtRoundStartRef.current ?? [];
        setCelebrationEvents(diffMonsterCelebrations(before, next.monsters));
        setSecureGain(secureWordDelta(before, next.monsters));
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
  const showScreen = (screen) => services.learning.showScreen(screen);
  const closeParent = () => {
    services.parent.lock();
    setParentOpen(false);
  };
  const filterCount = (id) =>
    bank.filters.find((option) => option.id === id)?.count ?? 0;

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

  if (switchOpen || learningState.screen === 'profiles' || !selectedProfile) {
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
        onRecoverAudio={recoverAudio}
        busy={learningState.status === 'saving'}
        dueCount={filterCount('due')}
        troubleCount={filterCount('trouble')}
        bankTotal={bank.total}
        vocabularySets={learningState.vocabularySets}
      />
    );
  }
  if (learningState.screen === 'practice') {
    return (
      <RoundScreen
        state={learningState}
        audioState={audioState}
        audio={services.audio}
        onSubmit={(typed) => services.learning.submitAnswer(typed)}
        onContinue={() => services.learning.continueRound()}
        onEnd={() => services.learning.endRound()}
        onPlaybackFailure={() =>
          services.audioAvailability.reportPlaybackFailure()}
      />
    );
  }
  if (learningState.screen === 'summary') {
    return (
      <ResultsScreen
        summary={learningState.summary}
        monsters={learningState.monsters}
        onScreen={showScreen}
        celebrationEvents={celebrationEvents}
        secureGain={secureGain}
        haptics={services.haptics}
        onCelebrationDone={clearCelebrations}
      />
    );
  }
  if (learningState.screen === 'progress') {
    return (
      <WordBankScreen
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
    return (
      <CampScreen
        camp={learningState.camp}
        revisitsWaiting={filterCount('due')}
        onScreen={showScreen}
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
