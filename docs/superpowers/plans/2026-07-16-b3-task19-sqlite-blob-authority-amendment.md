# B3 Task 19 SQLite BLOB Authority Amendment

**Status:** review candidate; implementation must not begin until two independent
reviewers approve one exact plan SHA-256.
**Fixed point:** `e9befe6e43493be7517aeac0fc6fcb63df8903ab`.
**Reason:** two exact-plan reviews rejected the proposed C4 filesystem publisher
because it recreated a pseudo-distributed transaction between SQLite and an
immutable working bundle. James explicitly selected SQLite as the elegant
recovery authority and asked that Task 19 stop accumulating race patches.

## Superseding boundary

This amendment replaces:

- `One capture bundle`, member publication and bundle reconciliation in the
  approved SQLite recovery plan;
- all remaining C4-C6 filesystem-authority work in the S3 working-bundle plan;
  and
- the uncommitted rejected C4 observation/checkpoint publication plan.

S0-S2 command, decision and build-authority semantics remain authoritative unless
this amendment explicitly removes a bundle dependency. C1-C3 are retained only
as historical implementation evidence until their production imports and tests
are deleted by this amendment. They are not a second authority and no new code
may call them.

The final six Task 19 evidence files, native device transport, signed distribution,
Cloudflare commerce/download proof, privacy bounds and offline-first claims do not
change. The database remains ignored host proof state: it is never packaged,
uploaded or committed and is unrelated to learner, spelling or Monster runtime.

## One authority

SQLite owns every mutable host capture decision and every retained working value:

```text
build binding
capture and command chain
canonical observation record bytes
canonical checkpoint bytes
recovery owner, abandoned snapshot, manifest, authority and terminal
```

One observation and its derived checkpoint are one SQL row inserted in one
`BEGIN IMMEDIATE` transaction. There is no observation/checkpoint one-behind
state, member temporary, rename, journal directory, bundle inventory, archive
directory or cross-resource commit.

The filesystem is input/output only:

- the native proof application publishes one fixed transport file already owned
  by the iOS/Android adapter;
- the host copies and validates those bytes before a SQL transaction;
- committed final reports are deterministic exports from validated SQLite state
  plus existing independently captured platform authority; and
- an absent, partial or stale export is recreated or rejected and can never change
  database truth.

R2 remains Task 19 commerce/download evidence only. It is not a capture store,
runtime dependency or recovery mechanism.

## Frozen schema replacement

Task 19 has no live Task 22 evidence or released host database. Replace the
pre-release schema while retaining the application ID and bumping SQLite
`user_version` plus `b3_meta.schema_version` from 1 to 2. Any non-empty v1
database fails closed as `b3_capture_state_schema_obsolete` with zero mutation.
There is no automatic
migration, table copy, bundle import, compatibility read or production reset API.
Removing ignored pre-release v1 state is an explicit out-of-process operator act
before Task 20 and is never performed by Task 19 code.

Remove bundle fields and foreign keys from the recovery tables. Add exactly one
working-value table:

```sql
CREATE TABLE b3_capture_steps (
  capture_id TEXT NOT NULL REFERENCES b3_captures(capture_id),
  observation_sequence INTEGER NOT NULL CHECK (observation_sequence BETWEEN 1 AND 512),
  command_sha256 TEXT UNIQUE NOT NULL,
  record_json BLOB NOT NULL CHECK (length(record_json) BETWEEN 1 AND 131072),
  record_sha256 TEXT NOT NULL,
  observation_sha256 TEXT NOT NULL,
  checkpoint_json BLOB NOT NULL CHECK (length(checkpoint_json) BETWEEN 1 AND 131072),
  checkpoint_sha256 TEXT NOT NULL,
  PRIMARY KEY (capture_id, observation_sequence),
  FOREIGN KEY (command_sha256, capture_id)
    REFERENCES b3_commands(command_sha256, capture_id)
) STRICT, WITHOUT ROWID;
```

Tighten existing `b3_commands.expected_observation_sequence` from `> 0` to
`BETWEEN 1 AND 512`. Allocation rejects a proposed command with sequence 513
before insertion; global `allocation_sequence` remains unbounded across later
recovery-fresh captures.

Replace `b3_recoveries` with the closed archived-snapshot row:

```sql
CREATE TABLE b3_recoveries (
  command_sha256 TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK (owner_kind = 'recovery-owner'),
  owner_claim_sha256 TEXT NOT NULL,
  capture_id TEXT UNIQUE NOT NULL,
  capture_snapshot_sha256 TEXT NOT NULL,
  row_version INTEGER NOT NULL CHECK (row_version = 1),
  FOREIGN KEY (command_sha256, owner_kind, owner_claim_sha256)
    REFERENCES b3_decisions(command_sha256, winner_kind, claim_sha256),
  FOREIGN KEY (command_sha256, capture_id)
    REFERENCES b3_commands(command_sha256, capture_id),
  UNIQUE (command_sha256, owner_claim_sha256, capture_snapshot_sha256)
) STRICT, WITHOUT ROWID;
```

All SHA columns retain the existing lowercase 64-hex checks and all BLOB columns
require `typeof(...)='blob'`. Full validation recomputes every canonical byte SHA
and the ordered capture snapshot directly; there is no duplicate row hash. The
closed device-smoke projection is derived from the validated observation record
and is never stored twice.

The existing recovery manifest and authority tables keep canonical BLOBs, but
their prerequisite becomes a `capture_snapshot_sha256` derived from the ordered
capture row, commands, decisions and steps. A `b3_recoveries` row exists only for
an archived capture; its insertion and the capture's `abandoned` state commit
together. There is no intermediate recovery-state column. No row contains a
bundle path, bundle state or filesystem snapshot.

The relational validator permits exactly one working capture and zero or more
immutable abandoned captures. The global command allocation remains one contiguous
predecessor chain across recovery-fresh starts. Every abandoned capture's ordered
steps remain queryable only through its recovery snapshot; public `readCapture()`
selects the sole working capture.

### Exact diagnostic records

After the capture is marked abandoned and its active pointer is cleared, full
database validation derives one closed capture snapshot. Every listed SHA is
first recomputed from its retained canonical BLOB. Arrays are sorted by allocation
sequence, `(commandSha256, sourceState)` and observation sequence respectively:

```text
{
  schemaVersion: 1,
  platform,
  captureId,
  startIntentSha256,
  captureState: 'abandoned',
  captureRowVersion,
  testedApplicationCommit,
  applicationFingerprint,
  commands: [{
    allocationSequence, commandSha256, predecessorCommandSha256,
    commandJsonSha256, preparedRecordSha256,
    expectedObservationSequence, previousObservationSha256
  }],
  decisions: [{
    commandSha256, sourceState, sourceRecordSha256, winnerKind,
    nextState, nextRecordSha256, claimSha256
  }],
  steps: [{
    observationSequence, commandSha256, recordSha256,
    observationSha256, checkpointSha256
  }]
}
```

The snapshot decision array is frozen at the archive boundary: it contains every
selected `ordinary` and `generic-consumption` decision for that capture plus the
single selected `recovery-owner` decision at its tail. It explicitly excludes
`winnerKind: 'recovery-terminal'`. The terminal decision is created later and is
bound downstream by the terminal record/claim, so including it here would create
a hash cycle and invalidate the archived snapshot.

`captureSnapshotSha256 = SHA-256("ks2-spelling:b3-capture-snapshot:v1\\0" ||
canonicalJson(unsignedSnapshot))`. The snapshot JSON is never stored: immutable
relational rows are the diagnostic record and full validation rederives this hash
on every reopen. This avoids a duplicate BLOB and any second size ceiling.

The manifest unsigned record has exactly:

```text
{
  schemaVersion: 2, platform, captureId, commandSha256,
  ownerClaimSha256, captureSnapshotSha256,
  observationCount, terminalObservationSha256
}
```

`terminalObservationSha256` is the latest step observation SHA or 64 zeroes. The
full manifest adds `manifestSha256 = SHA-256(
"ks2-spelling:b3-recovery-manifest:v2\\0" || canonicalJson(unsignedManifest))`.

The archive-authority unsigned record has exactly:

```text
{
  schemaVersion: 3, platform, captureId, commandSha256,
  ownerClaimSha256, captureSnapshotSha256, manifestSha256,
  testedApplicationCommit, applicationFingerprint
}
```

