# Native development and B2 verification

This runbook covers the B1 native shell plus the B2 local persistence and
lifecycle gates. Passing them proves the reviewed virtual-device boundary; it
does not mean the application is signed, store-ready or ready for release.

## Required local toolchain

- Node.js `24.18.0` and npm `11.16.0`;
- Xcode 26 or newer, with the iOS 26.5 Simulator runtime;
- Android Studio's bundled JBR 21;
- Android API 36, Build Tools 36.0.0, platform tools and emulator; and
- at least 25 GiB free disk space before native work, with 50 GiB recommended.

Run `npm ci`, then use `npm run native:doctor -- --strict` to verify the exact
local state. Never accept SDK or store licence terms on somebody else's behalf.

## Complete local B1 gate

A clean checkout does not contain Capacitor's ignored synced outputs. Materialise
and verify them before running the test suite so the Task 9 fingerprint covers
the same native packaging inputs that Xcode and Gradle consume.

```sh
npm ci && \
npm run native:doctor -- --strict && \
npm run native:sync:check && \
npm test && \
npm run lint && \
npm run build && \
npm run verify:vendor && \
npm run test:ios && \
npm run test:android && \
npm run certify:android && \
npm run test:android-resolved-policy && \
npm run audit:dependencies && \
node --test tests/b1-exit-report.test.mjs && \
actionlint .github/workflows/ci.yml && \
git diff --check
```

## Complete local B2 gate

After application or verifier changes, regenerate deterministic native and
dependency authority before lifecycle capture:

```sh
npm run report:b2-native-plugins
npm run audit:dependencies -- --write
```

These commands update `native-plugin-build.json`, `dependency-audit.json`,
`native-plugin-audit.json` and third-party notices. They do not capture or
approve lifecycle evidence. Commit those deterministic inputs in the clean B2
application checkpoint before either platform proof runs.

At that exact clean checkpoint, use the wrappers' two-stage procedure. A
capture deliberately exits with status `5` and leaves a pending proof plus its
screenshot; status `5` is expected only when the emitted code is the matching
`b2_*_manual_attestation_required` value. The root controller must inspect each
PNG at original resolution. A blank, partial, clipped or system-dialog capture
fails.

```sh
npm run prove:b2:ios
# Expected: exit 5, b2_ios_manual_attestation_required and a screenshot SHA-256.
```

After original-resolution inspection passes, create only
`.native-build/b2/ios-manual-attestation.json` with the emitted screenshot hash:

```json
{
  "schemaVersion": 1,
  "platform": "ios-simulator",
  "screenshotSha256": "<emitted iOS screenshot SHA-256>",
  "manualVisualInspection": "passed"
}
```

Then finalise iOS before starting Android:

```sh
npm run prove:b2:ios -- --attest .native-build/b2/ios-manual-attestation.json
npm run prove:b2:android
# Expected: exit 5, b2_android_manual_attestation_required and a screenshot SHA-256.
```

Inspect the Android PNG at original resolution, then create only
`.native-build/b2/android-manual-attestation.json`:

```json
{
  "schemaVersion": 1,
  "platform": "android-emulator",
  "screenshotSha256": "<emitted Android screenshot SHA-256>",
  "manualVisualInspection": "passed"
}
```

Finalise and build the exit report only after both reports are valid:

```sh
npm run prove:b2:android -- --attest .native-build/b2/android-manual-attestation.json
node scripts/build-b2-exit-report.mjs --write
node --test tests/b2-exit-report.live.mjs
```

The attestation files contain only platform, screenshot hash and the inspection
result. Do not include learner or other private data. Never hand-edit pending
proofs, native proof reports, screenshots, audit reports or the exit report;
their owning wrappers/builders are the only write authorities.

Commit only the regenerated B2 evidence. After that evidence-only commit,
`npm run verify:b2` and `node scripts/build-b2-exit-report.mjs --check` validate
the exact predecessor checkpoint, immediate-successor topology, fingerprint,
report hashes and cross-platform logical digest. Hosted CI checks committed
virtual-device evidence; it does not rerun a Simulator or Emulator lifecycle.

