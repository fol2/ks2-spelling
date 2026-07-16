# B3 Task 19 Capture Recovery Store Refactor Plan

**Status:** implementation-ready amendment after the exact-HEAD `227357c` review gate rejected the existing recovery seam.

**Authority:** this plan narrows and supersedes only the ambiguous-launch recovery implementation described by Task 19H in:

- `2026-07-12-standalone-spelling-mobile-b3-sandbox-billing-signed-download-proof.md`; and
- `2026-07-15-b3-task19-live-adapters-amendment.md`.

All other B3 scope, evidence, privacy, Cloudflare, signed-distribution and no-live-mutation boundaries remain unchanged.

## Why this refactor is required

The safety checkpoint through `227357c27b18b3ee2f98c92360a446821c994f30` proves the application, native and gateway paths, but the recovery implementation still spreads one logical transaction across issued-command successors, an abandoned archive, a journal snapshot and a generic consumption tombstone. Fresh exact-HEAD review reproduced a further P1: a `--resume-reinstall` acknowledgement pinned before distribution inspection could later be consumed by a restart gate which did not exist at invocation start because `records()` and `runScenario()` retained a second SHA-only recovery path.

This is the agreed stop condition for point fixes. The next implementation must replace that seam with one deep module and one recovery terminal claim. It must not add another externally visible race hook or another `clear + ENOENT` success path.

## Scope and non-scope

This amendment changes only host-side B3 proof recovery tooling. It must not:

- change spelling practice, learner progress, Monster progress or offline installed-pack behaviour;
- add a Cloudflare dependency to local learning;
- change the production purchase, download, activation or revocation coordinators;
- deploy a Worker, mutate R2, contact a store console, operate a physical device, sign an artefact, create live evidence or push the branch;
- widen the six-file live evidence topology; or
- claim resistance to a malicious process with the same Unix UID modifying files between arbitrary syscalls.

The clean `227357c` commit remains the rollback checkpoint until this refactor has passed the complete Task 19 gate.

## Threat model

### Required protection

The recovery store must fail closed or converge correctly for:

- process death after every emitted durable write, link, rename or parent-directory `fsync` primitive in the successful reference trace;
- two or more honest duplicate or delayed helpers running concurrently under the same account, within the frozen storage bounds below;
- stale reads, a replacement command and a command or observation gate appearing after the invocation pin;
- same-process and new-process retries;
- static hostile input including symlinks, hard links, wrong types or modes, repository escape, non-canonical bytes, invalid chains, excessive entries or bytes, conflicting partial archives and conflicting terminal claims; the sole exception is an installing temporary whose bytes are an exact canonical prefix, which is indistinguishable from bounded crash debris and is ignored rather than trusted;
- replacement during one bounded validation or move where stable descriptor/inode/stat/hash checks can detect it;
- strict separation of planned `REBIND_FRESH_INSTALL` from ambiguous-launch capture recovery; and
- prevention of any repeated uncertain native launch or termination side effect.

### Explicit non-goals

The store does not claim protection from:

- an actively malicious process with the same Unix UID rewriting files between arbitrary syscalls indefinitely;
- same-UID fabrication of an entirely new self-consistent archive, authority and terminal claim;
- root, kernel or filesystem compromise, dishonest `fsync` semantics or denial of service.

SHA-256 proves consistency, not authorship. Protecting against the explicit non-goals would require a signing authority unavailable to the local account, OS-protected storage or a separate privileged identity. Documentation and reviews must use this boundary.

## One public recovery abstraction

Create `scripts/lib/b3-capture-recovery-store.mjs`. It is one facade with three closed methods; callers never orchestrate issued-command, archive or tombstone operations themselves:

```js
const store = createB3CaptureRecoveryStore({
  root,
  platform,
  buildAuthority,
});

const invocation = await store.pinInvocation({
  acknowledgeReinstall: resumeReinstall,
});
const distribution = await inspectDistributionFresh();
const result = await store.finaliseInvocation({ invocation, distribution });

// Used only by the planned restore scenario when finaliseInvocation()
// returned not-applicable and left the same capability available.
const authorised = await store.authorisePlannedRebind({
  invocation,
  actionCode,
  observationSha256,
});
```

The call order is fixed and wrapper-contract tested:

```text
local mutation-authority gate
  -> closed local Cloudflare/deployment authority validation
  -> pinInvocation()
  -> successful read-only signed-distribution/device authority inspection
  -> distribution versus build/deployment authority equality
  -> finaliseInvocation()
  -> other device/store work
```

The existing local Cloudflare/deployment draft checks and the equality comparison are read-only and remain before recovery mutation. A mismatch or failed distribution inspection must leave the acknowledgement and every recovery file untouched. Neither step may reread or reinterpret the pinned command/journal authority; only `finaliseInvocation()` performs the closing authority read.

