---
title: A store that renumbers the build makes every verification layer test the wrong binary
date: 2026-08-14
category: workflow-issues
module: ios-release-pipeline
problem_type: workflow_issue
component: development_workflow
applies_when:
  - "A human tester reports a shipped feature missing and every automated layer says the feature is present and correct"
  - "A TestFlight or App Store Connect build number is used to decide which local archive a tester is holding"
  - "An archive is exported by a hand-written ExportOptions.plist rather than by the repository's own upload script"
  - "Post-upload App Store Connect steps such as encryption compliance or beta-group attachment resolve a build id from an expected number"
  - "A device acceptance round is about to conclude that the verification chain is broken rather than that the artefact under test is the wrong one"
symptoms:
  - "The tester cannot reach a feature after a genuine delete-and-reinstall, while Node, Chrome, WebKit and an iOS Simulator XCUITest all render it from the same bundle"
  - "A grep of the uploaded archive's minified JavaScript finds the feature's own strings, and devicectl reports the phone carrying exactly the version and build number that were announced"
  - "One App Store Connect build sits VALID but attached to no beta group, so the build that actually contains the work is invisible in TestFlight"
  - "Encryption compliance and beta-group attachment appear to have been set, but on a build the tester was never offered"
  - "Local archive numbering and App Store Connect numbering are consistently off by one across a whole night of uploads"
root_cause: config_error
resolution_type: config_change
severity: critical
related_components:
  - "development_workflow"
  - "tooling"
  - "testing_framework"
tags:
  - "ios"
  - "testflight"
  - "app-store-connect"
  - "export-options"
  - "artefact-identity"
  - "device-acceptance"
  - "release-pipeline"
  - "xcodebuild"
---

# A store that renumbers the build makes every verification layer test the wrong binary

## Problem

The Word Bank word-detail view shipped in **PR #182** and the human device tester
reported it missing from TestFlight build 5. The feature was then proven present
and correct at four independent layers, and the tester remained right, because
the binary on the phone was not the binary those layers had tested. The
`ExportOptions.plist` used for `xcodebuild -exportArchive` carried
`manageAppVersionAndBuildNumber: true`, so App Store Connect assigned its own
build number at upload and every archive that night landed one number higher
than it was built as. The number the tester was given was a real number
belonging to the previous archive.

The repository already contained the fix. `scripts/testflight-upload.sh` has
written that key as `<false/>` since commit `29db0139` on 2026-08-03
(`scripts/testflight-upload.sh:62-73`), eleven days before the incident. The
uploads that broke did not use it.

## Symptoms

- A tap on a Word Bank row on the tester's device did nothing recognisable as
  the new screen, on a build whose number matched the one announced to them.
- The same tap, on the same minified sandbox-configuration bundle, rendered the
  complete detail card in an iOS Simulator XCUITest — screenshot and journey
  video both showed the chevron affordance on every row.
- `xcrun devicectl device info apps --device <udid>` reported
  `uk.eugnel.ks2spelling 0.5.0 build 5` installed, agreeing with the
  announcement and disagreeing with the tester's eyes.
- The build that actually contained the feature was `VALID` in App Store
  Connect with no `usesNonExemptEncryption` answer and no beta group, so it
  never appeared in TestFlight at all.

## What Didn't Work

This section is the substance of the learning. Nothing below was wrong; all of
it was green; none of it could have found the defect, because every layer
answered the same already-answered question — *is the code correct?* — and the
question that mattered was *which binary is on the phone?*

**Layer one, Node.** The real `createProductLearningController` was driven over
the real vendored starter catalogue, and `buildWordDetail`
(`src/app/word-bank-model.js:172`) returned a populated detail object. That
function is a pure projection whose only guard returns `null` when material and
row disagree on `runtimeItemId` (`src/app/word-bank-model.js:173`), so a
populated return proves the data path and nothing about delivery.

**Layer two, Chrome.** Playwright against the `design/` harness at 390pt: a tap
on a row rendered the detail. The row is a real button that sets the open word
id (`src/app/ProductApp.jsx:1901-1906`), and `WordDetailScreen`
(`src/app/ProductApp.jsx:1624`) paints the word heading, the meaning and the
practise action.

