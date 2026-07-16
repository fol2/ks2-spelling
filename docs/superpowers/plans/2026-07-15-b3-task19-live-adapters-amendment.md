# B3 Task 19 Live Adapters Amendment Implementation Plan

**Status:** Approved implementation amendment; implementation has not started.

**Primary authorities:**

- [Standalone Spelling Mobile Application Design](../../../../ks2-mastery/docs/superpowers/specs/2026-07-09-standalone-spelling-mobile-application-design.md)
- [B3 Sandbox Billing and Signed Download Proof Plan](./2026-07-12-standalone-spelling-mobile-b3-sandbox-billing-signed-download-proof.md), especially Tasks 19–23

This document amends Task 19 where the current implementation proved that the original live-capture and Cloudflare primitives cannot produce honest evidence, plus the minimum Task 22 execution-order change required to finalise capability/Range smoke without exposing a sealed handle. All other B3 requirements remain authoritative. If this amendment and the original wording differ, this amendment governs the live-adapter implementation, production-trace contract and atomic Task 22 evidence assembly order; the exact six-file topology and all final claims remain unchanged.

## Outcome

Task 19 will finish with two deep, narrow live-proof adapters:

1. a B3-only, device-generated observation protocol which drives the existing production purchase, recovery, download, activation and revocation composition without accepting operator-authored outcomes; and
2. an audited Cloudflare adapter which deploys one exact bound Worker source, proves the deployed bytes through the official Workers content/version APIs, and accesses only the exact remote `PACKS` R2 binding through Wrangler 4.110.0 `getPlatformProxy`.

The shipping application remains offline-first. Cloudflare is not used for spelling practice, learner progress, Monster progress, installed pack reads or revision. It is used only when online commerce must be verified, a purchased pack must be downloaded/redownloaded, entitlement state must be refreshed/restored/revoked, or B3 must prove those boundaries. Once a verified pack is installed, its authorised content remains local and usable offline under the original design.

## Non-negotiable implementation boundaries

- Implement with RED → GREEN → REFACTOR. Record the focused RED before each production change.
- Use the existing production `StorePort`, gateway, purchase coordinator, download coordinator, activation coordinator, SQLite repositories and lifecycle composition. B3 may observe them and may hold at an existing failure-injection checkpoint; it must not replace their recovery behaviour.
- Never introduce a B3-only cached gateway response, replay gateway, synthetic completion, filtered trace, operator JSON outcome, arbitrary device file path, exported content provider or public URL scheme.
- Every gateway call made by the real composed application is evidence. The evidence validator must follow production truth; production must not be changed to satisfy the original simplified trace counts.
- The observation command carries correlation and requested action only. The application derives and publishes outcomes from its own local/store/gateway state.
- Native observation transport is compiled and registered only for the `B3SandboxProof` iOS scheme/configuration and Android B3 proof variant. Normal application builds must not expose it.
- No raw store JWS, purchase token, receipt, order/transaction identifier, sealed refresh handle, capability URL/query, tester/account identity, device identifier, learner identifier or learner nickname may cross the observation port or enter reports.
- During Tasks 19A–19H below: no Cloudflare deployment, R2 mutation, store-console mutation, signing, installation, uninstall/reinstall, physical-device launch, force-stop, screenshot capture, commit, push or evidence finalisation. Tests use fakes for external process/API/device boundaries while exercising the real application composition.
- Real Cloudflare/device mutations remain deferred to original Tasks 21–22 and still require the existing exact scoped approval and run-token gates.
- Existing dirty Task 19 work belongs to the active implementation lane. Do not discard, overwrite or stage unrelated changes.

## Task 19 protocol correction — physical process and host checkpoints

The physical transport proof established that every app command is a fresh process. `devicectl` launch environment applies only to the spawned process, Android launches use force-stop semantics, and operator/store-console actions do not launch the app. The following correction is therefore authoritative:

- `WAITING_OPERATOR`, force-stop and manual attestation are host-owned checkpoints, not app launch actions.
- `APPROVE_PENDING_PURCHASE` and `DECLINE_PENDING_PURCHASE` are host/store actions. The pending app observation remains `in-progress`; it must not claim an approved or declined result.
- Android decline is proved retroactively when the next fresh process observes no retained transaction and no access. Android approval is proved retroactively when a fresh `ARM_GATEWAY_COMPLETION_HOLD` process observes and verifies the purchased transaction, publishes `HOLD_REACHED`, and is force-stopped only after the host validates that observation and waits exactly five seconds. A fourth fresh process then runs `RELAUNCH` over the unchanged recovery path. The host may derive the prior public scenario outcome only from those retained, validated device observations.
- Every observation contains only the gateway calls and redacted store events since that session's previous successful publication. Calls are never filtered. A bounded app-owned cursor binds the capture, scenario, exact production offset and used trace identifiers across processes. A successful call which was not published causes the next process to fail closed; it cannot silently skip the call.
- A cursor for another capture ID is never silently reset on the same durable installation, even when its pending/publication fields are clean. A new capture requires the explicit reinstall/reset boundary which creates new durable application state.
- Publication validates each gateway delta as an exact contiguous segment of the production vector. The independent host validator concatenates every retained delta for the scenario and requires exact full-vector equality before deriving public evidence.
- The closed proof projection additionally carries four app-owned authorities:
  - `entitlementAuthority`: `{ id, state, domainSeparatedDigestSha256, refreshHandlePresent }`, where the digest binds the canonical redacted durable entitlement row and never the raw handle or transaction;
  - `packAuthority`: `{ packId, manifestSha256, archiveSha256, installed }`, accepted as installed only when the active row, ready installed row and latest matching ready download job agree exactly; and
  - `transportAuthority`: `{ storeAdapter, gatewayAdapter, serverUrl, nativeOriginAllowed, noRedirects }`, fixed by the physical composition to the concrete Capacitor store and concrete HTTP gateway with no server URL or redirects; and
  - `storeAuthority`: `{ environment, productId, localisedPriceObserved, completionState }`, derived only after StorePort validation and reconciled with durable journal completion. Completion is `finished` on iOS, `acknowledged` on Android, or `not-observed`; it never carries a receipt, token or transaction identifier.
