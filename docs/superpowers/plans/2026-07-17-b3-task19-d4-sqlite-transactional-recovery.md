# B3 Task 19 D4 SQLite Transactional Recovery Plan

> **Task 19H correction:** D4 recovery ownership still begins only from a
> durable `restart-required` command. The ordinary no-replay bridge from an exact
> retained native crossing is governed by
> [`2026-07-17-b3-task19h-native-crossing-correction.md`](2026-07-17-b3-task19h-native-crossing-correction.md).

**Status:** review candidate; implementation must not begin until two independent
reviewers approve one exact plan SHA-256.

**Parent authority:**
`docs/superpowers/plans/2026-07-16-b3-task19-sqlite-blob-authority-amendment.md`.

**Entry point:** D1-D3 are committed through `e898463`. SQLite is already the
default live capture authority. This slice replaces the interim recovery
classification with transactional SQLite recovery. D5 alone removes the legacy
filesystem recovery implementation and performs the final export/native/full
verification gates.

## Outcome and non-goals

D4 finishes one bounded capability:

> After an exact approved native distribution has been reinstalled, one or more
> helpers can converge an ambiguous `restart-required` capture into an immutable
> abandoned capture and a new working capture without filesystem authority,
> duplicate ownership or loss of the old capture history.

SQLite is the sole recovery authority. The recovery is three short, independently
durable transactions:

```text
working restart-required
  -> abandoned + owner + snapshot + manifest + archive authority
  -> recovery terminal + pending recovery-fresh reservation
  -> ready recovery-fresh working capture
```

D4 does not:

- deploy or mutate Cloudflare, R2, App Store, Play Store, devices or simulators;
- create a migration or reset path for the unreleased schema-v2 database;
- store a snapshot JSON BLOB or write an archive/journal/checkpoint directory;
- delete legacy modules or tests, rewrite the final six evidence exporters, or
  claim Task 19 complete; those are D5 and Task 19H work; or
- broaden D4 archive/recovery ownership beyond `restart-required`; Task 19H
  adds only an ordinary fail-closed bridge from exact retained native crossings.

## Frozen corrections to the parent amendment

### Terminal decision relational binding

The pre-release schema-v2 terminal table currently binds the archive authority
but not the selected recovery-terminal decision. This contradicts the parent
requirement that the terminal record and claim are bound through a composite
foreign key. D4 corrects schema v2 in place; there is no released/live database
and therefore no migration.

Add this unique parent key to `b3_decisions`:

```sql
UNIQUE (
  command_sha256, winner_kind, next_record_sha256, claim_sha256
)
```

Add this closed discriminator and foreign key to `b3_recovery_terminals`:

```sql
terminal_kind TEXT NOT NULL CHECK (terminal_kind = 'recovery-terminal'),

FOREIGN KEY (
  command_sha256, terminal_kind,
  terminal_record_sha256, terminal_claim_sha256
)
  REFERENCES b3_decisions(
    command_sha256, winner_kind,
    next_record_sha256, claim_sha256
  )
```

The existing authority foreign key and
`UNIQUE (command_sha256, terminal_claim_sha256)` remain. Schema-object hashing
must change deterministically, while application ID, `user_version = 2` and
`b3_meta.schema_version = 2` remain unchanged.

### Recovery-owner claim authority

The parent freezes the recovery-owner decision but omits its exact claim
record. D4 fills that closed hash-contract gap. The unsigned record is exactly:

```text
{
  schemaVersion: 1,
  platform,
  winnerKind: 'recovery-owner',
  instructionCode: 'REINSTALL_EXACT_BUILD',
  commandSha256,
  sourceState: 'restart-required',
  sourceRecordSha256,
  nextState: 'restart-executing',
  nextRecordSha256
}
```

The full record adds:

```text
ownerClaimSha256 = SHA-256(
  "ks2-spelling:b3-recovery-owner-claim:v1\0" ||
  canonicalJson(unsignedOwnerClaim)
)
```

`instructionCode` binds the exact operator action whose acknowledgement is
consumed; it is not a second recovery flag. `claim_json` stores the full
canonical record. `next_record_json` stores the
canonical issued-command authority for the same command in
`restart-executing`. `sourceRecordSha256` and `nextRecordSha256` bind those two
canonical state records. The claim is platform-internal and accepts only
`ios | android`.

### D3 facade boundary is slice-local

