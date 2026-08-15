---
module: compliance
tags:
  - store-release
  - kids-category
  - parent-access
  - support
problem_type: standing-position
---

# Parent access setup and recovery

Date: 15 August 2026

Owner: KS2 Spelling maintainer

This document records the Parent PIN setup and recovery mechanism implemented by
E4.2 / [#190](https://github.com/fol2/ks2-spelling/issues/190), following the
wayfinder decision in
[#140](https://github.com/fol2/ks2-spelling/issues/140). It is the support and
App Review explanation for the parental gate.

## What the gate protects

The six-digit Parent PIN protects the Parent area, including:

- learner administration and destructive learning resets;
- learning backup import and export;
- purchase, restore and paid-pack download controls; and
- the opt-in biometric quick-unlock setting.

The child learning experience remains usable while Parent access is locked.
Price, Buy, Restore Purchases and learner-administration controls do not render
on the locked surface.

## First setup

A proposed PIN is not self-authorising.

1. The adult enters and confirms a valid six-digit PIN.
2. The app asks the operating system to authenticate the device owner.
3. Only after a successful operating-system result does the app derive and
   persist the PIN verifier.
4. The Parent session opens only if the app remained active while the operation
   completed.

The operating-system request contains one bounded display reason. The PIN,
learner identifiers, nicknames, purchase identifiers, URLs and learning data do
not cross the native bridge.

If the device has no screen-lock credential, or the prompt is cancelled or
rejected, no Parent credential is written and the app remains in
`setup-required` state. The UI explains that a device screen lock is required.

## Forgotten PIN recovery

The locked Parent surface exposes **Forgot Parent PIN?**. Recovery collects a
new PIN and confirmation, then performs a fresh device-owner authentication.
Successful recovery:

- replaces only the Parent PIN credential;
- clears failed-PIN and timed-lock counters;
- preserves the existing opt-in biometric preference;
- preserves every learner profile, spelling snapshot, active pack and backup;
- preserves the store transaction journal and entitlement state; and
- opens the Parent session unless the app paused while recovery was in flight.

A cancelled, rejected, unavailable or malformed native result preserves the
previous credential and lock state exactly. A credential-derivation or durable
write failure also remains locked and reports that the PIN was not changed.

## Purchases are not recoverable through this path

PIN recovery is not purchase recovery. It does not create, restore or activate
an entitlement and it does not write the transaction journal.

After the Parent area has opened, **Restore purchases** continues through the
existing StoreKit or Play purchase workflow. That store-backed path is the only
way to recover a purchase on a fresh installation.

## Platform implementation

The existing native `ParentAccess` plugin carries two separate authorities:

- biometric-only, opt-in quick unlock; and
- device-owner authentication for PIN bootstrap and recovery.

On iOS the owner route uses `LAPolicy.deviceOwnerAuthentication`, allowing the
platform to apply its biometric or device-passcode policy.

On Android 11 and later the prompt allows `BIOMETRIC_STRONG |
DEVICE_CREDENTIAL`. On the repository's Android 7–10 compatibility range, the
app checks `KeyguardManager.isDeviceSecure()` and uses AndroidX Biometric's
credential-compatible prompt path. This avoids requesting the unsupported
strong-biometric-plus-device-credential combination on Android 9 and 10.

Only one `ParentAccess` authentication may be in flight. A quick-unlock prompt
and a setup/recovery prompt cannot overlap.

## Threat-model limit

The app can prove only that the operating system accepted a credential it treats
as the device owner's. It cannot prove biological parenthood or distinguish
family members who legitimately share that credential.

A child who already knows the shared device passcode, or whose biometric is
enrolled as a device owner, is trusted by the operating system. Support and
review notes must not claim otherwise. Families who need a stronger separation
must keep the device credential private and enrol only adults for device-owner
biometrics.

An arithmetic question is deliberately not used as the primary gate. This
product is designed for 9–11-year-olds, so a maths task would create the
appearance of an adult check without establishing an adult authority.

## Failure behaviour

The following all fail closed:

- no device screen lock;
- user cancellation or failed authentication;
- malformed or over-broad bridge request or response;
- two concurrent native prompts;
- app pause while setup or recovery is in flight;
- PIN-derivation failure; and
- persistence failure.

No failure deletes learners, learning, packs or purchase records. No failure
makes Buy or Restore reachable.

## App Review route

1. Open **For parents**.
2. On first launch, enter and confirm a valid six-digit PIN.
3. Complete the operating-system device-owner prompt.
4. The Parent area opens, exposing the purchase and restore controls.
5. To inspect recovery, close the Parent area, reopen it, choose **Forgot Parent
   PIN?**, enter a replacement PIN and complete a new device-owner prompt.

The review device must have a screen-lock credential configured. Review notes
should state that this requirement is intentional and that the learner app
remains functional when Parent setup is unavailable.

## Verification map

- Controller and race behaviour:
  `tests/parent-security-controller.test.mjs`
- Real locked-surface boundary after rejected setup:
  `tests/parent-access-boundary.test.mjs`
- JavaScript native-port validation:
  `tests/parent-device-authentication-port.test.mjs`
- iOS and Android native contract:
  `tests/parent-biometrics-native-contract.test.mjs`
- Locked and unlocked Parent renders:
  `tests/app-shell.test.mjs`

Native changes require the full three-job B4 continuous-integration workflow
before review.
