# Task 19 D3 — SQLite Command and Live-Capture Composition Plan

**Date:** 2026-07-17

**Parent:** `2026-07-16-b3-task19-sqlite-blob-authority-amendment.md`

**Slice:** D3 only — step-chain command invariants, facade composition and the
ordinary iOS/Android live-capture path.

**Architecture:** one fixed-root `B3CaptureStore` is the only working-state seam.
SQLite remains the sole command, observation and checkpoint authority. Legacy
filesystem recovery is neither mirrored nor extended.

## Exit outcome

After D3:

- a command cannot be generically consumed until its exact observation step is
  committed;
- command `N+1` cannot be allocated until command `N` is generically closed and
  step `N` is the exact committed tail;
- ordinary transitions that the existing state machine permits before
  publication remain legal;
- the default iOS and Android adapters start, allocate, transition, publish,
  consume and read through one `B3CaptureStore` facade;
- records, checkpoint and optional device-smoke projection come from one frozen
  `readCapture()` projection;
- wrappers close the default adapter's SQLite handle on success and failure; and
- an invocation requiring abandoned-capture recovery returns one closed interim
  `rejected` outcome without filesystem or database mutation. D4 replaces that
  boundary with transactional recovery.

This slice does **not** implement archive/snapshot/terminal/fresh-start recovery,
delete legacy modules, rewrite final report publication, deploy Cloudflare, touch
R2, launch a simulator or use a physical device.

## One relational validity model

Extend `validateReadyInitialStartUnchecked()` rather than adding a second
validator. The structural database state must satisfy all of these rules:

1. `allocation_sequence` remains one global, contiguous and unbounded command
   identity across all present and future captures;
2. within each capture, command ordinal, `expected_observation_sequence` and
   retained step sequence are local, contiguous from one and bounded at 512;
3. local command one names the zero previous-observation SHA;
4. local command `N > 1` names the exact `observation_sha256` from step `N-1`;
5. step `N`, when present, names local command `N` and remains structurally canonical
   under the D1 validator;
6. every generically consumed command has its exact step;
7. every command before the tail is generically consumed and has its exact step;
8. a generically closed tail has `steps.length === commands.length`;
9. an active tail permits only `steps.length === commands.length - 1` or
   `steps.length === commands.length`;
10. a ready capture with no steps consists only of its active first command; and
11. no pending, working or later recovery shape is healed by validation.

The active-tail two-state rule deliberately permits publication before generic
consumption. It does not require a step before an ordinary transition. The
maximum command and observation sequence remains 512.

Structural hashes are insufficient to authorise a mutation. Existing canonical
record/checkpoint semantic validation remains the one implementation extracted
in D2.

## Shared composition preflight

Refactor the repository around one private composition snapshot, not a generic
persistence abstraction. `readActiveCommand`, ready/idempotent `startCapture`,
`allocateNextCommand`, `transitionCommand` and `consumeCommand` share steps 1–4:

1. asynchronously read the fixed build-authority source;
2. in a short `BEGIN` transaction, run full structural database validation and
   copy the exact capture, singleton, command, decision and step rows needed by
   the operation;
3. commit the read transaction;
4. outside SQLite, semantically validate every retained canonical
   record/checkpoint pair with the shared D2 validator;
Read-only `readActiveCommand` returns after the semantically validated snapshot.
The ready/idempotent start branch rechecks that same snapshot in a second read
transaction before returning an adopted winner. Empty reservation and pending
reconciliation have no steps to validate.

Mutating branches then continue:

5. derive the command proposal from the copied source and build authority;
6. enter `BEGIN IMMEDIATE`, synchronously reread the fixed build source, rerun
   full structural validation and compare the complete copied composition
   snapshot byte-for-byte;
7. apply the existing checked decision/allocation statements, revalidate the
   resulting relational state, then commit; and
8. on build/database drift or `SQLITE_BUSY`/`SQLITE_LOCKED`, retry the complete
   operation at most three times. A stable authority, protocol or semantic error
   never retries.

There is no `await`, callback, random generation, network operation or
filesystem write inside the writer transaction. The only filesystem operation
inside it is the fixed no-follow synchronous build-source read. Public inputs are
copied before the first `await` and are never reread.

### Ordinary transition

Keep all twelve ordinary edges and the existing public result union:

```text
transitioned | already-transitioned | ordinary-conflict | generic-consumed
```

The exact selected active source remains required for a new decision. Retained
steps, if any, must be semantically valid, but the current command's step may be
absent. Publisher and ordinary transition may therefore both serialise
successfully when publication uses the current source.

