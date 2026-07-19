# Standalone Spelling Mobile B4 Capacitor Development Certification Plan

> Status: implementation must not start until the entry authority and this plan
> have passed the three review gates defined below.

## Purpose

B4 answers one bounded engineering question:

> Can the existing React, JavaScript domain and Capacitor native projects deliver
> a credible offline five-card Starter spelling round on iOS and Android without
> a demonstrated WebView ceiling?

This is a development platform decision, not production or store certification.
It uses virtual devices and hosted runners because no local physical iPhone or
Android device is available. A `GO` authorises the C-series Capacitor product
plans. It does not authorise App Store or Google Play submission.

The implementation must be small enough to discard if the evidence produces a
genuine `NO_GO`. It must reuse the existing spelling command planner, SQLite
repository, lifecycle coordinator and native projects. It must not introduce a
second learning engine, a second persistence model, a native UI rewrite or a new
general-purpose proof framework.

## Governing authority

- Foundation design:
  `docs/superpowers/specs/2026-07-09-standalone-spelling-mobile-application-design.md`
- Programme:
  `docs/superpowers/plans/2026-07-09-standalone-spelling-mobile-programme.md`
- B2 persistence authority:
  `docs/architecture/b2-persistence-authority.md`
- B3 commerce and pack authority:
  `docs/architecture/b3-commerce-pack-authority.md`
- Frozen source design section 5.3, section 9.1, section 17 and section 18:
  `fol2/ks2-mastery` commit
  `4501607a9b58f2fb252b4cce64ba056e6f60c630`

Where the original B4 wording requires physical devices, live sandbox stores or
deployed Cloudflare/R2, the later repository-owned Development-versus-Release
boundary governs:

- B4 owns virtual-device and hosted development quality;
- Task 22 owns final signed distribution, live stores, deployed Cloudflare/R2
  and physical or approved hosted-real-device truth; and
- Task 23 owns the final release-candidate exact-main review.

## Frozen B4 entry authority

Every value below was freshly measured from a clean detached checkout of exact
`origin/main` after PR #9 merged. No value is inferred from the feature branch.

| Authority field | Frozen value |
|---|---|
| B3 merged `main` commit | `c6fedd9f554a2873fb993ad4ae21e0cde54cba9d` |
| B3 merged tree | `4802611ff79ea6d56bb78f25f65eed4826159d22` |
| Task 20 application commit | `ea36913574679bad13440066f67c9e174f8707a3` |
| B3 application fingerprint | `2b6c4bc91c2d97f01e3a98236a4b0b7fe115a71e46388dc856e7491eead1fba5` |
| B3 evidence topology | `{"ok":true,"mode":"pending","testedApplicationCommit":"c6fedd9f554a2873fb993ad4ae21e0cde54cba9d","applicationFingerprint":"2b6c4bc91c2d97f01e3a98236a4b0b7fe115a71e46388dc856e7491eead1fba5"}` |
| `reports/b3/deterministic-proof.json` SHA-256 | `ad41000d657150df2c3a9b60a11c459d0e29728b39985e59cfdccb918a7ba404` |
| `reports/b3/dependency-audit.json` SHA-256 | `ea978fe264d2300eede27ec3189047e478c7e445f0f1a4c89d4f17fddf7ca9cd` |
| `reports/b3/native-build.json` SHA-256 | `ca8044a66dc0176e933fc9df7d2c60d626c2f8630e66e977c17ca4cb2c7904aa` |
| `package-lock.json` SHA-256 | `534b10c7f317622eba32b277b8755a0ac3d04aaf30359117fdeb7510050b6479` |
| `gateway/package-lock.json` SHA-256 | `173e712114782c4a7d38165bc12593ba6149089af88f35241308339a46e3db94` |
| Exact-main hosted CI | `https://github.com/fol2/ks2-spelling/actions/runs/29645002349` |
| Frozen upstream Gate A commit | `4501607a9b58f2fb252b4cce64ba056e6f60c630` |
| A2 contract manifest SHA-256 | `237b26b14e7506fa271bb3324f701d6205e6e0166d659a16789937478cc77b66` |

Before implementation, an independent reviewer must reproduce the commit, tree,
fingerprint, pending topology, five file hashes and successful CI `headSha` from
exact `origin/main`. Any mismatch stops B4 planning; it is not repaired by
updating this table to a convenient value.

