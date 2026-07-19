# B4 Gate B physical iOS evidence

## Objective

Measure the frozen B4 journey and the four breached comparators on one
physical iPhone in Release configuration, then convert Gate B Development
from `INCOMPLETE` to an honest `GO` or `NO_GO` under the unchanged Task 8
semantics. No journey narrowing, no threshold relabelling, no optimisation
work: this cycle produces measurement evidence and a decision, nothing else.

## Authorities

- Programme: `2026-07-09-standalone-spelling-mobile-programme.md`; design
  spec `../specs/2026-07-09-standalone-spelling-mobile-application-design.md`.
- Decision semantics: hash-frozen B4 plan
  (`2026-07-18-standalone-spelling-mobile-b4-capacitor-development-certification.md`,
  Task 8) — never edited; decisions land in dated successor records.
- Prior state: Gate B record (`INCOMPLETE`,
  `2026-07-19-b4-gate-b-development-record.md`) and the completed
  comparator investigation
  (`2026-07-19-b4-performance-comparator-investigation.md`), which
  attributed every breach but resolved none on virtual devices and
  concluded only physical-device evidence can settle the comparators.
- Comparators: frozen source design section 18 via
  `src/app/b4-development-report.js` `RISK_DEFINITIONS` — unchanged.

## Device and host

- Device: an iPhone 16 Pro Max (iPhone17,2) paired to the MacBook Pro,
  addressed through the `KS2_PHYSICAL_DEVICE_UDID` environment variable.
  The device identifier is pairing material: it is held locally on the
  host and never committed.
- Host: MacBook Pro (`ssh jamesto@macbookpro.lan`), repo checkout
  `~/Coding/ks2-spelling`, valid `Apple Development` identity, project
  team `V45S7U2LZB` already configured. Development signing here is an
  install mechanism only; it claims nothing about distribution.
- The device must be connected, unlocked, with Developer Mode enabled;
  James attends the first install for the trust prompt. Runs preflight
  device availability (`xcrun devicectl list devices`) and fail fast when
  the device is unavailable, preserving any partial evidence.
- The known macOS 27 beta simulator keyboard failure on this host is
  believed simulator-only; Task 1 proves that assumption on the physical
  device before any measurement work builds on it.

## Comparators to settle (virtual-device raw values for reference)

| Observation | iOS virtual raw | Comparator |
|---|---|---|
| coldLaunch | 5502 ms Debug / 11837 ms Release fresh-simulator | ≤ 2000 ms |
| answerFeedback ×10 | 500–787 ms (one isolated 2078 ms tail) | ≤ 100 ms |
| sqliteTransactionUpperBound ×10 | series reuse; isolated max 29 ms | ≤ 50 ms |
| audioStart ×2 | 1588 ms original / 1663–1708 ms reproduction fresh; 327–631 ms warm | ≤ 250 ms |

## Tasks

1. **Device smoke.** On the MBP, build the app dev-signed for device
   (`xcodebuild -configuration Release -destination generic/platform=iOS`),
   install and launch on the device (`xcrun devicectl device install app` /
   `xcrun devicectl device process launch`), and run one existing
   `B4DevelopmentTests` method via
   `xcodebuild test -destination id=$KS2_PHYSICAL_DEVICE_UDID`.
   No product-code change. Records a short smoke entry (tool versions,
   signing identity name only — no keys or profiles committed) under
   `reports/b4-physical/`. If the smoke fails for host or signing reasons,
   stop and report before building anything further.