`pinInvocation()` performs no recovery mutation. It pins the invocation-start command and observation-tail authorities into an opaque object registered in a private `WeakMap` owned by that store instance. A caller cannot construct, copy or alter valid pin authority. `finaliseInvocation()` validates the exact closed `mapDistribution()` projection: `kind` must imply the store platform, `embeddedCommit` and `embeddedFingerprint` must equal the store build authority, and every existing platform-specific signed/installed authority field must pass the current distribution schema. It then performs the closing command/journal reads after successful distribution inspection, rejects any drift, and owns the ambiguous recovery decision, abandoned-generation reconciliation and terminal publication. It must not accept a caller-reduced `{ platform, commit, fingerprint }` substitute.

The invocation owns one opaque, single-use reinstall acknowledgement capability. The helper which wins create-only `recovery-owner` publication consumes the acknowledgement; every exact recovery-applicable result permanently closes the planned-REBIND branch even when another helper already published the owner. Only a `not-applicable` finalisation may leave the capability available for `authorisePlannedRebind()`, and that method may consume it only for the exact invocation-start planned tail. The capability can never be consumed by both branches, by a repeated call or by a future tail.

`authorisePlannedRebind()` is a synchronous, filesystem-free check over the already validated opaque pin, so the existing synchronous `driveB3HostScenario()` resume callback need not change. It performs no late journal read. The default adapter exposes bound `pinInvocation` and `finaliseInvocation` primitives to the iOS/Android wrappers, retains the same invocation internally for `runScenario()` planned authorisation, and does not expose the store/core object or any lower-level recovery method.

The closed observable statuses are:

- `not-applicable`: the pinned generation has no ambiguous recovery debt;
- `operator-required`: an exact invocation-start restart gate exists but the acknowledgement is absent; the wrapper emits the existing visible exit-7 reinstall instruction;
- `recovered`: this invocation published or completed the exact recovery terminal;
- `already-recovered`: an exact validated recovery terminal already exists; and
- `rejected`: authority, invocation or concurrent state drift; the wrapper uses the existing fail-closed exit-6 path.

No boolean recovery result is permitted. The result may carry only a validated, internal invocation-tail projection required by the scenario driver; it must not expose filesystem paths, raw observations, acknowledgement state or test hooks.

## Invocation pin contract

`pinInvocation()` first reads the command ledger's active command, recovery owner and recovery terminal, then chooses one non-creating journal source before distribution inspection. `finaliseInvocation()` repeats the same selection after successful distribution inspection and rejects any difference in command hash, record hash, state, capture, sequence, previous observation hash, journal snapshot or tail. A recovery owner or terminal which is the exact durable continuation of the pinned restart gate is the only permitted state advance.

Ledger selection is exact: when an active command exists, only owner/terminal authority under that command hash participates; when no command is active, only an exact terminal for the global allocation-chain tail may yield `already-recovered`. A terminal for an older allocation never shadows a later active command. An old in-memory helper uses its opaque pinned command hash to validate only that prior terminal and may return `already-recovered` without touching the newer allocation. Every owner/terminal ledger entry must be reachable through this command-allocation chain; orphan or unexpected claims reject. Terminal-derived consumption also prevents `persistB3IssuedCommand()` from reusing the same command hash even though no generic `.consumed.json` exists.

Journal source selection is closed:

- without a recovery owner, read only the live journal with `create: false`;
- with an owner but no terminal, use the owner-bound abandoned generation once its `observations/` directory exists; before that directory exists, use the non-creating live journal;
- live and abandoned generations may not both contain records for the same owner; any conflicting or non-empty dual source rejects;
- absence and an exact empty journal are valid only for sequence 1 with the zero previous hash; both normalise to one canonical logical empty-journal snapshot, so an exact owner continuation may atomically publish the empty abandoned directory between pin and finalise without causing drift;
- an exact terminal requires a complete final archive first; a later live generation is then read independently and is never compared with the abandoned tail; and
- no pin/finalise read may create an empty live directory.

The journal API therefore needs an explicit strict non-creating snapshot read. The generated crash matrix must include a new invocation after `journal-move-durable`, where the live directory is absent and the owner-bound abandoned journal is the only pin source.

The pinned cases are closed:

| Invocation-start authority | Later authority | Required result |
| --- | --- | --- |
| no active command | remains absent | `not-applicable`, zero writes |
| no active command | any command appears after the pin | `rejected`; future command untouched |
| exact `launching` | remains `launching` | `not-applicable`; no ambiguous reset |
| exact `launching` | becomes `restart-required` later | `rejected`; fresh invocation and flag required |
| exact `restart-required`, no flag | `operator-required`, zero recovery mutation |
| exact `restart-required`, flag | `recovered` |
| exact `restart-executing` after durable ownership | resume without a second flag |
| exact partial abandoned generation | resume without a second flag |
| exact recovery terminal | `already-recovered` |
| command A replaced by command B | `rejected`; B remains untouched |

