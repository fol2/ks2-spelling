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
- Start one five-card `smart` round from five permanent Starter runtime IDs.
- Use the existing planner and command repository for every transition.
- Render only committed or freshly rehydrated state. React component state may
  hold view input and busy/error state, but it must not become a second durable
  spelling session.
- Complete the round with five correct submitted answers and the required
  continue transitions.
- Prove one mid-round termination and relaunch resumes the same session and
  advances each card exactly once.

This is one complete **five-card round**, not completion of all 20 Starter items.
C1 owns the production signed Starter 20 content/audio package. C2 owns
production profiles. C3 owns the full child information architecture.

### Bundled local audio

B4 needs only enough authorised, packaged speech audio to prove the Capacitor
audio path for the five-card round:

- one natural word cue per selected card;
- one normal dictation sentence per selected card; and
- one slow dictation sentence per selected card.

The exact 15 files must be committed or deterministically materialised from
repository-owned, redistribution-authorised inputs, mapped by a small manifest
to exact runtime item, sentence, kind and SHA-256, and packaged into both normal
native builds. Reusing one unrelated sound for different words is not acceptable
round evidence. Browser/native TTS and a network provider are forbidden at
runtime.

`Replay` and `Slow replay` consume the same manifest. A post-commit audio cue may
start playback only after the SQLite transaction succeeds. Pause, learner
rehydration or disposal stops current playback without altering durable session
state. Playback failure keeps the round recoverable and never invents an answer.

This 15-file proof manifest is not the production 840-asset Starter manifest and
must not be labelled as production audio readiness. C1 still requires two
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
- minimum 44 CSS-pixel interactive controls in the shared web surface;
- no colour-only correctness state;
- Reduced Motion disabling non-essential transition/celebration motion; and
- successful DOM zoom/text scaling at 200% without blocking the round.

iOS and Android virtual-device automation must observe and operate the same
labelled controls. It does not claim VoiceOver or TalkBack physical-device
certification; that remains in the pre-release gate.

## B4 performance and size proxies

B4 uses the section 18 thresholds as WebView risk gates where virtual/hosted
measurement is meaningful. Each result records platform, runner image, OS,
runtime, device profile, build configuration, sample count, raw samples, p95 and
threshold. The measurement code uses monotonic clocks.

| Measure | B4 development sample and threshold | Claim boundary |
|---|---:|---|
| Cold launch to interactive B4 round control | p95 <= 2.0 s across 30 terminated-app launches per platform | Virtual/hosted proxy; no production profile picker yet |
| Local answer feedback | p95 <= 100 ms across 200 submissions | Planner, SQLite commit and rendered feedback measured separately as well as end-to-end |
| Local audio start | p95 <= 250 ms across 100 starts from packaged local files | Measure request to `playing`; not acoustic-output latency |
| SQLite answer transaction | p95 <= 50 ms across 200 representative commits | Virtual/hosted database proxy |
| Child navigation/feedback frames | >=95% at <=16.7 ms and >=99% at <=33.3 ms during a scripted five-minute run | WebView frame proxy; physical reference classes remain pre-release |
| Starter application payload | <=120 MB compressed for each B4 native build proxy | Not an App Store/Play download-size claim |
| Representative local database | <=20 MB after the B4 round and bounded performance sample | Not a production `backup.sqlite` or retention claim |

Failure of a timing threshold must first be reproduced and attributed. B4 may
repair a demonstrated application bottleneck. It must not hide failure by
dropping samples, extending the threshold, adding broad retries or labelling a
different measurement as the original one.

The final production store-download and backed-up SQLite budgets remain C1/C2
and release evidence because those artefacts do not yet exist.

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

The report schema remains shallow: entry authority, tested commit/tree, app
bundle hashes, virtual-device identities, five-card journey outcome,
lifecycle/audio/accessibility/layout outcomes, budget samples and a final
`GO | NO_GO` decision. It contains no learner nickname, receipt, token, device
account, capability URL or live-store/cloud evidence.

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
- Use one app-owned, B4-only observation/report bridge only if native automation
  cannot read a required committed outcome safely. It must not become a general
  device command protocol.
- Extend the existing three CI jobs. Do not introduce an external device farm,
  live deployment, store credentials or a second CI system.
- Keep each implementation task in a reviewable commit and push safety
  checkpoints after clean verification.

## Task sequence

### Task 1 — Freeze B4 contracts and product composition

Add focused failing tests for:

- normal native builds selecting `b4-starter-product`, while B2 and B3 proof
  modes remain explicit and unchanged;
- one five-card Starter round contract;
- controller rehydration from the existing SQLite snapshot; and
- the shallow B4 report schema and claim labels.

Implement the smallest normal native composition using the existing connection,
migration, seed, command gate, snapshot store, command repository and lifecycle
coordinator. Extract shared setup from `create-b2-app-services.js` only where
both compositions demonstrably use it; do not create a framework of factories.

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

Add the 15-file B4 manifest and authorised assets, with a provenance note that
states their source, generation parameters, redistribution authority and B4-only
status. Tests must reject missing, extra, path-drifting or hash-drifting assets.