The B3 branch `jamesto/mobile-b3-billing-download` is retained. B4 begins from
the frozen merge commit on `jamesto/mobile-b4-vertical-slice`.

## Existing implementation truth

The entry tree already contains:

- the immutable 20-item `ks2-core:starter` catalogue;
- the A3 `start-session`, `submit-answer`, `continue-session`, `skip-word` and
  `end-session` command contracts;
- one learner-scoped SQLite command transaction that persists subject state,
  active session, events, Monster projection, Camp projection and revision;
- pause/resume close, WAL checkpoint, reopen, migration and rehydration;
- an app-owned post-commit `audio-cue` effect;
- normal iOS and Android Capacitor projects; and
- hosted unsigned compilation plus non-live commerce tests.

The current visible application remains a B1/B2/B3 diagnostic shell. It has no
learner round controls or audio player. B2 proves a scripted one-word persistence
scenario, not the five-card Starter round defined by section 9.1. No production
Starter audio is present.

## Exact B4 development slice

### Learner and content

- Use the existing synthetic local learner `learner-a` only for B4 development
  evidence. C2 owns production profile creation, selection and multi-child UI.
- Add an explicit B4 development build configuration. Keep the current normal
  B2 composition and its wrappers unchanged until Gate B returns `GO`; B3 also
  remains confined to its existing explicit proof configuration.
- Start one five-card `smart` round from five permanent Starter runtime IDs.
- Use the existing planner and command repository for every transition.
- Render only committed or freshly rehydrated state. React component state may
  hold view input and busy/error state, but it must not become a second durable
  spelling session.
- Complete five unique A3-planned items through the genuine A3 summary. The
  number and order of submit/continue transitions come from the engine; the
  controller must not assume one submission per item.
- Prove one mid-round termination and relaunch resumes the same session and
  advances each card exactly once.

This is one complete **five-card round**, not completion of all 20 Starter items.
C1 owns the production signed Starter 20 content/audio package. C2 owns
production profiles. C3 owns the full child information architecture.

### Pre-generated local audio

B4 needs only enough authorised, packaged speech audio to prove the Capacitor
audio path for the bounded five-card round:

- one natural word cue per selected card;
- one normal dictation cue for every sentence prompt the deterministic clean
  round can emit; and
- one slow dictation cue for every such sentence prompt.

Task 1 freezes the five runtime IDs, random seed, exact successful A3 command
trace, emitted sentence prompts and resulting asset inventory before product
code uses them. The same trace-derived audio manifest contains the exact source
or generation inputs, voice, licence or consent, redistribution grant and
SHA-256 for every audio file; there is no second provenance document.

The complete derived set must be committed or deterministically materialised
from repository-owned, redistribution-authorised inputs, mapped by a small
manifest to exact runtime item, sentence, kind and SHA-256, and packaged into
both B4 native builds. Reusing one unrelated sound for different words is not
acceptable round evidence. Browser/native TTS and a network provider are
forbidden at runtime.

B4 commits this bounded proof set so the installed virtual-device journey is
reproducible. The production contract remains server-pack/local-install: C1
will put the complete pre-generated audio set inside each signed downloadable
pack. The client never generates canonical spelling audio. Missing or corrupt
audio fails explicitly and recoverably instead of falling back to Web Speech,
iOS `AVSpeechSynthesizer`, Android `TextToSpeech` or a network provider.
VoiceOver and TalkBack may read the semantic interface under user control, but
they are not practice-audio implementations.

`Replay` and `Slow replay` consume the same manifest. A post-commit audio cue may
start playback only after the SQLite transaction succeeds. Pause, learner
rehydration or disposal stops current playback without altering durable session
state. Playback failure keeps the round recoverable and never invents an answer.

This bounded proof manifest is not the production 840-asset Starter manifest
and must not be labelled as production audio readiness. C1 still requires two
approved British-English voices and complete word/normal/slow coverage.

### Learner UI and keyboard

Use native web primitives:

- a labelled text `<input>` with visible focus, `autocomplete="off"`,
  `autocapitalize="none"`, `spellcheck="false"` and an appropriate return-key
  hint;
- a primary submit button;
- `Replay` and `Slow replay` buttons;
- progress expressed as text, for example `Card 2 of 5`;
- a polite live region for correct, retry and recoverable audio feedback; and
- a completion state which can start a fresh B4 round.

