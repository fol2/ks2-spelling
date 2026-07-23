import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
          className="button-quiet"
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
          className="button-quiet"
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
                  className="button-quiet"
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
            <p className="parent-backup-warning">
              Import replaces every learner and learning snapshot on this
              device. The Parent PIN, purchases and installed packs stay
              unchanged.
            </p>
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
      .then(() => setNickname(''))
      .catch(() => undefined);
  }

  return (
    <main className="product-app product-page" aria-labelledby="profile-title">
      <ProductTopBar
        action={(
          <button type="button" className="topbar-action" onClick={onOpenParent}>
            For parents
          </button>
        )}
      />
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
  actionError,
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
          onClick={() => void onStart(length).catch(() => undefined)}
        >
          {busy ? 'Preparing…' : 'Start trail'}
        </button>
        {actionError && (
          <p className="inline-error" role="alert">
            That trail could not start. Please try again.
          </p>
        )}
      </section>
    </main>
  );
}

export function LeaveRoundDialog({ onKeep, onLeave }) {
  const keepButton = useRef(null);
  const leaveButton = useRef(null);

  useEffect(() => {
    const previousFocus = document.activeElement;
    const handleKeyDown = (event) => {
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
      aria-describedby="leave-round-description"
    >
      <div>
        <h2 id="leave-round-title">Leave this round?</h2>
        <p id="leave-round-description">
          Your earlier saved learning stays safe. This round will be marked unfinished.
        </p>
        <div>
          <button
            ref={keepButton}
            type="button"
            className="button-quiet"
            onClick={onKeep}
          >
            Keep practising
          </button>
          <button
            ref={leaveButton}
            type="button"
            className="button-danger"
            onClick={onLeave}
          >
            Leave round
          </button>
        </div>
      </div>
    </section>
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
  const closeExit = useCallback(() => setConfirmExit(false), []);
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
    try {
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
    } catch {
      setLocalError('That answer did not save. Please try again.');
    }
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
        <LeaveRoundDialog onKeep={closeExit} onLeave={onEnd} />
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

function ProgressScreen({ progress, onBack, onStart }) {
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
          <button type="button" className="button-primary" onClick={onStart}>
            Start a Smart Review
          </button>
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
  const [voiceId, setVoiceId] = useState('Iapetus');

  useEffect(() => {
    const profileSubscription = services.controller.subscribe(setProfileState);
    const learningSubscription = services.learning.subscribe(setLearningState);
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
      <main className="product-app product-page">
        <ProductTopBar />
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
        voiceId={voiceId}
        onVoice={setVoiceId}
        onStart={(length) => services.learning.startSmartRound({ length })}
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
        onStart={() => showScreen('setup')}
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