If a store-backed controller publication loses to an ordinary transition, D2
correctly rejects the stale source. The controller may then reread and adopt only
an exact selected ordinary successor for the same command/capture, and retry the
same copied observation bytes. Adoption is bounded by the frozen ordinary state
graph (at most twelve selected edges), performs no native side effect and rejects
a different command, generic consumption or recovery edge. D2 publication itself
keeps its three result kinds and stable-error boundary unchanged.

### Generic consumption

Before inserting a generic-consumption decision, require the source command's
exact expected step in both the semantic preflight and committed writer
snapshot. Clearing the active pointer remains in the same transaction. Preserve:

```text
consumed | already-consumed | ordinary-selected
```

An attempt that observes no step fails unchanged. A stale retry against an
already selected valid consumption remains read-only and must never clear a
later active command.

### Later allocation

Before inserting command `N+1`, require:

- no active command;
- the exact generically closed command `N`;
- exactly `N` committed steps;
- proposal `expectedSequence === N+1 <= 512`;
- proposal `previousObservationSha256` equal to committed step `N`; and
- the existing capture/predecessor/build authority.

Preserve the S2 union:

```text
allocated | already-active | allocation-conflict | start-reserved
```

The post-commit state has one active command `N+1`, no step `N+1`, a contiguous
predecessor chain and an unchanged observation tail.

### Reads and start

`readActiveCommand()` performs the same semantic composition preflight and no
write. `readCapture()` stays the D2 committed projection. Initial reservation
owns no step; initial reconciliation creates only the first active command.
`startCapture()` therefore keeps its existing three result kinds unchanged.

## Complete `B3CaptureStore` facade

Add exact facade methods, delegating to the repository without exposing a path,
build authority, database handle, checkpoint, predecessor or retained row:

```js
await store.readActiveCommand()
await store.allocateNextCommand({ command })
await store.transitionCommand({ source, nextState })
await store.consumeCommand({ source })
```

Together with `startCapture`, `publishObservation`, `readCapture` and `close`,
the frozen handle has exactly eight methods. The facade synchronously snapshots
closed scalar command/source inputs before its first `await`; repository result
unions pass through unchanged and remain deeply frozen.

## One store-backed live-capture controller

Add one bounded live-capture controller module. It is orchestration, not a
second store and not a generic persistence abstraction. It imports
`B3CaptureStore` and pure proof-domain functions, and imports no journal,
checkpoint, issued-command, archive or recovery filesystem API.

The controller owns one lazily opened store per default adapter and exposes only
the operations the adapter needs:

- read one frozen capture projection;
- pin the current SQLite active-command projection for the invocation;
- start or allocate the next command with winner adoption;
- advance the ordinary device state machine;
- publish pulled observation bytes and consume the exact current source;
- expose the current records/checkpoint/smoke projection; and
- close the store exactly once.

No caller supplies a database root or state path. The store continues to use the
module-derived repository root. The adapter's existing `root` remains only for
signed distribution, screenshot, attestation and derived report paths.

### Pure next-command derivation

Extract the existing action/scenario bridge into a value-pure function receiving
only:

```text
platform, buildAuthority, capture projection or null, uuidFactory
```

For an empty database it derives the existing sequence-one `ARM_CAPTURE`
command and calls `startCapture()`. A pending start adopts
`intent.firstCommand`. A ready closed tail derives command `N+1` from
`capture.records` plus `capture.checkpoint` and calls `allocateNextCommand()`.
An active command is resumed exactly; its source state is never reconstructed
from an observation record or hash.

Different concurrent starters/allocators adopt the retained SQLite winner from
the existing facade unions. UUID generation occurs before the transaction and
never enters a retrying writer section.

### Device side-effect state machine

Map ownership to facade outcomes:

- only `transitioned` owns a new native side effect;
- `already-transitioned` resumes from its retained state;
- a returned ordinary winner becomes the next exact source; and
- generic consumption never authorises launch/force-stop/reinstall.

The controller retains the existing safety behaviour:

- `prepared -> launching` owns one launch;
- `stop-intent -> stop-executing` owns one force-stop;
- a retained `launched` command only pulls and never launches again;
- valid pulled bytes are checked against the exact command and previous
  committed observation;
- `publishObservation()` commits record and checkpoint together;
- only after publication does `consumeCommand()` close the command; and
- an already committed step is reread and consumed without a second native
  action.

`launching`, `stop-executing` and `reinstall-launching` are deliberately
ambiguous across process death. A fresh invocation never guesses whether the
native side effect crossed. Until D4 can abandon and restart transactionally,
the interim recovery classifier below rejects those states without replay.

Remove production fault callbacks such as `afterIssue`, `afterLaunch`,
`beforeJournal` and `afterJournal` from the store-backed path. D3 proofs use real
child processes, SQLite locks and process termination only. Legacy exported
helpers retain compatibility until D5 but receive no new default-adapter call
site.

