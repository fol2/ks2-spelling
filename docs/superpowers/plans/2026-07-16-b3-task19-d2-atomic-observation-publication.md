# Task 19 D2 — Atomic SQLite Observation Publication Plan

**Date:** 2026-07-16  
**Parent:** `2026-07-16-b3-task19-sqlite-blob-authority-amendment.md`  
**Slice:** D2 only — canonical observation/checkpoint derivation, atomic publish,
committed read projection and the public facade.  
**Architecture:** SQLite schema v2 is the sole working-state authority. Filesystem
observation/checkpoint writers remain untouched legacy code until D5 and receive
no new production call sites.

## Exit outcome

`B3CaptureStore` exposes exactly:

```js
await store.publishObservation({ source, observationBytes })
await store.readCapture()
```

One canonical physical-observation record and its checkpoint commit as one
`b3_capture_steps` row. A crash cannot expose one without the other. Identical
retries return committed bytes, conflicting retries return the committed winner,
and a missing step can be inserted only for the exact selected active command and
current observation tail.

This slice does **not** migrate live adapters, command-mutator sequencing,
recovery, report export or delete legacy filesystem modules. Those remain D3,
D4 and D5 respectively.

## Frozen domain seam

Extract and export pure derivation/validation from the existing observation and
checkpoint modules; do not introduce a generic persistence abstraction.

The observation domain owns functions equivalent to:

```js
await deriveB3CaptureStep({
  platform,
  command,
  buildSource,
  previousObservation,
  observationBytes,
})

await validateB3RetainedCaptureStep({
  platform,
  command,
  buildSource,
  previousObservation,
  recordBytes,
  checkpointBytes,
})

deriveB3DeviceGatewaySmokeProjection(records)
```

Exact names may follow the existing module vocabulary, but there is one shared
implementation used by publication and readback. The returned step contains:

- deep-frozen canonical `record` and `checkpoint` values;
- canonical `recordBytes` and `checkpointBytes` copied into fresh Buffers;
- `recordSha256 = SHA-256(recordBytes)`;
- `observationSha256 = record.observation.observationSha256`;
- `checkpointBlobSha256 = SHA-256(checkpointBytes)`; and
- the checkpoint's own `checkpointSha256`, which remains the existing hash of
  its unsigned checkpoint value and is not confused with the BLOB hash column.

The record remains the existing closed shape
`{schemaVersion:1, platform, sequence, command, observation}`. The checkpoint is
derived from that observation tail with `checkpointRevision = sequence - 1`;
revision is not a caller input or second decision source.
Validation rederives both canonical byte strings and both hash domains. No weak
map, path, inode or previously validated object is required.

The optional gateway-smoke projection is derived only from validated retained
records. Zero authorities yields `null`; one is valid only for the existing iOS
pack-install/scenario-complete/authorise binding and closed redacted projection;
an Android authority or two or more authorities fail closed. Move only this pure
extractor in D2 and re-export it from the live adapter; D3 still owns all live
orchestration and output migration. It is never stored in a second row or file.

The six-field trusted `buildSource.value` is deterministically expanded inside
the domain module to the existing eleven-field physical proof build authority:
fixed `mode`, `proofKind`, public sandbox origin, worker name and bundle ID;
platform-specific distribution and build number; and source-controlled version,
commit and fingerprint. This is the single implementation later reused by D3.
The two-field `buildSource.buildAuthority` is never passed to proof validation,
and no facade or repository caller may provide the expanded authority.

## Repository publication protocol

Add internal repository methods `publishObservation({source,
observationBytes})` and `readCapture()`; no caller can provide a path, build
authority, database handle, retained rows, predecessor, checkpoint, smoke value,
retry callback or timing hook.

The facade validates a two-key plain closed data record (no accessors), snapshots
the closed `source` including a closed copied scalar-data command, and copies any
`Uint8Array` to a Buffer before its first `await`. `readCapture()` accepts no
arguments. Caller mutation after invocation cannot alter the proposal.

Each publication performs no more than three complete attempts:

1. Async-read the fixed trusted build-authority source, retaining canonical
   value, byte hashes and ancestor/file identity.
2. In a short `BEGIN` transaction, run full synchronous database validation and
   copy the matched persisted command, exact predecessor step (or zero tail),
   current step if present, active pointer and retained ordered step rows. Commit
   before any async domain validation.
3. Outside SQLite, semantically validate all retained rows from canonical BLOBs.
   Resolve the closed source against persisted selected command history and
   derive the proposed row from the persisted command, exact predecessor and
   preflight build value.
4. If step N already exists, open a second `BEGIN`, synchronously reread the
   trusted build source, rerun full synchronous database validation and require
   the matched command, predecessor and existing row bytes/hashes to equal the
   preflight snapshot. Commit without writing. Return `already-published` when
   proposed and committed canonical rows are identical, otherwise
   `publication-conflict`.
5. If step N is absent, require the source to be the exact selected active
   command, then use `BEGIN IMMEDIATE`, synchronously reread the trusted build
   source, rerun full validation and require the active command, working capture
   and entire ordered retained-step byte/hash fingerprint to equal the preflight
   snapshot, not merely its tail.
6. Insert the complete row with `ON CONFLICT DO NOTHING`, reread the winner and
   full ordered structural chain. Only `changes === 1` can return `published`.
   Under the SQLite writer lock, `changes === 0` means the preflight snapshot
   drifted: roll back and restart in the existing-step branch; it is not described
   as a newly concurrent winner. Commit and reconstruct from committed bytes.