D3 approved an exact eight-method `B3CaptureStore`. D4 deliberately supersedes
that slice-local count with two recovery methods. It does not expose a SQL
handle, transaction phase, path, archive, journal, callback, build authority or
mutable pin.

## Canonical recovery authority

Add one bounded pure module:

```text
scripts/lib/b3-capture-recovery-authority.mjs
```

It creates and validates only:

- the recovery-owner claim;
- the derived capture snapshot;
- the recovery manifest;
- the archive authority; and
- the recovery-terminal claim.

It reuses the existing canonical JSON and issued-command authority helpers. It
does not open SQLite, inspect the filesystem, generate UUIDs or own retry logic.

The capture snapshot, manifest, archive authority and terminal claim are exactly
the parent amendment's records and hash domains. In particular:

- snapshot commands sort by `allocationSequence`;
- snapshot decisions sort by `(commandSha256, sourceState)` and include all
  selected ordinary and generic-consumption decisions in the capture plus the
  one recovery-owner decision, but exclude recovery-terminal;
- snapshot steps sort by `observationSequence`;
- snapshot JSON is derived and hashed but never stored;
- `terminalObservationSha256` is the last retained observation SHA or 64 zeroes;
- the terminal record is the issued-command state authority for the abandoned
  command at `restart-complete`; and
- the terminal claim binds the owner claim, snapshot, manifest, archive
  authority and terminal-record hashes.

Every persisted BLOB is reparsed as strict canonical JSON and every hash is
recomputed on each full database validation. A semantically equivalent but
non-canonical BLOB fails closed.

## Recovery-fresh start authority

Extend `b3-capture-start-authority.mjs`; do not add a second intent module.
Initial and recovery-fresh intents share the existing domain:

```text
ks2-spelling:b3-capture-start-intent:v1\0
```

A recovery-fresh intent has:

```text
intentKind: 'recovery-fresh'
recoveredCommandSha256: <abandoned terminal command>
terminalClaimSha256: <selected terminal claim>
captureId: <new UUID>
firstCommand: <canonical scenario-zero ARM_CAPTURE command>
```

The first fresh command is frozen as:

- a new capture UUID;
- platform matching the database;
- the same exact tested application commit and application fingerprint;
- `expectedScenarioIndex: 0`;
- `expectedSequence: 1`;
- `previousObservationSha256`: 64 zeroes;
- `installationMode: 'existing'`; and
- `actionCode: 'ARM_CAPTURE'`.

Recovery must never manufacture `REBIND_FRESH_INSTALL`. The command is generated
and copied before the writer transaction. Randomness, callbacks and filesystem
reads never occur while a SQLite writer lock is held. If two helpers propose
different fresh UUIDs, the committed pending intent wins and both helpers adopt
its retained command.

## One relational validator

Replace `validateReadyInitialStartUnchecked` and its one-capture assumptions with
one full relational validator. It validates one contiguous global command chain
partitioned into capture-local blocks and returns exactly one of these internal
phases:

1. `empty`;
2. `pending-initial`;
3. `working` — zero or more immutable abandoned captures followed by exactly
   one working capture;
4. `archived-recovery-pending-terminal` — the latest capture is abandoned, no
   working capture exists, active and reservation pointers are null, and its
   owner/snapshot/manifest/authority exist without a terminal; or
5. `terminal-pending-recovery-fresh` — the same archive has its terminal and
   exactly one pending recovery-fresh intent/reservation, with no working
   capture.

No other mixture validates.

### Global and capture-local chains

- The first start intent is exactly `initial`.
- Every later intent is exactly `recovery-fresh`, bound to the immediately
  preceding abandoned capture's terminal.
- Global `allocation_sequence` is contiguous `1..commandCount`.
- Global `predecessor_command_sha256` is null only for allocation 1; every later
  command points to the previous global command, including the first command in
  a recovery-fresh capture.
- Within each capture, expected observation sequence is contiguous `1..N`, with
  `N <= 512`.
- Within each capture, steps are contiguous and command-bound. The first command
  uses the zero previous-observation hash; later commands use the preceding
  local step's observation hash.
- The fresh capture therefore resets local command/observation sequence to 1
  while continuing the global predecessor and allocation chain.

### Closed capture and intent invariants

- A working capture has `capture_state = 'working'` and `row_version = 1`.
- An abandoned capture has `capture_state = 'abandoned'` and
  `row_version = 2`.
- A pending intent has `row_version = 1`; a ready intent has
  `row_version = 2`.
