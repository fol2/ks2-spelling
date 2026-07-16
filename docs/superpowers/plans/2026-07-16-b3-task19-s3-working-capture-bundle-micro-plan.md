# B3 Task 19 S3 Working Capture Bundle Micro-plan

**Status:** review candidate; implementation needs two reviewers on one exact SHA-256.
**Fixed point:** `9dd0706bcead903c389a8792efa5c0203256cd5f`.
**Authority:** the approved SQLite recovery-ledger superseding plan, especially S3 and its frozen schema, plus the approved S1/S2 implementation at this fixed point. Any schema edit is an architecture stop and plan amendment.

## Bounded outcome

S3 gives each canonical working capture one private, crash-closed filesystem bundle owned by the SQLite capture row. It completes the pending initial-start intent, publishes immutable observations, derives immutable checkpoint revisions and retains the one closed iOS gateway-smoke projection. Every honest production bundle reader/writer crosses one `B3CaptureStore` interface and one SQLite writer lock.

S3 is GREEN only when an observation-sequence-1 start converges from an absent or recognised partial empty bundle to one ready intent, one first command and the exact empty working bundle. Later publication converges after process death without a cross-directory move, hard link, mutable current file or caller-visible recovery phase.

S3 does **not** implement S4+ recovery claim, working-to-abandoned rename, archive manifest/authority, terminal claim, recovery-fresh start or the S6 composite/acknowledgement pin. It does not perform S8 deletion, final evidence assembly, deploy, device/store action, Cloudflare request or R2 mutation. Gateway smoke is only a local retained projection. Learner, spelling and Monster state remain local and unrelated to this host proof store.

## Fixed root, layout and inventory

The caller supplies no root or path. The existing fixed repository root derives:

```text
.native-build/b3/evidence/<platform>-capture-bundles/       0700
  <captureId>.working/                                      0700
    observations/                                           0700
      <sequence-8-digits>.json                              0600
    checkpoint/                                             0700
      revision-<revision-8-digits>.json                     0600
    derived/                                                0700
      cloudflare-device-smoke.json                          0600, iOS only
```

The bundles root is canonical/private; every `.working` directory is its direct child on the same device. Each member temporary and final share one immediate parent and rename only within it. S3 rejects `.abandoned`, nesting, alternate platform prefixes and every other root entry.

The closed inventory is:

- exactly the three child directories above, with no other directory or file;
- zero to 512 contiguous observation finals, starting at `00000001.json`;
- zero to 512 contiguous checkpoint revisions from `revision-00000000.json`;
- stable checkpoint count equal to observations, or exactly one behind only as an interrupted publication;
- zero/one exact iOS derived final and none on Android;
- final files `1..131072` bytes, exact `0600`, regular/single-link/no special bits; directories exact `0700`, real and on the bundle device; and
- at most `MAXIMUM_CAPTURE_MEMBER_TEMPORARIES = 32` recognised temporaries across all children. Number 33, a second temp for one final or any unknown name rejects before mutation.

Every snapshot recomputes sorted relative names, type, exact mode/link count/size/SHA-256, bundle/root device and canonical-parent identity. Semantics bind members to SQLite capture, command chain and fresh signed-build authority. Links, unbounded/non-contiguous members, wrong hashes, conflicting finals and namespace replacement reject.

There is no mutable `current.json`: revision `N-1` is current for observation `N`, preserving checkpoint schema/canonical bytes without overwrite.

## One deep production module and closed results

The sole production interface is:

```js
const store = await openB3CaptureStore({ platform });
await store.startCapture({ command });
await store.readActiveCommand();
await store.allocateNextCommand({ command });
await store.transitionCommand({ source, nextState });
await store.consumeCommand({ source });
await store.readCapture();
await store.publishObservation({ source, observationBytes });
await store.publishGatewaySmokeProjection({ projection });
await store.close();
```

`startCapture()` reserves/reconciles one intent and retry reuses its ID/command. `readCapture()` returns frozen validated domain records, never paths/tokens. `publishObservation()` owns observation plus checkpoint. Smoke must equal the unique retained `pack-install` authority.

All results are closed plain records with no extra keys. `startCapture()` has:

```text
{ kind: 'started', capture }
{ kind: 'already-started', capture }
{ kind: 'start-conflict', capture }
```

