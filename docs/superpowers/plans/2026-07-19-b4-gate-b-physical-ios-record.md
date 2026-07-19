# Gate B Development record (physical iOS evidence) — 2026-07-19

This record lives outside
`2026-07-18-standalone-spelling-mobile-b4-capacitor-development-certification.md`
because that plan document is a hash-frozen authority input to the committed
`reports/b4/domain-round-proof.json`; editing it invalidates the B4 evidence
check. The plan text remains exactly as certified. It succeeds
`2026-07-19-b4-gate-b-development-record.md` under the same unchanged Task 8
trichotomy.

Result: `INCOMPLETE` — physical iOS evidence gathered; three comparator
breaches persist as attributed product seams.

Integrated candidate: `ba55611` (harness `c468600`, physical evidence
successor `f26a580`, CI-contract amendment `4e46527`, mechanical
`reports/b4` refresh `ba55611`), merged to `main` as `a6ba8a1` through
PR #12. Governing plan and pinned findings:
`2026-07-19-b4-gate-b-physical-ios-evidence.md`. Evidence:
`reports/b4-physical/ios-physical-proof.json` (application checkpoint
`c468600`, iPhone 16 Pro Max, iOS 27.0, Release, Xcode 26.6 RC /
SDK `iphoneos26.5`) and `reports/b4-physical/smoke.json`. Gstack, Matt
(Standards and Spec, independent recomputation of every findings figure)
and Ponytail approved the same exact candidate; exact-head hosted CI
passed on `ba55611` and exact-main on `a6ba8a1`.

`INCOMPLETE`, not `GO`, because the frozen journey passes on the physical
device and `sqliteTransactionUpperBound` settles (27.664 ms against
≤ 50 ms), but three comparators still breach on hardware: `coldLaunch`
3453/3711/4062 ms against ≤ 2000 ms, `audioStart` 1745–1840 ms on the
slow-variant replay against ≤ 250 ms, and `answerFeedback` 725–859 ms
against ≤ 100 ms. Not `NO_GO`, because no reproduced, attributed,
disproportionate WebView ceiling is demonstrated: every breach is
attributed to a product seam — per-variant audio decode on the replay
path, first-launch work on the cold path, and feedback publication
ordering — so B4 continues on Capacitor without selecting another
framework.

Scope decisions of record: physical evidence is iOS-only. The programme
owner (James, 2026-07-19) has decided no physical Android device will
ever be available; Android comparators remain attributed-on-virtual-only
and Android real-device settlement is deferred to Task 22 through an
approved hosted-real-device service. No unqualified dual-platform claim
is made.

Explicitly unclaimed: signed-store distribution, VoiceOver, TalkBack,
acoustic and store-download certification; Android physical evidence;
hosted-runner execution of the installed journeys. Toolchain obligation
carried forward: the identical source built against the iOS 27 SDK
crashes at launch on an iOS 27 device (UIScene lifecycle-adoption
runtime check); device builds pin Xcode 26.6 RC. UIScene adoption is a
recorded C-series obligation.

Next required step before any `GO`: resolve the three attributed seams —
warm or pre-decode the slow audio variant on the replay path, publish
answer feedback before the deferred work that delays it, and trim
first-launch work on the cold path — then re-run
`scripts/prove-b4-ios-physical.mjs` on the same device class and re-run
the Task 8 gates on the resulting candidate.