- Every abandoned capture ends in one selected recovery-owner decision. Its
  commands, ordinary/generic decisions and steps are immutable after archive.
- Every abandoned capture except the latest archive-only phase has an exact
  terminal. Every earlier abandoned capture has an immediately following ready
  recovery-fresh intent/capture.
- At most one working capture exists and it is always the latest capture.
- `readCapture()` returns only the working capture and never exposes abandoned
  rows.

The authority singleton must satisfy:

```text
nextAllocationSequence = commandCount + 1
rowVersion = 1 + intentCount + commandCount
           + genericConsumptionDecisionCount + abandonedCaptureCount
```

This preserves D1-D3 increments: one for each intent reservation, one for each
command reconciliation/allocation, one for each generic active clear and one
for each archive active clear. Ordinary and recovery decisions do not otherwise
increment the singleton. The active and reserved pointers remain mutually
exclusive.

The validator must handle repeated recovery, including two abandoned captures
followed by one working capture. It must never assume one intent, one capture or
that local and global sequences are equal.

## Public and internal recovery seam

`B3CaptureStore` gains exactly:

```js
await store.pinRecoveryInvocation({ acknowledgeReinstall })
await store.finaliseRecoveryInvocation({ invocation, distribution, freshCommand })
```

The first method returns an opaque frozen object backed by a private `WeakMap`.
The second accepts only that object, a copied complete signed-distribution
projection and a copied canonical command proposal. Callers cannot inspect,
forge, serialise or reuse a pin with another store. A pin is single-use: its
second finalisation rejects. Acknowledgement is snapshotted before the first
await and is not a durable authority by itself.

The store/repository is the deepest mutation-capable distribution gate. Public
`startCapture()` remains initial-only and rejects every recovery-fresh intent or
reservation. Before any recovery write, every complete attempt validates the snapshotted
distribution with `validateB3DistributionProjection()` against that attempt's
fresh fixed build authority, then repeats the semantic binding after the
synchronous in-writer build reread. A direct store caller therefore cannot
bypass signed-distribution validation by supplying only a build-bound fresh
command. Missing, malformed or mismatched distribution rejects with exact
database bytes unchanged.

The existing live-controller surface remains:

```js
await controller.pinInvocation({ acknowledgeReinstall })
await controller.finaliseInvocation({ invocation, distribution })
```

`finaliseInvocation` must:

1. validate the exact signed distribution against a fresh build authority as an
   early controller gate;
2. derive one candidate recovery-fresh command outside SQLite; and
3. delegate both copied authorities to the store recovery seam, which validates
   the distribution again at the deepest mutation boundary.

An invalid distribution throws before any recovery mutation and leaves exact
database bytes unchanged whether finalisation is called through the controller
or directly through `B3CaptureStore`. The store/repository still performs the
shared fixed build reread before and inside each writer transaction.

The store returns an internal closed outcome containing its result kind and
whether this invocation presented `acknowledgeReinstall: true` while pinned to
the exact lineage which now owns recovery. The controller maps away that
internal bit. `createDefaultAdapter` supplies one bounded invocation-local
callback to the controller; after successful recovery finalisation, and outside
every SQLite transaction, the controller uses the bit to mark
`--resume-reinstall` consumed before any planned restore scenario can run. This
is conservative for a losing helper or an already-owned archive: once a process
presents the flag to that exact recovery lineage and successfully converges it,
the same process cannot reuse the flag at `REBIND_FRESH_INSTALL`. A no-op,
unrelated or rejected lineage does not consume it. If a later transaction fails
after Transaction A, the proof run cannot advance to a planned gate; a retry
resumes from the durable owner, and any flag presented to that recovery retry is
consumed when finalisation successfully returns. No callback executes while a
writer lock is held.

The only public result is one exact key:

```text
{ status: 'not-applicable' }
{ status: 'operator-required' }
{ status: 'recovered' }
{ status: 'already-recovered' }
{ status: 'rejected' }
```

Status meaning is frozen:

- Status resolution first follows the exact pinned command's retained recovery
  lineage at finalisation. A durable owner, terminal or terminal-bound successor
  always wins over the pin-time acknowledgement value and resumes/adopts without
  asking for the flag again.
- `operator-required`: at finalisation the exact pinned `restart-required`
  lineage is still unowned, Transaction A would be required, and the invocation
  did not include `acknowledgeReinstall: true`; zero mutation.
- `recovered`: this invocation committed at least one previously absent recovery
  boundary for the pinned lineage and converged it to a ready recovery-fresh
  working capture.
