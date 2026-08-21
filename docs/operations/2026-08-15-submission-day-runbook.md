---
module: operations
tags:
  - store-release
  - app-store-connect
  - testflight
problem_type: operating-procedure
---

# Submission day: the release runbook that walks Spelling Camp into review

Dated 2026-08-15. Resolves
[Submission day — the release runbook that walks the app into review](https://github.com/fol2/ks2-spelling/issues/171).
The first end-to-end execution of this document *is* the submission. Do not
improvise beside it.

This is a wizard: every step names who moves, the check that must already be
true, the action, the evidence that the step happened, and the stop. A red
check stops the day. It does not get worked around in a scratchpad.

## Decisions this ticket locks

1. **The submitted artefact is a production-channel Release Candidate.**
   Vite production mode (`npm run build`, no `--mode`) paired with the
   `KS2Spelling` scheme / `Release` configuration. That is what
   `scripts/testflight-upload.sh` already archives. TestFlight IAP is always
   Apple's Sandbox environment; the production gateway branches on Apple's
   signed `environment` field and accepts it ([#143](https://github.com/fol2/ks2-spelling/issues/143),
   [#145](https://github.com/fol2/ks2-spelling/issues/145)). There is no
   launch-day flip and no Sandbox-scheme binary in the submission.
2. **The tested TestFlight build is byte-identical to the submitted one.**
   Same git SHA, same archive, same App Store Connect build record. The
   runbook carries that as a check (SHA, build number, archive path, store
   `uploadedDate`), not a hope.
3. **Drive the repository's upload script. Do not track a second
   `ExportOptions.plist`.** The 14 August incident
   (`docs/solutions/workflow-issues/store-renumbering-the-build-makes-every-verification-layer-test-the-wrong-binary.md`)
   was a hand-written plist with `manageAppVersionAndBuildNumber: true`. The
   script has written that key as `<false/>` since `29db0139`. A tracked
   sibling plist would recreate the defect. Identity of a build is the pairing
   of the store's `uploadedDate` against the local archive's mtime, never the
   build number alone.
4. **First store version is `1.0.0`.** The shipping `CURRENT_PROJECT_VERSION`
   is committed in `project.pbxproj` before archive — max existing App Store
   Connect build number plus one. The script refuses an archive-time override.
5. **First non-consumable IAP ships in the same submission as 1.0.0.**
   `uk.eugnel.ks2spelling.fullks2` (£9.99). Apple requires the first item of
   each IAP type to travel with a new app version
   ([Submit an In-App Purchase](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-an-in-app-purchase)).
6. **Store-console actions stay agent-executable**, with two named exceptions:
   the export-compliance questionnaire (owner's declaration in their name,
   [#76](https://github.com/fol2/ks2-spelling/issues/76) / [#94](https://github.com/fol2/ks2-spelling/issues/94)),
   and the first-IAP version-attach if the public API returns
   `FIRST_IAP_MUST_BE_SUBMITTED_ON_VERSION` (owner web UI, one tap). Live
   Cloudflare and signing-key material remain owner-gated and are *not* this
   day's work — they are Sitting 2 of
   [#156](https://github.com/fol2/ks2-spelling/issues/156), a hard stop below.
7. **First version releases to all available territories on approval.** Phased
   release is an update-only control; it is not used on 1.0.0.
8. **Gap 1 ([#140](https://github.com/fol2/ks2-spelling/issues/140)) is a hard
   stop.** The Kids Category position already names trust-on-first-use as a
   plausible Guideline 1.3 rejection. Submitting into a known 1.3 hole is not
   walking this map's destination. The reviewer notes below describe the gate
   that actually ships; they are rewritten in one pass if #140 changes the
   first-run challenge.
9. **#199 complete before #201.**
   ([#199](https://github.com/fol2/ks2-spelling/issues/199) before
   [#201](https://github.com/fol2/ks2-spelling/issues/201).) Owner decision
   2026-08-21. Native runtime already composes the private-CloudKit replica
   (PR #228 / #277). The 15 August line that treated the replica as
   post-listing, with v1 shipping neither the backup file nor the replica, is
   stale source. Physical and store evidence remains unrecorded: this gate
   is red until the owner dated record exists, and source composition is
   not that record.

## Who moves

| Role | Moves |
|---|---|
| **Agent** | Every App Store Connect API step, the archive/upload script, identity pairing, reviewer-notes paste, IAP attach attempt, submit, rejection replies that are metadata. |
| **Owner** | Sitting 2 (already done before this day). Export-compliance questionnaire. First-IAP web-UI attach if the API refuses. Device acceptance of the RC on a physical iPhone. Two-device iCloud physical/store acceptance of the signed RC ([#199](https://github.com/fol2/ks2-spelling/issues/199)). Any hard-stop waiver, written on #171. |
| **Never this document** | Minting keys, `wrangler deploy`, R2 writes, ad-hoc `xcodebuild` from a scratch plist, a Sandbox-scheme archive passed off as the RC. |

ASC key already provisioned: `NA8CPX2ZL2`, issuer
`86050c03-0021-426c-8c9a-70965f016e81`, app id `6798866142`, bundle
`uk.eugnel.ks2spelling`, team `V45S7U2LZB`. Export the env vars; do not
prompt for the `.p8`.

## Go / no-go

Print this list at the start of the day. Every hard stop must be green.
Waivers are written on #171 *before* step B1, not invented at the submit
button.

### Hard stops

| Gate | Evidence |
|---|---|
| Sitting 2 complete | Production signing key in the keyring (`testOnly: false`, `allowedEnvironments: ["production"]`); 15 production-signed manifests on the production R2 bucket; production Worker live at `https://ks2-gateway.eugnel.uk`; dual-environment Apple verifier on that Worker ([#143](https://github.com/fol2/ks2-spelling/issues/143) / [#156](https://github.com/fol2/ks2-spelling/issues/156) / [#157](https://github.com/fol2/ks2-spelling/issues/157)). |
| Origin family cutover merged | [#169](https://github.com/fol2/ks2-spelling/issues/169) closed; production artefact contains `ks2-gateway.eugnel.uk` and none of `b3-gateway.eugnel.uk`, `b3-test-p256-2026-07`, `b3-sandbox-proof` ([#145](https://github.com/fol2/ks2-spelling/issues/145) B3.1). |
| Production observability | Same confirmation as `docs/operations/gateway-observability-confirmation.md`, against the **production** Worker script, not the sandbox one. `invocation_logs: false`. App Privacy "Data Not Collected" is only true after this. |
| `help.eugnel.uk` live | `https://help.eugnel.uk/` and `https://help.eugnel.uk/privacy` return the single-sourced pages ([#139](https://github.com/fol2/ks2-spelling/issues/139) / [#172](https://github.com/fol2/ks2-spelling/issues/172)). Apple version-gates both URLs. Owner wizard: `node scripts/deploy-help-site.mjs` (`--dry-run`; live Cloudflare needs `HELP_SITE_EXECUTE=owner --execute`). |
| Listing copy landed | [`docs/product/store-listing.md`](https://github.com/fol2/ks2-spelling/issues/144) exists; every claim cites shipped behaviour; subtitle and keywords carry KS2; name is already **Spelling Camp** ([#170](https://github.com/fol2/ks2-spelling/issues/170)). |
| Submission hygiene | [#160](https://github.com/fol2/ks2-spelling/issues/160) merged (Firebase hook gone, StoreKit test config not in the Release resources, app-target `PrivacyInfo.xcprivacy` present, no-link-out test green). |
| Parental-gate lifecycle | [#140](https://github.com/fol2/ks2-spelling/issues/140) closed and the adult-challenge that closed it is in the RC. |
| Floor iPad first launch | [#185](https://github.com/fol2/ks2-spelling/issues/185) closed, or reproduced-fixed on iPad 8: first activation after install paints, not a black screen. App Review uses iPads. |
| In-app privacy notice | [#159](https://github.com/fol2/ks2-spelling/issues/159) in the RC (PR #184 already merged; close the issue if it is still open). |
| IAP ready | `uk.eugnel.ks2spelling.fullks2` is `READY_TO_SUBMIT`: en-GB localisation, review screenshot, availability, £9.99 GBR. |
| Learning backup gone from the RC | [#198](https://github.com/fol2/ks2-spelling/issues/198) closed ([Progress lives in iCloud](https://github.com/fol2/ks2-spelling/issues/187)). Parent area has no Export / Import learning backup; both native backup plugins are unregistered. Gap 5's unsigned import path is closed by deletion. |
| iCloud learning replica physical/store evidence | [#199](https://github.com/fol2/ks2-spelling/issues/199) is a hard stop for [#201](https://github.com/fol2/ks2-spelling/issues/201) until the owner records signed-RC physical/store evidence in `docs/records/<YYYY-MM-DD>-icloud-learning-replica-physical-acceptance.md` per [`docs/operations/2026-08-21-icloud-learning-replica-physical-acceptance-runbook.md`](./2026-08-21-icloud-learning-replica-physical-acceptance-runbook.md). Native runtime already composes the private-CloudKit replica. Unsigned Simulator compile is not this gate. Portal CloudKit container configuration is not this gate. Runtime convergence and the ASC Data Not Collected read-back remain unrecorded. |
| Tree and CI | The RC SHA is on `main`, worktree clean, the three-job B4 workflow green on that SHA. |
| Channel pairing | `scripts/testflight-upload.sh` still archives `SCHEME=KS2Spelling` / `CONFIGURATION=Release`. A Sandbox-scheme archive is the wrong artefact. |

Sandbox device acceptance ([#133](https://github.com/fol2/ks2-spelling/issues/133))
already passed. That evidence is the *sandbox channel*. It does not stand in
for Phase D on this RC.

### Not a hard stop

- Felt-quality Batch 0 ([#151](https://github.com/fol2/ks2-spelling/issues/151))
  and the floor-device matrix ([#152](https://github.com/fol2/ks2-spelling/issues/152)):
  the bar may embarrass; it does not block a listing. Record the baseline
  state in the day's notes. #185 is the separate, blocking first-launch defect.
- E0.3 Dependabot and E0.4 merge-queue ([#90](https://github.com/fol2/ks2-spelling/issues/90)):
  repository governance, not a store gate. Nightly-green is already covered
  by "three-job B4 green on the RC SHA".

## The walk

### Phase A — confirm the hard stops

**A1. Agent.** Re-read the hard-stop table against live evidence (issue state,
`dig` / `curl` of the two public hosts, `asc` IAP state, CI run URL, and
whether a dated `docs/records/<YYYY-MM-DD>-icloud-learning-replica-physical-acceptance.md`
exists on this RC SHA). Unsigned Simulator compile, portal CloudKit
container configuration and source composition are not that record. Paste
the table into a comment on #171 with pass/fail per row.

**Stop if** any hard stop is red.

### Phase B — cut the RC

**B1. Agent.** Read the highest App Store Connect build number:

```sh
asc builds list --app 6798866142 --sort -uploadedDate --limit 20 --pretty
```

Commit on `main`, in one commit, `MARKETING_VERSION = 1.0.0` and
`CURRENT_PROJECT_VERSION = <max+1>` for every App target configuration the
script's `verify_project_version` greps. Do not pass the number as an
`xcodebuild` override.

**B2. Agent.** From a clean `main` at that SHA:

```sh
scripts/testflight-upload.sh --version 1.0.0 --build <N> --wait-for-valid
```

Honour `DEVELOPER_DIR` (the script pins Xcode 26.6 RC; Apple rejects beta
SDKs). The script: refuses a dirty tree; generates the plist with
`manageAppVersionAndBuildNumber: false`; builds product web assets in a
detached worktree; archives `KS2Spelling` / `Release`; uploads.

**Forbidden.** A hand-written `ExportOptions.plist`. `-scheme Sandbox`.
`CURRENT_PROJECT_VERSION=<n>` on the `xcodebuild` line.
`manageAppVersionAndBuildNumber: true`.

**Evidence.** Archive path under `build/archives/`; `Info.plist` inside the
archive reads `1.0.0` / `<N>`; script log ends `Done`.

**B3. Agent.** Identity pairing, before anyone is told which build to
install. Newest store `uploadedDate` against the archive mtime, one timezone
(store reports `-07:00`; the build host is BST). The paired record's `id` is
the only id used from here on.

```sh
# store, newest first
asc builds list --app 6798866142 --sort -uploadedDate --limit 20 --pretty
# local archives
stat -f '%N %Sm' -t '%Y-%m-%dT%H:%M:%S%z' build/archives/*.xcarchive
```

**Stop if** the timestamps do not pair, or the paired record's `version` is
not `<N>`. Do not "fix" it by using the number you intended.

**B4. Agent.** Content probe of *that* archive, not of `dist/` on disk: grep
the archived `public` JS for a string only this RC contains (a #144 or #140
user-visible string is ideal). `xcrun devicectl device info apps` is a label
read; it is not this probe.

### Phase C — make the RC installable

The upload script does not set encryption compliance and does not attach a
beta group. Both must land on the **paired** build id.

**C1. Agent.** `PATCH /v1/builds/<paired-id>` with
`usesNonExemptEncryption: false`. Without this the build is not installable.
`ITSAppUsesNonExemptEncryption` stays absent from `Info.plist`
(`tests/b2-native-plugin-policy.test.mjs`); the per-build API answer is the
path.

**C2. Agent.** Attach Internal Testers
(`f169a857-55dd-46bf-ac7b-22b180cd37a0`):

```
POST /v1/betaGroups/<groupId>/relationships/builds
```

Group ids from `GET /v1/betaGroups`, never a truncated copy. Pretty-printed
JSON breaks naive `grep '"id":'`; parse it.

The external group "Family testers"
(`b3a803e5-eddd-4387-8448-f78b083c41c8`) needs beta review once per app. It
is optional for family testing and is **not** the App Review path. Do not
block submission on it.

**C3. Owner (questionnaire) + Agent (record).** Owner completes the 1.0.0
export-compliance questionnaire in App Store Connect in their own name
(HTTPS + OS-standard crypto; SQLCipher packaged, database opens
`no-encryption`). Agent records the version's compliance answers. This is
the one owner store-console step that is not the first-IAP exception.

### Phase D — accept *this* RC on a device

**D1. Owner.** On a physical iPhone signed into a Sandbox tester: delete any
existing `uk.eugnel.ks2spelling` install (a TestFlight *update* can keep
serving the previous webview bundle; delete-and-reinstall is the only sure
swap). Install 1.0.0 (`<N>`) from TestFlight.

**D2. Agent, before the owner launches.** Over the tether:

```sh
xcrun devicectl device info apps --device <udid>
```

Confirm version `1.0.0` build `<N>`, then treat that as a label and rely on
D1's delete-and-reinstall plus B3's timestamp pair.

**D3. Owner.** Walk the reviewer path in Appendix A, for real: set the PIN,
buy Full KS2 (Sandbox, £0 charged), tap **Download pack**, wait through all
15 shards, tap **Use the full word list now**, confirm the word bank is the
full catalogue offline. Record device, OS, build `<N>`, and pass/fail per
step on #171.

**Stop if** D3 fails. A new binary is a full re-walk from B1 with `<N+1>`.

### Phase E — version-gated metadata

All of this ships with 1.0.0. Changing a version-gated field after submit
needs a new version.

**E1. Agent.** App Privacy nutrition label: **Data Not Collected**. Only
legal because C's production observability confirmation passed.

**E2. Agent.** Privacy Policy URL `https://help.eugnel.uk/privacy`. Support
URL `https://help.eugnel.uk/`. Contact `support@eugnel.uk`. Display name
**Spelling Camp** (already set). Subtitle, promotional text, description,
keywords, category, screenshots from `docs/product/store-listing.md` and
`design/app-store-screenshots/final-v3`.

**E3. Agent.** Paste Appendix A into App Review Information. If #140 shipped
an adult challenge, rewrite the PIN-setup paragraph to match the shipped
copy before pasting — do not leave the trust-on-first-use wording in place
over a harder gate.

**E4. Agent.** Confirm the IAP is selected on the 1.0.0 version record.

### Phase F — submit

**F1. Agent.** Create the review submission, add the iOS `appStoreVersions`
item for 1.0.0, add the `inAppPurchases` item for `6801319684`
(relationship type `inAppPurchases`, not `inAppPurchasesV2`), then
`submitted: true`.

**F2. Owner, only if F1 returns `FIRST_IAP_MUST_BE_SUBMITTED_ON_VERSION`.**
In App Store Connect: app 6798866142 → 1.0.0 version page → attach
**Full KS2** → Submit for Review. This is the standing first-IAP exception.
One tap; agent verifies afterwards.

**F3. Agent.** Both the version and the IAP read `WAITING_FOR_REVIEW`.
Comment that state, with the paired build id, on #171. The day is done.

## Rejection loop

Who moves is the same table. A metadata fix is agent-executable. A binary
fix is a full re-walk from B1.

| Class | Typical cause here | New binary? | Move |
|---|---|---|---|
| **1.3** Kids Category — gate, purchasing opportunity, link-out | First-run PIN, price on a child surface, an outbound link | Yes, if the gate or a child surface is wrong. No, if the notes failed to explain a correct gate. | Notes-only: agent replies in Resolution Center. Behaviour: ship the fix, re-walk B–F. |
| **5.1** Privacy | Missing/wrong privacy URL; in-app notice missing; nutrition label wrong | URL and nutrition label: no. In-app notice missing: yes. | Agent metadata vs full re-walk. |
| **2.1(a)** Completeness — backend | Production gateway or R2 down during review | No, if bringing the Worker back is enough. Yes, if the binary points at the wrong origin. | Owner restores the Worker (Sitting 2 territory). Agent replies. |
| **2.1(b)** Completeness — IAP | IAP not attached; reviewer cannot find Buy; sandbox purchase fails | Attach-missing: no (F2). Purchase-broken in the binary: yes. | |
| **2.3.8 / 2.3** Metadata, screenshots, kids vocabulary | Copy or screenshot set | Usually no; a new screenshot set on an inflight version is still metadata. | Agent. |
| **3.1.1** Unlock mechanism | Anything that grants Full KS2 without StoreKit | Yes. | |

Do not recycle a rejected binary by "just resubmitting". If the binary
changed, the number increments, the script runs, the timestamps pair again.

A webview reload is not a new binary. After a TestFlight update, delete and
reinstall before claiming the new bundle is running.

## Appendix A — Reviewer notes

Paste this into App Review Information. Rewrite the PIN paragraph if #140
has shipped a different first-run challenge.

```
Spelling Camp is a Made for Kids (9–11) spelling practice app. Primary
category Education. Age rating 4+. There are no accounts, no advertising,
no analytics, and no links out of the app.

How to reach the Parent area
1. Launch the app. On "Who is practising?", tap For parents (top right).
   You do not need to add a learner first.
2. The first visit asks you to Set a Parent PIN. Enter six digits that are
   not a repeated digit or a simple sequence (012345 / 123456 and the
   reverse sequences are rejected). Suggested PIN for review: 248135, then
   confirm it.
3. You are now in the Parent area. The app re-locks when it goes to the
   background.

How to exercise the In-App Purchase
4. On the "Full KS2 spelling" card, tap Buy Full KS2 — £9.99. Complete the
   StoreKit purchase. Use a Sandbox Apple ID; TestFlight IAP does not
   charge.
   Product id: uk.eugnel.ks2spelling.fullks2 (non-consumable).
5. After purchase the card offers Download pack. Tap it. The download is
   not automatic — a parent has to start it (it is about 436 MB across 15
   shards). Keep the app open. The card reads "Installing word pack N of
   15".
6. When install finishes, tap Use the full word list now. The app restarts
   once so the child catalogue switches from the 20 Starter words to the
   full KS2 list. Then turn on Airplane Mode and open Words: you should
   see the full list, playable offline.

Restore
Restore purchases is on the same Parent-area card, only after the PIN gate
reports unlocked.

Privacy policy
Guideline 5.1.1(i) requires a privacy policy easily accessible in the app.
Guideline 1.3 requires links out of a Kids Category app to sit behind a
parental gate. We reconcile those by rendering the full policy inside the
Parent area (the "Privacy & app information" card) and opening no external
URL at all. The Privacy Policy URL on this listing
(https://help.eugnel.uk/privacy) is the same source, hosted for the store
field; it is not linked from inside the app. The Parent PIN is a
parental gate over purchasing and learner management. It is not parental
consent to collect personal data (Guideline 5.1.4(b)); we collect none
from the child.

Backend
The entitlement gateway and pack origin are live at
https://ks2-gateway.eugnel.uk for the duration of review (Guideline 2.1).
Please keep that host reachable in your test environment.

Demo account
None. There are no user accounts. The Sandbox purchase above is the whole
of the paid path.
```

## Appendix B — Identity pairing (the 14 August rule)

1. Store `uploadedDate` and local archive mtime, one timezone.
2. Resolve the build **id** from that pair.
3. Pass that id to every subsequent ASC call. Never look the build up by
   number again.
4. Announce that id and the committed `CURRENT_PROJECT_VERSION` to the
   tester, not a number you remember from the `xcodebuild` line.

`devicectl device info apps` reports `CFBundleVersion`. That field is only
trustworthy because this runbook forbids the store to rewrite it. Pairing is
still required: it is what detects that a later operator re-introduced the
rewrite.

## Appendix C — First IAP attach

Official rule: the first non-consumable must be submitted with a new app
version. Product already created 13 August 2026 (IAP `6801319684`, GBR
£9.99).

Public API path: `POST /v1/reviewSubmissions` →
`POST /v1/reviewSubmissionItems` for the version → another item with
`relationships.inAppPurchases` (type `inAppPurchases`) → `PATCH` the
submission `submitted: true`.

If that returns `FIRST_IAP_MUST_BE_SUBMITTED_ON_VERSION`, stop using the
API for attach and do F2. Do not retry the standalone
`/v1/inAppPurchaseSubmissions` endpoint; it is the call that produces the
error on a first item of a type.
