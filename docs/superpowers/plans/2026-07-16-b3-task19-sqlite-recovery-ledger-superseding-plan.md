# B3 Task 19 SQLite Recovery Ledger Superseding Plan

**Status:** review-ready architecture stop; implementation is forbidden until two independent plan reviews approve the same exact file.

**Supersedes:** the complete filesystem transaction design in `2026-07-16-b3-task19-capture-recovery-store-refactor.md`. The earlier file remains historical evidence of the rejected approach and is not implementation authority after this plan is approved.

**Scope:** this plan replaces only the Task 19 ambiguous-launch, issued-command and abandoned-capture recovery mechanism. All other B3 purchase, download, signed-distribution, privacy, Cloudflare and final evidence requirements remain unchanged.

## Why the filesystem design stops here

The reviewed implementation repeatedly moved transaction authority between command state files, successor hard links, installing aliases, archive manifests, archive authorities and terminal claims. Every additional recovery rule created another independently mutable namespace and another crash interval. Exact reviews reproduced adjacent failures after successive fixes:

- an unselected state file conferred recovery authority;
- downstream claims could publish without durable prerequisites;
- an ordinary successor could strand a losing recovery writer;
- generic-consumption prefix files accumulated;
- a valid post-link owner alias with link count two could not resume; and
- tests had to expose or simulate increasingly detailed filesystem timing.

This is an architectural signal, not a request for another link-count exception. A filesystem remains the payload store, but it stops acting as a multi-file transaction database.

The rejected implementation evidence remains reproducible at base `d4610921f2a6db7894fc7c2df1ceb3c89661eed1`: aggregate `aefc0c30a1f1f3c7f4f3675b3d5b0745edcd566cfc15cd3a84885693e3a0f3f7` failed the selected-chain, prerequisite-DAG, owner-loser, generic-debris, runtime-seam and lock-proof reviews; aggregate `ac632d93501e24ccaab4d4e6916c534a8e48ff393b5d59174da069680bfdcdd0` repaired those findings but still failed exact post-link owner-alias recovery. Neither aggregate is commit authority.

## Fixed boundaries

The replacement must:

- remain completely local and offline for learning, learner progress and Monster progress;
- add no Cloudflare, store-console, physical-device or network dependency;
- use the repository-pinned Node `24.18.0` built-in `node:sqlite`; add no package dependency;
- keep the final six-file Task 19 evidence topology byte-for-byte compatible;
- keep evidence redacted and free of account, token, learner and device identity;
- preserve the existing signed build/deployment/distribution gates before recovery mutation;
- preserve the observable `not-applicable | operator-required | recovered | already-recovered | rejected` contract;
- fail closed on corrupt, unexpected or legacy authority;
- perform no automatic migration because Task 22 live evidence does not exist; and
- make no claim against an actively malicious process running as the same Unix UID between arbitrary syscalls.

The database is host proof state. It is not the mobile application's learner database, is never packaged in the app, is never uploaded, and is not part of final evidence.

## One transaction authority

Create one platform-local database:

```text
.native-build/b3/evidence/<platform>-capture-state/
  recovery.sqlite
```

The parent is an exact private `0700` real directory. The database is an exact private `0600` regular single-link file. The process opens no caller-selected database path. Before SQLite opens it, the host validates every existing path component with `lstat`/`O_NOFOLLOW`, rejects symlinks or repository escape, and sets a private creation mask for the bounded open operation. The database directory is excluded from packages, Git, evidence output and privacy reports.

Bootstrap is itself closed and crash-safe:

1. create-or-validate the exact state directory and sync the evidence parent;
2. create the fixed database file with `O_CREAT|O_EXCL|O_NOFOLLOW` and `0600`, or validate the exact existing file;
3. sync the state directory so the zero-byte directory entry is durable;
4. open it with `DatabaseSync`, start `BEGIN EXCLUSIVE`, create the complete frozen schema and metadata, then commit; and
5. sync the database and state directory again before returning authority.

An exact zero-byte private database with no legacy state is the sole recognised incomplete-bootstrap state. SQLite serialises duplicate initialisers; a child death before schema commit leaves an empty database or hot rollback journal which the next open recovers before retrying the one schema transaction. Any non-empty non-v1 database, partial schema, unexpected object or conflicting metadata rejects and is never deleted/rebuilt automatically. A missing/zero-byte database is eligible for bootstrap only when the new capture-bundles root is absent or an exact private empty directory; any working/abandoned/partial bundle without database authority rejects as `orphan-bundle-state`. Before bootstrap/open, the exact known legacy filesystem command, installing, owner, terminal and abandoned-generation paths are also required absent; their presence returns `legacy-state` with zero mutation and requires an explicit clean-state restart.

Fresh creation sets, and every later connection reads back and verifies:

```sql
PRAGMA application_id = <frozen B3 integer>;
PRAGMA user_version = 1;
PRAGMA journal_mode = DELETE;
PRAGMA synchronous = FULL;
PRAGMA fullfsync = ON;
PRAGMA foreign_keys = ON;
PRAGMA trusted_schema = OFF;
PRAGMA busy_timeout = 5000;
PRAGMA locking_mode = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA secure_delete = ON;
```

`DELETE` journal mode is deliberate: B3 needs one serial writer, not WAL read throughput. It avoids treating persistent `-wal`/`-shm` files as extra authority. SQLite's rollback journal owns interrupted transaction recovery. Before open, the directory may contain only `recovery.sqlite` and the exact SQLite-owned `recovery.sqlite-journal`; if present, that sidecar must be a private exact-`0600` regular single-link file with no special bits. It is never parsed, hashed, deleted or treated as application authority. It may be hot after a crash or live while another honest process owns a write transaction. A helper therefore opens SQLite and attempts its bounded transaction instead of classifying the journal by pathname. After it acquires `BEGIN IMMEDIATE`, SQLite has completed any required hot rollback; the helper reruns complete schema/application validation before its first application write. The application never requires journal absence before or after commit, rollback or close: another honest writer may create the exact journal immediately after the lock is released, and that cannot change an already committed domain result. Busy failure beside a live writer leaves that writer and journal untouched. Any WAL/SHM file, other sidecar or sibling rejects.

Every connection immediately calls `enableDefensive(true)` and `enableLoadExtension(false)`, verifies `location()` against the fixed prevalidated database, and installs a closed authoriser which denies attach/detach, extension loading, writable-schema changes, virtual tables and all unapproved pragma/schema operations.

Opening an existing database requires:

- exact path/type/mode/link policy;
- exact `application_id`, `user_version`, pragma values and frozen `sqlite_master` schema digest;
- no unexpected table, index, trigger or view;
- `PRAGMA integrity_check` returning exactly one `ok` row;
- `PRAGMA foreign_key_check` returning no rows; and
- complete application-level canonical-byte, SHA-256, hash-chain and phase validation.

SQLite atomicity prevents torn authority. Canonical hashes still prove domain consistency; they do not claim authorship against the same-UID non-goal. Validation occurs after SQLite has recovered any hot journal; an invalid post-recovery database receives no application mutation.

## Closed schema

All JSON is stored as canonical UTF-8 `BLOB`, never SQLite JSON text. Every SHA is lowercase hexadecimal and is independently recomputed after reads.

### `b3_meta`

Exactly one row binds the database to one platform and signed build authority:

```text
singleton = 1 PRIMARY KEY
schema_version = 1
platform = ios | android
tested_application_commit
application_fingerprint
schema_sha256
```

The commit and fingerprint must equal the independently read signed build authority on every mutation. Caller-supplied build identity is never authority.

Every table is `STRICT`; authority tables with natural primary keys are `WITHOUT ROWID`. The frozen schema places closed `CHECK` constraints on enums, positive versions/sequences, canonical relative identifiers, BLOB bounds and exact lowercase hash lengths. Application validation still recomputes every canonical byte/hash and proves the whole selected chain.

### `b3_captures`, `b3_commands` and `b3_authority_state`

`b3_captures` contains one row per capture journey:

```text
capture_id TEXT PRIMARY KEY
start_intent_sha256 TEXT UNIQUE NOT NULL
  REFERENCES b3_capture_start_intents(start_intent_sha256)
capture_state TEXT              -- working | abandoned
row_version INTEGER NOT NULL CHECK > 0
```

One working capture may own many sequential commands as observations advance. The capture row is inserted only when its start intent becomes ready. Recovery changes its exact row to `abandoned` in the same transaction that binds the renamed bundle; no later command may reference an abandoned capture.

`b3_commands` contains one immutable row per globally allocated command:

```text
command_sha256 TEXT PRIMARY KEY
allocation_sequence INTEGER UNIQUE NOT NULL CHECK > 0
predecessor_command_sha256 TEXT UNIQUE NULL REFERENCES b3_commands(command_sha256)
command_json BLOB NOT NULL
prepared_record_json BLOB NOT NULL
prepared_record_sha256 TEXT NOT NULL
capture_id TEXT NOT NULL REFERENCES b3_captures(capture_id)
expected_observation_sequence INTEGER NOT NULL CHECK > 0
previous_observation_sha256 TEXT NOT NULL
UNIQUE (command_sha256, capture_id)
```

The singleton `b3_authority_state` starts with `next_allocation_sequence = 1`, a null `active_command_sha256 REFERENCES b3_commands`, and a null `reserved_start_command_sha256 REFERENCES b3_capture_start_intents(first_command_sha256)`. The active pointer is the sole active-command slot; the reservation is the sole allocation hold while an initial or recovery-fresh capture start is pending. There is no redundant active flag or cached current state in each command. Global allocation sequence 1 has no predecessor; every later allocation is exactly prior sequence plus one and references the prior closed tail. A closed tail is exactly either a valid generic-consumption decision at its derived selected source or an exact recovery terminal. Merely inactive, corrupt or ordinary nonterminal rows never permit allocation. Command hashes can never be reused.

