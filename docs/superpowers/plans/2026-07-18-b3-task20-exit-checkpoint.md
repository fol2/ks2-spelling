# B3 Task 20 Exit Report and Development Application Checkpoint Plan

**Status:** implemented. Its downstream sequence is governed by the current B3
plan and programme.

**Fixed point:** `6be15b7df781670f8c19b59d4b2d033832c4b864`, the
reviewed and merged Task 19 checkpoint.

**Authority:** Task 20 in
`2026-07-12-standalone-spelling-mobile-b3-sandbox-billing-signed-download-proof.md`,
with the programme and standalone application design remaining authoritative.

## Outcome

Task 20 adds one narrow exit-report builder and converts the existing three-lane
workflow to B3. The resulting clean commit is the B3 Development application
checkpoint consumed by Task 21. It is not the final release-candidate checkpoint;
Task 22 freezes fresh final bytes before signing or live capture.

Task 20 performs no Cloudflare or R2 mutation, store action, signing, installation,
physical-device action or live evidence publication. It does not change application,
gateway, native, SQLite, commerce, download or capture behaviour.

## Design choice

Keep all new composition and checkpoint orchestration in one deep module:

```js
buildB3ExitReport({ root, expectedApplicationCommit, expectedApplicationFingerprint })
checkB3LiveEvidenceTopology({ root, operation, runGit })
```

The CLI exposes only `--write` and `--check-ci`.

Reuse the existing B2 authority verifier, B3 application fingerprint, Cloudflare
and platform evidence validators, PNG validator, pinned Git runner and create-only
final-output publisher. Do not add another evidence framework, history repository,
Git object parser, SQLite layer, recovery mechanism or Task 21/22 session facade.

Export the existing six output paths from
`scripts/lib/b3-final-proof-output.mjs`; derive its private `Set` from the exported
array so the builder and publisher share one topology authority.

## Closed topology

The six final paths remain exactly:

1. `reports/b3/cloudflare-sandbox-proof.json`
2. `reports/b3/ios-sandbox-proof.json`
3. `reports/b3/ios-sandbox-proof.png`
4. `reports/b3/android-sandbox-proof.json`
5. `reports/b3/android-sandbox-proof.png`
6. `reports/b3/b3-exit-report.json`

`--check-ci` accepts only:

- **pending**: zero current paths, a clean worktree, and six separate full-history
  queries proving that no path has appeared in any available ref;
- **complete**: all six current paths, strict byte regeneration, one shared final
  release-candidate commit/fingerprint, and an evidence-only successor whose diff
  is exactly the six paths.

One to five current paths always fail. A prior one-, five- or six-path state followed
by zero or partial current evidence fails permanently. History uses the existing
pinned Git adapter and one `git log --all --format=%H -- <path>` query per exact
path; no custom object traversal is required.

`--write` is the Task 22 hand-off. It accepts exactly the first five uncommitted
outputs and no unrelated change, validates and snapshots all five, builds the sixth
file and publishes it with `publishB3FinalProofOutput()`. Committed history must
still contain none of the six paths. An idempotent rerun is valid only for identical
six-file bytes.

## Exit report

The report stores identities and hashes rather than copying live detail:

```text
schemaVersion, status, testedApplicationCommit, applicationFingerprint
b2Authority
deterministicInputs
trackedAuthorities
liveEvidence
claimBoundary
```

It binds:

- the frozen B2 commit, tree and exit-report hash;
- the exact final release-candidate application commit and B3 fingerprint;
- the proof-pack, native-build, dependency and deterministic report hashes;
- tracked gateway, pack-object, product and synthetic-learner authority hashes;
- Cloudflare, iOS, Android and both screenshot hashes;
- the existing validators' Worker/R2/envelope, platform-specific certificate,
  signed-distribution, scenario, learner-preservation and offline-continuity truth;
- an exact `sandbox-test-only` claim boundary with production readiness and
  production content explicitly false.

Do not flatten device descriptions, gateway traces, learner identities or whole
input reports into the exit report. Existing closed validators remain the semantic
authority. The builder checks regular, non-executable, bounded files and rejects
unknown, private, stale, cross-platform or production claims through those existing
contracts.

## Files

Create:

- `scripts/build-b3-exit-report.mjs`
- `tests/b3-exit-report-builder.test.mjs`
- `tests/b3-live-evidence-history.test.mjs`
- `tests/b3-exit-report.live.mjs`
- `docs/architecture/b3-commerce-pack-authority.md`

Modify:

- `scripts/lib/b3-final-proof-output.mjs`
- `.github/workflows/ci.yml`
- `tests/ci-workflow-contract.test.mjs`
- `package.json`
- `docs/operations/native-development.md`
- `README.md`

Do not change dependencies, lockfiles, the SDK privacy register or application,
gateway, native, capture, repository and evidence-validator sources. The existing
privacy register already records the B3 sandbox-only and production deferrals.

## Implementation

### T1 — Freeze the topology and RED tests

Export the existing six paths without changing publisher behaviour. Add table-driven
tests for never-present pending, current one/five, prior one/five/six followed by
zero, valid complete, deleted complete and non-evidence successor changes.