`capture` is the winner's ready public projection with exactly `schemaVersion, startIntentSha256, intentKind, recoveredCommandSha256, terminalClaimSha256, captureId, firstCommandSha256, firstCommand, firstPreparedRecordSha256, intentState, rowVersion`. All return `intentState='ready'`; identical authority is `already-started`, otherwise `start-conflict` without allocating the losing UUID.

The facade preserves every S2 result union and key **exactly**, without wrapping:

```text
readActiveCommand:
  { kind: 'active', command }
  { kind: 'start-reserved', intent }
  { kind: 'none' }
allocateNextCommand:
  { kind: 'allocated', command }
  { kind: 'already-active', command }
  { kind: 'allocation-conflict', command }
  { kind: 'start-reserved', intent }
transitionCommand:
  { kind: 'transitioned', command }
  { kind: 'already-transitioned', command }
  { kind: 'ordinary-conflict', command }
  { kind: 'generic-consumed', commandSha256, sourceState, claimSha256 }
consumeCommand:
  { kind: 'consumed', commandSha256, sourceState, claimSha256 }
  { kind: 'already-consumed', commandSha256, sourceState, claimSha256 }
  { kind: 'ordinary-selected', command }
```

`readCapture()` returns exactly `{ schemaVersion: 1, platform, captureId, records, checkpoint, gatewaySmokeProjection }`. Before observation 1: `records=[]`, `checkpoint=null`; before the unique iOS smoke publication (and always on Android), `gatewaySmokeProjection=null`. At sequence `N`, checkpoint is mandatory with revision `N-1` and that observation's SHA. A present smoke projection is the same frozen closed projection returned by the smoke publisher and must equal the unique retained `pack-install` authority. The method heals a recognised one-behind state before return; larger gaps/ahead reject.

`publishObservation()` returns exactly one of:

```text
{ kind: 'published', record, checkpoint }
{ kind: 'already-published', record, checkpoint }
{ kind: 'healed', record, checkpoint }
```

`published` creates/adopts observation and stable checkpoint; `already-published` finds both exact; `healed` finds observation one ahead and publishes/adopts its checkpoint. Smoke returns exactly `{ kind: 'published', projection }` or `{ kind: 'already-published', projection }`.

Three failed pins throw `b3_capture_bundle_drift`; member/final/temp length, hash, slot or byte conflict throws `b3_capture_member_conflict`. Neither failing transaction mutates; S2 errors stay unchanged.

No production interface exposes root/database/SQL, callbacks, filesystem, clock, fault/phase selectors, temporary names or snapshots.

Private implementation modules behind that interface are:

- `b3-capture-state-database.mjs`: fixed path, SQLite lifecycle/validation;
- `b3-capture-state-repository.mjs`: transactions/domain outcomes;
- new `b3-capture-bundle-store.mjs`: sync layout, snapshot/reconciliation/publication; and
- new `b3-capture-store.mjs`: facade and async semantic-validation retry.

Internal exports only compose these modules/tests; live callers import only `b3-capture-store.mjs`.

## Transaction and semantic-validation rule

`node:sqlite` is `DatabaseSync`. Between `BEGIN IMMEDIATE` and commit/rollback,
use only bounded sync `node:fs`: `mkdirSync`, `lstatSync`, `realpathSync`,
`readdirSync`, `openSync`, `fstatSync`, `fchmodSync`, `readSync`, `writeSync`,
`fsyncSync`, `renameSync`, `unlinkSync`, `closeSync`. No await, Promise, callback,
sleep or caller code enters an open transaction.

Async observation hashing is resolved without weakening validation:

1. Outside a transaction, fresh-read signed-build authority and asynchronously
   validate an exact observation/bundle byte snapshot.
2. Enter `BEGIN IMMEDIATE`, fully validate SQLite first, then synchronously
   reread the whole closed bundle inventory and every retained byte.
3. Require names, metadata, sizes and SHA-256 to equal the semantically
   validated snapshot. Also rederive the active command/capture bindings.
4. On drift, perform no filesystem mutation, `ROLLBACK`, leave the transaction,
   and repeat full async semantic validation. After three drifts return a
   bounded conflict; never spin while holding the lock.
5. Once equal, publish/read back exact prepared bytes synchronously, rederive
   database plus bundle invariants and commit.