- `transactionAuthority.rawProofCleared` is an additional redacted durable boolean. It is true only when relevant full-KS2 transaction-journal rows are unambiguous and every `opaque_proof` cell has been cleared to SQL `NULL`. Recovery, install, restore, redownload and revocation cannot become terminal evidence while it is false.
- Exactly one distinct non-null relevant store transaction identifier may be authoritative. Historical terminal rows whose authority was atomically transferred to a revocation journal may be null, but multiple distinct identifiers fail closed.
- Proof observation and cursor persistence are fail-later metadata: they may mark the session drifted and block publication, but must never replace or delay ownership of a validated StorePort/gateway result or the original production error. The redacted StorePort projection retains the port's full 64-transaction result bound.
- Restore/reinstall and redownload report facts are host derivations over the authenticated observation chain and reinstall boundary. They are not caller-supplied booleans. StoreKit test reporting remains an independent host artefact.

The production-trace integration gate must create separate real `createB3AppServices` processes over the same SQLite path for the hold/relaunch boundary and fresh real-factory processes for every remaining iOS and Android scenario segment. External native/store/HTTP responses may be supplied only through the existing Capacitor and fetch boundaries; the application factory, coordinators, repositories, startup reconciliation and proof publication remain production code. Manually assembled coordinator worlds are not trace authority.

## Architecture and ownership

The application-side module is deliberately deep: the UI/composition sees a small `getLaunchCommand()` / `publishObservation()` port, while canonicalisation, state-machine validation, redaction, bounded projections and hash chaining remain hidden behind it. The host-side runner sees a small launch/pull/screenshot interface, while `devicectl`/`adb`, fixed paths, checkpoints, timeouts and evidence assembly remain hidden in platform adapters.

```text
scoped host runner
  -> correlation-only launch command
  -> B3 native observation port
  -> existing production app composition
       -> StorePort / gateway / SQLite / download / activation
  -> closed, redacted, hash-chained observation
  -> fixed native app-owned file
  -> host pull + independent validation
  -> exact six-file Task 22 evidence topology
```

Cloudflare ownership is similarly narrow:

```text
approved deployment orchestrator
  -> pinned Wrangler 4.110.0 dry-run
  -> bind exact source authority
  -> closed derived config + --no-bundle deployment
  -> sterile OAuth child
       -> official Workers content/version readback
       -> getPlatformProxy({ envFiles: [], persist: false, remoteBindings: true })
       -> exact PACKS binding, two immutable keys only
  -> byte/metadata/ETag/read-after-write proof
  -> closed Cloudflare evidence
```

The parent process never receives, logs or serialises an OAuth access token. The sterile child owns authenticated Cloudflare operations and emits only the closed redacted result schema.

## Planned file surface

Create:

- `src/app/b3-live-proof-protocol.js`
- `src/platform/proof/b3-proof-observation-port.js`
- `src/platform/proof/capacitor-b3-proof-observation.js`
- `ios/App/App/B3ProofObservationPlugin.swift`
- `android/app/src/b3SandboxProof/java/uk/eugnel/ks2spelling/B3ProofObservationPlugin.java`
- `scripts/lib/b3-device-observation.mjs`
- `scripts/lib/b3-host-capture-state.mjs`
- `scripts/lib/b3-issued-command.mjs`
- `scripts/lib/b3-physical-device-transport.mjs`
- `scripts/lib/b3-physical-observation-journal.mjs`
- `scripts/lib/b3-ios-proof-screenshot.mjs`
- `scripts/lib/b3-play-protect-attestation.mjs`
- `scripts/lib/b3-cloudflare-oauth-child.mjs`
- `tests/b3-live-proof-protocol.test.mjs`
- `tests/b3-live-proof-production-trace.test.mjs`
- `tests/b3-live-proof-privacy.test.mjs`
- `tests/b3-cloudflare-live-adapter.test.mjs`
- `tests/b3-live-capture-resume.test.mjs`
- `tests/b3-physical-device-transport.test.mjs`
- `tests/b3-physical-observation-journal.test.mjs`
- `tests/b3-ios-screenshot-capture.test.mjs`
- `tests/b3-play-protect-attestation.test.mjs`
- `ios/App/B3ProofUITests/B3ProofScreenshotTests.swift`
- `ios/App/App.xcodeproj/xcshareddata/xcschemes/B3ProofUITests.xcscheme`
- `tests/b3-ios-screenshot-target-contract.test.mjs`

Modify only where required:

- `src/app/create-b3-app-services.js`
- `src/app/create-app-services.js`
- `src/main.jsx`
- `src/app/App.jsx`
- `scripts/lib/b3-evidence.mjs`
- `scripts/lib/b3-cloudflare-evidence.mjs`
- `scripts/lib/b3-cloudflare-live-adapter.mjs`
- `scripts/lib/b3-live-capture-adapters.mjs`
- `scripts/deploy-b3-sandbox-gateway.mjs`
- `scripts/prove-b3-cloudflare.mjs`
- `scripts/prove-b3-ios.mjs`
- `scripts/prove-b3-android.mjs`
- `scripts/check-b3-external-prerequisites.mjs`
- `ios/App/App/AppDelegate.swift`
- `ios/App/App.xcodeproj/project.pbxproj`
- `ios/App/App.xcodeproj/xcshareddata/xcschemes/B3SandboxProof.xcscheme`
- `android/app/build.gradle`
- `android/app/src/main/java/uk/eugnel/ks2spelling/MainActivity.java`
- `tests/b3-evidence-contract.test.mjs`
- `tests/helpers/b3-evidence-fixtures.mjs`
- `tests/b3-cloudflare-wrapper-contract.test.mjs`
- `tests/b3-ios-wrapper-contract.test.mjs`
- `tests/b3-android-wrapper-contract.test.mjs`
- `tests/b3-live-composition.test.mjs`
- `package.json`

