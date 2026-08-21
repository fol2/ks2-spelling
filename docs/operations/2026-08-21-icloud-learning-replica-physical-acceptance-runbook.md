---
module: operations
tags:
  - icloud
  - store-release
  - physical-device
  - cloudkit
problem_type: operating-procedure
---

# iCloud learning replica: signed-RC physical and store acceptance

Dated 2026-08-21. Written for
[iCloud learning replica — CloudKit private database](https://github.com/fol2/ks2-spelling/issues/199).
Owner decision on this work order: **#199 complete before
[#201](https://github.com/fol2/ks2-spelling/issues/201)**. This document is the checklist, not the walk evidence.

Native iOS product composition already starts the private-CloudKit replica
(`createCapacitorICloudLearningReplica` → `startICloudLearningReplica` on
`runtime.isNativePlatform`). Privacy notice, kids-category position and
parent-data already describe that replica. Those facts are **source
composition**. They are not physical two-device proof, not signed-artefact
proof, and not an App Store Connect label confirmation.

Do not fabricate or pre-create a success record. Until the owner records the
walk below against a **signed physical RC**, the #199 gate stays red.

## Who moves

| Role | Moves |
|---|---|
| **Owner** | Every cell on a signed production-channel RC. Archive identity pairing. `codesign` read of the signed `.app`. App Store Connect App Privacy read-back. Dated evidence record. |
| **Never this document** | Keychain, certificates, provisioning profiles, signing keys, CloudKit record inspection, Apple-account login, live `asc` mutation, an unsigned Simulator build passed off as the RC, a Sandbox-scheme archive passed off as the RC. |

This walk is **owner-gated**.

## Lanes these cells are not

Keep these five lanes distinct. A green result in one lane is not evidence
for another.

| Lane | What it can prove | What it cannot prove |
|---|---|---|
| unsigned Simulator build | Source compiles; the plugin degrades when the running process has no named-container entitlement | Named-container entitlement on a distribution binary; CloudKit runtime merge; store privacy |
| signed physical RC | A `KS2Spelling` / `Release` archive installed on hardware, with distribution entitlements | Two-device convergence; ASC questionnaire |
| CloudKit container configuration | Portal/profile lists `iCloud.uk.eugnel.ks2spelling` | That this RC's signed blob carries it; that two devices merged |
| runtime convergence | Two physical devices on the same iCloud account actually merged learner progress | The signed entitlement dump; the ASC label |
| ASC label confirmation | App Store Connect App Privacy currently reads Data Not Collected | Binary behaviour or CloudKit merge |

A signed physical RC is not an unsigned Simulator build.
Unsigned Simulator compile is not signed-RC named-container evidence.
Portal CloudKit container configuration is not runtime convergence.
Runtime convergence is not an ASC App Privacy label confirmation.

## Artefact under test

Stop unless every identity token below is the same artefact:

1. git SHA of `main` (or the RC commit that will be submitted).
2. `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` committed in
   `project.pbxproj` — not an `xcodebuild` override.
3. Archive from `scripts/testflight-upload.sh`, scheme KS2Spelling,
   configuration Release.
4. Store `uploadedDate` paired with the local archive path mtime (the
   14 August rule in the submission-day runbook). The paired record's
   ASC build id is the only id used from here on.
5. Physical install is that TestFlight/App Store build after delete-and-
   reinstall. `devicectl device info apps` is a label read, not this probe.

A new binary is a full re-walk. Sandbox-scheme, B4Development, and unsigned
Simulator builds are the wrong artefact.

## Cells

Walk in order. A red cell stops the day. Record pass/fail per cell with the
evidence fields below. Do not skip ahead and do not “fix” identity by using
the build number you intended.

### Cell 1 — Same-iCloud-account two-device convergence

**Setup.** Two physical Apple devices (an iPhone and an iPad is the intended
pair) signed into the **same iCloud account**. Both run the signed RC.
Device A holds the Full KS2 StoreKit entitlement and the installed pack.
Device B may be entitled or not; this cell only cares that progress
converges.

**Action.**

1. On device A, add or select one learner. Practise until one Starter word
   is secured (the word bank shows it as secured).
2. Leave device A. On device B, force-quit, relaunch, and open the same
   learner.
3. Wait through the launch pull. If the learner or the secured word is
   missing, force-quit and relaunch once more. There is no child-facing
   “sync now” control; relaunch is the pull.

**Pass.** Device B shows that learner and the secured word without a file
import. Selected learner on B must not have been overwritten by A's
selection if the parent had a different child selected on B.

**Stop if** B never shows the secured word, or a learning-backup file path
reappears.

### Cell 2 — StoreKit entitlement separate from iCloud identity

**Setup.** Same iCloud account on A and B. Device A is StoreKit-entitled
for `uk.eugnel.ks2spelling.fullks2`. Device B has **never** purchased and
must **not** Restore purchases for this cell. iCloud identity and the
StoreKit sandbox/store account are allowed to differ; that is the point.

**Action.** After cell 1 (or a Full-catalogue practise on A), relaunch B.
Inspect B's word bank / pack size.

**Pass.** B stays on the 20-word Starter catalogue. A's Full KS2 StoreKit
entitlement did not travel through iCloud. StoreKit entitlement state is
device-local; iCloud carries learner profiles and snapshots only.

**Stop if** B's working catalogue becomes Full because the replica arrived.

### Cell 3 — Never-entitled device receiving Full history stays on Starter and parks preserved-full-learning-v1:{learnerId}

**Setup.** Device A entitled, Full pack installed, at least one non-Starter
word practised. Device B never entitled, same iCloud account, same learner.

**Action.**

1. Relaunch B. Confirm the working catalogue is Starter.
2. On B, purchase Full KS2, download the pack if offered, tap **Use the
   full word list now**, relaunch.
3. Confirm the Full word practised on A is still secured on B.

**Pass.** Before purchase, B stays on Starter. After purchase, the parked
Full history returns (same stages), which is the behavioural proof of
`preserved-full-learning-v1:{learnerId}`. Do not inspect CloudKit records
or the keychain to “see” the park key.

**Stop if** B raised onto Full before purchase, or the Full history was
gone after purchase (a reset, not a park).

### Cell 4 — Two devices practise offline concurrently and reconnect without losing a secured word

**Setup.** Both devices have the replica available (cell 1 already
converged). Same learner.

**Action.**

1. Enable Airplane Mode on both devices.
2. On device A, secure word X. On device B, secure a **different** word Y
   for the same learner. Do not practise the same word on both.
3. Disable Airplane Mode. Force-quit and relaunch both. Confirm relaunch
   and pull visibility of both words.

**Pass.** After reconnect, both devices show X and Y secured. Per-item
merge kept both. Whole-snapshot last-writer-wins would fail this cell.

**Stop if** either secured word disappeared.

### Cell 5 — Relaunch/pull visibility

**Setup.** Replica available. Device A will publish; device B is left in
the background or force-quit.

**Action.** Secure a fresh word on A. Do not touch B until A has returned
to the word bank. Then relaunch B.

**Pass.** B shows the new secured word after relaunch/pull. If B was left
in the foreground without a relaunch, a miss is not a fail of this cell;
relaunch is the specified pull. Record whether a backgrounded B updated
without relaunch as an observation, not as a pass requirement.

**Stop if** a relaunch on B still lacks the word after a second relaunch
and several minutes.

### Cell 6 — iCloud sign-out degrades local-only with no child-facing nag

**Setup.** Device B has local learning from earlier cells.

**Action.** Sign out of iCloud on device B (Settings → Apple ID → Sign
Out). Launch the app. Walk a child surface (Who is practising?, a round).
Open the Parent area only after the PIN gate.

**Pass.** The app stays usable locally. No child-facing sign-in nag: no
“Sign in to iCloud”, no iCloud banner, no blocking sheet on child
surfaces. Parent-area copy must not send the child to Settings either.
Local SQLite remains the source of truth.

**Stop if** a child surface nags for iCloud, or local learning is wiped by
sign-out.

### Cell 7 — Signed RC contains named-container entitlement

**Setup.** The signed `.app` inside the paired archive, not
`ios/App/App/App.entitlements` in the worktree, not a Simulator
`Debug-iphonesimulator` bundle.

**Action.** On the archive the store `uploadedDate` paired:

```sh
codesign --display --entitlements - \
  "<archive>/Products/Applications/App.app"
```

**Pass.** The signed entitlements list
`com.apple.developer.icloud-container-identifiers` containing
`iCloud.uk.eugnel.ks2spelling`, and `com.apple.developer.icloud-services`
containing `CloudKit`. This is **named-container entitlement** on the
signed physical RC.

**Stop if** the identifier is missing, is `iCloud.uk.eugnel.ks2spelling`
only in source, or the dump came from an unsigned Simulator build.

### Cell 8 — ASC App Privacy Data Not Collected read-back

**Setup.** Owner in App Store Connect, app `6798866142`. This cell is a
store-console read. It is not runtime convergence and not the privacy
markdown.

**Action.** Open App Privacy. Read the current nutrition-label answers.

**Pass.** The console reads **Data Not Collected**. Record the read-back
date and that the owner, not an agent session, performed it. Private
CloudKit plus disabled Worker `invocation_logs` is the argument; the
read-back is the store fact.

**Stop if** the console collects any data type, or this cell is filled
from `docs/legal/privacy-notice.md` without opening App Store Connect.

## Evidence record format

Write the walk to:

`docs/records/<YYYY-MM-DD>-icloud-learning-replica-physical-acceptance.md`

Do not create that file until the owner walk has actually run. A
source-controlled template is not a pass. Follow the freeze-record shape
in `AGENTS.md`: Status line, `## Evidence`, `## Remaining gates`, and an
explicit closing statement of what the record does not grant.

Required frontmatter:

```yaml
---
module: icloud-learning-replica
tags:
  - freeze-record
  - physical-acceptance
  - issue-199
problem_type: freeze-record
---
```

Required title: `iCloud learning replica physical/store acceptance — <YYYY-MM-DD>`.

Required Status line:

```
Status: <unrecorded|RED|GREEN> at <full git SHA>
```

A GREEN verdict is allowed only in that dated record after every cell
below is PASS. This runbook must stay unrecorded and must not itself
carry a GREEN verdict.

### Exact evidence fields

The record's `## Evidence` section must contain every field:

| Field | What to write |
|---|---|
| git SHA | Full SHA of the artefact, not a short hash. |
| MARKETING_VERSION | From the archive `Info.plist`. |
| CURRENT_PROJECT_VERSION | From the archive `Info.plist`. |
| archive path | Local `.xcarchive` path. |
| store uploadedDate | ASC timestamp, one timezone with the archive mtime. |
| ASC build id | From that pairing, never from memory. |
| scheme KS2Spelling | Confirm the archive scheme. |
| configuration Release | Confirm the archive configuration. |
| Device A | Model, iOS version, device name or UDID suffix. |
| Device B | Model, iOS version, device name or UDID suffix. |
| same iCloud account | Yes/no. Do **not** write the Apple ID into the repository. |
| StoreKit entitlement state | Which device holds `uk.eugnel.ks2spelling.fullks2`; confirm it did not travel with iCloud. |
| named-container entitlement | Paste the signed `codesign --display --entitlements` excerpt showing `iCloud.uk.eugnel.ks2spelling`. |
| ASC App Privacy | Date of read-back; **Data Not Collected**; reader is the owner. |
| Cells 1–8 | Each cell: PASS or FAIL, observations, timestamp. |

Then:

```
## Remaining gates
```

List anything still red, including #201 if this record is not GREEN.

Closing paragraph (required), using the words **does not grant**: this
record does not grant store approval, does not close #199 by itself
until the owner says so on the issue, does not authorise #201 to skip
Phase A, and does not claim an unsigned Simulator build, portal
container configuration, or source-only composition as physical proof.

## Current status of this gate

No dated evidence record exists. Physical proof is unrecorded. Source
composition, unsigned Simulator compile, and the 2026-08-18 named
container minting are narrower facts. They do not pass this checklist.