## Default adapter and wrapper composition

Migrate `createDefaultAdapter()` so its ordinary path uses only the controller:

- `records()` reads `capture.records`;
- scenario, slow-card, terminal, learner, device/store and observation-chain
  projections receive those validated records;
- host-stop and relaunch use controller transitions;
- `inspectGatewaySmoke()` reads `capture.gatewaySmokeProjection`, rejects null,
  and may retain the existing create-only writer strictly as derived output;
- no default ordinary path reads or writes the journal or checkpoint files; and
- no default ordinary path mirrors SQLite commands into the issued-command
  ledger.

Each final inspection that needs several fields takes one capture projection and
does not mix records/checkpoint/smoke from separate reads.

The default iOS and Android adapter objects add `dispose()`. The proof wrappers
call an optional `dispose` primitive in `finally`, so the default SQLite handle
closes on success, operator-required exits and failures. Injected test primitives
remain valid without providing `dispose`.

## Interim recovery boundary

D3 does not translate the old filesystem recovery algorithm. Invocation pinning
uses `readActiveCommand()` and a private opaque pin that retains exact
command/capture identity plus the observed source state. The pinned state is an
audit baseline, not finalisation authority. Distribution validation remains
mandatory before finalisation.

Finalisation performs a fresh semantic `readActiveCommand()` before deciding. If
both pin and fresh read have no active command, it classifies no-active. If both
name the same command and capture, it requires the fresh source to equal the pin
or a legal selected ordinary successor, then classifies the **fresh committed
state**. A missing, different or illegally replaced command after an active pin,
or a newly active command after a no-active pin, returns `rejected`. It never
falls back to the stale pinned state and never adopts a different command.

Finalisation uses this exhaustive table for both platforms:

| Fresh committed active state | D3 status | Reason |
|---|---|---|
| no active command | `not-applicable` | no command requires recovery |
| `prepared` | `not-applicable` | no native side effect is authorised yet |
| `stop-intent` | `not-applicable` | force-stop execution has not been claimed |
| `stop-executing` | `rejected` | force-stop crossing is ambiguous |
| `host-stopped` | `not-applicable` | force-stop receipt is retained; later launch is safe |
| `launching` | `rejected` | native launch crossing is ambiguous |
| `reinstall-authorised` | `not-applicable` | reinstall launch has not been claimed |
| `reinstall-launching` | `rejected` | reinstall launch crossing is ambiguous |
| `launched` | `not-applicable` | launch receipt is retained; only pull/publish remains |
| `restart-required` | `rejected` | abandonment and recovery are required |
| `restart-executing` | `rejected` | recovery execution is incomplete |
| `restart-complete` | `rejected` | D4 terminal/fresh-start authority is absent |

`not-applicable` returns:

```text
{ status: 'not-applicable' }
```

`rejected` returns:

```text
{ status: 'rejected' }
```

Classification is one value-pure exhaustive function; an unknown state rejects
as invalid rather than defaulting to either status. Both outcomes perform no
transition, consumption, allocation, archive, filesystem write or database
write. D4 replaces this exact seam with
`operator-required`, transactional recovery and recovered/already-recovered
outcomes. D3 does not claim recovery parity.

Legacy recovery exports may remain in their existing module for direct legacy
tests until D5, but the default store-backed controller must not call them.

## Device smoke and Cloudflare composition

The optional smoke projection remains derived only from validated retained
records and is never stored separately in SQLite.

`proveB3Cloudflare()` keeps explicit `smokeProjection` injection for bounded
tests. Its production default opens the iOS `B3CaptureStore`, reads one capture
projection, takes `gatewaySmokeProjection`, closes the handle and rejects null.
It no longer treats `cloudflare-device-smoke.json` as working authority. The
existing create-only smoke file can remain a derived diagnostic output until D5
reviews all final export writers.

The Cloudflare adapter still proves only commerce/download transport. No learner,
spelling or Monster runtime state becomes online.

## TDD and finite concurrency proof

Create focused D3 tests before production edits and show RED for the missing
facade/controller and missing-step gates.

### Relational and facade cases

1. ready zero-step state permits exactly one active first command;
2. ordinary transitions before publication remain valid;
3. generic consumption without the command step rejects byte-identically;
4. publication then consumption commits one decision and clears one pointer;
5. allocation without the closed tail step rejects byte-identically;
6. allocation after publication/consumption binds sequence and previous SHA;
7. a closed command without its step and an allocation that outruns the tail are
   rejected on open without healing;
8. semantic record/checkpoint corruption blocks read, ready/idempotent start and
   every command mutator, while empty/pending start remains step-free;
9. command-local observation ordinals are validated independently of the global
   allocation identity so the rule does not preclude D4's fresh capture;