The planned scenario path remains disjoint:

- only an exact invocation-start observation tail whose next action is `REBIND_FRESH_INSTALL` may consume the flag in the planned restore driver;
- a tail appearing after the pin cannot consume the flag;
- ambiguous recovery never manufactures or converts an action into `REBIND_FRESH_INSTALL`; and
- a command already pinned as `restart-required` uses the recovery store even if its original action was `REBIND_FRESH_INSTALL`.

Delete the secondary SHA-only recovery in `runScenario()`. `records()` must never late-pin a command or observation tail. Add explicit tests for recovery-then-planned-tail, planned-tail-then-future-gate and repeated authorisation calls; exactly one branch may consume the capability.

## Recovery terminal claim

Recovery uses one create-only canonical terminal file in the issued-command ledger:

```text
<commandSha256>.recovery-terminal.json
```

The closed schema is:

```json
{
  "schemaVersion": 1,
  "kind": "recovery-terminal",
  "platform": "ios",
  "commandSha256": "<64 lowercase hex>",
  "ownerClaimSha256": "<64 lowercase hex>",
  "terminalRecord": {
    "schemaVersion": 3,
    "platform": "ios",
    "state": "restart-complete",
    "command": { "<field>": "the exact validateB3ProofLaunchCommand object" },
    "commandSha256": "<64 lowercase hex>",
    "recordSha256": "<64 lowercase hex>"
  },
  "archiveAuthoritySha256": "<64 lowercase hex>",
  "terminalClaimSha256": "<64 lowercase hex>"
}
```

`terminalClaimSha256` is the domain-separated SHA-256 of the other canonical fields. Validation proves that:

- `ownerClaimSha256` resolves to the exact invocation-owned recovery owner and its embedded `restart-executing` record;
- the embedded terminal record is the deterministic exact `restart-complete` successor of that owner record;
- the archive authority exists, is complete and has the exact bound hash; and
- the terminal claim is create-only: identical bytes converge, any conflict rejects.

This claim is simultaneously the `restart-executing -> restart-complete` successor and the recovery consumption tombstone. No separate restart-complete state file or successor claim is written. Recovery commands must never be consumed by the generic tombstone. `clearB3IssuedCommand()` must reject every recovery-owned command; generic tombstones remain only for non-recovery commands. Active/consumed recovery state is derived from the owner/terminal claims, and no `ENOENT` is a success signal.

No compatibility migration is required for ignored, uncommitted schema-v1/v2 local recovery artefacts. Such local state fails closed and requires a new capture. This is honest because Task 22 live evidence has not been created.

## Complete abandoned-generation authority

Publish one create-only recovery-owner variant in the issued-command ledger before moving evidence. It occupies the existing single-winner predecessor decision path:

```text
<commandSha256>.successor-restart-required.json
```

```json
{
  "schemaVersion": 1,
  "kind": "recovery-owner",
  "platform": "ios",
  "commandSha256": "<64 lowercase hex>",
  "predecessorRecordSha256": "<restart-required record SHA-256>",
  "executingRecord": {
    "schemaVersion": 3,
    "platform": "ios",
    "state": "restart-executing",
    "command": { "<field>": "the exact validateB3ProofLaunchCommand object" },
    "commandSha256": "<64 lowercase hex>",
    "recordSha256": "<64 lowercase hex>"
  },
  "captureId": "<UUID v4>",
  "testedApplicationCommit": "<40 lowercase hex>",
  "applicationFingerprint": "<64 lowercase hex>",
  "archiveGeneration": "<commandSha256>",
  "ownerClaimSha256": "<64 lowercase hex>"
}
```

`ownerClaimSha256` is the domain-separated canonical hash of every other field. The claim is both the durable acknowledgement and the `restart-required -> restart-executing` successor; no separate executing state file or successor claim is written. The issued-command validator dispatches the existing `successor-restart-required` slot by its closed schema: either the existing ordinary successor claim (including `restart-required -> launched`) or this recovery-owner variant may win, never both. A late valid observation and a recovery helper therefore compete through the same create-only path. Identical recovery-owner bytes converge; an ordinary successor or conflicting owner rejects recovery without archiving. A pre-write reread is not accepted as a substitute for this single-winner slot. Only a crash before this claim is durable may require a second acknowledgement.

The owner-bound generation path is deterministic:

```text
.native-build/b3/evidence/<platform>-abandoned-captures/<commandSha256>
```

Upgrade the abandoned archive authority to schema version 3 so it binds a separate complete canonical `manifest.json`, not only the observation-journal snapshot. The final generation has exactly five root entries: `authority.json`, `manifest.json`, `observations/`, `checkpoint/` and `derived/`.

The manifest schema is:

```json
{
  "schemaVersion": 1,
  "kind": "abandoned-capture-manifest",
  "platform": "ios",
  "commandSha256": "<64 lowercase hex>",
  "directories": [
    { "path": "checkpoint", "mode": 448 },
    { "path": "derived", "mode": 448 },
    { "path": "observations", "mode": 448 }
  ],
  "files": [
    {
      "path": "observations/00000001.json",
      "mode": 384,
      "byteLength": 1234,
      "sha256": "<64 lowercase hex>"
    }
  ],
  "manifestSha256": "<64 lowercase hex>"
}
```

Paths use `/`, are unique, sorted by UTF-8 byte order and match the existing closed per-directory name allow-lists. Modes are exact decimal `0700`/`0600`; byte lengths are positive safe integers within existing per-file and aggregate bounds. `manifestSha256` is the domain-separated canonical hash of every other field. The `files` list covers every approved relative path under:

- `observations/`;
- `checkpoint/`; and
- `derived/`.

The archive authority schema is:

```json
{
  "schemaVersion": 3,
  "kind": "abandoned-capture-authority",
  "platform": "ios",
  "captureId": "<UUID v4>",
  "commandSha256": "<64 lowercase hex>",
  "expectedSequence": 7,
  "previousObservationSha256": "<64 lowercase hex>",
  "testedApplicationCommit": "<40 lowercase hex>",
  "applicationFingerprint": "<64 lowercase hex>",
  "manifestSha256": "<64 lowercase hex>",
  "authoritySha256": "<64 lowercase hex>"
}
```

`expectedSequence` is any positive safe integer copied exactly from the pinned command; `7` only demonstrates that later-sequence abandoned captures are valid. Tests cover both an empty sequence-1 archive and a populated later-sequence archive. `authoritySha256` is the domain-separated canonical hash of every other field. Unexpected, missing, linked, oversized, non-canonical or manifest-mismatched entries reject.

Use the deterministic per-command final generation and owner claim above. Do not use a staging-to-final rename. After the owner is durable, helpers monotonically create the generation root plus `checkpoint/` and `derived/`; `observations/` must remain absent until the complete live journal directory is atomically renamed to that exact path and both parents are synced. For the sole valid absent-journal case—sequence 1 with the zero previous hash—publish and sync an exact empty `observations/` directory instead. Never split one journal across live and abandoned directories. Helpers then move-or-validate each allow-listed checkpoint and derived member in place. A crashed helper leaves a recognisable owner-bound partial generation which another helper can reconcile. Identical helper work converges; conflicting bytes reject. After every payload member is durable, publish identical create-only `manifest.json` and `authority.json`. Only the recovery terminal claim publishes the generation as complete.

The reconciliation table is closed:

| Owner | Final generation | Terminal | Result |
| --- | --- | --- | --- |
| absent | absent | absent | flag required before publishing owner |
| present | absent | absent | create exact generation directories and resume |
| present | valid partial | absent | resume remaining create-only moves |
| present | complete manifest/authority | absent | validate final, then publish terminal |
| present | complete manifest/authority | exact | `already-recovered` |
| absent | any present | any | `rejected` |
| present | any invalid/conflicting state | any | `rejected` |
| present | absent or partial | terminal present | `rejected` |

After an exact terminal exists, a later active command does not invalidate the old terminal; an old helper validates the prior generation by command hash and may return `already-recovered`, but it may never alter the later command.

All create-only JSON publication uses one closed, bounded installing namespace outside both the issued-command ledger and the five-entry archive generation:

```text
.native-build/b3/evidence/<platform>-capture-recovery-installing/
  <commandSha256>.<owner|manifest|authority|terminal>.<UUID-v4>.tmp
```

The B3 live-capture host is macOS because the same gate requires Xcode and the iOS physical-device toolchain. The production path first validates Darwin, exact absolute, root-owned, non-symlink regular executable `/usr/bin/lockf`, and an absolute, non-symlink regular `process.execPath` owned by the current effective UID or root; these checks happen before creating recovery storage. It then bootstraps the installing directory with create-or-validate `mkdir(0700)` plus parent sync. Two first helpers may race only this idempotent bootstrap: `EEXIST` must resolve to the same strict real directory, and both sync the evidence parent before lock acquisition. The post-bootstrap namespace snapshot is the baseline for every timeout/no-mutation assertion: compare the complete installing-directory name/type/mode/inode/link-count/size/hash inventory plus the complete command ledger, abandoned-generation and live-journal trees. Before READY, no UUID temporary, ledger, archive, journal or terminal mutation is permitted. A non-Darwin production call fails before even this bootstrap mutation.

Before inspecting or mutating the post-bootstrap namespace, the production core acquires a real BSD kernel advisory lock on that already validated `0700` directory through `/usr/bin/lockf`. The exact process topology is public-helper Node process -> detached `lockf` child process group -> fixed Node holder grandchild. The exact argv is `-k -n -s -t 30 <installing-directory> <process.execPath> -e <fixed-holder-source>` and the child environment is exactly empty. The fixed holder emits exactly `B3_RECOVERY_LOCK_READY\n` after `lockf` has acquired the directory inode, then waits on inherited stdin without reading files or spawning another process. The parent accepts no preceding, trailing or second stdout byte, caps stderr at 4,096 bytes and enforces a 31-second READY watchdog in addition to `lockf`'s 30-second acquisition deadline.