Do not create another evidence report. Original Task 22's exact six files remain the only committed live topology:

- `reports/b3/cloudflare-sandbox-proof.json`
- `reports/b3/ios-sandbox-proof.json`
- `reports/b3/ios-sandbox-proof.png`
- `reports/b3/android-sandbox-proof.json`
- `reports/b3/android-sandbox-proof.png`
- `reports/b3/b3-exit-report.json`

## Task 19S — Preserve the reviewed scaffolding checkpoint

The existing repaired Task 19 scaffolding is a large, coherent safety boundary and James has explicitly requested periodic commits to reduce accident risk. Before Tasks 19A–19G begin, it may be committed once with an honest non-completion message such as `test: checkpoint B3 live proof scaffolding`, provided all current focused tests, the full suite, normal native builds, dedicated B3 unsigned builds, lint, native sync and `git diff --check` pass. The progress log must state that Task 19 remains incomplete and name Tasks 19A–19G as required follow-up work. This checkpoint must not be pushed unless the root controller separately confirms that the periodic-push boundary is due.

This safety checkpoint does not waive the Task 19H completion gates. It must contain no live evidence, deployment, R2 mutation, store mutation, device mutation, signing output or claim that the live adapters are complete.

## Task 19A — Derive and amend the trace contract from production composition

### RED

Add `tests/b3-live-proof-production-trace.test.mjs`. Compose `createB3AppServices` with the real purchase coordinator, commerce reconciler, download coordinator, pack reconciler, activation path and SQLite repositories. External store, HTTP and native transfer outcomes may be deterministic test doubles, but the doubles may only supply the external response at their existing ports; they must not implement application recovery or invent trace history.

The test records all calls at the production gateway seam and proves at least these currently missing truths:

- recovery may re-run transaction verification before gateway completion;
- purchase coordination may call `authorisePackDownload` to persist a download job;
- the download coordinator calls `authorisePackDownload` again to obtain the live capability and rotating handle;
- fresh-install startup reconciliation recovers entitlement before the command is published;
- `REBIND_FRESH_INSTALL` therefore publishes that startup replay authority and must not duplicate the same store transaction through a second explicit Restore call;
- revocation and post-reinstall calls stay ordered as actually emitted by the production composition.

Run:

```bash
node --test tests/b3-live-proof-production-trace.test.mjs
```

Expected RED: the current exact trace arrays in `scripts/lib/b3-evidence.mjs` omit real composed calls or the new production-trace contract does not yet exist. Preserve the RED output in the task log.

### GREEN

Update the exact iOS and Android scenario trace vectors in `scripts/lib/b3-evidence.mjs` and fixtures only after the real application-factory integration test has produced the ordered vectors. Each trace record remains a fresh UUIDv4 with its real operation and relation. Do not coalesce repeated calls, move a call to a more convenient scenario, or suppress startup calls. Worker deployment version IDs use lowercase UUIDv4 and the tracked single-part R2 objects use lowercase 32-hex ETags; neither may be validated by a generic identifier rule or substituted for a 64-hex SHA-256 authority.

The original nine user-visible scenarios and outcomes remain unless the real state machine proves a naming/order defect. The amendment is to trace multiplicity and relation, not permission to reduce coverage. Any scenario-name/order change requires a written mapping in the test and a spec review before implementation continues.

Add a mutation test which inserts, removes, reorders or relabels one real gateway call and requires evidence validation to fail. Add a test proving that a B3-only replay/cached gateway cannot be selected in physical mode.

Run:

```bash
node --test tests/b3-live-proof-production-trace.test.mjs tests/b3-evidence-contract.test.mjs tests/b3-live-composition.test.mjs
```

Expected GREEN: the evidence contract equals the real production call sequence and no B3-only recovery path exists.

### Gate

Fresh spec review and commerce/recovery review. The reviewers must compare the frozen vectors with the actual integration-test call log, not with the original simplified counts.

## Task 19B — Define the closed command, observation and state-machine protocol

### RED

Add protocol and privacy tests for a closed launch command:

```ts
{
  schemaVersion: 1,
  captureId,
  platform,
  testedApplicationCommit,
  applicationFingerprint,
  expectedScenarioIndex,
  expectedSequence,
  previousObservationSha256,
  installationMode: 'existing' | 'fresh-reinstall',
  actionCode,
  challengeSha256
}
```

The command contains no claimed result. `expectedSequence` is a positive safe integer owned by the host checkpoint; it is required because a fresh reinstall clears app metadata and the new installation cannot derive the prior sequence from a hash. `actionCode` is one value from a closed enum controlled by the host runner. It cannot contain free text, paths, shell fragments, URLs or evidence fields.

The application publishes a canonical JSON observation with exact keys:

```ts
{
  schemaVersion: 1,
  platform,
  buildAuthoritySha256,
  captureId,
  installationId,
  sequence,
  previousObservationSha256,
  scenarioIndex,
  scenario,
  phase,
  nextActionCode,
  completedTransitions,
  proofProjection,
  observedAt,
  observationSha256
}
```

Require a maximum canonical byte size of 64 KiB, bounded arrays, exact keys, lowercase SHA-256 values, monotonic sequence/index, challenge binding, previous-hash binding and self-hash verification. A fresh reinstall creates a new `installationId` but must link to the prior installation's tail hash supplied by the host command.

The app-side publication validator checks exact canonical shape, self-hash and every launch-command binding, including `expectedSequence` and the supplied prior tail. It does not claim to possess the prior installation's full observation after a fresh reinstall. The host-side validator remains separate and must receive the prior observation/checkpoint for every sequence above one; only that full-chain validator may advance the checkpoint or evidence.

The protocol state machine is closed:

