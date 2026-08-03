---
title: Keeping a committed backup import from being reported as failed
date: 2026-07-31
category: logic-errors
module: parent-backup-import
problem_type: logic_error
component: service_object
symptoms:
  - "Parent area reports that the backup did not complete and no learning was replaced, after an import that had already committed"
  - "A second banner on the same screen reports that progress could not be checked"
  - "sqlite3 inspection of the device database shows the imported profile, snapshot and selected-learner rows all present"
  - "Relaunching the app shows the imported learner despite the failure notice"
root_cause: logic_error
resolution_type: code_fix
severity: high
related_components:
  - "product_ui"
  - "database"
  - "parent_progress"
tags:
  - "backup-import"
  - "post-commit"
  - "error-propagation"
  - "transaction-boundary"
  - "failure-copy"
  - "parent-area"
  - "sqlite"
---

# Keeping a committed backup import from being reported as failed

## Problem

A learning backup import succeeded at the database level — the learner profile
was written, the snapshot persisted, and the selected-learner row pointed at it
— yet the Parent area reported the operation as failed and rolled back: "The
backup did not complete. No learning was replaced." Both halves of that claim
were false. The import had completed, and every learner in the store had in
fact been replaced.

## Symptoms

Importing a pre-generated learning backup (built by
`scripts/dev/make-all-mega-backup.mjs`) through Parent area → Import, during
Guardian mode verification on the iOS 26.5 simulator, produced two banners at
once:

1. "The backup did not complete. No learning was replaced."
2. "Progress could not be checked. Saved learning was not changed."

Both stayed on screen after the import had demonstrably committed.

## What Didn't Work

1. **Assuming the transaction had rolled back.** Direct `sqlite3` inspection of
   the on-device database showed the `mega-tester` profile row, its ~12KB
   snapshot row, and the selected-learner pointer all present. Ruled out by
   database state.
2. **Assuming the backup file was malformed.** The generator round-trips its own
   output through `codec.decode()` before writing
   (`scripts/dev/make-all-mega-backup.mjs:50`), and a local reproduction driving
   the same repository code path with the same file succeeded and returned the
   expected result.
3. **Suspecting the codec's exact-key snapshot validation was rejecting the
   fixture.** The same successful local reproduction ruled this out too.
4. **Reading the first banner alone.** The second banner was the breakthrough.
   "Progress could not be checked" names a step that runs *after* the repository
   import, which located the failure in post-commit work rather than in the
   import.

## Solution

Separate required post-commit work from the best-effort progress refresh in the
`afterImport` callback in `src/app/create-product-app-services.js`:

```javascript
afterImport: async () => {
  await runPostCommit(async () => {
    await profileStore.administration.promoteStarterCatalogue();
    await profileStore.administration.grantFullEntitlement();
    await controller.reload();
  });
  // The progress summary is auxiliary and carries its own notice when a
  // refresh fails; a committed import must not be reported as failed
  // because of it.
  await parentProgress.refresh().catch(() => undefined);
},
```

The chain that produced the false report:
`repository.importBackup()`
(`src/platform/database/sqlite-learning-backup-repository.js:235-261`) owns its
transaction and has therefore already committed by the time it returns.
`src/app/parent-backup-service.js:250-253` then awaits the `afterImport`
callback before resolving, so any rejection inside `afterImport` rejects the
whole import promise. The app's `afterImport` ended with
`await parentProgress.refresh()` — an auxiliary recomputation of the parent
progress summary. When that refresh threw, the rejection reached the UI, whose
`runBackup` handler (`src/app/ProductApp.jsx:745-772`) had a single bare `catch`
rendering one fixed message that asserts a rollback the code never performs.

The fix restores a convention the codebase already used everywhere else: the
boot path (`src/app/create-product-app-services.js:319`) and the component mount
path (`src/app/ProductApp.jsx:3290`) both already ran the same refresh as
`void parentProgress.refresh().catch(() => undefined)`. The import path was the
outlier, not the innovation.

Shipped in PR #61; the two sibling sites and the contract test followed
immediately after.

## Why This Works

The progress refresh owns an accurate failure surface of its own:
`src/app/ProductApp.jsx:586` renders "Progress could not be checked. Saved
learning was not changed." Swallowing the rejection inside `afterImport`
therefore costs the user no information — the stale summary still announces
itself — while removing a false rollback claim made over data that was
committed.