The supervisor owns the detached process group from spawn until reap and wraps pre-READY validation plus the complete storage critical section in one `try/finally`. On every normal result or error—including acquisition timeout, malformed/extra stdout, stderr overflow, early child exit and any reconciliation/publication exception—it closes holder stdin, waits at most 250 ms, sends `SIGTERM` to the process group, waits at most another 250 ms, then sends `SIGKILL` if required and reaps the direct child before returning or throwing. A four-second final reap watchdog is an internal invariant failure, never a recovery success. Tests inject every supervisor failure path and require immediate second acquisition plus no surviving holder/lockf process. Killing the public-helper process is the parent-death test: its pipe closes, the holder exits, `lockf` reaps it and the kernel releases the directory lock; only a waiting helper's acquisition proves that release because the dead helper cannot emit another trace. The implementation never uses a pathname lease, PID/mtime stale test, deterministic writer pathname, lock-file deletion or npm/native locking dependency. This macOS host-tool restriction does not affect the offline application runtime.

Hold this one platform-global lock across namespace validation, reconciliation, one UUID writer's complete write/sync, create-only target publication, strict readback and target-scoped cleanup. Serialisation deliberately replaces the earlier paused-live-writer cleanup claim: a second honest helper waits for the first helper to complete or die, and never removes a pathname belonging to a live writer. A crash releases the kernel lock and leaves only the crashed helper's stable UUID-v4 prefix as debris. The next helper acquires the same directory-inode lock and resumes without a second acknowledgement while the debris state remains in bound. This removes the deterministic-reservation pathname ABA which cannot be closed with portable `fs/promises` compare-then-unlink operations.

Each helper owns one unique sealed temporary. The installing directory is private exact `0700`; a temporary is a regular private exact `0600`, single-link file on the same filesystem as every target. Freeze `MAXIMUM_RECOVERY_DEBRIS_PER_TARGET = 32`, `MAXIMUM_RECOVERY_GLOBAL_DEBRIS = 128`, one platform-global reserved active writer and `MAXIMUM_RECOVERY_INSTALLING_ENTRIES = 129` across every command and the four closed target kinds. The global limit counts directory entry names. Before target publication, every approved name must identify a distinct single-link inode. After publication, at most the current writer name may have link count two, and its second link must be the exact validated target outside the installing directory; two installing names may never share an inode. Therefore a successful in-flight state has at most 128 crashed names plus one active name. A target-kind group with 33 single-link names is the first per-target out-of-bound state; 129 global single-link names is the first global out-of-bound state; 130 names is invalid even for inspection.

Under the kernel lock, allocation follows one closed order. First validate an existing target; when it is exact, sync its parent if required and clean only its exact command/kind names even at the 129-name inspection ceiling. Otherwise validate all names/inodes and choose the UTF-8-bytewise earliest fully written exact same-target temporary for adoption before allocating anything. If no adoptable file exists and both global debris is below 128 and target debris is below 32, allocate an ordinary UUID writer. If either bound is exactly saturated while neither is exceeded, allocate the sole platform-global reserved writer as entry 129 or target entry 33; the same one writer covers simultaneous global and target saturation. It must publish and clean or, if it dies, leave the exact first out-of-bound debris state. Static global 129-debris, target 33-debris, any larger count or any second active/link candidate rejects without mutation. A waiting duplicate cannot allocate while the lock holder owns the sole reserved slot.

RED tables cover global debris 127/128/129 plus 130 total names, per-target debris 31/32/33, both bounds saturated together, global-only saturation with target below 32, target-only saturation with global below 128, adoption at each saturated bound, one exact target-linked writer, duplicate installing-name inodes and a hostile external extra link. Thus every state at or below both frozen debris bounds converges when faults stop, while each first additional crashed writer is classified honestly rather than hidden by a larger bound.

Publication is: create the UUID temporary with `O_EXCL|O_NOFOLLOW`, write the exact canonical bytes in a checked partial-write loop, sync and close it, sync the installing parent, create-only hard-link it to the common target, sync the target parent, validate an exact strict readback, then remove only recognised temporaries whose filename carries the same exact command hash and target kind after descriptor/inode/type/mode/link-count checks, and sync the installing parent again. A stable fully written temporary whose exact bytes equal the expected target may be adopted while holding the global lock. An incomplete regular single-link temporary is permitted only when its stable bytes are an exact prefix, including the empty prefix, of that filename kind's exact canonical target; it is untrusted crash debris and never authority. Any non-prefix bytes, wrong types/modes, extra links, unexpected names, excessive global entries or excessive target-scoped debris reject before target or terminal publication. The helper may inspect and count other command/kind entries for namespace policy but must never adopt, unlink or otherwise alter them.