```text
UNBOUND
  -> ARMED
  -> WAITING_OPERATOR (exit 7)
  -> OBSERVING
  -> HOLD_REACHED
  -> HOST_FORCE_STOP
  -> RELAUNCH_RECOVERY
  -> SCENARIO_COMPLETE
  -> REBIND_FRESH_INSTALL
  -> TERMINAL_CAPTURE
  -> MANUAL_ATTESTATION (exit 5)
  -> COMPLETE
```

Only applicable transitions are traversed for a scenario. Timeout, unchanged observation, wrong challenge, replay, skipped index, wrong installation mode, broken hash chain, duplicate terminal state or unknown action exits `6` and must not advance the checkpoint.

Privacy RED cases must scan nested keys and values and reject raw JWS/token/receipt/order/transaction ID, sealed handle, capability, email/tester/account/device identifier, learner ID and nickname. Learners are verified internally against the exact tracked two-profile authority and exported only as fixed positional digests plus `syntheticAuthorityMatched: true`. Transaction authority exports only source, cross-check boolean and a domain-separated digest. Handle lifecycle exports only presence/version/rotation/deletion booleans.

The closed `proofProjection` also contains a bounded `gatewayCalls` array. Each item has exactly `{ operation, relation, traceId }`: `operation` is one of `verify | complete | refresh | authorise`, `relation` is from the production-derived closed relation enum frozen by Task 19A, and `traceId` is the gateway-generated random UUID already required by the public B3 transition evidence. This is not a store transaction identifier. The application must export every real call in order; the host copies these records and may never invent, filter or coalesce them.

Run:

```bash
node --test tests/b3-live-proof-protocol.test.mjs tests/b3-live-proof-privacy.test.mjs
```

Expected RED: the protocol modules do not exist.

### GREEN

Implement `src/app/b3-live-proof-protocol.js` as the single owner of closed state transitions, canonical observation construction, hash chaining, projection bounds and redaction. Implement `src/platform/proof/b3-proof-observation-port.js` as a two-method exact port and `src/platform/proof/capacitor-b3-proof-observation.js` as the only application-facing native adapter.

Use a fixed `app_metadata` key for durable proof state if the existing schema supports it safely; do not add tables merely for evidence. Any schema change requires an explicit migration amendment and a fresh database review before proceeding.

Run the RED command again and add hostile unknown-key, oversized, Unicode/canonicalisation, stale-command and crash/relaunch hash-chain cases.

### Gate

Fresh security/privacy review. The reviewer must attempt to smuggle every prohibited identifier through keys, values, arrays, errors and timestamps.

## Task 19C — Observe the real application without changing its recovery semantics

### RED

Extend `tests/b3-live-composition.test.mjs` to require:

- physical B3 composition selects the concrete observation port and never a fake;
- normal B3/browser and production builds have no live-proof command;
- wrappers around StorePort and gateway record calls after validation at the existing ports but do not change requests/responses/errors;
- purchase and download authorisations remain distinct real calls;
- learner baselines are queried from local SQLite and matched internally;
- no observation is published before the corresponding durable state exists;
- dispose/resume races cannot publish stale or duplicate observations.

Add the crash proof at the existing purchase-coordinator `before:gateway-completion` failure-injection seam. In B3 physical proof only, the closed command may arm a one-shot hold at that point. The entitlement and sealed handle must already be durable, while gateway completion has not run. The host observes `HOLD_REACHED`, waits exactly five seconds where required, force-stops, then relaunches the unchanged production recovery path. All re-verification and completion calls are recorded.

For iOS, the hold is part of `normal-purchase`: that scenario records the initial transaction verification and ends at `HOLD_REACHED`. The next `unfinished-relaunch` scenario records recovery re-verification, completion and all subsequent production calls. Android keeps both sides inside `unacknowledged-relaunch`. This preserves the existing public scenario meanings while recording every real call exactly once.

Expected RED: `createB3AppServices` hard-codes a no-op failure injector and has no observation composition.

### GREEN

Wire the proof protocol through `create-b3-app-services.js`, `create-app-services.js`, `main.jsx` and `App.jsx` behind exact B3 physical build authority. Keep UI additions diagnostic, calm and Parent-only; no final visual/theme/Monster claim is introduced.

Observation wrappers must be transparent: same input, output, error, timing ownership and disposal as their wrapped production ports. They may retain only redacted/digested proof state. The host command may ask the app to perform an existing controller action, but may not directly write commerce, entitlement, pack or learner tables.

Run:

```bash
node --test tests/b3-live-composition.test.mjs tests/b3-live-proof-production-trace.test.mjs tests/b3-live-proof-protocol.test.mjs tests/b3-live-proof-privacy.test.mjs tests/purchase-crash-recovery.test.mjs tests/purchase-second-lifecycle.test.mjs
```

### Gate

Fresh concurrency/recovery review plus a privacy review of every exported projection.

## Task 19D — Add B3-only iOS and Android native observation transports

### RED

Extend platform wrapper tests before native source changes. Require exact B3-only registration and fixed transport locations.

iOS:

- receive the command from `devicectl` process-launch arguments, not a URL scheme;
- atomically write canonical observation bytes to `Library/Application Support/b3-proof-observation-v1.json`;
- apply data-protection and no-backup attributes where available;
- reject symlinks, non-regular targets, oversized bytes and non-B3 build authority;
- permit host retrieval only through `xcrun devicectl device copy from --domain-type appDataContainer --domain-identifier uk.eugnel.ks2spelling`.

Android:

- receive the command through explicit `am start ... --es` extras addressed to the installed package/activity;
- atomically write the redacted observation to one fixed app-specific external file so `adb pull` can retrieve it without `run-as` or root;
- define no exported provider, receiver, service or arbitrary output path;
- reject non-B3 variant, symlink/path drift and oversized bytes.

If the target physical Android API denies the fixed app-specific file read, the live preflight must fail RED. Select a separately reviewed fixed-log transport only after proving it remains bounded and redacted; never fall back to operator-authored JSON or an exported provider.