Tapping the input must open the platform software keyboard. Pressing Enter from
a hardware/external keyboard path must use the same submission function as the
button. Do not build a custom on-screen keyboard, native text bridge or parallel
input state machine.

The B4 shell must not show price, Buy, Restore, download administration or an
automatic store sheet. B3 diagnostic commerce remains available only through
its existing explicit B3 proof build mode.

### Layout and accessibility

The same React surface must remain usable at phone portrait, tablet portrait and
tablet landscape viewports. B4 may add a few semantic layout tokens and
responsive rules, but it does not perform the final Visual / Theme / Asset
Migration.

Development accessibility requires:

- one logical heading hierarchy and landmark structure;
- stable accessible names for input and controls;
- DOM/focus order matching the visual task order;
- no target word in accessible labels, hints or hidden text before scoring;
- correct live feedback without duplicate announcements;
- platform-measured minimum 44 pt iOS and 48 dp Android interactive controls;
- no colour-only correctness state;
- Reduced Motion disabling non-essential transition/celebration motion; and
- a complete installed-platform round at 200% OS text scaling without blocked
  or clipped task controls.

iOS and Android virtual-device automation must observe and operate the same
labelled controls. It does not claim VoiceOver or TalkBack physical-device
certification; that remains in the pre-release gate.

## B4 performance risk observations

B4 records the section 18 behaviours that virtual/hosted execution can observe,
but it does not pretend that a hosted runner is a physical reference device or
that a different artefact is a store download or compacted backup.

The existing native journeys record monotonic raw timings naturally produced by
their required cold launches, five-card interactions, SQLite commits, rendered
feedback and Replay/Slow replay actions. Every audio observation creates a fresh
player and resets cached state before measuring to the `playing` event. Do not
mandate extra loops, sample counts, percentile code, a performance framework or
a separate report library.

Each native report records platform, runner image, OS/runtime, device profile,
build configuration and the raw observations beside the matching section 18
comparator. These sparse development observations identify obvious WebView
risk; they are not statistical certification.

Cold launch ends at a B4 control rather than the future profile picker, so it is
labelled a risk observation. Compressed B4 native payload and local database
bytes are recorded as raw facts without relabelling them as Starter store
download or compacted `backup.sqlite` evidence. The production hard gates remain
C1/C2/C7 and pre-release evidence. Final celebration/navigation frame budgets
are also C7 work because B4 deliberately has no production animation or visual
system to certify.

A comparator breach triggers investigation and one independent reproduction; it
does not itself produce `NO_GO`. Missing or malformed observations make B4
`INCOMPLETE`. Only a reproducible, attributed WebView ceiling which cannot be
removed without disproportionate platform-specific work may produce `NO_GO`.
Samples, comparators and labels must not be changed to turn a breach into a pass.

## Evidence shape

B4 development evidence is ordinary regenerable, non-secret repository output:

```text
reports/b4/domain-round-proof.json
reports/b4/ios-simulator-proof.json
reports/b4/ios-phone.png
reports/b4/ios-tablet-portrait.png
reports/b4/ios-tablet-landscape.png
reports/b4/android-emulator-proof.json
reports/b4/android-phone.png
reports/b4/android-tablet-portrait.png
reports/b4/android-tablet-landscape.png
reports/b4/b4-development-report.json
```

The report schema remains shallow: entry authority, tested application
commit/tree, app bundle hashes, virtual-device identities, five-card journey
outcome, lifecycle/audio/accessibility/layout outcomes, raw performance
observations and one technical outcome:

- `pass`;
- `investigation-required`;
- `incomplete`; or
- `webview-ceiling`.

It contains no learner nickname, receipt, token, device account, capability URL
or live-store/cloud evidence. It does not encode future review, merge, exact-main
CI or the final Gate B decision.

After implementation, freeze one clean application checkpoint. Generate all B4
reports and screenshots against that exact predecessor, then commit them as one
evidence-only successor. The shallow aggregate records the predecessor SHA; an
ordinary `git diff --name-only` allow-list verifies that the successor changes
only the declared `reports/b4` paths. No lineage-aware report builder is added.
The final Gate B `GO | INCOMPLETE | NO_GO` is recorded only after exact-main CI,
outside the technical report, in the merged GitHub PR discussion with the
exact-main commit and CI URL, so no file attempts to bind the future commit which
contains itself.

Do not reuse the B3 release-proof SQLite ledger, command protocol, immutable
publisher or six-file pending/complete topology. B4 evidence is not a commerce
transaction and does not need that machinery.