**Layer three, Playwright WebKit 26.4.** The same journey in the engine family
that backs iOS Safari and WKWebView: the detail heading present, zero console
and page errors. This was run specifically to rule out an engine-level
difference, and it did rule one out. It could not rule out that the phone held
different bytes.

**Layer four, iOS Simulator XCUITest.** A full journey — create learner, Words
tab, tap the "answer" row — against the *same sandbox-configuration minified
bundle the tester had*, following the existing simulator recipe of
create, boot, install and test in
`scripts/investigate-b4-release-launch-ios.mjs:62-73`. The diagnostic was
appended temporarily to `ios/App/B3ProofUITests/C5ProductLayoutTests.swift` and
reverted afterwards, so it is not in the tree. It passed, with a screenshot and
a video.

**A content probe of the uploaded archive.** The archive's minified JavaScript
was grepped and contained both `Practise this word` and `What it means`. This
was the closest thing to an artefact-identity check performed before the root
cause was found, and it was still aimed at the wrong artefact: it proved the
archive on the local disk contained the feature, not that the archive on the
phone was that one.

**A number check that confirmed the lie.**
`xcrun devicectl device info apps --device <udid>`, run over ssh to the Mac the
phone is tethered to, returned `0.5.0 build 5`. This looked like the decisive
identity check and was in fact the trap closing: `devicectl` reports the
`CFBundleVersion` baked into the installed bundle, and that number was the very
field the store had reassigned. A correct reading of a corrupted label.

**The cache theory.** The interim hypothesis was that the Capacitor WKWebView
was serving a page cached from before the update. It was reasonable — a webview
reload had bricked startup earlier the same night, fixed in **PR #180**, so
webview state was already under suspicion — and it was wrong. The tester had
already performed a genuine delete-and-reinstall, which removes the webview's
storage along with the app. That single fact killed it, and it was available
before the theory was formed.

**And, eight days earlier, a verification that could not fail.** (session
history) The upload path was first built on 2026-08-06 in a different session,
by copying a working recipe from a sibling repository and hand-writing an
`ExportOptions.plist` into a scratch directory. That session reasoned explicitly
about one key in the plist — that the App Store Connect API key must be passed
to `xcodebuild` as CLI flags because Xcode silently ignores it in the plist —
and never mentioned `manageAppVersionAndBuildNumber` at all. It then checked the
numbering carefully and correctly: the archive's `Info.plist` was read back and
verified as `0.5.0+1`, App Store Connect reported `0.5.0 (1)`, and the two
matched. That check was worthless, and could not have been anything else. The
App Store Connect app record had been created by hand minutes earlier, so the
app had no prior builds, so the store's "next available number" was 1. The
renumbering rule fired and was a no-op. "Archive says 1, store says 1, therefore
numbers are preserved" was true on the only build where it could be true, and
false from the next build onward.

The pattern across all of it: the first layer cost the most to set up and the
fifth cost the same as the fourth, and every one returned the same answer. When
verification stops changing its answer, the next layer is not adding
information; it is adding confidence to an answer to a question nobody is
asking.

## Solution

**The one-line fix.** In the `ExportOptions.plist` handed to
`xcodebuild -exportArchive`:

```xml
<key>manageAppVersionAndBuildNumber</key>
<false/>
```

With that key `false`, the number produced by the archive is the number that
ships, and `CURRENT_PROJECT_VERSION` is authoritative end to end — wherever the
build sets it. The chain it governs is short:

```
CURRENT_PROJECT_VERSION  →  CFBundleVersion  →  TestFlight build number
```

`ios/App/App/Info.plist:37-38` maps `CFBundleVersion` to
`$(CURRENT_PROJECT_VERSION)`. The App target carries
`CURRENT_PROJECT_VERSION = 1` at its Debug, Release and Sandbox configurations
(`ios/App/App.xcodeproj/project.pbxproj:590`, `:614`, `:637`) and takes it from
`$(B3_IOS_BUILD_NUMBER)` at its B3SandboxProof configuration (`:733`).