- `already-recovered`: before this invocation's first recovery mutation, the
  exact pinned command already had a durable recovery terminal/pending fresh
  intent or a terminal-bound ready successor, and reconciliation adopted that
  lineage. This remains true even if that successor has since transitioned,
  consumed, allocated later commands or independently reached another gate.
- `not-applicable`: empty, pending initial, a normal working state, an exact
  current native-crossing source owned by the operation-specific no-replay path,
  or an ordinary `restart-required -> launched` winner which prevents archive
  ownership.
- `rejected`: pin replacement/drift, including a pin taken before another
  helper advances into `launching | reinstall-launching | stop-executing`,
  malformed authority, mismatched platform/build or any impossible state.

A stale pin is resolved from its own command hash, capture and retained terminal
chain, never by comparing only the current active pointer. If helper A pins the
old restart-required command, helper B completes recovery and the new capture
advances before A finalises, A returns `already-recovered` without reading from
or mutating the new active command. A new pin taken against that advanced fresh
capture is `not-applicable` unless it independently reaches a new
`restart-required` tail.

If helper A pins without acknowledgement and helper B commits only Transaction A
before A finalises, A resumes Transactions B-C and returns `recovered`. If B has
already completed Transactions A-C, A returns `already-recovered`. Neither race
returns `operator-required`, because the durable owner already consumed the
operator boundary.

Acknowledgement is exact-tail-bound. A gate which appears only after pinning
cannot consume an earlier acknowledgement: it returns `operator-required` on a
new pin. After the durable archive-owner transaction commits, all later helpers
resume without repeating the operator flag.

`readActiveCommand()` adds one internal closed projection
`{ kind: 'recovery-pending' }` for both
`archived-recovery-pending-terminal` and
`terminal-pending-recovery-fresh`. It never exposes a recovery-fresh intent as
ordinary `{ kind: 'start-reserved', intent }`. Normal allocation, public initial
start, publication of a missing step, transition, consumption and
`readCapture()` fail closed in either phase. Recovery finalisation is the only
public facade operation allowed to advance either phase. The controller's
ordinary `currentCommand()` rejects `recovery-pending` and can never auto-start
the reserved recovery command.

## Three transactions

Each transaction uses the existing shared build source and the same complete
retry policy: at most three attempts for build/DB drift or
`SQLITE_BUSY | SQLITE_LOCKED`; stable validation errors do not retry. Each
attempt does an asynchronous fixed-build preflight, `BEGIN IMMEDIATE`, a
synchronous fixed-build reread, full relational validation, bounded writes,
full revalidation and `COMMIT`. On any error it rolls back.

No transaction calls user code, transport, UUID/random, filesystem export or an
asynchronous function while the writer lock is held.

### Transaction A — archive claim

Precondition: the pin saw the exact active working command at
`restart-required` and acknowledged it.

In one transaction:

1. compete for the existing decision primary key
   `(command_sha256, 'restart-required')` by inserting recovery-owner;
2. if ordinary `restart-required -> launched` won, adopt that decision and
   return not-applicable;
3. store the canonical restart-executing record/owner claim;
4. update the capture from working row version 1 to abandoned row version 2;
5. clear the exact active pointer and increment singleton row version once;
6. derive the snapshot hash from the resulting relational rows;
7. insert the recovery row, canonical manifest and canonical archive authority;
8. validate the exact `archived-recovery-pending-terminal` phase; and
9. commit.

No owner-only or abandoned-without-authority state can commit.

### Transaction B — terminal and fresh reservation

Precondition: the exact latest archive validates and lacks a terminal.

In one transaction:

1. insert the recovery-terminal decision and its canonical restart-complete
   issued-command record;
2. insert the terminal row bound by both decision and archive-authority foreign
   keys;
3. create one pending recovery-fresh start intent using the precomputed command;
4. set `reserved_start_command_sha256` to that exact command and increment the
   singleton row version once;
5. validate `terminal-pending-recovery-fresh`; and
6. commit.

If a terminal/pending intent already exists, discard any losing proposal and
adopt its retained command. Snapshot derivation excludes the terminal decision,
so its hash must remain byte-identical before and after this transaction.

### Transaction C — private fresh reconciliation

Keep public `startCapture()` and initial reconciliation strictly initial-only.
Extract only the bounded insert/validation mechanics needed by both start kinds
into a private repository helper; no facade method other than the already
distribution-gated `finaliseRecoveryInvocation()` may invoke its
recovery-fresh branch. For a recovery-fresh intent, in one transaction:

1. validate the terminal link, reservation and retained first command;
2. insert a new working capture at row version 1;
3. insert its first local command at expected sequence 1 and the current global
   allocation sequence, with global predecessor equal to the abandoned terminal
   command and previous-observation SHA equal to zero;
4. increment `next_allocation_sequence`, make the new command active, clear the
   reservation and increment singleton row version once;
5. mark the intent ready at row version 2;
6. validate the general `working` phase; and
7. commit.

An existing committed ready winner is adopted by recovery finalisation.
`startCapture()` rejects rather than rederives or reconciles a retained
recovery-fresh intent. The private recovery-fresh reconciler repeats complete
distribution validation against the asynchronous preflight and synchronous
in-writer build authority before inserting anything.

## Existing operation behaviour

- `publishObservation()` first searches every validated capture for the exact
  command/step. An existing abandoned step remains a read-only
  `already-published` or conflict result. A missing step may be inserted only for
  the exact sole working active command.
- `readCapture()` derives only the sole working capture. With no working capture
  it raises the existing closed no-readable-capture error.
- `allocateNextCommand()`, ordinary transition and generic consumption may target
  only the working capture. An archive-only phase fails closed.
- `startCapture()` may reserve/reconcile only an initial intent in an empty or
  pending-initial database. It rejects both recovery intermediate phases even
  when given the retained fresh command byte-for-byte.
- Once a capture is abandoned, no command, decision included in its snapshot or
  step can be inserted, updated or deleted. The only later decision for its tail
  is the separately excluded recovery-terminal decision.
- Planned `REBIND_FRESH_INSTALL` behaviour remains distinct and exact-tail-bound;
  its flag cannot authorise or be manufactured by this recovery path.

## Crash and concurrency contract

| Crossing | Durable result and retry |
|---|---|
| Death before archive commit | Old working restart-required bytes; acknowledgement is required again. |
| Death after archive commit | Exact archive pending terminal; no acknowledgement is required. |
| Death before terminal commit | Archive is unchanged. |
| Death after terminal commit | Exact pending recovery-fresh intent and same retained UUID/command. |
| Death before fresh reconciliation commit | Pending intent is unchanged. |
| Death after fresh commit but before return | Exact ready fresh capture; retry is already-recovered. |
| Ordinary launch wins owner decision | Recovery is not-applicable; no archive rows. |
| Recovery owner wins ordinary launch | Archive is authoritative; ordinary mutator fails closed. |
| Two archive helpers | One owner/archive commit; loser adopts it. |
| Two terminal helpers with different UUIDs | One terminal/intent commit; loser adopts retained intent. |
| Old pin versus completed and advanced successor | Resolve the old command's exact retained terminal and return already-recovered; never read or mutate the later active command. |
| Allocator versus terminal reservation | Allocator fails closed; only the reserved first fresh command receives the next global allocation. |
| Existing-step publisher versus archive | Both orders converge to identical read-only step result. |
| Missing-step publisher versus archive | One writer wins; archive snapshot either includes the committed step or publication fails closed after archive. |

The threat model covers process death, duplicate/concurrent helpers, stale pins,
SQLite lock contention and hostile/malformed database values. It does not claim
to defend against an operating-system account that can replace database bytes
between arbitrary syscalls; host file ownership/permissions remain the outer
boundary.

## TDD implementation order

Every production change begins with a focused failing test. No production fault
hook, phase selector, artificial sleep or filesystem race seam is added.

### D4.1 — pure authority and schema correction

Production:

- modify `scripts/lib/b3-capture-state-schema.mjs`;
- modify `scripts/lib/b3-capture-start-authority.mjs`;
- add `scripts/lib/b3-capture-recovery-authority.mjs`.

Tests prove:

- fixed vectors for owner, snapshot, manifest, authority, terminal and
  recovery-fresh intent;
- one-field mutation and non-canonical BLOB rejection;
- terminal insert fails without the exact selected decision and with wrong
  record, claim or discriminator;
- manifest/authority/terminal prerequisite swaps fail; and
- initial-start vectors remain unchanged except for the deterministic schema
  digest correction.

### D4.2 — general multi-capture validator

Production:

- refactor `scripts/lib/b3-capture-state-database.mjs`.

Tests prove:

- all five valid phases;
- two abandoned captures plus one working capture;
- global allocation/predecessor continuation and local sequence/hash reset;
- exact intent, capture and singleton row versions;
- abandoned immutability and terminal exclusion from snapshot;
- every impossible mixed phase fails on open; and
- the same snapshot SHA rederives after terminal/fresh successor creation.

### D4.3 — repository transactions and facade

Production:

- modify `scripts/lib/b3-capture-state-repository.mjs`;
- modify `scripts/lib/b3-capture-store.mjs`.

Tests prove:

- unacknowledged recovery is byte-identical and operator-required;
- a direct-store missing/malformed/mismatched distribution is byte-identical;
- each of the three committed phases reopens and resumes;
- ordinary-owner competition in both lock orders;
- duplicate helpers and different proposed fresh UUIDs;
- one helper pins the old tail while another completes recovery and transitions,
  consumes and allocates the successor before the old pin finalises;
- an unacknowledged old pin resumes as `recovered` after another helper commits
  only Transaction A, and returns `already-recovered` after another helper
  completes Transactions A-C;
- reservation versus allocator;
- archived existing-step identical/conflict retry;
- archive-only read and normal mutator rejection;
- direct `startCapture()` rejection for the exact retained recovery-fresh
  command after Transaction B, with byte-identical database proof;
- working read excludes abandoned rows; and
- opaque pin forgery, cross-store use and post-pin gate drift reject.

### D4.4 — live controller and real process proof

Production:

- modify `scripts/lib/b3-store-backed-live-capture.mjs`;
- change default adapter wiring only where required to preserve the wrapper's
  existing one-key recovery-status contract.

Tests prove:

- distribution validation precedes mutation;
- direct-store and controller distribution gates reject the same mismatch;
- every exact one-key status on iOS and Android;
- acknowledgement is consumed only by the exact pinned recovery lineage and
  never by a gate which appears after the pin or an unrelated tail;
- one `--resume-reinstall` presentation cannot authorise both ambiguous recovery
  and a later planned `REBIND_FRESH_INSTALL` in the same process;
- immediate post-recovery retry is already-recovered;
- no legacy recovery module is imported by the default live path; and
- wrapper/controller disposal closes SQLite after success and failure.

Use real child processes and SQLite locks/IPC barriers to prove:

- process death with uncommitted archive, terminal and fresh writes rolls back;
- separately materialised committed archive, terminal and fresh phases reopen
  through the unchanged production facade;
- two real helpers converge in both decision orders; and
- no test depends on timing sleeps.

A maximal fixture contains 512 commands and 512 steps in one capture. Its
snapshot derives without storing JSON. A 513th local command rejects. After
recovery, the fresh first command is global allocation 513 but local sequence 1.

## Verification and review gate

Focused verification must include all affected D1-D3 tests plus new D4 tests,
then:

```bash
node --check scripts/lib/b3-capture-recovery-authority.mjs
node --check scripts/lib/b3-capture-state-database.mjs
node --check scripts/lib/b3-capture-state-repository.mjs
node --check scripts/lib/b3-capture-store.mjs
node --check scripts/lib/b3-store-backed-live-capture.mjs
npx oxlint <changed production and test files>
git diff --check
```

Before implementation, two independent reviewers must approve this exact plan
SHA-256:

1. schema, canonical authority, transaction, crash and concurrency correctness;
2. parent-spec fidelity, SOLID/DRY/YAGNI boundaries and finite test adequacy.

After implementation, stage the complete D4 patch and record its SHA-256, base
commit and tree. Two fresh independent reviewers must approve that exact staged
snapshot on the same two axes. Any P1/P2 code change invalidates both approvals.
Commit D4 as one reviewed implementation commit. Do not push until the D5 legacy
deletion/export/full-verification slice is committed and ready for its checkpoint
push.

## D4 exit gate

D4 is complete only when:

- SQLite is the only authority used by the default recovery composition;
- the terminal row is relationally bound to the selected terminal decision;
- zero or more abandoned captures and at most one working capture validate;
- archive, terminal/reservation and fresh reconciliation are independently
  crash-safe and idempotent;
- concurrent helpers and the ordinary-owner decision race converge;
- all existing and new focused tests, syntax, lint and diff checks pass;
- two independent reviewers approve one exact staged patch; and
- the reviewed D4 patch is committed with the worktree clean apart from the
  ignored progress ledger.

D4 completion does not close Task 19. D5 must still remove legacy filesystem
recovery, switch final evidence to derived SQLite exports, run the native/full
gates and obtain the five exact-HEAD Task 19H approvals.
