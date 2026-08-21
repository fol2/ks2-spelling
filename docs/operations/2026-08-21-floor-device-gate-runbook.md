---
module: operations
tags:
  - ios
  - physical-device
  - deployment-target
  - floor-device
problem_type: operating-procedure
---

# Floor-device gate: owner-controlled physical and App Store Connect steps

Dated 2026-08-21. Written for
[E5.5 — Floor-device gate](https://github.com/fol2/ks2-spelling/issues/152)
after [#150](https://github.com/fol2/ks2-spelling/issues/150) fixed the version
number at `IPHONEOS_DEPLOYMENT_TARGET = 26.0`. This document is the checklist,
not the walk evidence.

The source tree now declares the deployment target, the exact floor-device
matrix, and optional App Store Connect API-key forwarding for
`scripts/prove-b4-ios-physical.mjs`. Those facts are **source composition**.
They are not a physical walk on iPhone SE (2nd generation) or iPad (8th
generation), not a signed archive, not TestFlight, and not an App Store
Connect record.

Do not fabricate or pre-create a success record. The committed
`reports/b4-physical/ios-physical-proof.json` remains the owner-iPhone
artefact (`iPhone 16 Pro Max` / iOS 27). It does not satisfy the floor-device
matrix.

## Who moves

| Role | Moves |
|---|---|
| **Owner** | Supply `KS2_ASC_*` in a visible shell if headless signing is required. Pair the floor devices. Toggle UI Automation. Run the physical harness on both floor machines. Write a dated evidence record after a real measurement. |
| **Never this document** | Keychain, certificates, provisioning profiles, signing keys, hidden terminal prompts for secrets, App Store Connect mutation, rewriting the committed owner-iPhone proof as if it were a floor-device walk. |

This walk is **owner-gated**.

## Lanes these cells are not

Keep these lanes distinct. A green result in one lane is not evidence for
another.

| Lane | What it can prove | What it cannot prove |
|---|---|---|
| unsigned Simulator build | Scheme `KS2Spelling` with `CODE_SIGNING_ALLOWED=NO`. Root `capacitor.config.json` pins `experimental.ios.spm.swiftToolsVersion` to `6.2` so Capacitor `cap sync` generates `CapApp-SPM/Package.swift` as `swift-tools-version: 6.2` plus `platforms: [.iOS(.v26)]`. That generated file is an output, not the authority. | Physical floor silicon; signed install; TestFlight |
| source / PBX contract | Every `IPHONEOS_DEPLOYMENT_TARGET` is `26.0`; the floor matrix is SE 2 and iPad 8 | That those devices were walked |
| committed owner-iPhone proof | Historical B4 physical capture on `iPhone 16 Pro Max` / iOS 27 | The performance floor |
| signed physical RC | A `KS2Spelling` / `Release` archive installed on hardware | Floor-matrix completeness unless both owned floor devices are the destination |
| App Store Connect API-key forwarding | `xcodebuild` received `-authenticationKey*` from owner-set env vars | That a signing identity, profile or store record exists |

An unsigned Simulator build is not a signed physical RC.
A signed physical RC is not an unsigned Simulator build.
The committed owner-iPhone proof is not floor-device evidence.
Source composition is not a physical walk.

## Owner-visible App Store Connect authentication

The physical verification script forwards optional owner-controlled
environment variables as `xcodebuild` flags next to
`-allowProvisioningUpdates`:

- `KS2_ASC_KEY_ID` → `-authenticationKeyID`
- `KS2_ASC_ISSUER_ID` → `-authenticationKeyIssuerID`
- `KS2_ASC_KEY_PATH` → `-authenticationKeyPath`

Set all three in the visible shell, or set none. A partial set fails closed
with a named error. The script does not read the keychain, certificates or
provisioning profiles to complete those values, and it does not accept
secrets from a hidden prompt. The `.p8` path is passed to `xcodebuild`; the
script does not load the key material.

Example, run by the owner only:

```sh
export KS2_ASC_KEY_ID='…'
export KS2_ASC_ISSUER_ID='…'
export KS2_ASC_KEY_PATH="$HOME/path-the-owner-controls/AuthKey_….p8"
export KS2_PHYSICAL_DEVICE_UDID='…'
node scripts/prove-b4-ios-physical.mjs
```

A single-device capture may write one of
`reports/b4-physical/ios-floor-iphone-se-2.json` or
`reports/b4-physical/ios-floor-ipad-8.json` and must report the matrix as
incomplete. It must not claim the pair is complete.

After both files exist, the executable gate is:

```sh
node scripts/prove-b4-ios-physical.mjs --check-floor-matrix
```

That command reads those two fixed paths. It fails closed until both are
valid schemaVersion 2 reports for the exact floor devices, share one
`applicationCheckpoint` commit and tree, and carry recorded comparators.
GREEN is a separate field: it stays false while time-to-interactive,
frame-rate and memory thresholds remain `pending-owner-adjudication`.

Device UDIDs are pairing material and are never committed. Both owned floor
devices are already registered to the account; the identifiers stay in the
#152 issue comment and are not copied into source.

## Hands-on device step

A first UITest run on a newly registered device requires the on-device
Settings → Developer → UI Automation toggle. That is a hands-on owner step,
not an agent action.

Floor hardware also needs pacing: back-to-back full journeys on iPad 8 have
stalled. Cool the device between series; do not treat a thermal flake as a
product pass.

## Remaining owner cells

1. Walk the product on **iPhone SE (2nd generation)** (375×667, A13, no notch).
2. Walk the product on **iPad (8th generation)** (810×1080, A12, non-laminated sRGB).
3. Verify the 320pt geometry floor at Slide Over and Split View on the iPad.
4. Score the existing physical comparators **and** the required
   time-to-interactive, frame-rate and memory comparators on both floor
   machines from a fresh measurement, writing
   `reports/b4-physical/ios-floor-iphone-se-2.json` and
   `reports/b4-physical/ios-floor-ipad-8.json`. Both reports must share the
   same `applicationCheckpoint` commit and tree. Do not retitle the committed
   owner-iPhone JSON as that evidence.
5. Frame-rate risk surfaces to measure: Phaser Monster Stage behind the
   Codex zoom, the celebration tier, and the ambient backdrop pan. Whatever
   else drops frames, **nothing may drop them during a question card**.
6. Adjudicate numeric thresholds for time-to-interactive, frame rate and
   memory. #141/#152 name those comparators but do not publish numbers; they
   stay `pending-owner-adjudication` and cannot score GREEN until the owner
   sets them.
7. Adjudicate the iPad 8 portrait two-column / 28rem practice-surface
   prediction against E5.2 after a real geometry walk.

Until those cells exist as a dated record under
`docs/records/<YYYY-MM-DD>-floor-device-gate.md`, this gate stays open.

## Dated evidence record

If and only if the owner completes the walk, create a new dated record. Do
not edit frozen `docs/records/**` in place.

```
Status: <unrecorded|RED|GREEN> at <full git SHA>
```

A GREEN verdict is allowed only in that dated record after both floor
devices are measured. This runbook must stay unrecorded and must not itself
carry a GREEN verdict.

### Exact evidence fields

The record's `## Evidence` section must contain every field:

| Field | What to write |
|---|---|
| git SHA | Full SHA of the artefact, not a short hash. |
| scheme KS2Spelling | Confirm the scheme. |
| configuration Release | Confirm the configuration. |
| IPHONEOS_DEPLOYMENT_TARGET | Must be 26.0 on the artefact. |
| Device A | iPhone SE (2nd generation), iOS version. |
| Device B | iPad (8th generation), iOS version. |
| reality | physical, not Simulator. |
| coldLaunch / answerFeedback / audioStart / sqliteTransactionUpperBound | Observed values from both machines. |
| timeToInteractive | Observed ms from launch until answer-path controls are enabled. Threshold pending owner adjudication. |
| frameRate | questionCardDroppedFrames (must be 0) plus fps on Codex-zoom Monster Stage, celebration tier, and ambient backdrop pan. fps threshold pending owner adjudication. |
| memory | peakBytes on each floor machine. Threshold pending owner adjudication. |
| Remaining gates | Anything still red. |

Closing paragraph (required), using the words **does not grant**: this
record does not grant store approval, does not close #152 by itself until
the owner says so on the issue, and does not claim an unsigned Simulator
build, the committed owner-iPhone proof, or source-only composition as
floor-device evidence.

## Current status of this gate

No dated floor-device evidence record exists. Physical proof on the floor
machines is unrecorded. Source composition, unsigned Simulator compile, and
the committed owner-iPhone artefact are narrower facts. They do not pass
this checklist.