10. exact stale consume/allocation retries cannot clear or replace a later active
   command; and
11. the eight-method facade snapshots caller input once and preserves every S2
    result union.

### Real-process races

Use one dedicated child helper, real repository/store entrypoints, SQLite locks
and IPC barriers; do not add production hooks or sleeps.

1. publisher versus ordinary transition in both lock orderings: transition-first
   makes the controller adopt the exact same-command ordinary successor before
   bounded republish; both orderings converge to one step plus one legal selected
   decision;
2. missing-step publisher versus consumption: consumption cannot commit first;
   its rejected attempt leaves the database unchanged and a later retry closes
   the published command;
3. exact already-published retry versus valid allocation: the read-only retry and
   command `N+1` allocation both succeed with one retained step and active tail;
4. publisher versus a selected ordinary/generic decision preserves the existing
   committed winner result rather than inventing a new union; and
5. connection/process death leaves only the pre-transaction or post-commit
   relational state on unpatched reopen; and
6. real child barriers terminate after `prepared -> launching` commits but before
   native launch, after the native launch receipt but before `launching ->
   launched`, and after the launched commit. Reopen never replays launch: the
   first two exact ambiguous states return zero-mutation `rejected`, while the
   retained `launched` state is pull-only and `not-applicable`.

### Store-backed adapter cases

1. empty database -> start -> one launch -> publish -> consume -> frozen records;
2. retained prepared command resumes one launch;
3. retained launched command pulls/publishes without relaunch;
4. already committed step consumes without relaunch;
5. command `N+1` derives only from the committed checkpoint/tail;
6. slow-card and host-stop paths preserve one side-effect owner;
7. one smoke authority comes from `readCapture()` and null/two authorities fail;
8. the exhaustive no-active plus eleven-state interim recovery table returns the
   exact status for both platforms and preserves byte-identical database and
   legacy filesystem namespaces;
9. pin `prepared`, concurrently commit `launching`, then finalise: the fresh
   state returns `rejected`; repeat `stop-intent -> stop-executing`, and prove
   both same-invocation and second-helper advancement with zero finaliser
   mutation;
10. wrapper success and failure each close the default store once; and
11. source scans prove the new controller imports no legacy working-state module
    and default Cloudflare smoke no longer reads the diagnostic JSON as authority.

## Expected production scope

- `scripts/lib/b3-capture-state-database.mjs`;
- `scripts/lib/b3-capture-state-repository.mjs`;
- `scripts/lib/b3-capture-store.mjs`;
- one new bounded store-backed live-capture controller module;
- `scripts/lib/b3-live-capture-adapters.mjs` ordinary/default composition only;
- the narrow interim status handling in `b3-capture-recovery-store.mjs` if reused;
- `scripts/prove-b3-ios.mjs` and `scripts/prove-b3-android.mjs` optional disposal;
- `scripts/prove-b3-cloudflare.mjs` default SQLite smoke projection; and
- focused repository/store/live-adapter/wrapper tests and process helpers.

An added database, caller-selected state path, generic persistence layer,
filesystem mirror, recovery transaction, changed proof schema, final report
rewrite or deployment path is an architecture stop.

## D4 and D5 boundaries

D4 alone owns recovery-owner selection, abandoned capture state, relational
snapshot hash, manifest/authority BLOBs, terminal claim, recovery-fresh intent and
duplicate-helper convergence.

D5 alone deletes legacy bundle/journal/checkpoint/issued-command/archive modules
and obsolete tests, removes transitional re-exports, audits the final six derived
writers, updates architecture/progress, and runs the full Node/native/build gate.
Pure observation, checkpoint, transition and evidence derivation must survive
legacy shell deletion.

## Verification

Run the new D3 focused files plus affected D1/D2/S2 tests, including repository,
database, facade, publication, live capture and all three wrappers. Also run:

```sh
node --check <every modified production/helper module>
npx oxlint <every modified production/test/helper file>
git diff --check
rg -n "b3-(issued-command|host-capture-state|abandoned-capture)|appendB3PhysicalObservation|readB3CaptureCheckpoint" \
  scripts/lib/b3-store-backed-live-capture.mjs
```

The scan must return no match for the new controller. Run native sync/build and
the full Node suite at D5, as required by the parent amendment.

## Review and commit gate

Before implementation, two independent reviewers approve the exact plan SHA:

- SQLite transaction/concurrency/crash correctness; and
- SOLID/DRY/YAGNI, live-adapter parity, parent-amendment fidelity and D3 scope.

Implementation is subagent-driven with root integration. After focused GREEN,
two independent reviewers approve one exact staged patch SHA/tree with no P1/P2.
Then commit D3 as one slice. Any production or test fix invalidates both
implementation approvals. Push remains scheduled after D5 under the parent plan.