2. **Physical proof harness.** Add `scripts/prove-b4-ios-physical.mjs`
   plus one focused shape test `tests/b4-physical-evidence.test.mjs`.
   Reused as-is: `investigationError`, `roundMs`,
   `createInvestigationRunner` and `exactAttachment` from
   `scripts/lib/investigation.mjs`, and the layout validators
   (`validateB4IosLayoutDimensions`, `measuredB4IosTextScale`) from
   `scripts/prove-b4-ios.mjs`. The device build/test arguments are new:
   `createB4IosXcodeTestArguments` hard-codes Debug configuration, a
   Simulator destination and disabled code signing, so it is not reused.
   The harness runs, in Release configuration on the physical device:
   the frozen B4 journey unchanged; the split-timing instrumentation for
   `answerFeedback` and `audioStart`; a repeated cold-launch measurement
   (terminate, relaunch from cold); and the isolated SQLite transaction
   check already proven at 29 ms. All journey and split-timing
   observations are extracted exclusively from xcresult attachments; the
   harness never polls the on-device application database (the simulator
   split harness's SQLite polling does not transfer to a physical
   device). The heavier Task 22-reserved
   `scripts/lib/b3-physical-device-transport.mjs` launch-identity
   protocol is explicitly not used.
3. **Evidence and decision.** Write
   `reports/b4-physical/ios-physical-proof.json` mirroring the
   `reports/b4/ios-simulator-proof.json` shape (runner metadata,
   platform, journey observations, layout, platform risk report) with
   device model, OS version and build configuration added, plus the
   split-interval and launch series. Add a Findings section to this
   plan. Then record the decision in a dated Gate B successor doc under
   the unchanged Task 8 trichotomy:
   - `GO`: the journey passes on the device and every breached comparator
     settles — inside its threshold, or with its labelled seam inside the
     threshold and the excess owned by already-attributed measurement
     composition;
   - `NO_GO`: a reproduced, attributed, disproportionate WebView ceiling
     persists on physical hardware;
   - `INCOMPLETE`: every other outcome — including a usable device path
     whose comparator breaches persist without a demonstrated
     disproportionate ceiling (still needs investigation), and an
     unusable device path — with all evidence preserved.
   Any recorded `GO` is explicitly iOS-physical-scoped: the record states
   that Android comparators remain attributed-on-virtual-only, that no
   physical Android device will ever be available (programme owner
   decision, James, 2026-07-19), and that Android real-device settlement
   is deferred to Task 22 through an approved hosted-real-device
   service. C-series authorisation on that narrowed footing is recorded
   as the owner's explicit decision in the same doc; no unqualified
   dual-platform claim is made anywhere.
4. **Integration.** Two commits on one PR: first the harness candidate
   (`scripts/prove-b4-ios-physical.mjs`,
   `tests/b4-physical-evidence.test.mjs`) passing the full local gate
   (`npm test`, `npm run lint`, `npm run build`,
   `npm run native:sync:check`, `npm run audit:dependencies`,
   `git diff --check`); then the evidence-only successor whose
   `git diff --name-only` against the harness candidate is exactly the
   declared `reports/b4-physical/` paths. Gstack, Matt (Standards+Spec)
   and Ponytail approvals on the exact final candidate; PR; hosted CI
   green; exact-main CI; only then the Gate B record. Any P1/P2
   correction creates a new exact candidate and invalidates all
   approvals.

## Boundaries

- No Task 22 scope: no store consoles, no Cloudflare/R2, no signed
  distribution claims, no hash-chained physical observation protocol.
- The phone receives app install/launch/terminate/uninstall only; no
  personal data is read; learner data lives in the app container and
  leaves with the app.
- Learner practice stays local/offline; no comparator, journey or
  evidence-schema change to force a result.
- `reports/b4` (pinned virtual evidence) is never touched; physical
  evidence lives only under `reports/b4-physical/`.
- Never commit signing keys, provisioning profiles, or device pairing
  material; the committed metadata is limited to device model, OS
  version, and build configuration.

## Review gates

The exact plan candidate requires Gstack (scope and contract), Matt
(Standards and Spec) and Ponytail (minimum credible physical proof)
approval before Task 1, and the same three gates on the resulting
evidence candidate before the Gate B record.

## Findings (2026-07-19)