## Test and implementation method

- Use red/green TDD for each product seam.
- Prefer direct Node contract tests for controllers, audio mapping and reports.
- Use React DOM tests through the existing Node test runner where practical;
  add a browser dependency only if a required behaviour cannot be proved with
  the existing toolchain.
- Use XCUITest for the installed iOS WebView journey and existing Android
  instrumentation/UI automation for the installed Android WebView journey.
- Extend the existing native test targets only. Do not add an app-authored
  observation bridge, private command channel or new native test target.
- Extend the existing three CI jobs. Do not introduce an external device farm,
  live deployment, store credentials or a second CI system.
- Keep each implementation task in a reviewable commit and push safety
  checkpoints after clean verification.

## Task sequence

### Task 1 — Freeze B4 contracts and product composition

Add focused failing tests for:

- an explicit B4 development configuration selecting `b4-starter-product`,
  while the current normal/B2 and explicit B3 compositions remain unchanged;
- one five-card Starter round contract;
- controller rehydration from the existing SQLite snapshot; and
- the shallow B4 report schema and claim labels.

Before product composition, add a deterministic characterisation test which
freezes the five permanent runtime IDs, random seed, exact A3 command trace,
summary and every emitted sentence prompt. Freeze the single executable audio
manifest and fail if its source, voice, redistribution authority or hashes are
absent.

Implement the smallest explicit B4 development composition using the existing
connection, migration, seed, command gate, snapshot store, command repository
and lifecycle coordinator. Extract shared setup from
`create-b2-app-services.js` only where both compositions demonstrably use it; do
not create a framework of factories.

Expected focused command:

```bash
node --test \
  tests/b4-app-composition.test.mjs \
  tests/b4-round-controller.test.mjs \
  tests/b4-development-report.test.mjs
```

Exit: a headless controller starts, advances, rehydrates and completes the exact
five-card round using committed SQLite state. Existing B1/B2/B3 tests remain
green.

### Task 2 — Package and execute the bounded local-audio slice

Add the complete trace-derived B4 manifest and authorised assets, with the
source, voice and redistribution authority frozen in Task 1. Tests must reject
missing, extra, path-drifting, provenance-drifting or hash-drifting assets.

Implement one small `HTMLAudioElement`-backed playback function. Inject that
function directly into controller tests; do not add a one-implementation port or
adapter hierarchy. Consume post-commit effects, expose replay/slow replay, and
stop safely on pause, rehydration and dispose. Test play rejection, interruption,
stale completion and rapid replay without changing durable round state.

Expected focused command:

```bash
node --test \
  tests/b4-audio-manifest.test.mjs \
  tests/b4-local-audio-player.test.mjs \
  tests/b4-round-controller.test.mjs
```

Exit: every item and sentence in the frozen clean round has exact local word,
normal sentence and slow sentence paths; both B4 native bundles contain those
exact bytes and the bound manifest authority; runtime network access is not used
for scored audio.

### Task 3 — Build the five-card learner surface

In the explicit B4 development composition, render the B4 product surface while
leaving the current normal/B2 and explicit B3 entry points unchanged. Implement
the real input, submit, replay, slow replay, progress, feedback, retry and
completion states. Keep product copy calm and free of commerce pressure.

Test:

- button and Enter submission share one action;
- a busy transition cannot double-submit;
- wrong and correct answers follow the domain result rather than UI inference;
- target words do not leak through accessibility text;
- completion and fresh-round actions are deterministic; and
- no child control can reach B3 commerce.

Exit: a browser-level test completes the five-card round and another test
recreates the controller mid-round and resumes the exact committed card.

### Task 4 — Accessibility and responsive layout

Add focused semantic, focus, 200% scaling, Reduced Motion and fixed-viewport
tests. Add only the CSS needed for phone portrait, tablet portrait and tablet
landscape usability. Preserve a visible focus indicator and prove the shared
surface reaches 44 pt on iOS and 48 dp on Android.

The evidence screenshots demonstrate layout only; they are not final visual QA.
Do not migrate Monster art, production typography, final colours, navigation or
celebration assets in B4.

Exit: the same DOM and information order serves every viewport, and all controls
remain reachable without target leakage or horizontal obstruction.

### Task 5 — Record B4 platform risk observations