Two honest caveats:

- **Why the refresh threw was not root-caused here — it was root-caused the next
  day.** The suspicion recorded at the time was that the fixture's minimal
  progress rows, carrying only `{stage: 4}`, tripped the parent projection. It
  was confirmed on 1 August: the projection summed `attempts`/`correct`/`wrong`
  raw, one sparse entry folded `NaN` into the totals, and the engine's redaction
  walk rejected the whole projection. The fix and the fixture rule behind it are
  in
  `docs/solutions/logic-errors/test-doubles-that-accept-more-than-the-contract.md`.
  The question was always independent of the defect recorded here: whatever made
  the refresh fail, it should never have been able to report a committed import
  as failed.
- **The fix trades observability for a truthful claim.** `.catch(() =>
  undefined)` discards the underlying error rather than surfacing it (session
  history — noted by the security review of this diff). That trade is acceptable
  only because the refresh has its own user-visible notice; a post-commit step
  with no notice of its own should be logged rather than silently swallowed.

## Prevention

1. **Post-commit work needs an explicit treatment.** Once a transaction commits,
   swallow an auxiliary or self-healing epilogue with `.catch(() => undefined)`.
   If the UI must keep the operation open for recovery, re-throw an error stamped
   `postCommit: true` and report that the mutation completed but refresh failed.
2. **Failure copy is a factual claim, not an apology.** "No learning was
   replaced" asserts a rollback. A single bare `catch` rendering one fixed
   message across every reachable failure mode will eventually lie. Narrow the
   catch to the phase that can actually roll back, or write copy that stays true
   on every path that reaches it.
3. **Two notices on one screen are a signal, not noise.** The second banner
   named the failing step and exposed the first as false. When two independent
   failure surfaces light up together, read the quieter one first.
4. **Sweep the whole class, not just the reported site.** The complete five-site
   matrix is:
   - `createProfile`: swallow selected-learner alignment because the new row is
     committed and creation does not change the selection.
   - `selectProfile`: typed re-throw from alignment, because swallowing would
     close the switch sheet on the wrong learner instead of allowing a retry.
   - `removeProfile`: swallow alignment and the auxiliary progress refresh;
     the committed removal self-heals through the profile-selection screen.
   - `parentAdministration.resetLearning`: typed re-throw from the active
     learner reload, then swallow the auxiliary progress refresh.
   - backup `afterImport`: typed re-throw from catalogue promotion, entitlement
     grant or controller reload, then swallow the auxiliary progress refresh.

   The two affected UI catch blocks now select truthful copy:
   - "The backup was imported, but this screen could not refresh. Close and reopen the app."
   - "That learning was reset, but the app could not refresh the view. Close and reopen the app."

   The rule is enforced rather than remembered:
   `tests/post-commit-refresh-tolerance.test.mjs` fails if any awaited
   parent-progress refresh loses its `.catch(...)`. The same test pins the
   opposite case — the standalone "check progress" action must keep surfacing
   its own failure, because there the refresh is the whole operation rather
   than an epilogue to one. `tests/post-commit-honesty.test.mjs` is the
   behavioural half: it boots the real service graph over `node:sqlite`, arms an
   SQL-level failure at each of the five sites, and asserts both the `postCommit`
   marker and the truthful UI copy — plus a pre-commit control that must still
   roll back.

## Related Issues

- PR #61 carried the fix alongside the wider polish pass;
  `reports/polish-verification.md` records the on-device evidence.
- `docs/solutions/workflow-issues/gating-physical-ios-installs-on-application-composition.md`
  covers the other side of the same boundary: how to prove learner SQLite data
  survived a native install, using a pre-install backup, `PRAGMA quick_check`
  and a before/after comparison. This learning is the complementary rule for
  what the app may *claim* about that data once a write has committed.
- `docs/solutions/integration-issues/capacitor-sqlite-value-less-dml-executes-as-a-no-op.md`
  — the same import one layer down: on iOS the replace-all DELETE this record
  assumes had committed was deleting nothing at all.
- `docs/solutions/logic-errors/test-doubles-that-accept-more-than-the-contract.md`
  — root-causes the progress refresh this record could only swallow.