Semantic approval is pinned to exact retained bytes under the SQLite writer
lock. If that byte pin cannot hold, stop for amendment; never await in the
transaction or trust an unpinned pre-lock object.

`readActiveCommand()` alone may retain database-only `BEGIN`. Every other bundle
operation uses `BEGIN IMMEDIATE`; specifically, `allocateNextCommand()`,
`transitionCommand()` and `consumeCommand()` become composite without changing
their S2 unions. Before the S2 SQL decision each validates DB, runs the whole
proposal-independent classifier, applies only authorised cleanup/adoption,
heals exact one-behind checkpoint count to equal observations, revalidates the
DB+bundle, then executes/rederives the S2 outcome. Pre-mutation member conflict
does no filesystem action or SQL decision, so authority never advances past a
publisher temporary.

Missing/zero-byte DB requires absent/exact-empty bundles; existing valid DB may pass a structurally valid non-empty root only to the composite validator. No public handle returns first.

## Initial pending-intent reconciliation

Only the exact S2 pending `initial` intent, singleton reservation, empty
capture/command chain and null predecessor can create the first bundle. The
recognised filesystem states are: bundles root absent; exact empty root;
working directory absent; exact empty working directory; any subset of the
three exact empty child directories; and the exact empty layout. Wrong
type/mode/device, any member, temporary, link or unexpected entry rejects with
zero mutation.

After `BEGIN IMMEDIATE` and complete DB/namespace validation, create or validate
in this fixed order:

1. bundles root; sync the new root, then the evidence parent;
2. `<captureId>.working`; sync it, then the bundles root;
3. `observations`, `checkpoint`, then `derived`; after each mkdir sync the new
   child, then the working directory; and
4. sync the complete working directory and bundles root, then take an exact
   empty snapshot.

Create only missing entries; existing recognised entries are revalidated. Then
execute, with checked row counts: insert the matching `b3_captures` row; insert
allocation-sequence-1 `b3_commands`; advance the singleton sequence/pointer,
clear the reservation and increment its row version; mark the intent `ready`
and increment its row version. Revalidate the complete database and exact empty
bundle before `COMMIT`.

A death before SQL commit rolls SQLite back but may retain a recognised empty
subset; the same pending intent completes it. A death after commit reopens as
the same ready capture. A ready retry validates and returns the same authority
even if the first command is no longer active. Pending with any capture/command
row, ready without the exact bundle, wrong reservation, non-empty initial chain
or another capture ID rejects. `BEGIN IMMEDIATE` serialises duplicate
reconcilers, so they converge on one bundle and one first command.

## Crash-closed member publication

A temporary has this closed same-directory name:

```text
.<final-name>.<expected-length-decimal>.<expected-sha256>.<uuid-v4>.member.tmp
```

The immediate child directory binds the member kind and relative path. The
filename binds the exact final name, byte length and SHA. Length is canonical
base-10 `String(length)`, with no sign or leading zero, and is in `1..131072`.
Each child directory has its own closed regex for its permitted final names; a
generic suffix parser is insufficient. A publisher uses
`O_CREAT|O_EXCL|O_NOFOLLOW`, exact `0600`, checked short-write loops, file sync,
metadata/hash readback, final-absence recheck, rename, member-directory sync and
final readback. It never renames over an existing final and never links.

Before **every** bundle-observing facade operation, the bundle store performs a
proposal-independent two-pass classifier. Pass one validates the entire
namespace and derives all permitted actions without mutation. A temporary
target is authorised only by a durable SQLite/retained-domain slot:

- an observation name must be an already retained final slot or the exact
  active command's expected sequence and previous-tail SHA;
- a checkpoint revision must be exactly derivable from its retained
  observation; and
- the smoke target requires the unique retained `pack-install` gateway authority.

An authorised incomplete file is removable only when its actual size is below
the bound expected length. An exact-length file is adoptable only when its SHA,
canonical bytes and domain authority all match that slot. Wrong/oversized,
future, stale-without-retained-authority, unauthorised, second-bound or
unrecognised temporaries reject with `b3_capture_member_conflict` and **zero**
cleanup/adoption. Only after every entry passes does pass two apply authorised
cleanup/adoption in sorted relative-path order and sync each changed directory.
The current caller proposal is never used to excuse pre-existing debris.

Under the same writer transaction, the closed state table is:

| Final | One bound temporary | Result |
|---|---|---|
| absent | absent | create, write, sync, rename, sync directory, adopt |
| absent | recognised incomplete prefix | unlink, sync directory, then publish |
| absent | exact complete bytes | rename, sync directory, adopt |
| exact desired bytes | absent | return already-published |
| exact desired bytes | incomplete or exact desired temp | unlink temp, sync, adopt final |
| conflicting/invalid | any | reject without replacing final |
| any | conflicting, second bound, or unrecognised temp | reject |

An incomplete prefix is a regular private single-link file whose size is
strictly below the name-bound expected byte length. Exact-length bytes must pass
hash, canonical and domain validation in the pre-transaction snapshot and the
synchronous byte pin; oversized/wrong-hash bytes reject.
Cleanup rereads inode/mode/link/size before unlink and treats `ENOENT` only by
rerunning the whole classifier. SQLite rollback cannot roll back a filesystem
rename; that is intentional. A later transaction classifies the exact final as
already published or adopts the one exact complete temporary. No SQL member row
or capture row-version bump is added: the independently recomputed inventory
hash is member authority, avoiding a second cross-resource commit marker.

## Exact writer and reader migration

Migration is replace-in-place, not a compatibility layer:

- `b3-physical-observation-journal.mjs` keeps pure record/chain derivation and
  async semantic validation. Its production path reader/writer is replaced by
  facade `readCapture()`/`publishObservation()`; old
  `<platform>-observations` and cross-directory hard-link temporaries are never
  consulted by the new store.
- `b3-device-observation.mjs` keeps checkpoint schema/create/validate/resume
  authority. Path reads and mutable-current/revision writes are replaced by
  immutable bundle revisions.
- `b3-host-capture-state.mjs` becomes pure checkpoint derivation used inside
  `publishObservation`; it no longer opens journal/checkpoint paths.
- `b3-live-capture-adapters.mjs` owns one facade per live capture. Journal reads,
  append-plus-checkpoint, command decisions and gateway-smoke persistence go
  through it. It removes all imports/calls of `b3-abandoned-capture.mjs`,
  `b3-capture-recovery-store.mjs` and the legacy ambiguous-recovery helpers.
  Screenshots remain final report evidence outside the working bundle.
- `prove-b3-cloudflare.mjs` reads the retained smoke projection through the
  facade when no explicit projection is supplied; this is a local read and
  does not add a Cloudflare/R2 action.
- `b3-issued-command.mjs` pending files are not copied into `derived`; SQLite
  S2 command rows are authority. Legacy command/recovery/archive modules may
  remain on disk only because S8 owns deletion; no S3 production dependency or
  acceptance path imports or calls them.

There is no fallback, dual write, old-to-new automatic migration, copy, hard
link or cross-directory rename. Presence of legacy live state fails closed as
already required by S1.

### Clean S3 interim recovery contract

S3 keeps the existing closed finalisation status shape without pretending S4-S6
exist. `pinInvocation()` uses only facade `readActiveCommand()` and stores its
exact frozen result in a private single-use `WeakMap` token. It reads no bundle
path and confers no acknowledgement authority. `finaliseInvocation()` first
validates the fresh signed distribution, then rereads through the facade:

- stable `none`, or the identical active non-`restart-required` command, returns
  exactly `{ status: 'not-applicable' }`;
- an exact `restart-required`, `start-reserved`, unsupported recovery state, or
  any command kind/hash/record/state drift returns exactly
  `{ status: 'rejected' }`; and
- both outcomes perform zero acknowledgement consumption, recovery SQL,
  filesystem mutation, native action and legacy-path access.

`acknowledgeReinstall` is type-checked but cannot authorise or be consumed by
this interim token. The token is **not** the S6 composite DB+bundle pin and
cannot return `operator-required`, `recovered` or `already-recovered`. S4-S6
replace it rather than layering over it.

Normal iOS/Android wrapper tests for stable `not-applicable`, distribution-first
validation, closed status handling and command-drift rejection remain passing.
Live-adapter tests which formerly expected positive ambiguous recovery,
successor adoption, archive movement or acknowledgement consumption change to
expect exact `rejected`, unchanged DB/bundle SHA and no legacy module call.
Direct legacy files/tests may remain until S8, but they are historical deletion
evidence only: they are neither imported by the adapter nor an alternative S3
GREEN path. Source scans enforce one facade path and no dual run.