Implement one small audio player port and browser implementation. Consume
post-commit effects, expose replay/slow replay, and stop safely on pause,
rehydration and dispose. Test play rejection, interruption, stale completion and
rapid replay without changing durable round state.

Expected focused command:

```bash
node --test \
  tests/b4-audio-manifest.test.mjs \
  tests/b4-local-audio-player.test.mjs \
  tests/b4-round-controller.test.mjs
```

Exit: all five cards have exact local word, normal sentence and slow sentence
paths; both native bundles contain those exact bytes; runtime network access is
not used for scored audio.

### Task 3 — Build the five-card learner surface

Replace the normal diagnostic launch with the B4 product surface while retaining
explicit B2/B3 proof modes. Implement the real input, submit, replay, slow replay,
progress, feedback, retry and completion states. Keep product copy calm and free
of commerce pressure.

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
landscape usability. Preserve a visible focus indicator and 44 CSS-pixel minimum
targets.

The evidence screenshots demonstrate layout only; they are not final visual QA.
Do not migrate Monster art, production typography, final colours, navigation or
celebration assets in B4.

Exit: the same DOM and information order serves every viewport, and all controls
remain reachable without target leakage or horizontal obstruction.

### Task 5 — Add the measurable B4 budget harness

Implement one bounded measurement library and one report builder. It records raw
samples and derives percentiles without rounding a failure into a pass. Tests use
fixed samples to prove percentile and frame-budget calculations, schema
validation and fail-closed threshold decisions.

Measure the seven B4 proxies exactly as defined above. The five-minute frame run
may execute once per platform rather than once per viewport if all viewport
journeys separately pass.

Exit: deterministic calculation tests pass and real virtual/hosted runs emit
complete, internally consistent measurements. A missing sample or wrong count is
`NO_GO`, not `not applicable`.

### Task 6 — Prove the installed iOS vertical slice

Create a B4 XCUITest target or extend the existing owned UI-test target without
changing B3 evidence semantics. On supported hosted Simulator profiles:

1. install and cold-launch the normal unsigned app;
2. operate the labelled input with the software keyboard;
3. complete part of the five-card round;
4. background/foreground during audio;
5. terminate and relaunch;
6. prove the same committed session resumes;
7. complete the round exactly once;
8. exercise the Enter-key path;
9. capture phone and tablet portrait/landscape screenshots; and
10. record B4 performance and payload/database proxies.

The report records exact Simulator runtime and device types. No result is called
physical, signed or App Store evidence.

### Task 7 — Prove the installed Android vertical slice

Use the existing Android native project and owned instrumentation/UI automation
on hosted emulators. Execute the same journey and assertions as iOS, including
software keyboard, interruption, process death/relaunch, exact resume, Enter-key
path, phone/tablet screenshots and budget proxies.

Run a minimum API 24 launch/core-flow compatibility check and an API 36 product
journey where hosted images support them. Record actual image, ABI, API and device
profile. Do not substitute an emulator result for Play, signed distribution or
TalkBack physical-device truth.

### Task 8 — Gate B Development decision and integration

Regenerate the domain, iOS and Android reports from a clean candidate. Build the
aggregate report only when all required evidence exists and binds the same
candidate commit/tree and application bundle inputs.

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

Push the approved candidate, require hosted Domain/Web, iOS and Android jobs to
pass, merge through one ordinary PR, then require exact-main CI. Record one of:

- `GO`: the bounded Capacitor slice passes and no demonstrated WebView ceiling
  blocks C-series work; or
- `NO_GO`: preserve the evidence, stop Capacitor product work and write a React
  Native design grounded in the measured failure.

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

1. Normal iOS and Android builds launch the local B4 product slice; B2/B3 proof
   modes remain explicit and non-production.
2. One real five-card Starter round uses the existing A3 planner and SQLite
   transaction repository from start through completion.
3. Termination/relaunch resumes the exact committed session without skipping or
   double-advancing a card.
4. Fifteen exact, authorised B4 speech assets are bundled and verified; replay,
   slow replay and interruption work without runtime network or TTS.
5. Software-keyboard and Enter-key paths operate the same labelled input and
   submission action on both platforms.
6. Phone portrait, tablet portrait and tablet landscape remain usable on both
   virtual platforms.
7. B4 semantic, focus, Reduced Motion, 200% scaling, minimum-target and
   no-answer-leakage checks pass; physical screen-reader certification remains
   explicitly unclaimed.
8. All seven B4 performance/size proxies meet their sample counts and thresholds
   or the decision is `NO_GO`.
9. Existing domain, B1/B2/B3, native, dependency, privacy and offline-learning
   contracts remain green.
10. Reports and screenshots bind one candidate and contain no secret/private
    identity or live commerce/cloud claim.
11. Gstack, Matt and Ponytail approve the same exact candidate; exact-head and
    exact-main hosted CI pass.
12. The aggregate report states either `GO` or `NO_GO` with no ambiguous partial
    pass.

