# B3 Task 19 D5 Legacy Deletion and Derived Output Plan

**Status:** review candidate; implementation must not begin until two independent
reviewers approve one exact plan SHA-256.

**Parent authority:**
`docs/superpowers/plans/2026-07-16-b3-task19-sqlite-blob-authority-amendment.md`.

**Entry point:** D1-D4 are committed through `fab652f`. SQLite is the sole live
capture and recovery authority. This final bounded slice deletes the superseded
filesystem authority, preserves the pure proof domain, closes final derived-output
publication, and runs the full non-mutating Task 19 verification set.

## Outcome and non-goals

D5 finishes one bounded capability:

> Production B3 capture, recovery and proof derivation have no legacy filesystem
> working-state dependency, while the existing Task 22 final proof outputs are
> create-only, byte-idempotent derived evidence which cannot mutate SQLite.

D5 does not:

- change schema v2, transaction ordering, recovery decisions or store methods;
- create a migration, reset, second database or filesystem working-state store;
- deploy or mutate Cloudflare, R2, App Store, Play Store, a simulator or a device;
- create signed output, live evidence or any of the final six report files;
- implement the Task 20 exit-report builder, execute the Task 22 live assembly or
  widen the exact six-file topology;
- rewrite the independent ignored deployment draft, screenshot capture source or
  Play Protect attestation; or
- add a generic persistence abstraction, path parameter, database handle, fault
  hook or compatibility facade.

## 1. Filesystem-free proof domain

Create one narrow pure module:

```text
scripts/lib/b3-capture-proof-domain.mjs
```

Move, without changing canonical records, hash domains, validation rules or error
semantics, the surviving pure functions from the old journal/checkpoint shells:

- `buildB3PhysicalProofAuthority`;
- `createB3CaptureCheckpoint`;
- `createB3CaptureCheckpointFromObservation`;
- `validateB3CaptureCheckpointBytes`;
- `assertB3CaptureResumeAuthority`;
- `validateB3PhysicalObservationRecordBytes`;
- `deriveB3PhysicalObservationRecord`;
- `deriveB3CaptureStep`;
- `validateB3RetainedCaptureStep`;
- `deriveB3DeviceGatewaySmokeProjection`;
- `deriveB3ProofObservationChain`; and
- `deriveB3ScenarioTransition`.

The module may import canonical JSON, evidence and live-proof protocol validators.
It must not import `node:fs`, `node:path`, SQLite, transport, a clock, environment
variables or any deleted module. It accepts values/bytes only and returns frozen
validated values. `b3-capture-state-repository.mjs`,
`b3-live-capture-adapters.mjs`, store-backed helpers and focused tests import the
pure module directly.

Pure checkpoint validation survives because a checkpoint is embedded in every
SQLite step row. Filesystem checkpoint read/write and resume reconciliation do
not survive. The default adapters expose the store-backed public surface only;
the transitional checkpoint re-exports are removed.

## 2. Delete the superseded working-state architecture

After every surviving pure import is rewired, delete these production modules:

```text
scripts/lib/b3-capture-bundle-store.mjs
scripts/lib/b3-capture-recovery-store.mjs
scripts/lib/b3-abandoned-capture.mjs
scripts/lib/b3-host-capture-state.mjs
scripts/lib/b3-issued-command.mjs
scripts/lib/b3-physical-observation-journal.mjs
scripts/lib/b3-device-observation.mjs
```

Retain `b3-issued-command-authority.mjs`; it is a pure canonical authority used by
SQLite. Retain `b3-capture-recovery-authority.mjs`; it is the pure D4 archive and
terminal authority, not a filesystem recovery store.

Remove the corresponding dead exports and code paths from
`b3-live-capture-adapters.mjs`:

- device-smoke diagnostic-file publication;
- filesystem observation capture/resume;
- issued-command filesystem lifecycle;
- abandoned-directory recovery;
- checkpoint reconciliation; and
- the old one-step host command driver.

The default adapter continues to compose only
`createB3StoreBackedLiveCapture`, physical transport, independent distribution
inspection, screenshot capture and pure proof derivation. `inspectGatewaySmoke`
returns the validated projection read from the fresh SQLite working capture and
does not create `.native-build/b3/evidence/cloudflare-device-smoke.json`.

Delete tests and helper children whose sole subject is the bundle, journal,
checkpoint file, filesystem issued command, filesystem recovery store or
same-UID filesystem race matrix. Move the still-authoritative pure assertions
from `b3-physical-observation-journal.test.mjs` and the small live-driver tail of
`b3-live-capture-resume.test.mjs` into concise domain/live-composition tests before
deleting those obsolete files. Update wrapper contracts to require the SQLite
default adapter and to reject the removed transitional checkpoint export.

The whole-file obsolete deletion set is:

```text
tests/b3-capture-bundle-store.test.mjs
tests/b3-capture-recovery-store.test.mjs
tests/b3-live-capture-resume.test.mjs
tests/b3-physical-observation-journal.test.mjs
tests/helpers/b3-capture-bundle-materialise-aba-child.mjs
tests/helpers/b3-capture-bundle-reconcile-death-child.mjs
tests/helpers/b3-capture-bundle-store-child.mjs
tests/helpers/b3-capture-store-fs-death-child.mjs
tests/helpers/b3-issued-command-race-child.mjs
tests/helpers/b3-live-capture-race-child.mjs
```

Source scans must prove:

1. all seven deleted production paths are absent;
2. no production or test import names a deleted module;
3. no production symbol names an old bundle/journal/checkpoint/issued-command or
   abandoned-directory working-state API;
4. the store-backed controller still imports no filesystem working-state module;
5. `cloudflare-device-smoke.json` has no production writer or final-evidence
   reader; and
6. `reports/b3` remains the only final proof-output namespace.

## 3. Exact final derived-output publisher

Add one B3-specific module:

```text
scripts/lib/b3-final-proof-output.mjs
```

This is not a generic persistence abstraction. Its closed allow-list is exactly:

```text
reports/b3/cloudflare-sandbox-proof.json
reports/b3/ios-sandbox-proof.json
reports/b3/ios-sandbox-proof.png
reports/b3/android-sandbox-proof.json
reports/b3/android-sandbox-proof.png
reports/b3/b3-exit-report.json
```

D5 calls it only for the five outputs that already have Task 19/22 writers. Task
20 owns and implements the exit-report builder through this closed publisher;
Task 22 executes that builder to create `b3-exit-report.json` with the other five
live outputs; Task 23 only reviews, fast-forwards and verifies exact main. D5's
sixth allow-list entry freezes the topology but creates no exit writer, bytes or
report.

The publisher receives only a repository root, one closed output identity and
already validated frozen bytes. It never receives a database handle/path,
capture ID, SQL, validator callback, arbitrary relative path or delete/overwrite
option. JSON callers canonicalise their already validated report as the existing
two-space JSON plus final newline. PNG callers pass bytes already accepted by
`validateB3PngBytes`. The publisher copies the bounded input buffer synchronously
before its first asynchronous boundary so caller mutation cannot change the
published bytes.

Publication behaviour is exact:

1. canonicalise the repository root and create/validate only `reports/b3`;
2. require real non-symlink directories and a non-group/world-writable output;
3. create a private unique temporary file with `wx`, write all bytes, `sync`,
   close, `link` to the fixed final path, immediately unlink only that temporary,
   then sync the parent directory;
4. on an existing final, open with `O_NONBLOCK | O_NOFOLLOW`, `fstat` before any
   read, require a regular file, then read bounded bytes and compare the exact
   buffer so a FIFO/device/non-regular path can never block validation;
5. return one frozen result for a newly created or byte-identical final;
6. permit only a bounded revalidation when an exact-byte existing final has the
   legitimate transient two-link publication state; succeed only if it converges
   to one link, and fail closed for a persistent hard link, partial, different,
   symlinked, non-regular, oversized or group/world-writable final; and
7. always remove only its own temporary file.

There is no overwrite, rename-over-final, final deletion, repair or best-effort
healing. Concurrent identical writers converge to one identical final;
concurrent different writers produce one winner and one conflict. The bounded
two-link revalidation observes only the final inode; it never searches for or
removes another process's temporary and a persistent two-link inode remains a
conflict.

Use this publisher in:

- `prove-b3-cloudflare.mjs` for Cloudflare JSON;
- `prove-b3-ios.mjs` for iOS JSON;
- `prove-b3-android.mjs` for Android JSON; and
- `persistB3PlatformScreenshot` for the iOS/Android PNG paths.

Pending platform evidence, the Cloudflare deployment draft, captured source
screenshots and Play Protect attestation keep their existing independent ignored
input boundaries. They are not final derived outputs and are not moved into the
publisher.

## 4. TDD and finite verification

### RED first

Add focused failing tests before production edits:

- pure-domain tests import the new module and prove canonical record/checkpoint,
  optional smoke, scenario transition and proof-chain parity;
- legacy-deletion tests prove the seven files and every import/export are absent;
- default-adapter tests prove SQLite-only records/checkpoint/smoke/recovery and no
  duplicate smoke file;
- one final-output contract covers absent, identical, partial, different,
  symlink, FIFO/non-regular, persistent hardlink, test-owned transient two-link
  convergence and concurrent identical/different publication;
- each JSON wrapper and both screenshot paths use the same closed publisher; and
- absent, identical, partial and conflicting final-output cases hash the real
  SQLite database before and after and prove byte identity, including failure
  cases.

Tests operate in isolated temporary roots. They may seed a real schema-v2 database
through the existing `B3CaptureStore` test surface. They must not mock the final
publisher in wrapper contract tests or add a production fault hook.

### Focused GREEN

Run all modified/new tests plus D1-D4 state, repository, publication, recovery,
live-composition, default-adapter, wrapper, screenshot, device-smoke, evidence and
privacy suites. Run `node --check` on every modified production/helper module,
Oxlint on every modified production/test/helper file, the source scans above and
`git diff --check`.

