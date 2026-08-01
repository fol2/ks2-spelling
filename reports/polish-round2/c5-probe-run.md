# C5 practice-probe run — slice 4.1 evidence

Date: 1 August 2026. Machine: James's MacBook Pro, Xcode 26.6.0 release candidate.
Simulator: KS2 Polish iPhone 17 (`76770E0C-F6EF-4DE7-859A-9C2972D91B6B`), iOS 26.5,
freshly erased before each evidential run. App composition verified before build:
`ios/App/App/public/index.html` contains no `B4Development|B3SandboxProof`; bundle
id `uk.eugnel.ks2spelling`.

## What slice 4.1 changed

`C5ProductLayoutTests.swift` no longer waits on `staticTexts["Vocabulary set"]`
to decide Setup has appeared — static texts materialise late in WKWebView
accessibility, and a Guardian-due Setup renders no vocabulary rail at all
(`tests/app-shell.test.mjs` pins `doesNotMatch(dueSetupHtml, /Vocabulary set/)`).
The wait now anchors on `buttons["Back to the trail"]`, the setup chrome's
unconditional control. `tests/c5-practice-probe-wait.test.mjs` pins the new wait
and forbids the old one.

## Runbook corrections discovered

The README's C5 runbook omitted two steps this run surfaced:

1. **Install is not implied.** `xcodebuild test -scheme B3ProofUITests` builds the
   runner but does not install the product app; on an erased simulator every
   launch-dependent case fails with `FBSApplicationLibrary returned nil`. Install
   the built product first:
   `xcrun simctl install <udid> <DerivedData>/Build/Products/Debug-iphonesimulator/App.app`.
2. **Per-test provisioning differs.** `testProductLargeTextProfilePicker`
   requires the simulator preference set to the maximum accessibility size
   (`xcrun simctl ui <udid> content_size accessibility-extra-extra-extra-large`)
   and fails by design at the default. The two keyboard probes run at the default
   size. `testProductTabletLayouts` requires an iPad destination and fails by
   design on iPhone. Change `content_size` only while the simulator is otherwise
   idle, then relaunch cleanly — flipping it live between tests left SpringBoard
   unsettled and produced spurious launch failures until the next erase.

## Results (round-2 head, after install and provisioning)

| Test | Result | Notes |
|---|---|---|
| testProductLargeTextProfilePicker | PASSED (18.4s) | Under accessibility-XXXL provisioning |
| testProductNicknameFieldRaisesSoftwareKeyboard | PASSED (15.9s at XXXL; PASSED again on erased sim at default size) | Software keyboard raises with hittable letter keys on the profiles surface |
| testProductPracticeFieldKeepsSoftwareKeyboardAcrossReturn | Wait swap PROVEN; final assert fails environmentally (see below) | The probe now traverses Setup via the new wait and reaches the Practice field on every run |
| testProductTabletLayouts | Requires iPad destination | Fails by design on an iPhone run; unchanged by this slice |

## The practice-probe hittability finding — pre-existing, not a round-2 regression

On this machine the practice probe reaches the Practice field, taps it, a
software keyboard appears, and the letter key `a` EXISTS — then the stricter
`isHittable` refinement fails ("The software letter row exists but is not
hittable", `C5ProductLayoutTests.swift:130`). Reproduced identically at the
default text size on a freshly erased simulator.

**Control experiment:** the identical probe binary was run against the app built
from `main @ 29b2e58e` (round-1 ship, built in a clean worktree, installed on a
freshly erased simulator). It fails at the same assert, same line, same message
(45.2s). The finding therefore predates every round-2 change.

Adjacent facts that bound the finding:

- The same `requireSoftwareLetterKeys` helper PASSES on the profiles surface
  (nickname test) in the same environment — keyboard presence, letter keys and
  hittability all hold there.
- The incident this class guards against (input assistant with NO letter rows)
  is NOT reproduced: letter keys exist on every run.
- The four keyboard invariant suites are byte-identical to `29b2e58e` and pass
  11/11 at every slice of this round.
- RoundScreen's JSX is byte-identical to `29b2e58e` for the whole round.

Disposition per repo doctrine (compile-evidence in CI, decisive assertions on
device): recorded here as an environment-conditioned simulator finding on the
iOS 26.5 runtime under Xcode 26.6 RC XCUITest hit-testing; NOT ad-hoc patched.
The physical-device checklist (slice 4.2) remains the decisive authority for
Practice keyboard behaviour and exercises the same helper on real hardware.

## Raw logs

Scratchpad logs from the runs behind this note: `41-c5-probe.log` (no install —
runbook gap), `41-c5-probe-2.log` (installed, XXXL), `41-c5-probe-3.log` (live
content_size flip — invalid, SpringBoard unsettled), `41-c5-probe-4.log`
(clean-room, default size), `41-c5-control.log` (29b2e58e control).