The transaction contains no `await`, caller code, random generation, network or
filesystem write. Its only filesystem operation is the fixed synchronous trusted
build-authority read. Exact source equality includes canonical SHA, original
source SHA and every ancestor/file identity field `(dev, ino, mode, nlink, size,
mtime, ctime)`, not merely semantic values. Build/source identity drift or
database snapshot drift rolls back and retries the complete attempt.
`SQLITE_BUSY`, `SQLITE_LOCKED` and a zero-change missing-step insert are also
private drift signals. Protocol/canonical/semantic errors, database corruption
and a stable conflicting committed row never retry. A fourth attempt is
impossible.

Use a private immutable snapshot/fingerprint record for the preflight SQL rows;
do not pass mutable database row objects across phases. Equality includes command,
predecessor and step canonical bytes plus the relevant active/capture state, not
only hashes.

Exact public results are deep-frozen and reconstructed from committed BLOBs:

```text
{ kind: 'published', record, checkpoint }
{ kind: 'already-published', record, checkpoint }
{ kind: 'publication-conflict', record, checkpoint }
```

Existing-step resolution precedes active-command enforcement. Therefore an exact
or conflicting retry remains read-only and deterministic after consumption,
later allocation or (once D4 exists) archival.

The repository normalises domain/protocol/checkpoint failures to the existing
public `b3_capture_state_invalid` error boundary; lower-level domain codes do not
leak through `B3CaptureStore`.

## Read projection

`readCapture()` first async-reads the fixed trusted build source, then opens one
short read transaction, performs full synchronous database validation, copies
the ready working capture and ordered step BLOBs, and commits. It performs
canonical semantic validation outside SQLite using that source and returns:

```js
{
  schemaVersion: 1,
  platform,
  captureId,
  records,
  checkpoint,
  gatewaySmokeProjection,
}
```

The object, records and nested values are deeply frozen. A ready working capture
with no steps returns `records: []`, `checkpoint: null` and
`gatewaySmokeProjection: null`. Empty, pending-start and recovery/archive states
fail closed because they have no selected readable working capture. There is no
healing write.

## D2 validation boundary

Keep D1's synchronous structural validator authoritative for contiguous step
rows, command/capture foreign-key binding, previous-observation linkage and raw
BLOB hashes. D2 adds exact snapshot comparison inside publication transactions
and full asynchronous record/checkpoint semantics outside those transactions on
the copied immutable rows.

Publication locally requires a missing step to belong to the selected active
tail, exact retained predecessor and sequence at most 512. Existing-step retries
remain independent of the active pointer. Do **not** yet make global database
validity depend on generic closure having a step: that would silently change the
existing consume/allocation mutators in this slice. D3 adds their step gates,
global command-count/closure invariants and publisher-versus-transition,
consume/allocation race proofs. D2 does not change their public result unions.

The database session gains only the package-private full async and synchronous
trusted-build-source readers needed above. The existing D1 parser and policy stay
the single implementation.

## TDD and verification

Create focused store/repository tests first and show RED for absent methods. Cover:

1. first and sequential publication, canonical committed bytes, read projection,
   empty ready capture and deep immutability;
2. identical retry and same-sequence/different-byte conflict, including retry
   after generic consumption and later allocation;
3. wrong source/command/build/tail, malformed/non-canonical/oversized bytes,
   checkpoint BLOB hash versus internal checkpoint hash, and sequence 513;
4. zero/one/multiple gateway-smoke authorities and exact redacted projection;
5. caller mutation immediately after invocation for source, command and bytes;
6. two real child publishers with identical bytes and with different bytes;
7. child death before insert, after the SQLite insert but before commit, and
   after commit before promise return. The test child may monkey-patch Node's
   SQLite primitive at the process boundary to terminate around the real
   production `INSERT`/`COMMIT`; production code receives no hook or bypass;
8. build-source byte/inode/ancestor drift while a real SQLite lock pauses
   publication, plus database
   winner drift, proving convergence and the three-attempt ceiling; and
9. direct database tampering fixtures for D1 structural hashes/linkage and D2
   semantic BLOB validation, followed by unpatched repository read rejection.

Run:

```sh
node --test tests/b3-capture-step-domain.test.mjs \
  tests/b3-capture-state-publication.test.mjs \
  tests/b3-capture-store.test.mjs \
  tests/b3-capture-state-repository.test.mjs \
  tests/b3-capture-state-database.test.mjs
node --check scripts/lib/b3-device-observation.mjs
node --check scripts/lib/b3-physical-observation-journal.mjs
node --check scripts/lib/b3-capture-state-database.mjs
node --check scripts/lib/b3-capture-state-repository.mjs
node --check scripts/lib/b3-capture-store.mjs
npx oxlint <modified production and test files>
git diff --check
```

Also run affected legacy observation/checkpoint tests to prove that extraction did
not change existing filesystem behaviour. The full repository suite waits for D5,
when the obsolete production path is removed.

## Review and commit gate

Before implementation, two independent reviewers approve the exact plan SHA:

- transaction/concurrency/crash correctness; and
- SOLID/DRY/YAGNI, parent-amendment fidelity and D2 scope.

Implementation is subagent-driven with root integration. After focused GREEN,
two independent reviewers approve the same staged patch SHA/tree with no P1/P2.
Then commit as one D2 slice and push the branch. Any code fix invalidates both
implementation approvals.