## TDD slices and fault matrix

Implement one RED -> GREEN slice at a time:

1. Freeze layout, per-kind temp grammar including canonical length, count 32/33,
   same-parent snapshot hashes, all closed result keys and both error codes.
2. Adjust bootstrap/existing bundle classification; orphan, legacy, wrong-root
   and non-empty bootstrap cases mutate nothing.
3. Reconcile initial intent from absent, empty and all eight child subsets;
   race same/different starters and assert the three exact start outcomes.
4. Kill after each mkdir/sync and ordered SQL `exec/prepare/run` boundary;
   unmocked reopen converges on the same capture/command. Materialised impossible
   committed partial rows must reject with no bundle mutation.
5. Run the proposal-independent classifier through every facade bundle method.
   Materialise every prefix of one minimal member and representative prefixes
   of every kind; prove only authorised targets clean/adopt and all future,
   unauthorised, wrong-length/hash/domain and second-temp states mutate nothing.
6. In real two-helper races, kill a publisher after temp create, each forced
   short write, exact-complete write, file sync, rename and directory sync.
   Competing transition/consume/allocation must first clean, adopt and heal, or
   return deterministic pre-mutation conflict; none may make debris stale.
7. Replace/append/remove retained bytes between async validation and sync pin;
   require rollback, three bounded retries and `b3_capture_bundle_drift`.
8. Publish observations 1..512; crash between observation/checkpoint, require
   `readCapture()` healing, exact `published | already-published | healed`, and
   reject gaps, checkpoint-ahead, wrong capture/build/hash and member 513.
9. Prove exact smoke outcomes and reject Android, duplicate authority, privacy
   material and projection/journal mismatch.
10. Prove interim stable `not-applicable`; convert all formerly-positive live
    recovery cases to exact zero-mutation `rejected`, including restart-required
    and every pinned command drift.
11. Migrate callers; scan for old paths, legacy recovery, links, mutable current,
    cross-directory moves, private imports, async transactional fs and any live
    use of bare repository mutators. Run S1/S2/S3, journal/checkpoint,
    live-adapter, Cloudflare-input, wrapper/contention, syntax, Oxlint and diff.

Filesystem faults mock fixed `node:fs` sync dependencies before dynamic import.
SQL faults import real `node:sqlite`, then mock a delegating `DatabaseSync`.
Transparent `Proxy`/`Reflect` preserves every non-target database/statement
method, property, return and throw. At the selected ordered before/after
`exec`, `prepare` or returned-statement `run` ordinal, the child `writeSync`s to
an inherited pipe and self-sends `SIGSTOP` immediately before delegation or
after return. The parent waits for that record, sends `SIGKILL`, then reopens in
an unmocked production child. Test-owned SQL fixtures
materialise otherwise impossible committed states: pending plus capture/command,
ready without capture/command, reservation retained with ready rows, and partial
singleton pointer/sequence. They must reject unchanged. Production gets no
hook, callback, sleep or adapter; real two-process contention remains separate.

## Commit and review gates

Do not implement until two independent reviewers approve the exact plan digest:

1. spec/concurrency: recognised states, semantic byte pin, transaction order,
   kill convergence and strict S3/S4 boundary; and
2. simplicity/standards: one deep interface, no dual-write/compatibility layer,
   SOLID/DRY/YAGNI and bounded tests.

During implementation, commit only complete GREEN checkpoints: (C1) layout and
composite validator; (C2) initial-start reconciliation; (C3) member publisher;
(C4) observation/checkpoint migration; (C5) smoke/caller migration; and (C6)
all S3 gates. Each checkpoint records its exact tests and keeps the tree clean;
push after C2, C4 and C6 to limit accident exposure. Never deploy or mutate a
device, store, Cloudflare or R2 resource.

S3 exits only when three fresh reviewers approve the same exact C6 HEAD:

1. spec, SQLite/filesystem crash and concurrency compliance;
2. module depth, code quality and test adequacy; and
3. path/link/privacy and no-network/no-secret compliance.

Any P1/P2 fix invalidates all three approvals. Only then may progress mark S3
complete and the next task plan S4; S3 itself makes no progress, deploy or Task
19 completion claim.