The full authority adds `archiveAuthoritySha256 = SHA-256(
"ks2-spelling:b3-recovery-archive-authority:v3\\0" ||
canonicalJson(unsignedAuthority))`.

The terminal record is the existing canonical issued-command state authority for
the same command at `restart-complete`. The terminal-claim unsigned record has
exactly:

```text
{
  schemaVersion: 1, platform, winnerKind: 'recovery-terminal',
  commandSha256, sourceState: 'restart-executing', sourceRecordSha256,
  ownerClaimSha256, captureSnapshotSha256, manifestSha256,
  archiveAuthoritySha256, terminalRecordSha256
}
```

The full claim adds `terminalClaimSha256 = SHA-256(
"ks2-spelling:b3-recovery-terminal-claim:v1\\0" ||
canonicalJson(unsignedTerminalClaim))`. Schema composite foreign keys bind the
rederived snapshot hash and the manifest, authority, terminal-record and
terminal-claim canonical BLOBs in snapshot -> manifest -> authority -> terminal
order. No old filesystem manifest or authority bytes are accepted.

## Shared build source

Add one package-internal `b3-build-authority-source.mjs` used by database open and
capture publication. It owns the literal
`.native-build/b3/distribution/build-authority.json`, one parser and shared async
and synchronous no-follow readers.

Each read binds canonical bytes/SHA, full six-field semantic value and exact
ancestor/file `(dev, ino, mode, nlink, size, mtime, ctime)` identity. The async
reader is used before semantic validation. The synchronous reader is repeated
after `BEGIN IMMEDIATE`; any difference rolls back and retries the complete
publication at most three times. No caller path or build value enters a repository
or facade method.

## Atomic observation publication

The public facade remains one `B3CaptureStore` and gains only:

```js
await store.publishObservation({ source, observationBytes })
await store.readCapture()
```

The facade synchronously snapshots the closed source and copies the `Uint8Array`
before the first await. It accepts no database state, retained observation,
checkpoint, build authority, path, SQL handle, pin, callback or gateway smoke.

For each of at most three complete attempts, the repository:

1. fresh-reads build authority;
2. opens a short SQLite read transaction, fully validates the database, resolves
   the caller source against its persisted command/state history and copies that
   command plus ordered retained step rows; if its step already exists, active
   pointer ownership is not required; only a missing step requires that exact
   source to be the selected active command;
3. outside SQLite, validates every retained canonical row/checkpoint projection.
   For an existing step `N`, it validates the proposal only against that step's
   persisted command and exact predecessor step `N-1` (or the initial zero tail),
   derives record/checkpoint bytes and compares them with committed step `N`. For
   a missing step, it validates only against the current retained tail and exact
   selected active command. Both branches validate any closed gateway-smoke
   projection inside the observation and freeze the proposal;
4. for an existing step, opens a second read transaction, synchronously rereads
   build authority, revalidates the same command/predecessor/step bytes and returns
   `already-published` or `publication-conflict` without a write transaction;
5. for a missing step, starts `BEGIN IMMEDIATE` and synchronously rereads exact
   build authority;
6. fully revalidates SQLite and requires the active command/current retained tail
   hashes and bytes to equal the proposal snapshot;
7. inserts the complete step row with `ON CONFLICT DO NOTHING`, rereads and fully
   validates the ordered capture chain and exact inserted row; and
8. commits.

There is no await, callback, filesystem write, random generation, network or
caller code between `BEGIN IMMEDIATE` and commit/rollback. The sole filesystem
operation is the fixed read-only, no-follow synchronous build-authority reread in
step 4. Hash/semantic conflict does not retry. Build/database drift retries the
whole attempt; a fourth attempt never starts.

Exact results are:

```text
{ kind: 'published', record, checkpoint }
{ kind: 'already-published', record, checkpoint }
{ kind: 'publication-conflict', record, checkpoint }
```

An identical committed row returns `already-published`; a different row for the
same sequence or command returns `publication-conflict` with the committed final
projection. Existing-step lookup precedes active-command enforcement, so an exact
retry still converges after the command was consumed, a later command was
allocated or the capture became abandoned. Results are always reconstructed from
committed database bytes.

`readCapture()` uses one read transaction, full database validation and the
ordered retained rows. It returns deeply frozen:

```text
{
  schemaVersion: 1,
  platform,
  captureId,
  records,
  checkpoint,
  gatewaySmokeProjection
}
```

