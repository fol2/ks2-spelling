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

Make the auxiliary post-commit step best-effort, in
`src/app/create-product-app-services.js:333-341`:

```javascript
afterImport: async () => {
  await profileStore.administration.promoteStarterCatalogue();
  await profileStore.administration.grantFullEntitlement();
  await controller.reload();
  // The progress summary is auxiliary and carries its own notice when a
  // refresh fails; a committed import must not be reported as failed
  // because of it.
  await parentProgress.refresh().catch(() => undefined);
},
```

The chain that produced the false report:
`repository.importBackup()`
(`src/platform/database/sqlite-learning-backup-repository.js:235-257`) owns its
transaction and has therefore already committed by the time it returns.
`src/app/parent-backup-service.js:248-252` then awaits the `afterImport`
callback before resolving, so any rejection inside `afterImport` rejects the
whole import promise. The app's `afterImport` ended with
`await parentProgress.refresh()` — an auxiliary recomputation of the parent
progress summary. When that refresh threw, the rejection reached the UI, whose
`runBackup` handler (`src/app/ProductApp.jsx:730-749`) has a single bare `catch`
rendering one fixed message that asserts a rollback the code never performs.

The fix restores a convention the codebase already used everywhere else: the
boot path (`src/app/create-product-app-services.js:303`) and the component mount
path (`src/app/ProductApp.jsx:3175`) both already ran the same refresh as
`void parentProgress.refresh().catch(() => undefined)`. The import path was the
outlier, not the innovation.

Implemented in PR #61, open and unmerged as of this writing.

## Why This Works

The progress refresh owns an accurate failure surface of its own:
`src/app/ProductApp.jsx:571` renders "Progress could not be checked. Saved
learning was not changed." Swallowing the rejection inside `afterImport`
therefore costs the user no information — the stale summary still announces
itself — while removing a false rollback claim made over data that was
committed.

Two honest caveats:

- **Why the refresh threw was never root-caused.** The suspicion is that the
  fixture's minimal progress rows, carrying only `{stage: 4}`, tripped the parent
  projection. That question is independent of the defect: whatever made the
  refresh fail, it should never have been able to report a committed import as
  failed.
- **The fix trades observability for a truthful claim.** `.catch(() =>
  undefined)` discards the underlying error rather than surfacing it (session
  history — noted by the security review of this diff). That trade is acceptable
  only because the refresh has its own user-visible notice; a post-commit step
  with no notice of its own should be logged rather than silently swallowed.

## Prevention

1. **Post-commit work is best-effort by nature.** Once a transaction commits, no
   later step in the same promise chain may reject the operation unless the
   operation can genuinely be undone. Either await that work with
   `.catch(() => undefined)`, or stop claiming a rollback in the failure copy.
2. **Failure copy is a factual claim, not an apology.** "No learning was
   replaced" asserts a rollback. A single bare `catch` rendering one fixed
   message across every reachable failure mode will eventually lie. Narrow the
   catch to the phase that can actually roll back, or write copy that stays true
   on every path that reaches it.
3. **Two notices on one screen are a signal, not noise.** The second banner
   named the failing step and exposed the first as false. When two independent
   failure surfaces light up together, read the quieter one first.
4. **Two sibling call sites still carry this shape** at the time of writing, and
   are not addressed by this fix:
   - `src/app/ProductApp.jsx:3247-3250` — `onRemoveProfile` awaits
     `services.controller.removeProfile(learnerId)` and then
     `await services.parentProgress.refresh()`. Its handler
     (`src/app/ProductApp.jsx:334-343`) reports "That learner was not deleted.
     Please try again."
   - `src/app/create-product-app-services.js:311-318` —
     `parentAdministration.resetLearning` awaits the reset and then
     `await parentProgress.refresh()`. Its handler
     (`src/app/ProductApp.jsx:346-359`) reports "That learning was not reset.
     Please try again."

   Both would misreport a committed mutation exactly as the import path did, and
   both are destructive operations where a false "it did not happen" is worse
   than a false "it did".

## Related Issues

- PR #61 (`agent/polish-phaser-guardian`) carries the fix alongside the wider
  polish pass; `reports/polish-verification.md` records the on-device evidence.
- `docs/solutions/workflow-issues/gating-physical-ios-installs-on-application-composition.md`
  covers the other side of the same boundary: how to prove learner SQLite data
  survived a native install, using a pre-install backup, `PRAGMA quick_check`
  and a before/after comparison. This learning is the complementary rule for
  what the app may *claim* about that data once a write has committed.
