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

### B3 — sandbox billing and signed-download proof

Add the app-owned StoreKit 2 and Google Play Billing bridges, receipt-only
Cloudflare gateway, sealed refresh handles, private-R2 capability delivery,
signed data-only pack verification and physical proof protocol. B3 must preserve
B1/B2 local learning authority and privacy boundaries.

Task 19 builds and locally certifies the non-mutating capture/tooling path. It may
use fakes at external process, API and device boundaries, but it must exercise the
real application composition and SQLite recovery semantics. It must not deploy,
write R2, mutate store consoles, sign, install, operate physical devices or
publish live evidence.

Task 19 closes only when five independent reviews approve one exact HEAD for:

1. specification and production-trace compliance;
2. SQLite concurrency and recovery semantics;
3. native transport, command injection and privacy;
4. Cloudflare exact-byte, R2 and credential security; and
5. code quality and test adequacy.

Every Critical or Important correction creates a new exact HEAD and invalidates
all prior Task 19 approvals.

### Task 20 — clean application checkpoint

After Task 19 approval, create the clean application checkpoint and exact
application fingerprint. Any later application, gateway, native, dependency,
configuration, wrapper or validator change invalidates this checkpoint.

### Task 21 — signed distribution authority

Build and inspect fresh signed iOS and Android distributions from the exact Task
20 checkpoint. Signing, provisioning, store identities and distribution
inspection are separate gates from successful compilation. Task 21 does not
substitute for physical execution evidence.

### Task 22 — scoped live execution

Only explicit scoped approvals and run-token gates may authorise Cloudflare/R2,
store-console or physical-device actions. Deploy and read back the exact Worker
bytes, create-only upload the two closed R2 objects, inspect the exact signed
distributions and execute the complete iOS/Android physical scenario protocol.
Create only the six closed `reports/b3` final outputs.

### Task 23 — final exact-main review

Review the final evidence-only change, fast-forward the approved commit and
verify exact main. Task 23 does not repair application code or conceal stale
Task 20/21/22 authority; any such change restarts the affected downstream gates.

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

Changes to runtime application bytes, gateway source/configuration, native
projects, dependencies, proof plugins, fingerprint inputs, validators or wrapper
logic invalidate the Task 20 checkpoint and therefore require new signed
distributions, exact Cloudflare readback and complete physical recapture. An
evidence-only correction may not hide stale application or distribution
authority.