Run:

```bash
node --test tests/b3-ios-wrapper-contract.test.mjs tests/b3-android-wrapper-contract.test.mjs tests/b3-live-proof-privacy.test.mjs
```

### GREEN

Implement the native plugins and register them only in the dedicated proof scheme/variant. Add negative source-contract tests proving the normal iOS scheme and normal Android build do not register or package the observation plugin.

Run native compile-only verification without a device:

```bash
npm run native:sync:check
xcodebuild -project ios/App/App.xcodeproj -scheme B3SandboxProof -configuration B3SandboxProof -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO B3_TESTED_APPLICATION_COMMIT=1111111111111111111111111111111111111111 B3_APPLICATION_FINGERPRINT=2222222222222222222222222222222222222222222222222222222222222222 B3_VERSION_NAME=0.3.0-b3 B3_IOS_BUILD_NUMBER=1 build
(cd android && ./gradlew test assembleDebug assembleRelease bundleB3SandboxProofRelease -Pb3Distribution=1 -Pb3AndroidVersionCode=1 -Pb3TestedApplicationCommit=1111111111111111111111111111111111111111 -Pb3ApplicationFingerprint=2222222222222222222222222222222222222222222222222222222222222222)
```

Use the exact Gradle task names generated by the implemented variant; update this command in the implementation log if Gradle exposes different names. Do not install either build.

### Gate

Fresh Swift/native-file security review and Android exported-component/storage review.

## Task 19E — Replace operator outcomes with resumable host adapters

### RED

Add `tests/b3-live-capture-resume.test.mjs` and extend the iOS/Android wrapper tests. Replace the current checkpoint schema with an atomic compare-and-swap record containing at least:

```ts
{
  schemaVersion: 2,
  platform,
  captureId,
  testedApplicationCommit,
  applicationFingerprint,
  installationId,
  nextScenarioIndex,
  nextObservationSequence,
  state,
  completedScenarios,
  previousObservationSha256,
  checkpointRevision,
  checkpointSha256
}
```

Require file mode `0600`, no symlink/hard-link, repository containment, canonical JSON, exclusive first write, expected-revision replacement, fsync/rename durability and stale-writer rejection. A runner resumes only when commit, fingerprint, capture ID, platform and hash-chain tail all match. Any mismatch exits `6` before device launch.

Host adapters must:

- launch only the exact package/bundle and exact closed action enum;
- pull only the fixed observation path;
- validate the observation independently before advancing;
- print one bounded operator instruction from a closed enum and exit `7` when human store action is required;
- own the exact slow-card poll budget and five-second unacknowledged hold;
- treat `--resume-store-action` as a single-use acknowledgement for exactly one
  retained observation hash and closed store-action code in one CLI invocation;
  it never supplies an approve/decline outcome, and a later operator gate requires
  a fresh invocation and flag;
- bind `--resume-reinstall` to the exact `REBIND_FRESH_INSTALL` action and
  retained invocation-start observation hash; the first encounter exits `7`
  with `REINSTALL_EXACT_BUILD`, while a future or different reinstall gate
  cannot consume the acknowledgement;
- retain each issued native command as a canonical `prepared -> launching ->
  launched` record. A prepared command may launch once, a launched command may
  only pull, and an ambiguous launching command must pull the exact fixed-path
  publication first. If none validates inside the fixed bound, exit `7` at the
  closed reinstall checkpoint without repeating the native side effect;
- store issued commands in bounded, private per-platform immutable ledgers.
  Each command hash has one immutable base, each source state has one atomic
  successor claim, and completion appends a command-hash tombstone bound to the
  actually derived terminal record. No transition uses PID liveness, a reusable
  lock/current path or unlink; conflicting successor edges have exactly one
  winner and stale completion of one command cannot consume another;
- model iOS termination as `stop-intent -> stop-executing -> host-stopped`.
  Exactly one successor claimant owns the physical terminate side effect, and
  the transport must durably retain the post-terminate receipt before its
  `forceStop` promise resolves. Process absence without that receipt is never
  treated as proof of a host-owned stop;
- retain invalid command-bound publication authority instead of clearing and
  relaunching it. A replacement exact publication may recover through pull-only
  resume;
- use immutable observation creation and immutable checkpoint revision claims
  as the filesystem concurrency primitives. Writer temporaries live outside the
  closed observation directory, and obsolete `.lock` debris cannot wedge a
  checkpoint revision after process death;
- wait for `HOLD_REACHED` before force-stop and require `RELAUNCH_RECOVERY` afterwards;
- capture the final original-resolution screenshot from an owned platform tool, never from an environment-supplied source path: Android uses `adb exec-out screencap -p`; Xcode 26.6 exposes no `devicectl` screenshot command, so iOS uses a dedicated B3-only XCUITest which retains `XCUIScreen.main.screenshot()` as a named original-quality `XCTAttachment`, then exports that attachment from its `.xcresult` with `xcresulttool`. The UI-test target/scheme has no App target dependency or App build product and uses `XCUIApplication(bundleIdentifier:)`, so XCTest launches the already-installed Task 21 application instead of replacing it; distribution authority is re-inspected after capture;
- validate the entire PNG structure, chunk CRCs, compressed scanline extent and
  final `IEND`, not only its signature/IHDR. Before Android's final screencap,
  foreground the exact application component with a closed `adb am start -W`
  command so Play Protect Settings cannot become the app proof screenshot;
- after the ninth scenario, issue only `CAPTURE_TERMINAL` and retain the
  app-owned `TERMINAL_CAPTURE` observation. The app must not claim
  `MANUAL_ATTESTATION` or `COMPLETE`; those are host report states reached only
  after the separately captured screenshot is actually attested;
- stop at pending evidence and exit `5` for manual visual attestation;
- never accept a path to operator JSON as a device observation.

### Task 19H review correction — ambiguous-launch reinstall recovery