Retain only the raw timings naturally emitted by the required native cold
launches, five-card journey, SQLite commits, rendered feedback and uncached
Replay/Slow replay actions. Do not add sample loops, percentile code, a
measurement library or a performance report subsystem. Fixed-viewport journeys
remain separate layout evidence. Missing, malformed or mislabelled observations
are `incomplete`; a comparator breach is `investigation-required` until
independently reproduced and attributed.

Exit: both native reports contain complete raw observations and honest labels.
No result claims physical-reference, store-download or backup certification.

### Task 6 — Prove the installed iOS vertical slice

Extend the existing owned XCUITest target without changing B3 evidence
semantics. On supported hosted Simulator profiles, with network access denied
for the installed application:

1. install and cold-launch the unsigned B4 development app;
2. operate the labelled input with the software keyboard;
3. complete part of the five-card round;
4. background/foreground during audio;
5. terminate and relaunch;
6. prove the same committed session resumes;
7. complete the round exactly once;
8. tap Replay and Slow replay, wait for the neutral visible `Audio playing`
   state, then prove interruption stops it;
9. exercise the Enter-key path;
10. repeat the complete journey at 200% OS text scaling and prove controls are at
    least 44 pt;
11. capture phone and tablet portrait/landscape screenshots; and
12. record B4 performance observations plus raw payload/database sizes.

The test runner derives the expected runtime item, audio kind and manifest hash
from the committed deterministic trace and audio manifest. The application
exposes only neutral visible playback state, so the target word does not leak and
no private observation bridge is introduced.

The report records exact Simulator runtime and device types. No result is called
physical, signed or App Store evidence.

### Task 7 — Prove the installed Android vertical slice

Use the existing Android native project and owned instrumentation/UI automation
target on hosted emulators. Deny network access to the installed application and
execute the same journey and assertions as iOS, including Replay/Slow replay,
visible playing/stopped state, software keyboard, interruption, process
death/relaunch, exact resume, Enter-key path, a complete journey at 200% OS text
scaling, platform-measured 48 dp targets, phone/tablet screenshots and raw
performance/payload/database observations.

Run a minimum API 24 launch/core-flow compatibility check and an API 36 product
journey where hosted images support them. Record actual image, ABI, API and device
profile. Do not substitute an emulator result for Play, signed distribution or
TalkBack physical-device truth.

### Task 8 — Gate B Development decision and integration

Freeze a clean application checkpoint after Tasks 1-7. Regenerate the domain,
iOS and Android reports against that checkpoint. Commit reports and screenshots
as one evidence-only successor whose shallow aggregate records the predecessor
SHA and application bundle inputs. Verify with an ordinary
`git diff --name-only <application-checkpoint>..HEAD` exact allow-list that the
successor changes only the declared `reports/b4` paths.

Run at minimum:

```bash
npm test
npm run lint
npm run build
npm run native:sync:check
npm run test:ios
npm run test:android
npm run audit:dependencies
git diff --check
```

Run the three exact-candidate review gates:

1. Gstack: boundary, purpose and contract fulfilment;
2. Matt: Standards and Spec implementation review; and
3. Ponytail: simplicity, native fit and over-engineering review.

Only actionable P1/P2 findings inside B4 block. Any correction creates a new
exact candidate and invalidates all three approvals.

Push the approved evidence successor, require hosted Domain/Web, iOS and Android
jobs to pass, merge through one ordinary PR, then require exact-main CI. Only
then record one of:

- `GO`: the bounded Capacitor slice passes and no demonstrated WebView ceiling
  blocks C-series work; or
- `INCOMPLETE`: required evidence is missing, malformed, stale or still needs
  investigation; continue B4 without selecting another framework; or
- `NO_GO`: preserve the evidence, stop Capacitor product work and write a React
  Native design grounded in a reproduced, attributed and disproportionate
  WebView ceiling.

Do not turn a `NO_GO` into `GO` by narrowing the frozen journey or relabelling a
failed threshold.

## Review gates for this plan

Before Task 1, the exact plan candidate must receive:

1. Gstack approval that the work still answers the platform decision and keeps
   Task 22/C-series scope out;
2. Matt Standards+Spec approval, including an independent reproduction of every
   B4 entry-authority value; and
3. Ponytail approval that the task sequence is the minimum credible Capacitor
   proof and introduces no speculative framework.

The reviewers return `APPROVE` or actionable P1/P2 findings with exact evidence.
Minor style preferences do not block implementation.