The installing namespace is not evidence. Every successful or already-recovered result reconciles all four exact targets for that recovery command and leaves no UUID temporary bearing that command hash; it does not require or cause removal of a later command's temporary. Tests barrier one helper after a partial write and prove that a duplicate cannot enter the serialised storage section; killing the first helper releases the kernel lock and lets the duplicate or a fresh helper resume. Same-command/different-kind and old-command/new-command helpers serialise without cross-target removal. Tests also cover process death at every partial-write offset, after write completion, after temporary sync, after link, after target-parent sync, after unlink and after installing-parent sync. Cleanup is authority-bearing work and is traced; it is never an unrecorded best-effort `rm`.

The logical durable stages remain an exported frozen internal inventory:

```text
recovery-owner-published
archive-generation-directory-durable
journal-move-durable
checkpoint-item-move-durable
derived-item-move-durable
archive-manifest-durable
archive-authority-durable
terminal-claim-durable
```

Loop stages are parameterised over every checkpoint and derived member. This logical list is not by itself the exhaustive crash claim. The core storage adapter must emit a closed durability trace entry for every durable primitive with `{ operation, item, primitive }`; `operation` is exactly `install-recovery-claim`, `item` is `recovery-installing | recovery-owner | archive-manifest | archive-authority | recovery-terminal`, and `temporary-write-progress` additionally carries the positive safe-integer byte `offset`. Bootstrap may emit only `directory-created` and `directory-synced` for item `recovery-installing`. After the exact READY bytes are accepted while the direct child remains live, emit `{ operation: 'install-recovery-claim', item: <target-kind>, primitive: 'kernel-lock-acquired' }`; no coordination event is emitted for a pre-READY failure. After closing stdin and reaping a zero-exit holder, emit the corresponding `kernel-lock-released`, then return or rethrow the storage result. A forced-but-confirmed process-group reap may emit released but must still throw its supervisor error. Parent-death traces end without released; the waiting helper's later acquired event is the release proof. READY timeout/overflow/non-zero exit has zero post-bootstrap durable trace and leaves the complete post-bootstrap path snapshot unchanged. Durable `primitive` is one of:

```text
temporary-created
temporary-write-progress
temporary-write-complete
temporary-synced
create-only-link-published
temporary-unlinked
temporary-parent-synced
source-renamed
source-parent-synced
destination-parent-synced
directory-created
directory-synced
```

`temporary-created` fires after exclusive open and before the first byte; every checked `write()` result advances the offset and emits `temporary-write-progress`; `temporary-write-complete` fires only when the offset equals the canonical byte length; sync happens afterwards. The injected core storage seam can materialise a crash at every prefix offset of each exact owner/manifest/authority/terminal byte vector, independent of the host filesystem's normal write chunking. The prefix table proves that every incomplete offset is non-authoritative and that the next no-fault helper can publish the exact target and clean the debris.

Crash enumeration computes the bounded reachability closure rather than trusting one clean trace. Each test node is a deterministic sequence of prior crash selectors `{ operation, item, primitive, occurrence }`. The internal core test seam supplies a deterministic helper-ID/UUID sequence and lock coordinator; production always uses cryptographically random UUID-v4 values and the real Darwin coordinator, while the public facade offers neither injection. Selectors normalise the helper-ID component instead of retaining a concrete random pathname. The platform-neutral harness replays each sequence from a fresh fixture, constructs a fresh internal store/core harness after every simulated process death, records the next attempt's complete primitive trace, and enqueues a child sequence ending at every trace selector while the resulting state remains within the frozen debris/storage bounds. The separate Darwin process matrix reconstructs the real public facade after actual helper death. Both de-duplicate by a canonical recovery-state fingerprint which normalises valid temporary UUIDs and represents inode/link equivalence classes rather than machine-specific device/inode numbers. Enumeration stops only when no unseen in-bound state remains; every node must converge without another acknowledgement when faults are removed. The exact first out-of-bound debris transition is separately proved to reject as the declared denial-of-service boundary. This includes in-bound primitives reached only while adopting or cleaning a temporary, reconciling a partial generation or losing a create-only collision.

The test also asserts that every logical stage emitted its required primitive set and that no production storage write/link/rename/unlink/fsync path bypasses the injected traced storage adapter. Separate barrier tests replace or race a source during stable validation and during each move. The duplicate-helper schedule suite independently covers `recovery-owner`, `archive-manifest`, `archive-authority` and `recovery-terminal`. For every kind it captures lock-holder and waiting-helper traces, injects public-helper child exit after every role-specific durable primitive, proves pipe EOF/kernel release, waiting-helper exclusion, same-kind target-scoped cleanup and same/different-kind serialisation, and requires the waiting helper or a fresh helper to converge. It separately proves timeout failure is post-bootstrap mutation-free while a live holder deliberately remains paused. Adding a future durable primitive automatically expands the reachable-state and contention crash tables.