The planned restore journey keeps its existing exact `REBIND_FRESH_INSTALL`
gate: `--resume-reinstall` remains bound to that retained observation tail and
cannot acknowledge another restore gate. A launch whose native outcome is
ambiguous is a disjoint recovery case. The same explicit flag may acknowledge
that recovery only when it is bound to the exact retained command hash,
platform, capture ID, observation sequence, prior hash-chain tail, tested
commit and application fingerprint recorded by a durable `restart-required`
gate. It must not convert an arbitrary action into protocol
`REBIND_FRESH_INSTALL`, because that action is valid only for the planned
`restore-after-reinstall` scenario.

After the operator reinstalls the exact approved distribution, one immutable
claim owns a bounded, crash-resumable host reset. It archives—without deleting
or overwriting—the abandoned journal, checkpoint revisions and capture-bound
pending projections under private per-platform storage, consumes the exact
ambiguous issued command, and starts a new capture ID at sequence 1 with
`ARM_CAPTURE`. The abandoned capture never contributes to final evidence. A
concurrent helper may complete the same filesystem-only reset idempotently,
but the acknowledgement is single-use; no process may relaunch the uncertain
action, continue it under the old capture/hash chain, reset automatically from
`restart-required`, or require manual ledger deletion. A crash after the
durable acknowledgement may resume `restart-executing` or `restart-complete`
without asking the operator to repeat the flag.

Android `playCertified: true` cannot come from the app. Bind it to a CLI-captured Play Protect settings screenshot plus an independent root SHA attestation, together with installer and Play App Signing certificate authority. Retain those two hidden artefacts only at the fixed private paths `.native-build/b3/evidence/android-play-protect-settings.png` and `.native-build/b3/evidence/android-play-protect-root-attestation.json`. The committed Android `device` block includes only `playCertified: true`, `playProtectSettingsScreenshotSha256` and `playProtectRootAttestationSha256` alongside model/OS/physical authority.

The first absent Play Protect authority exits `7` with `SHOW_PLAY_PROTECT_SETTINGS`.
After the root controller opens that exact screen, rerun with
`--capture-play-protect`; the CLI captures the PNG directly with `adb`, retains it
at the fixed path, and exits `7` with `ATTEST_PLAY_PROTECT_SETTINGS`. The root
attestation is mode `0600`, canonical JSON without a trailing newline, and has
exactly:

```json
{"playCertified":true,"platform":"android-play-physical","schemaVersion":1,"screenshotPath":".native-build/b3/evidence/android-play-protect-settings.png","screenshotSha256":"<exact lowercase PNG SHA-256>"}
```

Only a genuinely absent file reaches these operator gates. A symlink, hard link,
non-canonical record, hash mismatch or replacement is a hard exit `6` and cannot
be relabelled as an operator task.

### GREEN

Implement `scripts/lib/b3-device-observation.mjs`, the default adapters in `scripts/lib/b3-live-capture-adapters.mjs`, and state-machine orchestration in `prove-b3-ios.mjs` / `prove-b3-android.mjs`. All process execution remains injectable for tests. Bound stdout/stderr, timeouts, package identity, file sizes and command arguments.

Run:

```bash
node --test tests/b3-live-capture-resume.test.mjs tests/b3-physical-device-transport.test.mjs tests/b3-physical-observation-journal.test.mjs tests/b3-ios-screenshot-capture.test.mjs tests/b3-ios-screenshot-target-contract.test.mjs tests/b3-play-protect-attestation.test.mjs tests/b3-ios-wrapper-contract.test.mjs tests/b3-android-wrapper-contract.test.mjs tests/b3-evidence-contract.test.mjs
```

Expected GREEN: default adapters are no longer unavailable, but tests perform no real device command or mutation.

### Gate

Fresh adversarial runner review covering command injection, stale checkpoints, app reinstall boundaries, force-stop timing, screenshot provenance and privacy.

## Task 19F — Implement the exact Cloudflare live adapter

### RED

Replace the current fail-closed placeholder test with `tests/b3-cloudflare-live-adapter.test.mjs`. Keep the fail-closed cases and add command/API/proxy mutation tests.

The test must require all of the following:

1. Resolve `gateway/node_modules/wrangler/bin/wrangler.js` and its adjacent package metadata as regular, non-symlink files. Require version exactly `4.110.0` and the lockfile resolution for exactly `4.110.0`.
2. Run the deterministic dry-run with the pinned binary, closed tracked config, `--dry-run`, fixed outdir and `--env-file /dev/null`. Accept one bounded normalised main-module source containing exactly one 64-zero authority placeholder.
3. Bind the source authority, write one private derived config under `.native-build/b3/`, and close every mutable field: exact account, Worker name, compatibility date/flags, route/origin, `PACKS` bucket, rate-limit binding, version metadata binding, rules and main-module path. The derived config contains no secrets or environment inheritance.
4. Deploy the already-bound source with the pinned Wrangler binary using `--no-bundle`, the closed derived config and `--env-file /dev/null`. A second bundling/transformation path is forbidden.
5. In a sterile child, obtain the current session credential with the pinned Wrangler 4.110.0 `auth token --json` command, keep that OAuth token only in child memory, and read back the deployed Worker through the official Workers Script Content API v2 and Versions API. Hash the returned main-module bytes and require exact equality with the bound/deployed SHA-256 and returned deployment version. Do not trust the deploy command's local output alone.
6. In that same sterile authenticated child, call pinned Wrangler's:

```js
getPlatformProxy({
  configPath: derivedConfigPath,
  envFiles: [],
  persist: false,
  remoteBindings: true,
})
```