The B2 database and lifecycle semantics, evidence paths and deferrals are
recorded in `docs/architecture/b2-persistence-authority.md`.

The later B3 physical-capture tooling keeps mutable capture and recovery state
only in its ignored SQLite schema-v2 database. Final B3 reports and screenshots
are immutable derived evidence outside SQL and use one closed create-only,
exact-byte-idempotent publisher. See
`docs/architecture/b3-capture-authority.md`. Task 19 runs locally and must not
be described as a Cloudflare/R2 deployment, store mutation, signed build or
live-evidence result.

## B3 application checkpoint

Task 20 verifies the clean application checkpoint in pending mode:

```sh
npm run verify:b3
node scripts/build-b3-exit-report.mjs --check-ci
```

Pending means that none of the six final B3 paths exists now or anywhere in the
available Git history. One to five paths, or deleted earlier evidence, fail closed.
Pending is the successful B3 Development Checkpoint state. After deferred Task 22
has certified the final release-candidate bytes and created the exact six-file
evidence-only successor, the same commands require complete mode and strict byte
regeneration. See
`docs/architecture/b3-commerce-pack-authority.md` for the topology and invalidation
rules.

Task 20 does not sign, install, deploy or contact a store or physical device. Task
21 closes the development checkpoint without those actions. Deferred Task 22 owns
fresh final-candidate signed distribution and explicitly authorised live execution.
Do not use the exit builder to invent or hand-edit any live input. A Simulator,
emulator or unsigned build remains non-live evidence even when it passes every
development test.

`npm run test:domain` runs the ordinary default suite without resolving Android.
The two fresh resolved-toolchain assertions live only in
`tests/dependency-policy-resolved.live.mjs`; run them through
`npm run test:android-resolved-policy` after `npm run test:android` and
`npm run certify:android`. The default dependency audit also requires the
certified Android toolchain and fresh packaged-permission evidence, so keep that
ordering in a clean checkout. The pure domain/web CI lane exercises
pre-toolchain classification without overwriting the committed
resolved-toolchain report with pre-bootstrap evidence.

## Virtual-device lifecycle

The frozen B1 devices are:

- iOS Simulator: `KS2 Spelling iPhone 17`, iOS 26.5; and
- Android Emulator: `KS2_Spelling_API_36`, API 36, Pixel 9 profile, port 5580.

`npm run launch:ios -- --capture` and `npm run launch:android -- --capture`
install the local build, prove the foreground application, capture evidence and
shut down only the exact B1 virtual device. They do not delete a simulator or
AVD. A collision or unknown device is fail-closed and is not stopped.

The capture wrappers run `native:sync:check` immediately before their platform
build. Failed capture removes stale reports and screenshots rather than leaving
old evidence that appears current.

## Unsigned and local-debug boundary

The iOS gate builds scheme `KS2Spelling` for the Simulator with
`CODE_SIGNING_ALLOWED=NO`. It does not read certificates, provisioning profiles,
the login keychain or an Apple signing identity.

The Android gate builds and installs the local debug variant. It does not use a
release keystore, Play App Signing or production credentials. Neither local nor
CI verification deploys an application or mutates a store record.

## Dependency and privacy review

Dependabot proposals are weekly and manual-review only. An npm, SwiftPM, Gradle,
Capacitor or GitHub Actions update is not a routine version bump: rerun the full
gate and regenerate the deterministic dependency evidence and third-party
notices where applicable. Native dependency changes also require review of
`docs/compliance/sdk-privacy-register.md`, permission evidence, licence terms and
store-disclosure assumptions.

## B2 plugin-approval boundary

B2 conditionally approves `@capacitor-community/sqlite@8.1.0` and
`@capacitor/app@8.1.0` for the persistence proof only. Filesystem, billing and
biometric plugins remain `Not approved`. Production security, backup and store
disclosure decisions remain later gates.

## Hosted CI evidence

The private remote and branch pushes are authorised. A committed workflow is
configuration evidence only: claim a hosted result only after the exact commit's
GitHub Actions run has been observed. Never infer a hosted pass from local green
commands.