### `b3_decisions`

Every selected successor occupies one immutable relational decision slot:

```text
command_sha256 TEXT REFERENCES b3_commands
source_state TEXT
source_record_sha256 TEXT
winner_kind TEXT                -- ordinary | generic-consumption | recovery-owner | recovery-terminal
next_state TEXT NULL
next_record_json BLOB NULL
next_record_sha256 TEXT NULL
claim_json BLOB NOT NULL
claim_sha256 TEXT NOT NULL
PRIMARY KEY (command_sha256, source_state)
UNIQUE (command_sha256, winner_kind, claim_sha256)
```

A closed union `CHECK` enforces the exact allowed transition pairs and required/null fields. Generic consumption is allowed only from the eight non-recovery states and has no next record. Recovery owner is exactly `restart-required -> restart-executing`; recovery terminal is exactly `restart-executing -> restart-complete`. The primary key is the single-winner CAS: an ordinary `restart-required -> launched` and recovery owner physically cannot coexist. The selected state is always re-derived from the prepared record through these decisions; losing or orphan rows reject.

### `b3_recoveries`

At most one bundle intent exists per recovery-owner decision:

```text
command_sha256 TEXT PRIMARY KEY REFERENCES b3_commands
owner_kind TEXT CHECK = 'recovery-owner'
owner_claim_sha256 TEXT
capture_id TEXT UNIQUE NOT NULL
bundle_state TEXT               -- claimed | move-intent | bound
source_snapshot_sha256 TEXT NULL
row_version INTEGER NOT NULL CHECK > 0
FOREIGN KEY (command_sha256, owner_kind, owner_claim_sha256)
  REFERENCES b3_decisions(command_sha256, winner_kind, claim_sha256)
FOREIGN KEY (command_sha256, capture_id)
  REFERENCES b3_commands(command_sha256, capture_id)
UNIQUE (command_sha256, bundle_state, owner_claim_sha256, source_snapshot_sha256)
```

The source and destination paths are never stored: they are deterministically derived from validated `capture_id` and `command_sha256`. `source_snapshot_sha256` is null only for `claimed` and mandatory/immutable for `move-intent | bound`.

### `b3_recovery_manifests`, `b3_recovery_authorities` and `b3_recovery_terminals`

The archive DAG is normalised instead of encoded as optional columns:

```text
b3_recovery_manifests:
  command_sha256 PRIMARY KEY
  bundle_state CHECK = 'bound'
  owner_claim_sha256
  payload_snapshot_sha256
  manifest_json BLOB
  manifest_sha256
  composite FK (command, 'bound', owner claim, payload snapshot)
    -> exact bound recovery-owner row
  UNIQUE (command, owner claim, manifest SHA)

b3_recovery_authorities:
  command_sha256 PRIMARY KEY
  owner_claim_sha256
  manifest_sha256
  authority_json BLOB
  authority_sha256
  composite FK -> exact manifest row
  UNIQUE (command, owner claim, manifest SHA, authority SHA)

b3_recovery_terminals:
  command_sha256 PRIMARY KEY
  owner_claim_sha256
  manifest_sha256
  authority_sha256
  terminal_record_json BLOB
  terminal_record_sha256
  terminal_claim_json BLOB
  terminal_claim_sha256
  composite FK -> exact authority row
  UNIQUE (command, terminal claim SHA)
```

The terminal transaction also inserts the exact `recovery-terminal` decision and clears the active pointer. Direct manifest, authority or terminal insertion without the exact prerequisite row fails relationally before application publication.

### `b3_capture_start_intents`

Initial start and recovery completion use one closed intent schema:

```text
start_intent_sha256 TEXT PRIMARY KEY
intent_kind TEXT                -- initial | recovery-fresh
recovered_command_sha256 TEXT NULL
terminal_claim_sha256 TEXT NULL
capture_id TEXT UNIQUE NOT NULL
first_command_sha256 TEXT UNIQUE NOT NULL
first_command_json BLOB NOT NULL
first_prepared_record_json BLOB NOT NULL
first_prepared_record_sha256 TEXT NOT NULL
intent_state TEXT              -- pending | ready
row_version INTEGER NOT NULL CHECK > 0
```

A closed union `CHECK` requires both recovery fields null for `initial` and both present with a composite FK to the exact recovery terminal for `recovery-fresh`. The schema has a partial unique constant-expression index permitting at most one row with `intent_state='pending'`.

The composite foreign key `(recovered_command_sha256, terminal_claim_sha256)` references the exact recovery terminal. Application validation recomputes the canonical intent SHA and proves that `initial` has no predecessor while `recovery-fresh` names the exact terminal command as predecessor.