**The real fix is upstream of that, and it is a whole guard, not one key.**
`scripts/testflight-upload.sh` already generates a correct plist in
`write_export_options()` (`scripts/testflight-upload.sh:62`, with the key at
`:72`); it lists App Store Connect builds newest-uploaded-first rather than
paging by number (`:215`), though it still matches the target within that window
by version (`:224`); and — the part that would have stopped this outright —
`verify_project_version()` hard-fails unless the tracked project file already
reads `CURRENT_PROJECT_VERSION = <--build>` for the App target (`:138-146`),
while its archive invocation passes no build-setting override at all
(`:408-417`). The script's design is that the shipping number is committed and
then read; the uploads that broke supplied it as an archive-time override, which
is the case that guard exists to refuse. Use the script.

**The detection technique, as a procedure.** The off-by-one was found by pairing
each App Store Connect build's `uploadedDate` against the modification time of
the local archive. This is reusable and cheap:

1. Read the upload times from the store, newest first:
   `GET /v1/builds?filter[app]=<appId>&sort=-uploadedDate&fields[builds]=version,uploadedDate,processingState`
2. Read the local archive times in a comparable form:
   `stat -f '%N %Sm' -t '%Y-%m-%dT%H:%M:%S%z' <archive-dir>/*.xcarchive`
3. Convert both to one zone and pair them. App Store Connect reported `-07:00`;
   the build host was on BST, an eight-hour offset.

Applied that night the pairing was exact. The archive built as 5 had mtime
17:04 BST, which is 09:04 in the store's zone, and store build 6 reported
`uploadedDate` of `2026-08-14T09:05:07-07:00` — one minute of upload apart.
Store build 5 at `06:08 -07:00` paired with the archive built as 4, mtime
14:06 BST. The whole ladder was off by one, in the same direction, for every
archive of the night.

**Repairing the orphan.** The post-upload steps — `PATCH /v1/builds/<id>` with
`usesNonExemptEncryption: false`, and
`POST /v1/betaGroups/<groupId>/relationships/builds` — had been applied to a
build id resolved *by build number*, so they had landed on the wrong build. Both
were re-applied to the id of the build that actually held the feature.

**Verification of the fix.** With the key set to `false`, the next archive was
built with `CURRENT_PROJECT_VERSION=7`, landed in App Store Connect as build 7,
was polled to `VALID`, given its compliance answer, attached to the internal
group, and confirmed by the tester with the feature present. The number matching
the intent on the first try is the whole of the evidence, and it is sufficient:
under the old plist it had failed to match three times in a row.

## Why This Works

`manageAppVersionAndBuildNumber` tells `xcodebuild -exportArchive` to let the
store own the version and build fields. With it enabled, App Store Connect
increments past the highest number it has already seen, which is why the drift
was a consistent `+1` rather than random. The archive is not modified on disk,
so the local artefact and the store's record disagree from the moment of upload,
and nothing in either place flags the disagreement — both numbers are internally
consistent, they simply name different things.

That makes the build number an *assigned label* rather than a property of the
artefact, and every step downstream that treats it as an identifier inherits the
lie. Announcing "build 5" to a tester pointed them at the wrong binary. Looking
up a build id by number pointed the compliance `PATCH` and the beta-group `POST`
at the wrong record. Reading `devicectl device info apps` read the label back
faithfully and confirmed the wrong thing. Three separate consumers, one
corrupted key.

The second consequence is worse than the first, and is why this is severity
critical rather than an annoyance: **the bug hid its own fix**. Because the
post-upload steps landed on the wrong build, the build containing the feature
had no compliance answer and no beta group, and a build in that state does not
appear in TestFlight regardless of its processing state. Shipping a corrected
build would not have helped — the corrected build would have been equally
invisible, and would have looked like the same failure repeating. A defect that
makes its own remedy indistinguishable from the original symptom will absorb an
unbounded number of attempts.

The timestamp pairing works because upload time is a property of the *event*,
not of the label. The store cannot renumber when a file was uploaded, and the
filesystem cannot renumber when an archive was written. Two independent clocks
recording the same physical act give a match that survives any renaming in
between — which is exactly what an identity check needs to be made of.

## Prevention