Empty capture has `records=[]`, `checkpoint=null` and smoke `null`. There is no
healing write because partial steps cannot commit.

## Command and capture invariants

Full database validation owns the composite rules previously split across SQLite
and bundle classification:

- step sequences are contiguous from 1;
- step `N` is bound to exactly one command whose expected sequence is `N` and
  whose previous observation SHA equals step `N-1` or the initial zero hash;
- a command cannot advance to generic consumption until its expected step exists;
- allocation of command `N+1` requires the closed command `N`, committed step
  `N`, exact observation tail and `N+1 <= 512` within that capture;
- ordinary transitions that occur before observation publication remain allowed
  only where the existing state machine requires them; final/generic closure does
  not outrun the step;
- pending initial start owns no step; ready capture may be empty only while its
  first command is active; and
- abandoned captures are immutable and can never become active or receive a step.

`startCapture`, `allocateNextCommand`, `transitionCommand` and `consumeCommand`
therefore call the same database validator inside their existing transaction.
They need no async bundle coordinator and preserve their exact S2 public unions.
`readActiveCommand` remains a read-only database projection.

## Recovery and abandonment

Recovery selection remains a SQLite decision. The existing ordinary restart path
and recovery owner compete for the same `(command_sha256, 'restart-required')`
decision slot. After the required operator acknowledgement, one claim/archive
transaction:

1. inserts or rederives the unique recovery-owner decision;
2. revalidates that owner and the working capture;
3. marks the capture `abandoned` and clears the matching singleton active pointer
   while the start reservation is null;
4. derives `capture_snapshot_sha256` from the resulting immutable relational rows;
5. inserts the recovery row plus canonical diagnostic manifest and authority BLOBs
   referencing that snapshot; and
6. revalidates then commits.

That commit creates one exact `archived-recovery-pending-terminal` state: the
latest capture is abandoned, there is no working capture, the active pointer and
start reservation are null, one selected recovery-owner decision plus matching
snapshot/manifest/authority rows exist, and no terminal exists. Full database
validation accepts no other archive-only shape. Ordinary allocation, transition,
consumption, missing-step observation insertion, initial start and `readCapture()`
fail closed in this state; only the recovery-terminal resumer may mutate it. A
`publishObservation()` call for an already committed step remains a read-only
lookup in archive states and returns exact `already-published` or
`publication-conflict`; it can never insert or change a row.

A later terminal/fresh-start transaction inserts or rederives the terminal
decision and reserves the pending recovery-fresh start intent through existing
prerequisite foreign keys. It does not require an active pointer: it requires the
exact archived owner and its canonical `restart-executing` source record, inserts
the `restart-complete` terminal decision/record/claim, inserts the pending
recovery-fresh intent and sets only `reserved_start_command_sha256`. Its exact
post-commit state has no working capture, a null active pointer and one matching
pending recovery-fresh reservation; the existing start reconciler then creates
the sole new working capture and active sequence-1 command atomically. Death
before either commit leaves that phase wholly absent; death after commit resumes
from exactly that phase. No observation or other content from the abandoned
capture enters final Task 19 evidence. Retry reads the same committed
owner/snapshot/terminal; two helpers converge through the SQLite writer lock and
unique constraints.

There is no abandoned bundle export. The ignored database is the diagnostic
archive. Final report generation reads only the fresh working capture selected by
the terminal chain.

## Derived output boundary

C5 migrates `b3-live-capture-adapters.mjs`, iOS/Android wrappers and evidence
assembly to depend only on `B3CaptureStore`. The old observation journal,
checkpoint file and filesystem recovery APIs lose all production imports and are
deleted with their obsolete tests.

The final six report writers keep their existing atomic create-only output rules.
They receive a validated frozen capture projection, not a database handle. A
report hash is compared with any existing final; identical is idempotent and
different conflicts. Report publication is deliberately outside the SQLite
transaction because reports are derived evidence, never working state.

Physical screenshots, the Android Play Protect attestation and the Cloudflare
deployment draft remain bounded immutable proof inputs at their existing ignored
paths. They are not SQLite recovery authority and are not claimed to be derivable
from the database. Their hashes may enter pending/final reports only after their
existing independent validators pass. If an input is lost before final evidence,
Task 22 must recapture or recreate it; Task 19 never invents or heals those bytes.