Every figure below is pinned to
`reports/b4-physical/ios-physical-proof.json` (application checkpoint
`c468600`, iPhone 16 Pro Max on iOS 27.0, Release configuration, built
with Xcode 26.6 RC / SDK `iphoneos26.5`), which lands in the
evidence-only successor commit immediately following this edit. All
journey and split-timing observations were extracted exclusively from
xcresult attachments (`b4-ios-journey-observations.json`,
`b4-ios-split-timing.json`), exported via
`xcrun xcresulttool export attachments` and matched by
`suggestedHumanReadableName` prefix — no on-device database polling.

Toolchain finding (`reports/b4-physical/smoke.json`): the identical
source built against the iOS 27 SDK (Xcode 27 beta) crashes at launch on
the iOS 27 device (`EXC_BREAKPOINT` in the UIScene lifecycle-adoption
runtime check); built with Xcode 26.6 RC (SDK 26.5) it passes. UIScene
adoption is a recorded C-series obligation. Simulators never exposed
this because they run the iOS 26.5 runtime.

Three full journeys plus one split-timing journey ran on the device,
fresh install per run, so every cold launch is first-launch-after-install
(the frozen journey requires a fresh round state). All four runs
completed; layout, keyboard, Enter-submit, background-audio-stop and
resume checks all passed on the physical device.

| Comparator | Physical Release observed | Virtual reference | Verdict |
|---|---|---|---|
| sqliteTransactionUpperBound (≤ 50 ms) | 27.664 ms isolated | 29 ms isolated | settled — within |
| coldLaunch (≤ 2000 ms) | 3453 / 3711 / 4062 ms | 5502 ms Debug / 11837 ms Release fresh-simulator | breach persists (~2×) |
| audioStart (≤ 250 ms) | 472–634 ms normal replay; 1745–1840 ms slow-variant replay | 1588–1708 ms fresh / 327–631 ms warm | breach persists |
| answerFeedback (≤ 100 ms) | 725–859 ms across all thirty answers | 500–787 ms (one 2078 ms tail) | breach persists |

Physical-versus-virtual behaviour, per comparator:

- `sqliteTransactionUpperBound` behaves identically to virtual (27.664 ms
  against 29 ms) and is settled; the SQLite path carries no
  physical-device concern.
- `coldLaunch` behaves the same way as virtual but roughly 3× faster
  than the virtual Release figure; the breach is real product latency,
  not a simulator artefact, and all three observations are
  first-launch-after-install.
- `audioStart` behaves differently on hardware: virtually, the first
  play was slow (1588–1708 ms) and warm replays fast (327–631 ms); on
  the device the normal-variant replay is 472–634 ms while the
  slow-variant replay is 1745–1840 ms in every journey. The cost tracks
  the asset variant, not element warm-up — pointing at per-variant
  decode on the replay path. The split-timing journey shows the same
  split (replay-to-audio 391–465 ms on eight answers, 1526–1536 ms on
  the two answers that hit the slow-variant path).
- `answerFeedback` behaves the same way as virtual at slightly higher
  values: 725–859 ms externally observed against a ≤ 100 ms internal
  seam, confirmed by the split-timing journey (submit-to-feedback
  849–881 ms on the same answers).

Tail behaviour: no isolated outlier occurred in the committed runs (the
worst of thirty submit-to-feedback observations is 859 ms). A superseded
measurement run — regenerated when the committed identifier scrub
rewrote the branch, and therefore not part of the committed evidence —
once recorded a single 60.6 s submit-to-feedback outlier that did not
reproduce; it is noted here only so the observation is not lost.

Consequence under the unchanged Task 8 trichotomy: the journey passes on
the physical device and one comparator settles, but three breaches
persist and no reproduced, attributed, disproportionate WebView ceiling
is demonstrated — every breach is attributed to a product seam (audio
asset decode on replay, first-launch work on the cold path, feedback
publication ordering). That is the `INCOMPLETE` outcome; the formal
decision lands in the dated Gate B successor record after integration.