- **Use the repository's upload script rather than hand-rolling its output.**
  This defect was not discovered, it was re-introduced: `manageAppVersionAndBuildNumber`
  has been `<false/>` in `scripts/testflight-upload.sh` since 2026-08-03, and
  the uploads that broke came from a plist hand-written into a scratch
  directory. Three of that script's guards were bypassed at once — the correct
  plist key, the refusal to archive unless the tracked project file already
  carries the shipping number, and the newest-uploaded-first build lookup — and
  each one alone would have prevented or immediately exposed the fault. A
  tracked script is not only automation; it is the accumulated record of every
  flag someone already got right. Writing its output again from memory discards
  that record silently, and the discard leaves no diff to review — the
  hand-written plist was never a repository file, so the project's otherwise
  heavy hash-freeze governance had nothing to bite on. Before hand-rolling any
  release step, `git ls-files scripts/` and look for the one that already does
  it.

- **Distrust a verification whose degenerate case cannot fail.** The 2026-08-06
  check — archive says `0.5.0 (1)`, store says `0.5.0 (1)` — was a real check
  that passed for a reason unrelated to what it was believed to prove: a
  brand-new app record has no prior builds, so the renumbering had nothing to
  renumber to. When a guard is first exercised on the empty, first, or
  single-element case, ask what it would have said had the case been ordinary.
  This is the *green check, wrong artefact* shape: a check passes because it
  never ran against what ships. Prior instances in this project are the
  derived-config lane (**issue #156**), a path-filtered CI lane (**issue #87**)
  and the evidence-successor gate (**issue #73**); this is the fourth.
  (session history)

- **Identify a build by timestamp pairing, never by number alone.** Match the
  store's `uploadedDate` against the local archive's mtime, in one zone, before
  telling anyone which build to install and before resolving a build id for any
  post-upload call. The number is a label the store may reassign; the timestamp
  pair is evidence. Resolve the id once, from the paired record, and pass that
  id to every subsequent call rather than re-looking-up by number.

- **Pair every number check with a content probe.**
  `xcrun devicectl device info apps --device <udid>` is worth running early — it
  is the fastest read of what is installed — but it reports the number, the one
  field that can lie. Grep the bundle that is about to ship for a string only
  the new feature contains, and pick a string that is user-visible and new, so
  its presence cannot predate the feature.

- **When a feature is green at every layer and a human still cannot see it,
  stop verifying the code and start verifying artefact identity.** A fifth
  verification layer costs what the fourth cost and returns what the fourth
  returned. The cheap questions at that point are all identity questions: which
  bytes are on the device, when were they built, when were they uploaded, which
  record did the API calls touch.

- **Kill a theory with the fact that already exists before pursuing it.** The
  cache theory was plausible on the evidence of PR #180 and was already dead:
  the tester had done a delete-and-reinstall. Before spending on a hypothesis,
  ask which known fact would falsify it and whether that fact is already in
  hand.

## Related Issues

- **Issue #171** — "Submission day — the release runbook that walks the app into
  review". Carries the upload chain, the timestamp-pairing procedure, and the
  requirement that the runbook drive `scripts/testflight-upload.sh` rather than
  an ad-hoc plist.
- **Issue #76** (closed) — the prior instance of the same post-upload-by-number
  hazard, where build `0.5.0 (1)` sat VALID but undistributable pending the
  export-compliance questionnaire.
- **Issue #133** — the sandbox device-acceptance ticket whose tester held the
  mismatched binary.
- **PR #182** — the Word Bank word-detail feature that was reported missing.
- **PR #180** — the webview soft-reload fix, merged the same day, which is what
  made the cache theory plausible.
- [Gating physical iOS installs on application composition](./gating-physical-ios-installs-on-application-composition.md)
  — the direct ancestor. There a build compiled, installed and launched, and all
  three successes attested to the wrong application composition; its rule is
  that an identity token proves the wrapper, never the contents. This record is
  the same rule one layer further out: install identity is not the last
  unverified token, because the build number the installer reports back is one
  too.
- [A harness that omits a field photographs a screen the product never renders](./harness-omitting-a-field-photographs-a-screen-the-product-never-renders.md)
  — the sibling in which the instrument is honest about a product that is not
  the product. There the data behind the render was wrong; here the binary
  behind the number was wrong. Both produce a green result that describes
  something real, just not the thing being asked about.