## Module and file boundaries

Create:

- `scripts/lib/b3-capture-recovery-store.mjs` — the only production facade;
- `scripts/lib/b3-capture-recovery-store-core.mjs` — internal storage/algorithm seam with injected fault/barrier storage for tests;
- `tests/b3-capture-recovery-store.test.mjs` — terminal, invocation, crash, concurrency and hostile-input contract;
- `tests/helpers/b3-capture-recovery-race-child.mjs` — public-facade child-process contention helper where required.

Modify:

- `scripts/lib/b3-issued-command.mjs` — closed recovery-owner variant in the existing `successor-restart-required` decision slot, recovery terminal validation/derivation, generic clear prohibition, removal of recovery-successor public helpers, and removal of `restart-required -> restart-executing` plus `restart-executing -> restart-complete` from the generic transition table/API after migration;
- `scripts/lib/b3-abandoned-capture.mjs` — move archive validation/reconciliation behind the core storage seam; stop exporting `readB3AbandonedCaptureArchive()` and `archiveB3AbandonedCapture()` and migrate every direct caller/test;
- `scripts/lib/b3-physical-observation-journal.mjs` — strict snapshot/tail input for live or archived generations;
- `scripts/lib/b3-live-capture-adapters.mjs` — use one opaque `pinInvocation()` followed by one `finaliseInvocation()`; remove exported recovery race hooks, SHA-only secondary recovery and late pinning;
- `scripts/prove-b3-ios.mjs` and `scripts/prove-b3-android.mjs` — pin after mutation authority, inspect signed distribution, then finalise before any other device/store work;
- `tests/b3-live-capture-resume.test.mjs` — retain host-capture behaviour tests but remove assertions against internal filesystem ordering;
- `tests/b3-ios-wrapper-contract.test.mjs` and `tests/b3-android-wrapper-contract.test.mjs` — exact pin/inspect/finalise ordering and late-gate refusal;
- fingerprint/package transition authority inputs if the new tracked files are not already covered automatically;
- both Task 19 plan documents and `.superpowers/sdd/progress.md` only after the implementation gate is satisfied.

Confirm that `resumeB3AmbiguousIssuedCommandAfterReinstall()` has no production caller, then delete it rather than retain a second recovery seam.

Production code must not accept `afterArchive`, `afterSuccessorCurrentRead`, `beforeClear`, `beforeClearCommandRead` or equivalent hooks. Fault and barrier injection exists only in the core test seam; runtime callers cannot select it. The public facade is the only production import of the core. Direct application imports of issued-command recovery helpers or abandoned-capture helpers fail a source-contract test. A RED source/behaviour contract also proves the generic `transitionB3IssuedCommand()` rejects both old recovery transition pairs and can never create `state-restart-executing`, `state-restart-complete` or `successor-restart-executing`; only the store may validate embedded records and publish owner/terminal authority.

## TDD execution slices

### Slice R1 — Facade and wrapper ordering

Write RED wrapper tests for one `pinInvocation()` call after the local mutation/deployment authority checks, signed-distribution inspection and its existing build/deployment equality next, then one `finaliseInvocation()` call before any other device/store operation. Cover invocation-start absence followed by a command or planned tail during preflight; both reject without consuming the flag. Distribution or deployment mismatch leaves zero recovery writes.

Implement the facade and migrate wrapper order without yet deleting old internals. GREEN requires no recovery mutation before successful distribution inspection and zero post-preflight device/store calls on rejection.

### Slice R2 — Terminal claim and command-chain authority

Write RED tests for the closed owner and terminal schemas, domain hashes, owner/terminal/archive triple binding, create-only equality/conflict, terminal-without-archive, archive-without-terminal and generic clear rejection. Race an ordinary `restart-required -> launched` successor against recovery ownership and prove exactly one can occupy `successor-restart-required`. Prove that owner embeds the sole executing record and terminal embeds the sole restart-complete record, leaving no unenumerated recovery state/successor write. At the installing seam, prove exact private modes, allocation-chain reachability, target-scoped cleanup and the macOS `lockf` contract: exact binary/argv/environment, bounded READY/stderr/timeout, one platform storage holder, normal release, every abnormal supervisor release and pipe-EOF release after public-helper death. An internal core-only injected lock coordinator supplies deterministic R2/R5 unit tests on any host; production exports and the public facade cannot select it. A separate Darwin integration test exercises the real `/usr/bin/lockf`, while non-Darwin production-path tests require fail-closed zero mutation.

Implement terminal-claim persistence and derive recovery consumption from it. GREEN removes every generic `clear + ENOENT` success path.

### Slice R3 — Complete archive manifest and monotonic generation

