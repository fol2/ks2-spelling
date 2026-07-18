# B3 Task 19 S3 C2 Initial-start Reconciliation Micro-plan

**Status:** review candidate; implementation must not begin until two independent
reviewers approve one exact plan SHA-256.
**Fixed point:** `2fa555b0773de58e567bed1e8be8c3e2a30091ae`.
**Authority:** the approved S3 working-capture-bundle micro-plan, the approved
SQLite recovery-ledger superseding plan, and the C1 classifier/composite
validator at this fixed point. The frozen schema remains authoritative.

## Bounded outcome

C2 turns the already-durable S2 `initial` start reservation into one ready
capture, one allocation-sequence-1 prepared command and one exact empty working
bundle. Process death may retain only the same pending intent plus a recognised
partial empty bundle; an unmocked retry converges on the retained capture ID and
first command without allocating a second authority.

C2 introduces the public `B3CaptureStore.startCapture()` seam and the private
reconciler needed for that operation. It does not publish a bundle member,
migrate a live caller, change an S2 command/decision outcome, or implement any
recovery phase.

## Exact seams

The C2 public module is `scripts/lib/b3-capture-store.mjs`:

```text
openB3CaptureStore({ platform })
  -> frozen handle with exactly startCapture and close

startCapture({ command })
  -> { kind: 'started', capture }
   | { kind: 'already-started', capture }
   | { kind: 'start-conflict', capture }
```

The input is a closed record with exactly `command`. Snapshot the command and
all nested values synchronously before the first await. `capture` is the exact
ready projection already frozen by `publicB3CaptureStartAuthority()`: no path,
database handle, transaction, root state, temporary name or reconciliation
phase is exposed.

The private repository operation is:

```text
reconcileInitialCaptureStart({ command })
  -> { kind: 'won-reservation', capture }
   | { kind: 'same-winner', capture }
   | { kind: 'different-winner', capture }
```

The facade maps these kinds respectively to `started`, `already-started` and
`start-conflict`, without wrapping or altering `capture`. The existing S2
repository methods and their exact result unions remain unchanged.

The sole new bundle-store operation is private to the repository:

```text
materialiseB3EmptyWorkingBundle({ platform, captureId, rootState })
  -> fresh branded C1 root state for the exact empty working bundle
```

It is synchronous, accepts only a C1-branded `rootState`, derives every literal
path from the fixed repository root, and accepts no caller root, path,
filesystem adapter, callback or fault selector. It creates no SQL row. The
repository owns both SQLite transactions and calls the C1 classifier and
composite validator before and after the filesystem effect.

## Reservation and result semantics

`reconcileInitialCaptureStart()` owns two transactions because the pending
intent must be durable before any bundle directory can survive a crash.

1. Fresh-read build authority outside a transaction, derive the caller's exact
   initial-start proposal, then enter reservation `BEGIN IMMEDIATE`.
2. Validate the whole database and C1 database/bundle composite.
3. Empty authority inserts the pending intent and singleton reservation exactly
   as S2 does, rederives it, commits, and records `won-reservation`.
4. A retained pending or ready initial intent is the winner. Compare its
   `startIntentSha256` with the caller proposal, commit without mutation, and
   record `same-winner` or `different-winner`.
5. Fresh-read build authority again outside a transaction. Pending authority
   proceeds to the reconciliation transaction below; ready authority is fully
   revalidated and returned without requiring its first command to be active.

A different-command loser **may and must be able to complete** the retained
winner's pending-to-ready reconciliation. It creates only the retained
winner's bundle and rows. Even when that losing invocation performs the mkdir,
fsync and SQL transition, it returns `start-conflict`, never `started` or
`already-started`. A same-command invocation which did not win the reservation
returns `already-started`, even if it performs the ready transition. Only the
invocation which inserted the reservation returns `started`; another helper
may have completed readiness before it returns.

This makes the result describe caller authority, not which process happened to
finish an idempotent effect.

## Recognised partial-empty state machine

C2 reuses `classifyB3CaptureBundleRootState()` and
`validateB3CaptureBundleComposite()`; it does not introduce a second parser.

| Pending database and C1 root state | Action |
| --- | --- |
| `absent` bundles root | Create root, working directory and all three children |
| `empty` bundles root | Create the winner's working directory and all children |
| Same-capture `partial-working`, exact empty, any of eight child subsets | Create only missing children in fixed order |
| Same-capture `working`, exact empty | Perform no mkdir; continue to SQL |
| Wrong capture, non-empty child, member/temp, link, wrong mode/type/device/parent or unexpected entry | Reject before mutation |
| Pending plus any capture/command row, wrong reservation, active command, non-empty chain or non-null predecessor | Reject before mutation |
| Ready plus its exact authoritative bundle and rows | Validate and return the retained winner |
| Ready with any other database/bundle pairing | Reject without repair |

The eight subsets are the power set of `observations`, `checkpoint` and
`derived`, all exact empty `0700` direct children. No state is recognised by a
caller-supplied capture ID: the durable winning intent supplies it.

## Filesystem order under the writer lock

After fresh build-authority validation, the second transaction runs one
repository-owned `BEGIN IMMEDIATE`. There is no await, Promise, callback,
sleep, caller code or asynchronous filesystem operation until commit or
rollback.

After complete database and composite validation, the bundle operation creates
or validates in this exact order:

1. `<platform>-capture-bundles`; if missing, mkdir exact `0700`, fsync the new
   directory, then fsync `evidence`.
2. `<captureId>.working`; if missing, mkdir exact `0700`, fsync it, then fsync
   the bundles root.
3. `observations`; if missing, mkdir exact `0700`, fsync it, then fsync the
   working directory.
4. `checkpoint`; apply the same child-then-working fsync order.
5. `derived`; apply the same child-then-working fsync order.
6. Fsync the complete working directory, fsync the bundles root, then obtain a
   fresh C1 classification and prove the exact empty working composite.

Every existing component is revalidated through C1 before use. Directory
handles use no-follow semantics and exact inode/device/mode checks. `EEXIST`,
`ENOENT` or identity replacement is never success: rollback and require a full
database plus namespace reread. SQLite rollback does not remove already-durable
recognised directories; they are the intentional resume states.

## Checked SQL order

Only after the exact empty bundle snapshot is pinned does C2 execute these
statements, each with an exact checked row count of one:

1. Insert `b3_captures` for the winner's capture ID, intent SHA, `working`,
   `row_version=1`.
2. Insert `b3_commands` from the retained canonical command/prepared bytes at
   allocation sequence 1, null predecessor, observation sequence 1 and the
   all-zero previous observation SHA.
3. Update singleton authority from the exact pending row version: set next
   allocation sequence 2, active command to the first command, clear the
   reservation and increment row version.
4. Update the exact pending intent to `ready` and increment its row version.

Any zero/multiple row count throws and rolls back. Before `COMMIT`, rerun full
database validation, C1 root classification and ready/exact-empty composite
validation. The transaction must rederive the same ready capture, command,
active pointer, cleared reservation and row versions. No result is built from
unchecked write inputs.

Death before commit rolls back all four SQL changes while retaining only a
recognised empty directory subset. Death after commit reopens as the same ready
winner. A ready retry continues to validate the first command's immutable row
but does not require it to remain the active tail after later S3 checkpoints.

## TDD slices

Implement one bounded RED-to-GREEN slice at a time:

1. Freeze the facade and internal result shapes, closed options, synchronous
   input snapshot and `started | already-started | start-conflict` mapping.
2. RED every recognised pending root state: absent root, empty root, working
   absent, all eight empty child subsets and complete empty layout. Prove every
   hostile/non-empty/wrong-capture state rejects byte-for-byte unchanged.
3. Implement the single private bundle materialiser with the exact mkdir/fsync
   order and C1 branded input/output; do not add another inventory grammar.
4. RED then implement the checked four-statement SQL transition and final
   database/bundle rederivation.
5. Race real same-command and different-command starters. Prove one retained
   winner, one bundle and one first command. Include a different loser which
   performs reconciliation yet returns `start-conflict`, and a same loser which
   performs it yet returns `already-started`.
6. Prove ready retries after the first command is transitioned, consumed or no
   longer active return by start-intent identity and never allocate again.

## Fault and kill matrix

Use test-owned child processes around the unchanged production seams. Mock
fixed synchronous `node:fs` before dynamic import for filesystem ordinals; for
SQL ordinals, delegate every non-target `node:sqlite` method through
`Proxy`/`Reflect`. Production receives no hook or adapter.

For the maximal absent-root path, stop and kill a child immediately before and
after every mkdir, new-directory fsync and parent fsync, then reopen in an
unmocked child. Also kill after the complete empty snapshot. Every case must
converge with the same retained capture ID and first-command SHA.

For SQL, stop and kill before and after each ordered statement `run`, after
each checked row count, before final validation, before commit, and after commit
before return. Include death immediately after the reservation commit and
between the two transactions. SQLite rollback plus a recognised bundle subset
must converge; impossible committed partial rows created only by fixtures must
reject without filesystem mutation.

Run two-process contention for same/different starters separately from mocked
faults. Assert bounded busy handling, no orphan active command, no ownerless
bundle, no second UUID and no result containing a losing command.

## Verification and checkpoint rule

C2 GREEN requires focused start/bundle/repository tests; the complete C1 bundle
suite; S1/S2 database, allocation, transition and consumption regression
suites; real child kill/contention tests; syntax, Oxlint and diff checks; native
sync plus exact iOS and Android builds; and source scans proving no caller path,
production fault hook, async transactional filesystem, schema edit or legacy
compatibility path.

Freeze one exact staged implementation snapshot only after all gates pass. Two
fresh independent reviewers must approve that same snapshot: (1) state,
transaction, crash and concurrency compliance; and (2) module depth, path
security, code quality and test adequacy. Any P1/P2 fix invalidates both.

Only then create the single complete C2 GREEN commit and push it as the S3
safety checkpoint required by the approved plan. Do not commit or push partial
slices. Never deploy or mutate a device, store, Cloudflare or R2 resource.

## Explicit C2 exclusions

- No schema, schema digest, migration or compatibility-layer change.
- No observation, checkpoint, gateway-smoke or temporary member publication.
- No `readCapture()` or existing live adapter/wrapper/caller migration.
- No legacy import, dual write, old-path migration, hard link or fallback.
- No recovery-fresh start, recovery claim, working-to-abandoned rename,
  manifest, archive authority, terminal claim or invocation pin (S4+).
- No final evidence assembly, S8 deletion, deployment, network request, secret,
  store/device action, Cloudflare request or R2 mutation.
- No learner, spelling, Monster or application-runtime behaviour change.