The first capture starts with a transaction that proves an empty command/capture chain, inserts one immutable pending `initial` intent and sets `reserved_start_command_sha256`. That transaction performs no bundle filesystem mutation. Recovery terminal performs the same reservation with a pending `recovery-fresh` intent containing the already generated fresh UUID and exact observation-sequence-1/zero-previous-hash `ARM_CAPTURE` command bytes. The global command allocation sequence still advances normally. Competing helpers may propose different values, but only the committed intent wins; every retry discards its proposal and reuses the committed canonical intent.

## Transaction rules

All mutations use a repository-owned `BEGIN IMMEDIATE` transaction. Production exports accept no connection, SQL, clock, callback, fault hook or transaction function.

### Allocation and ordinary transitions

Ordinary later-command allocation validates the entire database, proves both `active_command_sha256 IS NULL` and `reserved_start_command_sha256 IS NULL`, proves the prior tail is closed by one of the two exact forms above, and proves its capture row belongs to a `ready` start intent and remains `working`. It then inserts the next immutable command for that same capture and advances the singleton pointer/sequence in one transaction. This is how commands A, B and C may advance one capture journey without creating another capture row or bundle.

Only the capture-start reconciler may allocate while the reservation is non-null. It must match the reserved hash, sole pending intent and exact next allocation sequence. While holding one `BEGIN IMMEDIATE`, it creates or validates the fixed empty working bundle, then inserts the capture row and already-fixed first command, advances the singleton sequence and active pointer, clears the reservation and marks the intent `ready` in one SQL commit. An initial intent has no predecessor and requires an otherwise empty command/capture chain; a recovery-fresh intent uses the recovered terminal command as predecessor. A process death before that SQL commit leaves only the same pending intent plus an absent or recognised partial empty bundle, so no active command can be orphaned from its bundle and no bundle UUID can lose its database owner.

An ordinary transition derives the selected source record and attempts one decision insert:

```sql
INSERT INTO b3_decisions (...)
VALUES (...)
ON CONFLICT (command_sha256, source_state) DO NOTHING;
```

Exactly one selected successor may insert one row. Zero changed rows causes a reread: identical canonical authority converges; another valid winner returns the typed domain result; corruption rejects. The repository then re-derives the chain rather than trusting a cached state.

### Generic consumption

Generic consumption is the same decision insert, restricted to the eight existing non-recovery source states. A newly inserted generic decision clears the singleton active pointer in the same transaction and must change exactly one matching pointer row. An identical stale retry after command B exists reads the prior decision and never changes B. There are no `.issued-*` temporaries, hard links, tombstones or cleanup protocol.

### Recovery claim versus ordinary launch

`recoverAmbiguousCapture()` consumes the acknowledgement by inserting the exact `recovery-owner` decision and `claimed` recovery row in one transaction, conditional on the active pointer and re-derived selected `restart-required` record.

An ordinary `restart-required -> launched` transition competes for the same `(command_sha256, 'restart-required')` primary key. Therefore exactly one transaction commits. The loser rereads the database:

- ordinary launch winner -> recovery returns `not-applicable`;
- identical recovery winner -> helper resumes without another acknowledgement;
- any other state -> `rejected`.

There is no writer alias, `nlink=2`, losing temporary or external lock.

### Recovery terminal

After archive verification and exact private manifest/authority materialisation, one transaction inserts the exact recovery terminal row and `recovery-terminal` decision, clears the matching active pointer, and inserts the immutable pending recovery-fresh capture-start intent. The terminal claim binds:

```text
commandSha256
ownerClaimSha256
manifestSha256
archiveAuthoritySha256
terminalRecordSha256
```

No terminal can exist without the preceding fields because composite foreign keys and the one transaction construct them together. Recovery completion never constructs final Task 19 evidence from the abandoned capture.

## One capture bundle

All mutable files belonging to one capture live under one real directory from capture start:

```text
.native-build/b3/evidence/<platform>-capture-bundles/
  <captureId>.working/
    observations/
    checkpoint/
    derived/
```

Every component uses the existing closed name/type/mode/count/size/hash rules. No symlink or external hard link is accepted. The command row binds `captureId`, expected sequence and previous observation hash. The mutable working-bundle inventory is independently recomputed while the SQLite writer transaction excludes every honest writer; it is never cached as immutable command authority. Freeze `MAXIMUM_CAPTURE_MEMBER_TEMPORARIES = 32` per working bundle; every in-bound recognised temporary is reconciled under the SQLite writer transaction, while the first additional name or any unrecognised entry rejects without mutation.

The abandoned destination is deterministic and under the same parent:

```text
.native-build/b3/evidence/<platform>-capture-bundles/
  <commandSha256>.abandoned/
    observations/
    checkpoint/
    derived/
```

Recovery never moves members separately. It atomically renames the whole working bundle to the exact abandoned name inside one private parent and syncs that one parent.