## Explicit non-goals

B4 does not implement or certify:

- production profile picker, multi-child administration, PIN or biometrics;
- Parent Progress, Children, Packs or Settings UI;
- Full KS2, production signed Starter 20, 840-asset audio readiness or two voice
  profiles;
- final child navigation, Monster/Camp presentation, Guardian, Boss, Pattern
  Quest, achievements or revision rewards;
- final Visual / Theme / Asset Migration;
- live Apple/Google purchases, signed distribution, deployed Cloudflare/R2 or
  public pricing;
- platform backup/export, production database encryption or retention;
- physical-device, VoiceOver, TalkBack, acoustic or store-download
  certification;
- compliance metadata, DPIA, privacy policy, store screenshots or public
  release readiness; or
- changes to spelling mastery, Monster stages, Camp rules or pack entitlement
  semantics.

After a B4 Development `GO`, write and complete the dedicated Visual / Theme /
Asset Migration plan before C3 child-facing production UI. Task 22 remains
deferred until final product, visual, security and store records have stabilised.

## Acceptance criteria

B4 returns `GO` only when all of the following are true on one exact integrated
candidate:

1. Explicit B4 iOS and Android development builds launch the local product
   slice; the current normal/B2 and explicit B3 proof compositions remain
   unchanged.
2. One real five-card Starter round uses the existing A3 planner and SQLite
   transaction repository from start through completion.
3. Termination/relaunch resumes the exact committed session without skipping or
   double-advancing a card.
4. Every asset derived from the frozen five-item A3 trace has exact, authorised
   word/normal/slow speech bytes and provenance in one manifest; replay, slow
   replay and interruption work without runtime network or TTS.
5. Software-keyboard and Enter-key paths operate the same labelled input and
   submission action on both platforms.
6. Phone portrait, tablet portrait and tablet landscape remain usable on both
   virtual platforms.
7. B4 semantic, focus, Reduced Motion, complete 200% OS text-scale,
   platform-specific 44 pt/48 dp and no-answer-leakage checks pass; physical
   screen-reader certification remains explicitly unclaimed.
8. Raw timings from the required B4 journeys are complete and honestly shown
   beside section 18 comparators without a statistical-certification claim. A
   concern is investigated; missing evidence is `INCOMPLETE`; only a reproduced,
   attributed, disproportionate WebView ceiling is `NO_GO`.
9. Existing domain, B1/B2/B3, native, dependency, privacy and offline-learning
   contracts remain green.
10. Reports and screenshots bind one candidate and contain no secret/private
    identity or live commerce/cloud claim.
11. Gstack, Matt and Ponytail approve the same exact candidate; exact-head and
    exact-main hosted CI pass.
12. The shallow technical aggregate records the application checkpoint and an
    ordinary report-path diff allow-list proves the evidence-only successor; the
    final `GO | INCOMPLETE | NO_GO` is recorded only after exact-main CI.

## Gate B Development record — 2026-07-19

Result: `INCOMPLETE` pending performance investigation.

Integrated candidate: evidence-only successor `3935a0e` on application
checkpoint `9f4820e`, merged to `main` as `8b91515` through PR #10. The iOS and
Android B4 proofs were re-run sequentially in isolation after the StoreKit
contradictory-summary fix; the earlier concurrent Android launch failure did not
reproduce. Gstack, Matt (Standards and Spec, including the StoreKit
contradictory-terminal reproducer) and Ponytail approved the same exact
candidate; exact-head and exact-main hosted CI passed on `3935a0e` and
`8b91515`.

`INCOMPLETE`, not `GO`, because the committed evidence honestly records
`technicalOutcome: investigation-required`: raw cold-launch and
submit-to-render observations breach the section 18 comparators on both virtual
platforms and no investigation artefact yet attributes or resolves the concern.
No reproduced, attributed, disproportionate WebView ceiling is demonstrated, so
`NO_GO` is not justified; B4 continues on Capacitor without selecting another
framework.

Explicitly unclaimed: physical-device, signed-store, VoiceOver, TalkBack,
acoustic and store-download certification; hosted-runner execution of the
installed journeys (hosted jobs compile the B4 seams and re-verify committed
evidence; journeys ran on local virtual devices); Android API 24 launch
evidence (`not-hosted`).

Next required step before any `GO`: investigate the performance comparator
breaches with one independent reproduction, then re-run Task 8 gates on the
resulting candidate.
