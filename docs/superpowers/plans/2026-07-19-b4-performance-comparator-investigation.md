# B4 performance comparator investigation

## Objective

Attribute every `investigation-required` observation in the merged B4 evidence
(`reports/b4/ios-simulator-proof.json`, `reports/b4/android-emulator-proof.json`
at candidate `3935a0e`) to an owning seam with one independent reproduction
each, then either clear or uphold the concern so Gate B Development can move
from `INCOMPLETE` to an honest `GO` or `NO_GO`. No journey narrowing, no
threshold relabelling, no statistical-certification claim.

## Authorities

- Gate B Development record (`INCOMPLETE`, 2026-07-19) in
  `docs/superpowers/plans/2026-07-18-standalone-spelling-mobile-b4-capacitor-development-certification.md`
- Comparators: frozen source design section 18 via
  `src/app/b4-development-report.js` `RISK_DEFINITIONS`
- Evidence base: merged `main` commit `0daa0cc` (candidate `3935a0e`,
  checkpoint `9f4820e`)

## Observed breaches to attribute

| Observation | iOS raw | Android raw | Comparator |
|---|---|---|---|
| coldLaunch | 5502 ms | 3677 ms | ≤ 2000 ms |
| answerFeedback ×10 | 500–787 ms | 927–2680 ms | ≤ 100 ms |
| sqliteTransactionUpperBound ×10 | same raw values | same raw values | ≤ 50 ms |
| audioStart ×2 | 1588, 391 ms | 504, 315 ms | ≤ 250 ms |

`nativePayload` and `localDatabase` pass and are out of scope.

## Hypotheses to test (each needs one independent reproduction)

1. **Measurement composition owns most of the answerFeedback breach.**
   `src/app/b4-round-controller.js` `runCommand` awaits `playCue()` — which
   resolves only on the audio element `playing` event — before `publish`.
   Submit-to-render therefore structurally includes audio-start latency, and
   `sqliteTransactionUpperBound` reuses the same raw series, so neither
   measures its labelled seam in isolation.
   Reproduction: a Node-level timing harness that runs the frozen B4 command
   trace against the real SQLite repository with a no-op audio player and
   records per-command transaction plus apply time. If the isolated
   transaction time is comfortably inside 50 ms, the breach attributes to
   composition, not SQLite or the WebView.
2. **Debug builds on virtual devices own the coldLaunch breach.**
   The journeys ran Debug configuration on Simulator/emulator. Reproduction:
   measure cold launch of the same bundle in Release configuration on the
   same virtual devices, recorded beside the Debug number. No threshold is
   redefined; the comparison is attribution evidence only.
3. **Audio element start latency owns the audioStart breach.** The first
   observation (fresh player) is 3–5× the second on both platforms.
   Reproduction: the Node/WebView-level player timing split — element
   creation, `src` set, `play()` call, `playing` event — to locate the
   dominant interval.

## Tasks

1. Build the isolated timing harness (`scripts/investigate-b4-performance.mjs`
   plus one focused test) reusing the frozen trace from
   `src/app/b4-round-contract.js`. No product-code changes in this task.
2. Run reproductions 1–3; write one investigation report
   (`reports/b4/performance-investigation.json` + a short findings section in
   this plan) recording raw numbers, attribution, and the owning seam for each
   breach. Fail closed: any unattributable breach stays
   `investigation-required`.
3. Decision from evidence only:
   - all breaches attributed to measurement composition or virtual/debug
     environment, with isolated seams inside comparators → propose the
     minimal product correction if one is owed (for example publishing state
     before awaiting audio, if the design intends feedback to render before
     audio starts) as its own gated candidate; otherwise record attribution
     and re-run Task 8 gates for `GO`;
   - a reproduced, attributed, disproportionate WebView ceiling →
     `NO_GO` path per the B4 plan.
4. Any code change creates a new exact candidate: full Task 8 local gate,
   fresh Gstack, Matt and Ponytail approvals, exact-head and exact-main CI,
   and a fresh sequential proof cycle before any Gate B re-record.

## Boundaries

- Learner practice stays local/offline; no TTS, no runtime network.
- No comparator, journey, or evidence-schema change to force a result.
- Task 22 / C-series scope stays out.
- Virtual-device limitation language stays in every report.

## Review gates

The exact plan candidate requires Gstack (scope and contract), Matt
(Standards and Spec) and Ponytail (minimum credible investigation) approval
before Task 1, and the same three gates on any resulting code candidate.