Every live member write is also crash-closed. While holding a repository-owned `BEGIN IMMEDIATE` transaction, the writer reconciles bounded same-directory temporary names whose closed filename binds the final relative path and expected SHA, writes one sealed temporary with checked partial writes and syncs it. Still under the lock it snapshots the final name: an exact identical final discards/reconciles the temporary; an absent final permits rename; a conflicting final rejects. POSIX file rename is never called when the final exists because it may replace that file rather than return `EEXIST`. After a permitted rename, sync the member directory and commit. An honest duplicate cannot enter while the writer holds the SQLite transaction. A child death releases the database lock: an exact complete final member is adopted; an exact fully written temporary may be renamed to its bound absent final name; a recognised incomplete unlinked temporary is removed before retry. Every `ENOENT` or directory-rename `EEXIST` causes a transaction and namespace reread; neither is a success signal. Static unexpected names, links, modes or conflicting bytes reject.

## Honest database/filesystem reconciliation

SQLite and directory rename are not falsely described as one atomic transaction. The database is intent and authority; the bundle is an idempotent effect.

The closed phase protocol is:

1. `claimed` commits the single winner and acknowledgement consumption; `source_snapshot_sha256` remains null.
2. A short `BEGIN IMMEDIATE` transaction reruns complete database validation, validates the exact working bundle while every honest bundle writer is excluded, stores its inventory hash and commits `move-intent`.
3. A new `BEGIN IMMEDIATE` transaction rereads the database and both names, performs or reconciles the same-parent rename, syncs the common parent, validates the abandoned bundle against the stored hash, updates the recovery to `bundle_state='bound'` and the exact capture row to `capture_state='abandoned'`, then commits. Holding this transaction across the filesystem effect is the honest-helper mutex; it is not a claim that SQLite and rename are one atomic resource.
4. Under a fresh `BEGIN IMMEDIATE`, rerun complete database/bundle validation, derive canonical schema-v1 manifest and schema-v3 authority, insert both rows through their prerequisite foreign keys and commit. The payload snapshot excludes `manifest.json` and `authority.json`; later phase validation permits those two names only when their committed rows exist.
5. Under another `BEGIN IMMEDIATE`, reconcile and materialise `manifest.json` followed by `authority.json` as rebuildable private archive files from committed database bytes. Each uses a hash-bound same-directory staging name, checked writes, file sync, absent/exact/conflicting final-name classification, permitted rename only when absent, abandoned-directory sync and exact readback. Missing files and recognised incomplete staging files resume from the database; conflicting final bytes, links, modes or unexpected names reject and are never overwritten. The terminal transaction later rereads both exact final files while it holds its own writer lock.
6. One `BEGIN IMMEDIATE` transaction reruns complete database validation, strictly rereads both exact final archive files against the committed rows, publishes the recovery terminal, clears the active pointer, commits the pending recovery-fresh capture-start intent and sets the singleton start-command reservation.
7. The capture-start reconciler handles the recovery-fresh intent through the same protocol as an initial start: one `BEGIN IMMEDIATE` creates or validates its observation-sequence-1 three-directory working bundle, syncs its children/bundle/common parent, proves the reservation and pending intent still match, inserts the `b3_captures` row plus already-fixed first command at `next_allocation_sequence` with the recovered command as predecessor, advances the singleton sequence/active pointer, clears the reservation and marks the intent `ready`, then commits.

On entry, reconciliation validates one of these states:

| Database phase | Working bundle | Abandoned bundle | Required action |
| --- | --- | --- | --- |
| `claimed` | exact | absent | commit `move-intent` |
| `move-intent` | exact | absent | rename, sync common parent, validate, bind |
| `move-intent` | absent | exact | sync common parent, validate, bind |
| `bound` or later relational row | absent | exact | validate and continue |
| any | both present | any | reject |
| any | both absent | any | reject |
| any | linked, unexpected or wrong/conflicting | any | reject |

An empty observation-sequence-1 capture is still a real three-directory working bundle before the claim. There is no special absent-directory authority.

Every rename `ENOENT`/`EEXIST` rereads the transaction phase plus both complete snapshots before deciding. If the process dies after rename but before SQL commit, SQLite rolls back to `move-intent`; the next helper observes the exact abandoned bundle, syncs the parent and commits `bound`. Both/neither/conflicting states never self-heal.

Private archive materialisation has its own closed table, always under `BEGIN IMMEDIATE`:

| Committed rows | `manifest.json` | `authority.json` | Required action |
| --- | --- | --- | --- |
| neither | absent | absent | derive/commit both rows first |
| manifest + authority | absent or recognised partial | absent | finish manifest, sync/readback, continue |
| manifest + authority | exact | absent or recognised partial | finish authority, sync/readback |
| manifest + authority | exact | exact | exact reread; terminal eligible |
| neither | any present | any | reject |
| any | authority present before exact manifest | any | reject |
| any | conflicting final/staging, wrong link/type/mode/name | any | reject |

