# Native development and B1 verification

This runbook covers the B1 native shell and governance gates. Passing them means
`native shell and governance ready`; it does not mean the application is signed,
store-ready or ready for release.

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
npm run audit:dependencies && \
node --test tests/b1-exit-report.test.mjs && \
actionlint .github/workflows/ci.yml && \
git diff --check
```

The default dependency audit requires the certified Android toolchain and the
fresh packaged-permission evidence produced by `npm run test:android`, so keep
that ordering in a clean checkout. The pure domain/web CI lane exercises
pre-toolchain classification through the dependency policy tests; it does not
overwrite the committed resolved-toolchain report with pre-bootstrap evidence.

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

B1 approves no production native plugin beyond Capacitor core and its iOS and
Android platform packages. SQLite, filesystem, billing, biometric and lifecycle
plugins remain `Not approved`. B2 must approve each capability, data boundary,
permission surface, licence and failure mode before installation.

## Hosted CI evidence

The private remote and branch pushes are authorised. A committed workflow is
configuration evidence only: claim a hosted result only after the exact commit's
GitHub Actions run has been observed. Never infer a hosted pass from local green
commands.