## Bounded implementation slices

1. **D1 schema/source:** shared build reader, schema replacement, step-row
   structural validation, no bundle bootstrap/open dependency.
2. **D2 observation/checkpoint:** extract pure canonical domain derivation from
   legacy modules; implement atomic publish/read and facade results.
3. **D3 composition:** make command mutators enforce step-chain invariants; derive
   the optional device-smoke projection and migrate live adapters/wrappers.
4. **D4 recovery:** replace bundle recovery phases with database snapshot,
   manifest, authority, terminal and recovery-fresh transactions.
5. **D5 deletion/export:** remove C1-C3/legacy production modules and tests,
   preserve final six-file report writers, update architecture/progress.

Each slice is one reviewed commit. Push after D2 and D5. No deployment, R2,
store, simulator or physical-device mutation occurs in Task 19.

## Finite verification

TDD must cover only observable transaction boundaries:

- semantic publication: empty first step, sequential step, identical retry,
  same-sequence conflict, wrong command/build/tail/canonical bytes, oversized
  bytes, optional smoke derivation, exact retry after consume/allocation/archive,
  archived non-tail identical/conflicting read-only retry, and command expected-
  sequence 513 rejection before insertion;
- transaction death: child death before insert, after insert and before commit,
  after commit before return, with unpatched reopen convergence;
- concurrency: identical publishers, different publishers, publisher versus
  transition, publisher versus consume, and publisher versus allocation;
- drift: build bytes/inode, active command and retained step replacement between
  preflight and commit, proving at most three attempts;
- obsolete schema: a real non-empty v1 database plus any exact rollback-journal
  sidecar returns `b3_capture_state_schema_obsolete` before SQLite opens, with
  byte-identical database/sidecar SHA and a source scan proving no migration,
  cleanup or reset entrypoint exists;
- recovery: death before and after abandoned snapshot commit, duplicate helpers,
  exact archived-pending-terminal reopen, terminal retry and fresh-start
  allocation, plus one 512-command maximal ordinary-decision-chain fixture proving
  snapshot hash derivation has no independent storage bound, and a terminal/fresh-
  intent reopen proving the snapshot hash is unchanged after the separately
  chained recovery-terminal decision; and
- export: absent/partial/identical/conflicting derived report without database
  mutation.

No production fault hook, sleep, filesystem race matrix, temporary-name matrix or
same-UID attacker claim is permitted. Real child processes and SQLite locks prove
crash/concurrency behaviour.

## Exact production scope

Expected edits/additions:

- `scripts/lib/b3-build-authority-source.mjs`;
- `scripts/lib/b3-capture-state-schema.mjs`;
- `scripts/lib/b3-capture-state-database.mjs`;
- `scripts/lib/b3-capture-state-repository.mjs`;
- `scripts/lib/b3-capture-store.mjs`;
- pure validation/derivation exports in the observation/checkpoint modules;
- live adapter/wrapper/evidence callers in D3-D5; and
- deletion of `b3-capture-bundle-store.mjs` plus obsolete filesystem recovery
  modules after the last production import disappears.

Any new generic persistence abstraction, second database, SQL path parameter,
filesystem working-state store, R2 state store or automatic old-state migration
is an architecture stop.

## Review and exit gates

Before D1 implementation, two independent reviewers must approve this exact plan
SHA: one for schema/transaction/recovery correctness and one for SOLID/DRY/YAGNI,
spec compatibility and bounded verification. Any amendment invalidates both.

Every slice requires focused RED/GREEN, affected legacy regressions, schema/import
scans, syntax, Oxlint and `git diff --check`, followed by two exact-snapshot reviews.
D5 additionally requires native sync 7/7, iOS/Android native builds and the full
Node suite.

Task 19 closes only after the final exact HEAD passes the existing five independent
Task 19H reviews: spec/trace, SQLite concurrency/recovery, native transport/privacy,
Cloudflare/credential security, and code quality/test adequacy. Any P1/P2 fix
invalidates all five approvals.

Task 19 completion claims no live deployment, R2/store/device mutation, signing or
committed evidence. Tasks 20-23 remain the only route to checkpoint, signed
distribution, live execution and Gate B.