Capture-start reconciliation is closed for both `initial` and `recovery-fresh` while the pending reservation owns the SQLite writer lock:

| Intent/rows | Fixed working bundle | Active/reservation | Required action |
| --- | --- | --- | --- |
| `pending`, no capture/first-command row | absent | none / exact fixed command | create the exact empty bundle and three children in order |
| `pending`, no capture/first-command row | recognised partial subset of empty exact directories | none / exact fixed command | create and sync the remaining directories |
| `pending`, no capture/first-command row | exact empty three-directory bundle | none / exact fixed command | insert capture plus fixed command, consume reservation, mark ready |
| `pending`, any capture/command row | any | any | reject as an impossible torn/corrupt authority state |
| `pending` | non-empty, linked, wrong mode/type or unexpected entry | any | reject |
| `pending` | any | another active command or wrong reservation | reject |
| `ready`, exact capture/first-command rows | location exact for current `working | abandoned` capture state | reservation absent; active pointer validates against the current global chain | validate and converge without requiring the first command to remain active |
| `ready` | any other database/namespace state | any | reject |

For `initial`, the pending state additionally requires an empty command/capture chain and a null predecessor. For `recovery-fresh`, it requires the exact recovered terminal tail and uses that command as predecessor. Creation order is bundle directory, each required child, child/bundle syncs, common-parent sync, exact snapshot, capture/command inserts, singleton update and intent-ready update. A process death may leave only a recognised empty partial subset owned by the durable intent; no premature observation/checkpoint/derived member is accepted. The SQL commit makes the capture row, first command, null reservation and `ready` intent visible together. After readiness, ordinary transitions may advance the active pointer through later commands in the same capture, so the first command is never treated as a permanent active pointer.

Once `claimed` commits, another acknowledgement is never required. A crash before that commit rolls back and may require the acknowledgement again. SQLite recovery decides whether that commit occurred.

## Abandoned archive is not final evidence

The abandoned bundle and its database/materialised manifest/authority remain private diagnostic recovery state. They are excluded from the Task 19 final six files and must never contribute an observation, screenshot, learner result or trace to final evidence. Recovery terminal exists only to prove that the uncertain old capture was quarantined without repeating a native side effect.

The pending recovery-fresh capture-start intent is therefore part of terminal completion. Its fresh observation-sequence-1 `ARM_CAPTURE` command and capture ID are fixed before the terminal transaction commits. A crash at any later bundle/allocation step resumes that same intent; it never allocates a second UUID or asks for another reinstall acknowledgement. Only the new capture can eventually feed the independent existing Task 19 evidence assembler.

The public facade returns `recovered` only after the recovery-fresh intent is `ready`. An already-terminal invocation first reconciles the exact pending intent and returns `already-recovered` only when that same fresh command/bundle is ready. Neither status means the abandoned capture entered final evidence or that a new native action already ran.

## Invocation and planned REBIND

The public facade remains:

```js
const invocation = await store.pinInvocation({ acknowledgeReinstall });
const distribution = await inspectDistributionFresh();
const result = await store.finaliseInvocation({ invocation, distribution });
```

`pinInvocation()` acquires a short `BEGIN IMMEDIATE`, reruns complete database validation, captures the exact database row versions, command/decision hashes and bundle inventory in a private `WeakMap`, then commits without writing. `finaliseInvocation()` validates signed distribution first, acquires a new `BEGIN IMMEDIATE`, reruns complete database validation and captures the closing DB+bundle snapshot while every honest bundle writer is excluded. It rejects any unapproved drift; when recovery is applicable, the same still-open transaction inserts the recovery-owner decision/row before it commits, so no writer can enter between closing validation and acknowledgement consumption. Plain read transactions are never used for a composite database/filesystem pin because they could observe old database rows beside newer filesystem bytes.

The in-memory acknowledgement capability remains single-use across ambiguous recovery and planned `REBIND_FRESH_INSTALL`. Only the transaction that inserts `recovery-claimed` consumes the recovery branch. A `not-applicable` result may leave the planned branch available for the exact pinned tail. No late SHA-only recovery path survives.

## One deep production module

The external seam is one `B3CaptureStore` facade. Live adapters and wrappers may start/resume a capture, publish the next validated member/transition, or execute the existing pinned recovery invocation through that interface; they never receive a database handle, bundle path, SQL transaction, recovery phase or filesystem primitive. Deleting this module would force command allocation, bundle publication, crash reconciliation and recovery ordering back into every caller, so it earns its depth.

The files below are private implementation modules behind that one interface, not additional production seams:

Create:

- `scripts/lib/b3-capture-state-database.mjs` — strict path, SQLite open/schema/integrity and transaction ownership;
- `scripts/lib/b3-capture-state-schema.mjs` — exact SQL schema and frozen schema digest;
- `scripts/lib/b3-capture-state-repository.mjs` — command/decision/recovery/capture-start-intent transactions;
- `scripts/lib/b3-capture-bundle-store.mjs` — strict working/bound bundle snapshot and whole-directory rename;
- `scripts/lib/b3-capture-recovery-service.mjs` — one phase-reconciling recovery operation;
- `scripts/lib/b3-capture-store.mjs` — the sole external interface used by production callers;
- focused database, bundle, facade, process-crash and capture-start tests.

Modify:

- the live observation journal, checkpoint and derived writers so one capture begins inside one `.working` bundle;
- live adapters and proof wrappers to depend only on the public capture store facade;
- abandoned-capture inspection to consume the bound bundle while final evidence assembly explicitly ignores all abandoned state and continues to consume only the fresh capture;
- package/fingerprint/private-material scanners for the new tracked modules and ignored runtime database;
- Task 19 documentation and progress only after the final gate passes.

Delete after caller migration:

- filesystem issued-command allocation, state and successor ledgers;
- generic-consumption temporary/tombstone logic;
- `installB3RecoveryClaim({ kind })` and its four-kind installing namespace;
- recovery hard-link CAS and link-count authority;
- `/usr/bin/lockf` coordinator and lock primitive modules;
- per-target/global recovery-debris limits that exist only for the deleted protocol;
- public abandoned-capture multi-step helpers;
- every production race/fault callback and obsolete filesystem crash test.

No production export accepts a database connection, path, SQL statement, filesystem adapter, clock, callback, phase selector or fault hook. Observable behaviour is tested through the same `B3CaptureStore` interface used by callers. Narrow internal invariant tests may seed canonical database phases through test-owned SQL fixtures in isolated temporary roots, but those fixtures are not a second production adapter. Deterministic failures between write, sync, rename and SQL commit run in isolated Node child processes with `--experimental-test-module-mocks`: fixed dependency modules are mocked before dynamically importing unchanged production modules, and test-owned IPC reports the selected syscall boundary. Materialised stable states and real two-process SQLite-lock/kill tests independently cover reopen and concurrency. No normal runtime process or production option can select a mock.

## TDD execution slices

### S0 — Preserve the rejected work as evidence, then reset the implementation seam

Record the rejected aggregate and review findings in this plan. Keep `d461092` as the code rollback checkpoint. After this plan is approved and committed, remove only the uncommitted rejected filesystem implementation with explicit `apply_patch` edits; do not use a destructive Git reset and do not touch unrelated user work.

RED source contracts enumerate the old modules, imports, hard-link calls, lock coordinator and runtime hooks which must be absent at the end.

### S1 — Strict SQLite foundation

RED tests cover directory/file bootstrap death at every step, duplicate initialisers, zero-byte recovery, hot-journal rollback, exact modes including special bits, symlink/hard-link/path escape, unexpected sidecars, wrong application ID/version/pragmas/schema objects, corruption, foreign-key failure, canonical row/hash failure, rollback after child death with an open transaction, busy timeout and close/reopen. One two-real-connection test holds T1 after its first write while T2 opens beside the live DELETE journal; T2 must wait/return bounded busy rather than reject the journal path, and a later reopen must let SQLite recover. A second deterministic test lets T1 commit and release its lock, then makes T2 perform its first write before T1 returns/closes; T1 must still return its committed domain result and must neither reject nor remove T2's exact journal.

Implement the database and schema modules. GREEN requires identical schema bytes/digest across clean clones and no mutation on invalid existing state.

### S2 — Capture-start, command and decision parity

RED tests port every issued-command allocation, all ordinary transitions, all eight generic-consumption sources, duplicate/stale helpers, same-hash reuse, unselected/orphan rows and ordinary-versus-generic single-winner cases. Initial-start tests prove that two starters commit one pending intent/reservation, an initial intent requires an empty chain, and no command/capture row exists before reconciliation. Allocation parity covers multiple generic-consumed commands A -> B -> C sharing one capture/bundle and the distinct recovery-terminal A -> reserved recovery-fresh B path into a new capture. Merely inactive A rejects.

Implement the repository transactions and remove filesystem command authority. GREEN must prove one active command, one selected successor per state, one exact global allocation chain entirely from committed rows and no accidental one-command-per-capture constraint.

### S3 — One working capture bundle

RED tests require journal/checkpoint/derived writes to remain under one capture ID; cover closed names, modes, links, counts, sizes, hashes, same-parent roots and observation-sequence-1 empty capture. Initial capture-start tests kill a real child after the committed intent and after every bundle mkdir/sync/SQL boundary, then require the same fixed capture ID/command to converge from absent, every recognised partial-empty subset and exact-empty states. Duplicate initial reconcilers must produce one bundle and one first command. The member table covers temporary create, every partial prefix, sync, rename, directory sync, transaction rollback, complete-file adoption, dead-temp cleanup and honest duplicate exclusion.