7. Require `env.PACKS` to be the exact remote binding for `ks2-spelling-b3-sandbox-packs`. Reject missing/local/emulated/drifted bindings before object work.
8. Allow exactly two object keys: `B3_MANIFEST_KEY` and `B3_ARCHIVE_KEY`. Reject list, delete, copy, rename, multipart upload, arbitrary bucket/key and every third key before proxy creation.
9. For an absent object, call `PACKS.put` with the exact authority bytes, exact closed `customMetadata`, exact SHA-256 integrity option and create-only `If-None-Match: *` semantics (`onlyIf.etagDoesNotMatch: '*'` in the R2 binding API). A precondition failure never overwrites; it moves directly to exact readback comparison.
10. Immediately call `head` and `get`, consume bounded bytes, and require key, byte length, byte SHA-256, ETag, uploaded SHA-256/integrity result and exact custom metadata to match tracked authority. This immediate read-after-write is the strong-consistency proof. An existing object is accepted only after the same `head` + `get` equality.
11. Always dispose the platform proxy in `finally`, including API error, precondition failure, mismatch, timeout and smoke-test failure.
12. The authenticated child receives only a closed operation document over stdin and a sterile environment allow-list. OAuth credentials remain available only inside that child through the audited Wrangler authentication path and are discarded before exit. No token, authorisation header, keyring record, secret value, raw API body or proxy object reaches parent stdout/stderr/evidence.

The sterile environment allow-list is limited to the minimum runtime/authentication values required by pinned Wrangler (for example `HOME`, `PATH`, `TMPDIR`, fixed account ID and fixed non-secret control flags). Explicitly delete `CLOUDFLARE_API_TOKEN`, `.env` loading, process-environment inclusion and unrelated credentials. Tests inject a fake authenticated transport; they do not log in or call Cloudflare.

Run:

```bash
node --test tests/b3-cloudflare-live-adapter.test.mjs tests/b3-cloudflare-wrapper-contract.test.mjs tests/b3-external-prerequisites.test.mjs
```

Expected RED: the default adapter still throws `b3_cloudflare_exact_r2_metadata_adapter_unavailable`.

### GREEN

Implement `scripts/lib/b3-cloudflare-oauth-child.mjs` and `scripts/lib/b3-cloudflare-live-adapter.mjs`. Keep orchestration policy in `b3-cloudflare-evidence.mjs`; keep OAuth/API/proxy mechanics in the child adapter. The parent receives only these closed primitives:

- `dryRunBundle`
- `deployExactBundle`
- `inspectVersionApi`
- `inspectWorkerState`
- `inspectObject`
- `uploadObject`
- `smokeGateway`

`smokeGateway` must not mint or receive a capability on the host: the host has no legitimate sealed refresh handle before the physical journey, and neither a raw handle nor a new admin/test endpoint is allowed. Its default remains fail-closed until Task 19G supplies a device-generated closed smoke projection. The physical B3 application uses its own sealed handle internally to exercise valid/tampered/expired capability and Range behaviour, then publishes only the approved booleans and deployment/script bindings. No capability URL, query or handle crosses the observation port.

Update `buildB3CloudflareDeploymentPlan` so the recorded exact deployment is explicitly `--no-bundle` against the derived config. Preserve scope/run-token/local-authority gates before the child is spawned or any remote inspection/mutation occurs.

Run the focused command again. Add tests that mutate the Wrangler version, derived config, content bytes, version ID, remote binding name, bucket name, object key, metadata, SHA, ETag, precondition, consistency readback, child environment, output schema and disposal path one at a time.

Expected GREEN: all operations are proven through fakes; no network request or remote mutation occurred.

### Gate

Two fresh reviews are mandatory: Cloudflare/runtime correctness and security/credential containment. Both must inspect the exact child environment, official API byte readback, `getPlatformProxy` options, two-key allow-list, put precondition and `finally` disposal.

## Task 19G — Integrate the amended evidence contract without widening claims

### RED

Extend evidence and exit-builder mutation tests to reject:

- original simplified trace counts when production emitted additional calls;
- trace filtering/coalescing;
- operator-authored observation or screenshot paths;
- broken observation/checkpoint hash chains;
- self-claimed Android Play certification;
- a Cloudflare report based only on Wrangler stdout rather than content/version readback;
- R2 object evidence without both `head` and `get` byte equality;
- reports with extra native-observation files;
- claims that installed spelling practice, learners or Monster progress require Cloudflare.

### GREEN

Split Cloudflare evidence assembly without widening the six-file topology: Task 22 first creates an ignored run-local deployment draft after Worker/version/R2 proof, then the physical application performs the closed capability/Range smoke after it has a legitimate sealed handle. The app publishes only the redacted smoke projection. The final Cloudflare report is assembled from the deployment draft plus that validated projection; iOS/Android finalisation then binds the same Cloudflare report. This changes execution order only—no incomplete draft or extra report may be committed, and the final six files remain atomic.

Keep the public report schemas as small as possible. Observation/checkpoint internals remain untracked under `.native-build/b3/evidence`; only their approved hashes/projections enter the existing platform reports. Update architecture wording only if necessary to state:

- offline spelling and installed-pack use are local;
- commerce verification/download requires online store/gateway access;
- Monster is motivational presentation around spelling, not an independently cloud-tracked Parent metric;
- visual/theme/asset migration remains a later mandatory plan after Gate B `GO` and before C3;
- B3 proves sandbox/test commerce and download truth only, not production release readiness.

Run:

```bash
node --test tests/b3-evidence-contract.test.mjs tests/b3-live-proof-production-trace.test.mjs tests/b3-live-proof-privacy.test.mjs tests/b3-cloudflare-live-adapter.test.mjs tests/b3-cloudflare-wrapper-contract.test.mjs tests/b3-ios-wrapper-contract.test.mjs tests/b3-android-wrapper-contract.test.mjs
```

### Gate

Fresh claim-honesty/spec review. Any finding which requires application/gateway/native/verifier changes returns to the appropriate RED task above.

## Task 19H — Full local verification and reviewed completion commits

Apart from the explicit Task 19S safety checkpoint, no completion commit is made until Tasks 19A–19G are GREEN and their review gates have passed. Before each commit, inspect `git status --short`, stage only the named task files and review the staged diff. Do not push during Task 19.