Add builder RED tests for valid composition; commit/fingerprint drift; deterministic
and tracked-authority drift; Cloudflare/platform equality; screenshot bytes; wrong,
generic and cross-platform certificate fields; conflicting exit bytes; and unrelated
dirty input. Do not duplicate the exhaustive nested mutation matrices already owned
by `b3-evidence-contract.test.mjs`.

Expected RED:

```bash
node --test tests/b3-exit-report-builder.test.mjs \
  tests/b3-live-evidence-history.test.mjs \
  tests/ci-workflow-contract.test.mjs
```

### T2 — Implement the builder and CLI

Implement the two exported functions in the single builder module. Validate all
five live inputs before writing. Use canonical one-line JSON with a trailing newline
and the existing create-only publisher. `--check-ci` prints exactly one safe JSON
record containing `ok`, `mode`, `testedApplicationCommit` and
`applicationFingerprint`; failures print one redacted error record and return
non-zero.

Add `tests/b3-exit-report.live.mjs` outside the default glob. It requires complete
mode and remains Task 22 evidence, not a Task 20 pending test.

### T3 — Add the authorised package command and three-lane CI

Add the exact `verify:b3` command already frozen by
`b3-package-transition-authority.mjs`.

Keep exactly three jobs, full history, pinned Actions and Node `24.18.0`. Change the
workflow identity and push branch from B2 to
`jamesto/mobile-b3-billing-download`. Pull requests must check the exact head rather
than treating GitHub's synthetic merge commit as application authority.

- Domain/Web installs both lockfiles, verifies frozen/vendor authority, materialises
  deterministic proof-pack and native bundle inputs, then runs the host-neutral
  default-suite tests, real gateway/workerd tests and dry-run, deterministic proof,
  lint, build and `--check-ci`. Platform execution stays in the native lanes; the
  two cross-host aggregate tests remain in the full local `verify:b3` gate.
- iOS runs native sync, unsigned normal and B3 compilation, the owned hostile pack
  inspector, the non-live StoreKit test and `--check-ci`.
- Android retains Java 21/API 36, runs Java tests plus normal/B3 unsigned builds,
  dependency certification/resolved policy and `--check-ci`.

The known local Xcode 26.6/iOS 26.5 StoreKit runtime error remains fail-closed. Do
not add a mock or weaken the hosted StoreKit gate. The wrapper separates a clean
hosted Simulator readiness phase, allowed up to five minutes, and
`build-for-testing`, allowed up to ten minutes, from a bounded
`test-without-building`. The latter consumes the generated `.xctestrun` manifest
instead of reloading the project graph. Execution is allowed 90 seconds while
preserving the 20/30-second XCTest limits.

### T4 — Document the checkpoint boundary

Create one architecture document explaining the Development-versus-Release
commerce and signed-download boundary, local/offline learning authority, the
six-file successor and checkpoint invalidation rules. Add only concise links and
operator commands to the native-development guide and README.

Explicitly defer production content/audio, production secrets/Worker/bucket,
pricing, store approval, Parent/child production UI, family sharing and Visual /
Theme / Asset Migration. B4 owns virtual/hosted product-quality development; the
pre-release gate owns broad physical compatibility, accessibility/performance and
Release Commerce Certification.

## Verification and commit

Run the original Task 20 verification chain, including fresh installs, B2/vendor/A3,
the full Node suite, lint/build/native sync, gateway tests/dry-run/audit, normal and
B3 native builds, hostile inspectors, StoreKit fail-closed evidence, Android
certification/resolved policy, deterministic/native/dependency report regeneration,
`actionlint`, history tests and `git diff --check`.

Commit only the intended Task 20 files and regenerated deterministic B3 reports.
The clean commit becomes the Task 21 Development `testedApplicationCommit`. Push
it to a Task 20 branch and obtain exact-head hosted CI before integration. Task 22
later replaces that authority with a fresh final release-candidate checkpoint.

## Review gate

All reviewers inspect the same exact candidate:

1. Gstack confirms Task 20 scope, the six-file boundary, Task 21 Development
   integration and Task 22 Release deferral.
2. Matt runs the two-axis Standards and Spec code review.
3. Ponytail rejects duplicate validation, speculative abstraction and unnecessary
   files, tests, modes or dependencies.

Only actionable P1/P2 findings inside Task 20 block completion. Any correction
creates a new candidate and restarts all three reviews.

## Invalidation

Before Task 21 integration, any application, gateway, native, dependency,
configuration, proof-wrapper, validator, fingerprint, builder or workflow change
invalidates the Task 20 Development checkpoint, except Task 21's exact order-only
move of the unchanged iOS topology command immediately after Node setup and its
contract assertion. That exception changes no application, verifier or report
input and must preserve the exact Task 20 fingerprint. After integration, planned
B4/C changes do not require throw-away signing or live capture. Task 22 freezes
one fresh final release-candidate checkpoint; any subsequent
application-authority change invalidates its signing and live evidence. The only
legal tracked successor to that final checkpoint is the exact six-file evidence
set; Task 23 changes no files.
