# B4 physical iOS re-measurement (seam fixes follow-up) — 2026-07-24

This record documents a physical iOS device re-run following the seam fixes merged to `main` as PR #24 (2026-07-24). It succeeds `2026-07-19-b4-gate-b-physical-ios-record.md` as measurement follow-up only and makes no pass/fail claim on the three application thresholds. It is development evidence only, not final-candidate Task 22 evidence.

This re-measurement does not alter the owner `GO` decision of `2026-07-23-b4-owner-go.md`. It does not relabel any historical evidence or the recorded `investigation-required` technical outcome. The three attributed seams have been addressed in code; this record observes their application-side impact under the same external timing method.

## Run

**Candidate:** `main` commit `46ff00b` (merge commit of PR #24). Physical evidence regenerated from `reports/b4-physical/ios-physical-proof.json` (evidence-only commit `dc79325` immediately before this record). The July-19 evidence figures remain pinned in git history at the prior revision of the same path.

**Toolchain:** MacBook Pro, macOS 27.0 (26A5388g; host advanced from 26A5378n since July 19), Xcode 26.6 RC (17F109), SDK `iphoneos26.5`, Release build. Device: iPhone 16 Pro Max, iOS 27.0, fresh install per run.

**Method:** Three journey runs (the frozen journey three times), one split-timing run (replayToAudioPlayingVisibleMs and submit→feedback instrumentation on the same ten answers), one isolated SQLite measurement. All four device runs completed without error.

## Figures

External comparator maxima (external XCUITest method, thresholds and interpretation unchanged):

| Comparator | Threshold | July-19 Pre-fix | 2026-07-24 Post-fix | Outcome |
|---|---|---|---|---|
| `coldLaunch` | ≤ 2000 ms | 3453 / 3711 / 4062 | 5394 / 4420 / 5083 | worse by ~1.0–1.3 s |
| `audioStart` | ≤ 250 ms | max 1839.6 | max 621.4 | improved |
| `answerFeedback` | ≤ 100 ms | max 858.9 | max 919.5 | unchanged (method floor) |
| `sqliteTransactionUpperBound` | ≤ 50 ms | 27.664 | 24.843 | settled |

**Audio start detail (post-fix):** Journey pairs [Replay, Slow replay] ms: [621, 412], [506, 431], [495, 389]. Pre-fix, slow-variant replay was 1745–1840 in every journey; post-fix, both paces fall into the pre-fix normal-variant band (472–634).

**Split-timing replayToAudioPlayingVisibleMs (post-fix):** Eight small-asset answers 385–471 ms (pre-fix 391–465, unchanged). Two large sentence-dictation answers 976 / 1073 ms (pre-fix 1526 / 1536 ms). The split helper backgrounds the app before every answer, flushing audio caches; the halving reflects Web Audio decode replacing the cold element path.

**Split-timing submit→feedback (post-fix):** 829–1106 ms across ten answers (pre-fix 849–881). The split poller runs every ~2 ms; the consistency across both eras indicates this floor is the tap-synthesis and WKWebView accessibility-snapshot cost of the method, not poller granularity. Roughly 8.5× the 100 ms threshold.

**Critical revision on answerFeedback attribution:** In both July-19 and July-24 split captures, `audioPlayingVisibleEpochMs` is −1 (audio never externally visible before feedback) on all ten answers. A correct-answer submission emits no audio cue; the pre-fix submit path therefore never contained an audio wait. The July-19 attribution of the answerFeedback breach to feedback publication ordering is revised: the external figure was and remains dominated by the method floor. The merged reordering (enforced by unit contract in PR #24) is unobservable by this external method.

**Cold launch (post-fix):** externally worse by roughly 1.0–1.3 s in every run (5394 / 4420 / 5083 against 3453 / 3711 / 4062). Candidate attributions, none proven: the new loading shell introduces an intermediate accessibility state ("Getting ready") before the measured heading, adding a settle/poll cycle to the `XCTNSPredicateExpectation` waiter; the host macOS beta build changed between runs (26A5378n → 26A5388g); run-to-run device variance. Under `docs/architecture/product-performance-authority.md` this journey has no correlated owned boundaries and is unscored — not slow and not fast. The simulator resume-state capture at the same change moved in the opposite direction (4562 → 3778 ms), reinforcing that the external figure composes non-application time. Resolution belongs to the owned-span measurement work.

## Consequence

**Audio decode seam is closed on hardware.** The one comparator movement the external method can observe under the same threshold interpretation is the `audioStart` improvement. Pre-fix slow-variant replay spent 1745–1840 ms waiting for Web Audio decode; post-fix it sits at 412–431 ms, aligned with the normal-variant band.

**SQLite comparator remains settled.** The transaction bound at 24.843 ms is stable and well within the 50 ms threshold across both measurement eras.

**External method's measurement composition is now demonstrated.** The answerFeedback and coldLaunch figures remain unchanged or worsened despite app-side changes (reordering and loading shell), confirming that the external method does not isolate application seams but instead composes non-application time. The three application thresholds remain unscored pending the owned-span measurement authority work as deferred by the 2026-07-23 owner record.

**B4 remains `GO` per the owner record.** This measurement does not reopen the owner decision. The obligations carried forward by the 2026-07-23 deferral record and owner `GO` — the owned-span measurement authority before any final performance acceptance, and the final Task 22/23 checkpoint claims — are unchanged.

## Unclaimed

- Signed iOS distribution, VoiceOver, TalkBack, acoustic or store-download certification.
- Android physical device evidence; Android comparators remain attributed-on-virtual-only.
- Hosted-runner execution of the installed journeys.
- Fresh final performance evidence for Task 22 acceptance. This is development evidence and application-seam characterisation only.