Implement bundle creation/snapshot/member publication and migrate all live capture writers. No cross-directory member move remains.

### S4 — Recovery claim and whole-bundle reconciliation

RED tests cover flag absence, claim winner, ordinary-launch winner, two recovery helpers, database busy/rollback, every reconciliation-table row, same-parent rename before/after parent sync and SQL commit, wrong bundle, source replacement during bounded validation and stale command A with active B. Every rename `ENOENT`/`EEXIST` row reruns the closed database/namespace classifier.

Implement the single recovery transaction and whole-directory rename protocol. There is no public phase method.

### S5 — Archive verification, terminal and recovery-fresh start

RED tests cover exact schema-v1 manifest/schema-v3 authority, owner/manifest/authority/terminal composite-FK binding, terminal-before-bound rejection, corrupt rows, conflicting stored/materialised bytes, duplicate terminal helpers and proof that abandoned observations never reach final evidence. Terminal tests require exactly one immutable pending recovery-fresh capture-start intent and the exact `commandSha256 | ownerClaimSha256 | manifestSha256 | archiveAuthoritySha256 | terminalRecordSha256` canonical binding.

Implement archive verification and the one terminal transaction. Reuse the capture-start reconciler for recovery-fresh working-bundle creation plus first-command allocation under one subsequent `BEGIN IMMEDIATE`, including death after each filesystem sync/SQL statement. Race the terminal commit, an ordinary allocator and the start reconciler: the ordinary allocator must reject the reservation and only the fixed recovery-fresh command may consume the immediate successor/allocation-sequence slot. GREEN proves no database state can represent a terminal missing any prerequisite and every terminal converges to one ready observation-sequence-1 capture without a second acknowledgement.

### S6 — Invocation pin and planned REBIND

RED tests cover command/bundle appear, disappear, replace and advance between pin and finalise, distribution mismatch, all observable statuses, single-use acknowledgement and every planned-REBIND conflict.

Implement the opaque capability and delete secondary late recovery.

### S7 — Complete database/bundle crash closure

RED tests materialise or process-kill at:

- before and during an uncommitted SQL transaction;
- after each committed recovery phase;
- before/after whole-directory rename;
- before/after the common-parent sync;
- archive manifest/authority materialisation at every file prefix, sync, readback and conflicting-byte state;
- initial-intent commit plus initial bundle child/bundle/parent sync, command insertion and intent-ready commit;
- terminal plus recovery-fresh-intent commit;
- recovery-fresh bundle child/bundle/parent sync, command insertion and intent-ready commit; and
- duplicate helpers at each stable database phase.

After faults stop, every initial start converges to one ready capture, and every recovery converges to one terminal, one private abandoned bundle and one ready recovery-fresh observation-sequence-1 capture without another acknowledgement or native side effect. The final six-file assembler still contains no abandoned member. SQLite transaction crash tests use a test-owned child which begins/writes without commit and is killed; production exposes no pause callback.

### S8 — Remove the rejected protocol

Delete all old filesystem ledger/recovery/lock modules, fixtures and tests. Source contracts scan all production imports and calls for the forbidden interfaces. Retain only observable integration tests and the new SQLite/bundle crash matrix.

### S9 — Complete Task 19 gate

Run the original Task 19 focused suite plus the new SQLite/bundle suites, then the full repository, lint, build, native sync, B2 authority, deterministic B3 proof, dependency audits, gateway gates, iOS inspector and exact iOS/Android native builds from the approved Task 19 plan.

Commit only after all gates pass. Obtain five fresh independent reviews of the same exact HEAD:

1. spec and trace compliance;
2. SQLite recovery, concurrency and threat-model compliance;
3. native transport, signed distribution and privacy;
4. Cloudflare exact-byte/R2/credential containment; and
5. code quality, deletion completeness and test adequacy.

Any P1/P2 requires a RED test, a new commit and all five reviews restarted.

## Completion gate

The superseding recovery work is complete only when:

- SQLite is the sole command, selected-transition, consumption and recovery authority;
- one conditional transaction decides ordinary launch versus recovery claim;
- one terminal transaction binds every prerequisite and closes the command;
- the capture payload moves as one atomic directory bundle;
- database intent plus deterministic reconciliation handles every DB/filesystem crash boundary without claiming cross-resource atomicity;
- every initial start first commits one durable intent and converges to one ready capture without an orphan active command or ownerless bundle;
- abandoned recovery state is excluded from final evidence, and the existing independent assembler retains the exact six-file topology using only the fresh capture;
- every terminal commits one durable recovery-fresh capture-start intent which converges to one ready observation-sequence-1 capture;
- no hard-link CAS, installing alias, link-count authority, external `lockf`, filesystem command chain or generic temporary remains;
- no production runtime injection seam exists;
- the same-UID non-goal and static hostile-input boundary remain honest;
- complete Task 19 verification passes; and
- five independent reviewers approve the same exact HEAD.