### Full non-mutating gate

Run the authoritative Task 19H local set, adjusted only to replace deleted legacy
test filenames with their D5 successors:

```text
npm test
npm run lint
npm run build
npm run native:sync:check
npm run verify:b2-authority
npm run verify:vendor
npm run test:upstream:a3
npm run test:ios
node scripts/test-ios-pack-inspector.mjs
npm run test:android
npm run certify:android
npm run test:android-resolved-policy
npm run report:b3-native
npm run prove:b3:deterministic
npm run audit:dependencies
npm audit --audit-level=high
(cd gateway && npm test)
(cd gateway && npm run lint)
(cd gateway && npm run deploy:dry-run)
(cd gateway && npm audit --audit-level=high)
```

Also run the compiled hostile-ZIP harnesses, iOS StoreKit proof wrapper, Android
certification/resolved-policy checks, private-material/package scanners and the
normal iOS/Android test/build wrappers used by Tasks 12-18. Run:

- the unsigned `B3SandboxProof` iOS simulator build with fixed synthetic commit,
  fingerprint, version and build-number authority; and
- Android `test`, `assembleDebug`, `assembleRelease` and
  `bundleB3SandboxProofRelease` with fixed synthetic authority.

The native-sync gate must report all seven contract tests green. Normal native
builds must not expose the B3 proof plugin; B3 proof builds compile without
signing or installation. No command may contact Cloudflare, R2, a store console,
a physical device or a live store. Run `npm run prove:b3:ios-storekit-test`
separately as the already authorised local non-live simulator proof. A real
external Xcode/StoreKit runtime failure remains fail-closed and is reported
separately; mocks cannot make it green or authorise any live-evidence claim.

Run full gates in an isolated output root or serially where two repository scripts
otherwise share generated output. A shared-output race may be rerun in isolation
only to diagnose it; D5 cannot waive a deterministic product failure or call the
full gate green while it remains reproducible.

The previously observed `b3-native-audit` double-build failure is part of D5 if
it reproduces. Repair the test harness, not global test concurrency: resolve one
fresh dependency-artifact snapshot, freeze it, and pass that same input to the
two deterministic audit builds. The real `report:b3-native`, certification and
resolved-policy commands independently prove a fresh resolution. An isolated
rerun is diagnostic evidence only and cannot replace a green full suite.

## 5. Documentation, review, commit and push

Create `docs/architecture/b3-capture-authority.md` and update only directly
affected existing operations/privacy references to state:

- SQLite schema v2 is the sole ignored mutable capture/recovery archive;
- reports and screenshots are immutable derived evidence outside SQL;
- no spelling practice, learner progress or Monster progress depends on
  Cloudflare/R2; and
- Task 19 performs no live mutation and claims no signed/live evidence.

Update `.superpowers/sdd/progress.md` with D5 focused/full gate results, exact
commit/tree and the explicit Task 19-incomplete hand-off to five exact-HEAD
reviews. The progress file remains ignored unless its existing policy changes.

Before the implementation commit:

1. stage only D5 files;
2. record exact base SHA, staged patch SHA and resulting tree;
3. obtain two independent approvals of that exact staged snapshot: one for
   legacy deletion/import/domain/output correctness and one for spec,
   SOLID/DRY/YAGNI, tests and verification adequacy;
4. fix every actionable P1/P2 with RED/GREEN and invalidate both approvals; and
5. commit only after both reviewers approve the same exact snapshot.

The later SQLite parent amendment's `push after D5` instruction supersedes the
older Task 19H `do not push during Task 19` wording. After the reviewed D5 commit
and full non-mutating gate, push the current branch non-force as the requested
safety checkpoint. Do not create or merge a PR.

Task 19 still closes only after five fresh independent reviewers approve the same
exact final HEAD for:

1. spec and production-trace compliance;
2. SQLite concurrency and recovery semantics;
3. native transport, command injection and privacy;
4. Cloudflare exact-byte/R2/credential security; and
5. code quality and test adequacy.

Any P1/P2 fix invalidates all five approvals and requires the affected/full gates
again. Five approvals close Task 19 only; Tasks 20-23 remain responsible for the
clean checkpoint, signed distribution, scoped live execution and final evidence.

## Completion definition

D5 is complete only when:

- the seven legacy production modules and obsolete tests/helpers are deleted;
- every surviving pure derivation imports the filesystem-free proof domain;
- production default adapters use only SQLite for mutable capture/recovery state;
- the obsolete device-smoke file has no writer;
- all five existing final proof writers are exact-byte idempotent and conflicting
  bytes fail closed without changing SQLite;
- all focused, full, native, audit and gateway dry-run gates pass;
- two exact-snapshot D5 reviewers approve one implementation tree;
- the clean D5 commit is pushed non-force; and
- progress hands the exact HEAD to the five Task 19H reviewers without claiming
  live deployment, R2/store/device mutation, signing or evidence completion.
