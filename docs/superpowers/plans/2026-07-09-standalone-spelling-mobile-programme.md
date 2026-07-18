# Standalone Spelling Mobile Programme

## Repository-owned programme authority

This tracked programme is the GitHub-reviewable replacement for the earlier
workstation-only programme reference. It freezes sequencing and claim boundaries
for `fol2/ks2-spelling`; it does not retroactively widen any completed gate.

The product design authority is
[`../specs/2026-07-09-standalone-spelling-mobile-application-design.md`](../specs/2026-07-09-standalone-spelling-mobile-application-design.md).
The frozen upstream input is `fol2/ks2-mastery` commit
`4501607a9b58f2fb252b4cce64ba056e6f60c630`, tree
`129ba457cccf21df03f4be813b4f4ed6e7d9f6ad`. Imported runtime bytes are governed
by manifest and hash evidence in this repository rather than by a sibling
working tree.

## Programme sequence

### Gate A — upstream spelling authority

Freeze the reusable spelling runtime, catalogue and contract manifest in the
upstream repository. Gate A is source authority only. Later mobile work may copy
only the frozen manifest-selected closure with exact hash evidence.

### B1 — repository and native-shell authority

Create the standalone mobile repository, vendor the frozen upstream closure and
establish the local-first installed-code boundary. B1 does not approve SQLite,
commerce, downloads, signing, deployment or production native capability.

The effective record is
[`../../architecture/b1-authority.md`](../../architecture/b1-authority.md).

### B2 — transactional persistence and lifecycle proof

Prove learner-isolated SQLite persistence, atomic command application, rollback,
WAL lifecycle handling and process restart on owned virtual devices. B2 evidence
proves only the exact simulator/emulator and unsigned/local configurations it
records.

The implementation plan is
[`2026-07-11-standalone-spelling-mobile-b2-native-persistence-lifecycle-proof.md`](2026-07-11-standalone-spelling-mobile-b2-native-persistence-lifecycle-proof.md)
and the effective record is
[`../../architecture/b2-persistence-authority.md`](../../architecture/b2-persistence-authority.md).

### B3 — development commerce and signed-download proof

Add the app-owned StoreKit 2 and Google Play Billing bridges, receipt-only
Cloudflare gateway, sealed refresh handles, private-R2 capability delivery,
signed data-only pack verification and a fail-closed release-proof protocol. B3
must preserve B1/B2 local learning authority and privacy boundaries.

Task 19 builds and locally certifies the non-mutating capture/tooling path. It may
use fakes at external process, API and device boundaries, but it must exercise the
real application composition and SQLite recovery semantics. It must not deploy,
write R2, mutate store consoles, sign, install, operate physical devices or
publish live evidence.

Task 19 closes only when three independent reviews approve one exact HEAD:

1. Gstack confirms the frozen Task 19 scope and Task 22 deferral;
2. Matt reviews Standards and Spec compliance; and
3. Ponytail rejects over-engineering and premature Task 22 work.

Only actionable P1/P2 findings inside the frozen Task 19 boundary block
completion. Every such correction creates a new exact HEAD and invalidates all
three Task 19 approvals. The detailed gate is defined by the Task 19H scope
correction.

### Task 20 — clean application checkpoint

After Task 19 approval, create the clean application checkpoint and exact
application fingerprint. Any later application, gateway, native, dependency,
configuration, wrapper or validator change invalidates this checkpoint.

### Task 21 — development commerce checkpoint

Close the B3 Development Checkpoint using the exact Task 20 application
fingerprint, deterministic commerce/download proof, workerd and gateway dry-run,
hosted Xcode StoreKit Test, Android BillingClient tests, unsigned native builds
and CI `pending` topology. Merge the reviewed checkpoint to `main` only after
Gstack boundary, Matt Standards/Spec and Ponytail over-engineering reviews approve
one exact HEAD. The resulting claim is development capability, not signed-store,
live Cloudflare or physical-device certification.

### Task 22 — deferred Release Commerce Certification

Task 22 is intentionally non-blocking for B4 and C-series development. After the
final product, visual and release-candidate bytes are frozen, only explicit scoped
approvals and run-token gates may authorise Cloudflare/R2, store-console or
physical-device actions. Produce and inspect fresh signed iOS and Android
distributions from that final checkpoint, deploy and read back the exact Worker
and R2 bytes, and execute the complete Apple/Google store protocol. Create only
the six closed `reports/b3` final outputs. Device access may be borrowed or an
approved hosted-real-device service; the evidence contract is not weakened to
accept a Simulator or emulator as live store truth.

### Task 23 — deferred release-candidate exact-main review

After Task 22, review the final evidence-only change, fast-forward the approved
release-candidate commit and verify exact main in CI `complete` mode. Task 23
does not repair application code or conceal stale release-candidate authority;
any application change restarts the final checkpoint, signed distribution and
live certification.

## Cross-cutting rules

- Use UK English in code, comments, documentation, commit messages and product
  copy.
- Keep production application code local and bundled; `server.url` remains null.
- Keep learner spelling, session, Monster and Camp state local and independent of
  Cloudflare/R2 availability.
- Keep child surfaces free of commerce and administrative controls.
- Never request or commit signing keys, store credentials, raw receipts,
  purchase tokens, refresh handles or private tester/device identity.
- Treat project configuration, compilation, launch, signing, installation,
  physical execution, store readiness and production readiness as separate
  evidence gates.
- Do not claim a wider gate from a narrower simulator, emulator, unsigned build,
  mock, dry-run or local proof.

## Downstream invalidation

Before Task 21 integration, changes to runtime application bytes, gateway
source/configuration, native projects, dependencies, proof plugins, fingerprint
inputs, validators or wrapper logic invalidate the Task 20 checkpoint. After B3
Development Checkpoint integration, ordinary planned B4/C development is allowed
to change those bytes without producing throw-away signed distributions or live
captures. Task 22 must instead create one fresh final release-candidate checkpoint
and bind all signed distribution, Cloudflare/R2 and physical-store evidence to
that exact authority. An evidence-only correction may not hide stale application
or distribution authority.