Suggested checkpoint strategy:

1. `test: derive B3 production trace authority`
2. `feat: add B3 live observation protocol`
3. `feat: export B3 iOS proof observations`
4. `feat: export B3 Android proof observations`
5. `feat: resume B3 physical proof capture`
6. `feat: add exact B3 Cloudflare live adapter`
7. `test: close B3 live proof evidence`

Combine adjacent commits when the implementation cannot remain buildable independently. Never split a protocol change from the tests which authorise it. Record every resulting SHA and review verdict in `.superpowers/sdd/progress.md`.

Run the complete local, non-mutating verification set:

```bash
node --test tests/b3-live-proof-protocol.test.mjs tests/b3-live-proof-production-trace.test.mjs tests/b3-live-proof-privacy.test.mjs tests/b3-live-capture-resume.test.mjs tests/b3-physical-device-transport.test.mjs tests/b3-physical-observation-journal.test.mjs tests/b3-ios-screenshot-capture.test.mjs tests/b3-ios-screenshot-target-contract.test.mjs tests/b3-play-protect-attestation.test.mjs tests/b3-cloudflare-live-adapter.test.mjs tests/b3-evidence-contract.test.mjs tests/b3-application-fingerprint.test.mjs tests/b3-cloudflare-wrapper-contract.test.mjs tests/b3-ios-wrapper-contract.test.mjs tests/b3-android-wrapper-contract.test.mjs tests/b3-distribution-authority.test.mjs tests/b3-live-composition.test.mjs tests/purchase-crash-recovery.test.mjs tests/purchase-second-lifecycle.test.mjs
npm test
npm run lint
npm run build
npm run native:sync:check
npm run verify:b2-authority
npm run prove:b3:deterministic
npm audit --audit-level=high
(cd gateway && npm test)
(cd gateway && npm run lint)
(cd gateway && npm run deploy:dry-run)
(cd gateway && npm audit --audit-level=high)
xcodebuild -project ios/App/App.xcodeproj -scheme B3SandboxProof -configuration B3SandboxProof -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO B3_TESTED_APPLICATION_COMMIT=1111111111111111111111111111111111111111 B3_APPLICATION_FINGERPRINT=2222222222222222222222222222222222222222222222222222222222222222 B3_VERSION_NAME=0.3.0-b3 B3_IOS_BUILD_NUMBER=1 build
(cd android && ./gradlew test assembleDebug assembleRelease bundleB3SandboxProofRelease -Pb3Distribution=1 -Pb3AndroidVersionCode=1 -Pb3TestedApplicationCommit=1111111111111111111111111111111111111111 -Pb3ApplicationFingerprint=2222222222222222222222222222222222222222222222222222222222222222)
git diff --check
git status --short
```

Also run the repository's compiled hostile-ZIP harnesses, iOS StoreKit proof wrapper, Android certification/resolved-policy checks and private-material/package scanners used by Tasks 12–18. A known external StoreKit/Xcode runtime failure remains fail-closed and must be reported as external evidence not passed; it must not be converted to GREEN by mocks.

Full verification must prove:

- normal iOS/Android builds do not expose the proof plugin;
- B3 proof builds compile without signing or installation;
- no test contacted Cloudflare, a store console or a physical device;
- no tracked B2 evidence changed;
- no secret/private material entered source, bundles, native resources, logs or reports;
- the working tree contains only intended Task 19 files plus pre-existing owned changes.

Obtain fresh independent reviews on the exact final Task 19 HEAD:

1. spec and trace-contract compliance;
2. application concurrency/recovery semantics;
3. native transport, command injection and privacy;
4. Cloudflare exact-byte/R2/credential security;
5. code quality and test adequacy.

Resolve every Critical or Important finding with a new RED test and rerun the affected gate plus the full suite. Task 19 is complete only when all five reviews approve the exact same HEAD.

## Downstream invalidation and execution hand-off

Task 19 changes application, native, gateway fingerprint and verifier inputs. Therefore any earlier Task 20 checkpoint, Task 21 distribution authority or Task 22 live evidence is stale, even if its files still exist.

After this amendment is implemented and reviewed:

1. execute original Task 20 against the new clean Task 19 HEAD and record the new application fingerprint;
2. run exact-head branch CI in legitimate pending mode;
3. execute Task 21 to create fresh signed distribution authority from that exact checkpoint;
4. only then execute Task 22 with explicit scoped approvals to deploy the exact Worker/object authority and operate the two physical devices;
5. capture all nine scenarios through the device-generated state machine, then complete manual screenshot attestations;
6. commit only the exact six evidence files and run Task 23 complete-mode CI/review.

Any later application, gateway, config, native, dependency, proof-wrapper or validator change invalidates the Task 20 checkpoint and forces a new signed distribution, exact Cloudflare deployment/readback and complete iOS/Android recapture. Evidence-only corrections cannot conceal stale application authority.

## Completion definition

This amendment is complete only when:

- production integration tests define the accepted trace vectors and every real call is preserved;
- physical default adapters consume device-generated, redacted, hash-chained observations and can resume safely;
- iOS and Android transports are B3-only and fixed-path/closed-command;
- crash proof uses the existing `before:gateway-completion` seam and unchanged production recovery;
- Android certification and both screenshots are independently host-captured;
- Wrangler is pinned to 4.110.0, bound source is deployed with `--no-bundle`, and official content/version readback hashes the deployed bytes;
- the sterile OAuth child uses exact `getPlatformProxy({ envFiles: [], persist: false, remoteBindings: true })`, exact remote `PACKS`, two keys only, create-only metadata/SHA uploads, immediate `head`/`get` equality and unconditional disposal;
- all focused/full/non-mutating gates and fresh reviews pass on one exact HEAD;
- Task 19 contains no live deployment, R2 mutation, store mutation, device mutation, signing, commit of evidence or push;
- original Tasks 20–23 remain the only route to the final B3 checkpoint, live execution and Gate B decision.