Write RED table tests for the exact manifest/authority/owner schemas, deterministic paths, exact manifest coverage, hostile links/types/modes/names/count/size, wrong capture/build/tail, incomplete/conflicting owner-bound generations, every reconciliation-table row and checkpoint/current-revision drift.

Implement the deterministic owner-bound generation, complete manifest authority and monotonic create-or-validate member publication. Every rejection leaves the recovery command recoverable and publishes no terminal claim.

### Slice R4 — Invocation pin and planned-REBIND separation

Write RED tests for command/journal appear, disappear, replace and append between the two pin reads and after preflight. Cover all rows in the invocation table, including the sole canonical absent-live to exact-empty-abandoned sequence-1 equivalence, and the five planned-REBIND cases.

Implement preflight-spanning pin/finalise reads and remove `records()`/`runScenario()` late recovery. Add the one opaque single-use capability shared by finalisation and planned REBIND. GREEN proves a future gate cannot consume an old flag and neither branch can consume the capability twice.

### Slice R5 — Exhaustive crash matrix

Run the bounded reachability crash explorer independently through owner, manifest, authority and terminal UUID publication over the clean path and every in-bound resume-only reconciliation path, plus the explicit first per-target and global denial-of-service boundary cases. The platform-neutral explorer constructs a fresh internal core/store over its injected deterministic lock coordinator after each simulated death; a Darwin public-facade integration matrix repeats every real process-death/lock-release boundary without exposing that injection. Resume without a second acknowledgement. Assert that every logical stage emitted its required primitive set and that every production write/link/rename/unlink/fsync path emitted a trace entry. Require exactly one complete archive, one terminal claim, no installing temporary for the recovered command, no native side effect, no abandoned observation in final evidence and a fresh sequence-1 capture only after terminal publication.

Only a crash before `recovery-owner-published` may require the flag again.

### Slice R6 — Duplicate helpers and public idempotence

Run barriered child-process cases independently for owner, manifest, authority and terminal publication. For every kind prove exact lock acquisition order, no second storage-section entry while the holder is live, same-kind cleanup, different-kind serialisation, kernel release after normal completion and public-helper process death, and convergence of both helpers to `recovered` or `already-recovered`. A stale recovery for command A must never alter active command B. A same-helper retry and a new-helper retry preserve exact inode/hash authority and require no new flag.

### Slice R7 — Remove old seams and simplify tests

Delete the exported multi-step recovery function, public race hooks, recovery-successor public helpers, both abandoned-capture public exports, generic recovery tombstone path and secondary run-scenario recovery. Move storage-specific hostile cases into the store suite. Keep integration tests only for the observable statuses, wrapper ordering, scenario parity and no repeated native action.

### Slice R8 — Complete verification and exact-HEAD review

Run the original Task 19 focused 19-file suite plus the new store suite, then:

```bash
npm test
npm run lint
npm run build
npm run native:sync:check
npm run verify:b2-authority
npm run prove:b3:deterministic
npm audit --audit-level=high
npm --prefix gateway test
npm --prefix gateway run lint
npm --prefix gateway run deploy:dry-run
npm --prefix gateway audit --audit-level=high
node scripts/test-ios-pack-inspector.mjs
git diff --check
```

Run the exact Task 19 iOS and Android native build commands from the original plan. Commit only after all gates pass. Then obtain five fresh independent reviews of the same exact HEAD:

1. spec and trace compliance;
2. recovery/concurrency and threat-model compliance;
3. native transport, signed distribution and privacy;
4. Cloudflare exact-byte/R2/credential containment; and
5. code quality, deep-module boundary and test adequacy.

Any P1/P2 requires a new RED test, a new commit and all five reviews restarted.

## Completion gate

This refactor is complete only when:

- one production facade owns invocation pin/finalisation, command recovery, archive reconciliation and recovery terminal publication;
- the invocation command and observation tail are pinned before distribution preflight and revalidated after it;
- one opaque single-use acknowledgement capability is shared by ambiguous recovery and planned REBIND;
- one terminal claim binds the exact predecessor, terminal record and complete archive authority;
- no successful generic recovery tombstone, `clear + ENOENT`, SHA-only recovery or late pin remains;
- every in-bound reachable durability primitive, including resume-only cleanup and contention branches, has an automatically enumerated crash case, the first out-of-bound debris state proves the declared denial-of-service rejection, and every logical stage has its required primitive coverage;
- duplicate helpers converge without repeated acknowledgement or native effects;
- the kernel-released macOS storage lock serialises honest helpers without pathname leases or live-writer cleanup, and its runtime/timeout/credential-containment contract is proved;
- hostile static input fails closed without a terminal claim;
- planned REBIND and ambiguous recovery remain disjoint;
- production interfaces expose no race hooks or test storage selection;
- the same-UID non-goal is documented honestly; and
- all complete Task 19 gates and five exact-HEAD reviews pass.
