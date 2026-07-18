# B3 Task 19 S2b Command and Decision Parity Micro-plan

**Status:** review candidate; implementation needs two reviewers on one exact SHA-256.

**Fixed point:** `1040d0d8b8f3cd14a111ce9f85313dd9c7763cd8`.
**Authority:** SQLite recovery-ledger superseding plan lines 245-272, 419 and
462-464, its frozen schema, and the approved S2a implementation at this fixed point.

## Bounded outcome

S2b adds repository-owned later-command allocation, ordinary decisions and
generic consumption for a canonical **ready initial** capture. It is GREEN only
when one capture supports:

```text
A active -> A generic-consumed -> B active
         -> B generic-consumed -> C active
```

A, B and C have one `capture_id`, contiguous global allocation sequences and
exact predecessor command SHAs. There is one global active pointer and one
selected decision per `(command_sha256, source_state)`.

S2b does not reconcile a pending start, insert a first command, create/inspect
bundles or recovery rows, create `recovery-fresh` intents, migrate callers,
delete filesystem authority, or implement S3+ work. Test-owned SQL fixtures may
seed a canonical ready initial intent/capture/first command in an isolated root;
production gets no fixture hook. S2b proves one relational capture, not S3.

The positive `recovery-terminal A -> reserved recovery-fresh B` path needs later
terminal authority and start reconciliation. S2b must not imitate it: recovery
rows and `recovery-fresh` fail closed without mutation. This prevents initial
start/generic closure being mistaken for recovery; S2 remains incomplete.

## Repository public domain API

`openB3CaptureStateRepository({ platform })` retains S2a’s
`reserveInitialCaptureStart()` and `close()`, and adds:

```js
repository.readActiveCommand()
repository.allocateNextCommand({ command })
repository.transitionCommand({ source, nextState })
repository.consumeCommand({ source })
```

Every options object is a closed plain record whose properties/getters are
snapshotted once. No export accepts/returns a database, path, SQL, transaction
callback, clock, phase/fault selector or filesystem primitive.

`source` is a copied domain snapshot, never a capability. It contains only:

```text
schemaVersion, platform, allocationSequence, predecessorCommandSha256,
captureId, commandSha256, command, state, recordSha256
```

The repository rejects a forged/partial snapshot and re-derives its exact row
and selected path under `BEGIN IMMEDIATE`; SHA-only input is never authority.

### Typed outcomes

`readActiveCommand()`:

- `{ kind: 'active', command }`
- `{ kind: 'start-reserved', intent }` for the valid S2a pending-initial state
- `{ kind: 'none' }` only for an exact empty database or a validated
  generic-consumed tail

`allocateNextCommand()`:

- `{ kind: 'allocated', command }`
- `{ kind: 'already-active', command }` for the same canonical proposal/slot
- `{ kind: 'allocation-conflict', command }` naming a different valid winner
- `{ kind: 'start-reserved', intent }` while the valid initial reservation owns
  the singleton

`transitionCommand()`:

- `{ kind: 'transitioned', command }`
- `{ kind: 'already-transitioned', command }` for the identical retained edge
- `{ kind: 'ordinary-conflict', command }` for another ordinary winner
- `{ kind: 'generic-consumed', commandSha256, sourceState, claimSha256 }`

`consumeCommand()`:

- `{ kind: 'consumed', commandSha256, sourceState, claimSha256 }`
- `{ kind: 'already-consumed', commandSha256, sourceState, claimSha256 }`
- `{ kind: 'ordinary-selected', command }` when that source chose an ordinary
  successor

Invalid/corrupt/unselected authority, unsupported states/recovery, impossible
pointers, inactive-unclosed tail, old-hash reuse, stale build authority and
bounded SQLite busy are errors, never success; they perform no mutation.
Pending initial makes transition/consume reject; only read/allocation may return
`start-reserved`.

## Frozen transitions and hashes

Ordinary edges are exactly:

```text
prepared -> launching | stop-intent
stop-intent -> stop-executing
stop-executing -> host-stopped | restart-required
host-stopped -> launching
launching -> launched | reinstall-authorised | restart-required
reinstall-authorised -> reinstall-launching
reinstall-launching -> launched | restart-required
restart-required -> launched
```

Generic consumption is allowed from exactly:

```text
prepared, stop-intent, stop-executing, host-stopped, launching,
reinstall-authorised, reinstall-launching, launched
```

It rejects `restart-required`, `restart-executing`, `restart-complete` and
unknown/recovery-only states.

One pure authority module owns canonical state-record and ordinary-claim bytes.
Prepared records and schema-v1 ordinary claims remain byte-identical to legacy
authority, so later filesystem deletion cannot delete SQLite hash semantics.

Generic consumption freezes this canonical schema-v1 claim:

```text
schemaVersion, platform, winnerKind='generic-consumption', commandSha256,
sourceState, sourceRecordSha256, claimSha256
```

`claimSha256` is SHA-256 of the existing B3 canonical JSON bytes for the
unsigned fields, prefixed with
`ks2-spelling:b3-generic-consumption-claim:v1\0`. Known literal tests freeze
field order, bytes and digest before repository work.

## Whole-database invariants

S2a empty/pending validation remains unchanged. The ready-initial classifier
must prove before every operation and after every write:

1. One canonical ready `initial` intent, null recovery fields, one matching
   `working` capture and its exact first command.
2. Commands are contiguous sequences `1..N`; sequence 1 has no predecessor and
   each later row names the exact SHA at `N-1`.
3. Every command/record byte, SHA, platform, fresh build identity, capture ID,
   expected observation sequence and previous observation SHA recomputes.
4. All S2b commands belong to that one capture; multiple commands never create
   multiple capture rows.
5. Each decision source is on the unique selected path from `prepared`; its
   source/next record and claim bytes/hashes recompute. Unselected/orphan rows,
   branches and cycles reject.
6. A generic decision appears only at the final selected source, closes that
   command and has no successor decision.
7. Every command before the tail is exact generic-consumed. The tail is either
   the sole active unconsumed command or generic-consumed with a null pointer.
8. `next_allocation_sequence = N + 1`; every singleton pointer/allocation write
   increments `row_version` once.
9. Active and reserved pointers never coexist. A valid pending-initial
   reservation blocks all S2b mutations; null active alone never closes a tail.
10. Recovery tables/kinds, `recovery-fresh` and abandoned captures reject in
    this slice.

## Repository transaction rules

Every read fresh-reads fixed-root build authority, then validates/derives inside
one repository-owned `BEGIN` read snapshot and `COMMIT`, rolling back on failure.
No multi-SELECT validation may straddle another commit.

Every mutation performs, in order:

1. closed input validation and one snapshot of each property;
2. stable fixed-root build-authority reread;
3. proposal/source canonicalisation against that fresh authority;
4. repository-owned `BEGIN IMMEDIATE`;
5. complete validation with the same fresh snapshot;
6. bounded operation-specific SQL writes under checked CAS predicates, with all expected row changes required before commit;
7. complete re-derivation and typed result;
8. `COMMIT`, or `ROLLBACK` on every failure.

There is no `await` inside any SQLite transaction.

Later allocation requires: no reservation/active command, a non-empty exact
generic-consumed tail and the same ready working capture. It inserts one command
at `next_allocation_sequence`, links the closed predecessor, advances sequence
and row version, and sets active in one transaction. Same hash is idempotent only
for the same canonical row/slot still active; reuse at a later sequence rejects.
Different concurrent proposals yield one `allocated` winner and one
`allocation-conflict` naming it.

Ordinary transition derives the next record/claim and inserts with conflict on
`(command_sha256, source_state)`. It does not move the active pointer. Zero
changes rederive and return identical, ordinary-conflict or generic-consumed.

Generic consumption inserts at that same decision slot and clears only the
matching active pointer, with null reservation, in one transaction. Both
expected changes must occur. A stale retry of consumed A reads A’s immutable
decision and never clears active B/C.

## TDD slices

Implement one RED -> GREEN slice at a time:

1. Known-literal pure authority parity: all state records, thirteen ordinary
   edges and the generic claim; legacy bytes remain exact.
2. Ready-A fixture/full validator; corrupt intent/capture/command, gaps,
   predecessors, bytes/hashes, pointers and orphan rows reject unchanged.
3. Closed API and snapshot-consistent `active | start-reserved | none` reads.
4. All thirteen ordinary edges, all other pairs rejected, with identical and
   conflicting typed outcomes.
5. All eight generic sources; every recovery/unknown source rejected; pointer
   clearing is exact.
6. A -> B -> C: one capture, three contiguous rows, exact predecessors, active
   C and no bundle namespace mutation.
7. Same proposal/slot idempotency, earlier-hash reuse rejection, stale A after
   B, inactive-unclosed tail and unselected/orphan decisions.
8. Real-process barriers for identical/different ordinary successors, identical
   consumption and ordinary-versus-generic; assert one row/winner and typed loser.
9. Real-process barriers for same/different B allocations after closed A; assert
   one sequence-2 row/pointer and bounded lock behaviour.
10. Pending-initial blocks every mutator; recovery/recovery-fresh fixtures reject
    without being interpreted as generic closure.
11. For allocation, transition and consumption, open under build authority A,
    stably replace it with valid B, release the A-bound child, and prove reject
    before mutation with unchanged database SHA.
12. Focused S1/S2a/S2b, legacy contention, iOS/Android wrappers, syntax, Oxlint,
    diff check and scan proving no repository import of filesystem authority.

Real-process tests use test IPC and the existing fixed-root module mock before
dynamic production imports. No production pause/fault callback or sleep is
added.

## Files and gates

Expected edits are limited to pure issued-command authority, database validator,
repository and focused tests/helpers. Legacy may delegate only canonical
record/claim byte derivation: no live/exported caller rewiring or filesystem
authority removal. Frozen-schema change is an architecture stop/plan amendment.

Before implementation, two reviewers approve one exact plan SHA:

1. **Spec/concurrency:** chains, CAS winners, stale A/active B, reservations,
   fresh build authority and recovery boundary.
2. **Simplicity/standards:** SOLID/DRY/YAGNI, bounded API/tests, one deep seam,
   no speculative S3+ work or raw authority.

Any edit invalidates both approvals. S2b authorises no commit, push, deploy,
caller migration, progress edit or Task 19 completion claim.
