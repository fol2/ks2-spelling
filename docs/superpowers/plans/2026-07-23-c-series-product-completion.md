# KS2 Spelling C-series product-completion plan — 2026-07-23

## Authority and outcome

This plan is the lean successor for continued product development after
`2fd0641`. It is governed by
`2026-07-23-b4-physical-proof-deferral-and-c-series-continuation.md` and does
not modify the hash-frozen B4 plan.

James has authorised completing the product before repeating physical iPhone,
signed-distribution, store and live-service proof. A C-series milestone may
therefore become development-GREEN without a fresh physical-device run, but no
such result may be described as release, store or iOS 27 device proof.

The development outcome is one frozen release-candidate checkpoint whose
installed code is complete, whose Starter 20 data and audio are complete, and
whose child and Parent journeys work from local authority. Task 22 then creates
fresh distributions and performs the deferred physical, accessibility,
acoustic, performance, signing, live-commerce and store proof against those
exact bytes.

## Permanent product boundaries

- Production mode is a first-class composition. It must never fall back to a B1,
  B2, B3 or B4 proof shell.
- SQLite is the local source of truth for profiles, practice, progress, Monster,
  Camp, installed packs and last verified entitlement.
- Child journeys contain no prices, purchase pressure, restore controls,
  download administration or Parent secrets.
- Application HTML and JavaScript remain installed. Production has no
  `server.url`, live reload, remote HTML, remote JavaScript or runtime speech
  fallback.
- Downloaded content is bounded signed data, verified before atomic local
  activation. Network, gateway and store failure cannot erase valid local
  learning state or an already installed pack.
- One learner's actions must not change another learner's bytes.
- Proof plugins and diagnostic shells remain build-mode isolated.
- Credentials, production signing material and store or service mutations stay
  behind James's later visible approval gates.

## Milestones

### C0 — production composition

- Add an explicit production service mode for iOS and Android.
- Open and migrate the production SQLite database and expose an honest
  recoverable bootstrap state.
- Select the production application in ordinary release builds while retaining
  exact B2, B3 and B4 proof modes.
- Keep the application usable without Cloudflare, R2 or store availability.

### C2A — profiles and selected-child authority

- Implement the asynchronous SQLite profile repository against the frozen A3
  profile contract.
- Persist the selected learner independently of React state.
- Support list, create, edit, select and delete with deterministic ordering,
  validation, transaction rollback and learner-data cascade.
- Remove the hard-coded `learner-a` production path. Preserve B2/B4 fixtures
  only inside their proof compositions.

### C1 — Starter 20 content and audio

- Derive the exact 840-asset inventory from the frozen 20-item catalogue:
  two approved British-English voices across word, normal-sentence and
  slow-sentence variants.
- Record engine, model, voice, redistribution and generation-input authority;
  generate deterministically and verify byte hashes, duration, format,
  loudness, silence, completeness and orphan absence.
- Assemble the production Starter 20 data-only pack in the existing bounded
  signed-pack format. The application may verify and install final signed bytes,
  but production signing material remains outside the repository and outside
  this development session.
- Provide an explicit recoverable state for absent or corrupt audio; never use
  device or network speech as fallback.

### V1 — visual, theme and asset authority

- Freeze a child-friendly visual direction, semantic colour and typography
  tokens, icon/illustration provenance, motion rules and phone/tablet layouts.
- Reuse or create repository-owned assets with recorded rights; do not depend on
  remote fonts or images.
- Define accessible focus, contrast, text scaling, reduced-motion and
  non-colour feedback rules before C3 child UI.
- Approve side-by-side reference frames for onboarding, child home, practice,
  feedback, results, Monster, Camp and Parent entry.

### C3 — complete child journey

- Implement first-run setup, profile picker, child home, practice configuration,
  spelling round, correction flow, result summary, progress, Monster rewards
  and Camp presentation.
- Make interrupted practice resumable from SQLite and make every loading,
  empty, offline, missing-audio and recovery state actionable.
- Keep semantic labels, Dynamic Type/text scaling, keyboard/switch reachability,
  VoiceOver/TalkBack order and reduced motion inside the component contracts.

### C2B — Parent security, administration and backup

- Add a local Parent gate with reviewed PIN and platform-biometric behaviour;
  child navigation must not reach Parent or commerce actions.
- Complete multi-child administration, reset/delete confirmation, retention,
  export/import and bounded backup recovery.
- Set the production database-at-rest and platform backup/device-transfer
  policy explicitly, migrate safely and prove rollback. Do not infer encryption
  or backup readiness from configuration alone.

### C4 — Parent progress, packs and commerce

- Present redacted local progress per child and separate it from motivational
  Monster/Camp state.
- Promote the existing purchase, restore, entitlement, download and pack
  recovery paths into the secured Parent surface.
- Preserve last verified active access and installed data during offline,
  timeout and gateway failure; only live store-verified revocation may lock paid
  access.

### C5 — release-candidate closure

- Close accessibility, performance, privacy, dependency, licence, legal copy,
  icons/splash, orientation, lifecycle, migration and failure-recovery work.
- Run the full local suites and both affected unsigned native compiles, then
  hosted exact-head CI. Resolve only evidence-backed failures.
- Obtain independent product-direction, engineering-completeness and simplicity
  reviews on one exact checkpoint, then freeze the release candidate.

### Task 22/23 — final real-world proof and release

After James separately approves the visible credential and external-mutation
gates, build fresh signed distributions from the frozen checkpoint and perform
the physical iPhone/iOS 27, approved real Android, VoiceOver/TalkBack, acoustic,
performance, live-commerce, download, store and exact-main evidence sequence.
Any application-byte change restarts the affected final proof.

## Integration checkpoints

Create one integration checkpoint after C2A, C1, C3 and C5. Each checkpoint must
record the exact commit, focused RED/GREEN evidence, `test:fast`, affected
compile/build results, independent verdict and remaining narrower gates. No
intermediate checkpoint grants release authority.
