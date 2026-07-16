# B3 Task 19 S3 C3 Durable-bundle Reconciliation Micro-plan

**Status:** review candidate; implementation must not begin until two independent
reviewers approve one exact plan SHA-256.
**Fixed point:** `3c167fc1edb82a41af5a6e504afaebee2dafee33`.
**Authority:** the approved S3 working-capture-bundle micro-plan and the approved
C1 classifier/composite plus C2 initial-start implementation at this fixed point.
The frozen SQLite schema and all S1/S2/C2 public outcomes remain authoritative.

## Checkpoint amendment and bounded outcome

C3 is deliberately smaller than the original S3 checkpoint label “member
publisher”. It implements only the proposal-independent, synchronous filesystem
mechanics already authorised by a C1 durable slot. It does not approve, create or
publish new payload bytes.

This amendment closes an authority gap in the first C3 draft: C3 cannot safely
publish a new observation/checkpoint/smoke member while the real closed per-kind
semantic validators belong to C4/C5. A generic branded “validated” token would be
an ambient publication capability, not proof. C3 therefore adds no such token.

C3 may only:

- remove one recognised incomplete temporary;
- remove one recognised redundant temporary beside an exact final;
- adopt one exact-complete temporary whose durable C1 slot already contains its
  exact final name, length, SHA-256 and domain binding; and
- re-inspect the complete bundle after the sorted effects.

C4 owns the fixed observation/checkpoint validators, exact signed-build byte
authority, repository `BEGIN IMMEDIATE` coordinator, bounded preflight retries,
new observation/checkpoint publication and the production import. C5 owns the
equivalent iOS smoke validator and publication. Successful new publication,
candidate-temporary adoption and publisher race claims are deferred to those
checkpoints.

C3 is GREEN when these durable actions are one small idempotent effect module
with exact path/order/crash tests. It adds no schema, SQL row, facade method,
live caller, build-authority claim or cross-resource commit marker.

## One private authority, no caller assertions

C1 `inspectB3CaptureBundleInventory()` remains the sole namespace parser and
pass-one classifier. C3 adds a module-private `WeakMap` authority for every
inventory it returns. The private value contains:

```text
platform + captureId
exact fixed-root/root/working/three-child identities
exact sorted member identities and C1 action projection
inventory snapshotSha256
```

The authority is copied from the completed C1 result during the original
inspection; it does not retain the caller's raw database/domain objects. Later
mutation of `databaseState`, `retainedDomain` or nested objects cannot alter the
inventory action. Structural copying is closed and bounded by the existing C1
limits; JSON round-tripping, getters, callbacks and caller clone helpers are
forbidden.

The only new internal operation is:

```text
reconcileB3DurableBundleActions(inventory)
  -> undefined
```

It accepts only the exact frozen inventory object present in that same module's
`WeakMap`. A clone, spread, serialised object, digest, `{ validated: true }`, raw
path, raw `databaseState`, raw `retainedDomain`, callback or caller-built pin is
rejected before filesystem mutation.

The operation returns no receipt, authority, path, outcome or proposed domain.
It is exported only as a package-internal composition seam. In C3 its
import allow-list is the focused production-seam test only. C4 must import it
from the repository coordinator while the SQLite writer transaction is open;
no facade/live adapter imports it directly. Until C4, C3 makes no claim that the
helper is a complete production operation.

## Closed action eligibility

The complete original inventory must validate before any effect. Its actions are
sorted by `temporaryRelativePath` and must all be in this table:

| C1 action | Required C1 authority | C3 effect |
| --- | --- | --- |
| `remove-incomplete-temporary` | recognised target; actual size strictly below the name/slot-bound length | revalidate exact identity, unlink, fsync immediate parent |
| `remove-redundant-temporary` | exact desired final plus matching recognised temporary | revalidate final and temporary identities, unlink temporary, fsync immediate parent |
| `adopt-complete-temporary` | durable slot has exact length/SHA/domain; final absent; temporary exact | revalidate exact identity and final absence, same-parent rename, fsync immediate parent |

Any `validate-complete-temporary` action is a candidate needing a C4/C5 semantic
validator. Its presence rejects the whole C3 call unchanged; C3 must not first
clean another entry. Unknown actions, duplicate targets, final conflicts, wrong
hash/length, oversized/future/stale targets, second temporaries, links, special
files, namespace replacement or an unbranded inventory likewise reject with
`b3_capture_member_conflict` and zero C3 mutation.

“Durable slot” means C1 already derived exact expected length and SHA-256 from
the retained composite. A candidate slot containing only sequence/revision or
observation binding is not durable byte authority. Equal proposal bytes, a
matching filename or a digest supplied by a caller cannot upgrade it.

All eligible actions are derived before the first effect. No proposal is an
input, so current caller intent can never excuse debris.

## Exact synchronous effect protocol

For each sorted action C3 must:

1. revalidate the fixed repository/evidence/bundles/working/child hierarchy
   against the inventory's private identity;
2. open/read the named temporary with the existing no-follow C1 reader and
   require exact device, inode, mode `0600`, link count one, size and SHA-256;
3. for redundant cleanup, independently revalidate the exact final;
4. for adoption, prove the literal final absent immediately before rename;
5. call only `unlinkSync` or same-immediate-parent `renameSync` as the table says;
6. open and `fsyncSync` that literal member directory; and
7. revalidate the fixed hierarchy before proceeding to the next action.

`ENOENT`, `EEXIST`, replacement, metadata drift, parent drift or a final appearing
before rename is drift/conflict, never success. C3 does not overwrite a final,
rename across directories/devices, hard-link, create a temporary, write payload
bytes or treat a missing pathname as completed cleanup.

After all effects, C3 rereads every affected final/temporary target and the fixed
hierarchy against the action's exact expected postcondition. It does **not** call
C1 with an invented successor domain. In particular, adopting a pending
checkpoint turns its filesystem state from temporary to final while its C1
input domain is still the pre-adoption one-behind projection. Only C4's closed
validator/coordinator may derive the successor domain and run the final complete
C1 inspection before SQLite commit.

For cleanup-only actions the original domain can be freshly inspected and has no
remaining actions. For adoption, the C3 test explicitly builds the frozen
fixture's expected successor retained-domain, calls the public C1 inspector, and
requires one exact final with no actions. This test fixture is not a production
domain minter and is never passed into the C3 effect function. A no-action
successor inventory makes a second C3 call an exact no-op.

SQLite rollback cannot undo an unlink/rename. C3's effects are therefore the
idempotent filesystem half of the later C4 transaction: after death, fresh C1
inspection sees the original recognised temporary, the exact adopted final or
the already-clean state. C3 itself does not claim transaction isolation or
two-helper serialisation before C4 supplies the SQLite writer lock.

## Exact files and TDD slices

Production edits are limited to:

- `scripts/lib/b3-capture-bundle-store.mjs`

Tests/helpers are limited to:

- `tests/b3-capture-bundle-store.test.mjs`
- `tests/helpers/b3-capture-bundle-reconcile-death-child.mjs`

Implement one RED-to-GREEN slice at a time:

1. Brand inventories with privately copied authority; reject clones, spreads,
   stale identities, caller mutation and candidate actions with zero mutation.
2. Reconcile one incomplete and one redundant temporary in sorted order with
   exact unlink and parent-fsync traces.
3. Adopt one durable exact-complete temporary with exact same-parent rename,
   final-absence proof, parent fsync and final readback.
4. Revalidate exact postconditions; use explicit test successor-domain fixtures
   to prove fresh C1 inspection and idempotent no-op, and reject hierarchy,
   inode/final/parent ABA at every pre-effect boundary.
5. Run the finite real-child death matrix and prove unmocked fresh inspection
   converges without a production fault hook.

No repository, facade, live adapter, journal, checkpoint builder, smoke builder,
schema, native source or Cloudflare file changes in C3.

## Finite crash and adversarial matrix

The child helper patches Node filesystem exports before importing the unchanged
production module, emits the exact operation index/kind/repository-relative path
and pauses itself with `SIGSTOP`. The parent validates the trace, sends
`SIGKILL`, then uses an unpatched child for fresh inspection/reconciliation.
Production receives no hook, phase flag, adapter, callback or environment check.

The crash matrix is exactly 18 cases, not an unbounded prefix product:

- Android observation incomplete cleanup: before/after unlink and parent fsync
  (4);
- iOS derived redundant cleanup: before/after unlink and parent fsync (4);
- Android checkpoint durable adoption: before/after rename and parent fsync (4);
- one two-action sorted fixture: after each of its four operations plus before
  and after exact affected-target/hierarchy postcondition validation (6).

Each case asserts the complete trace prefix, exact relative path, operation
order, process signal and fresh convergence. Since C3 creates/writes no payload,
there is no short-write or “all prefixes” matrix. C4/C5 must separately freeze
representative write schedules (`0`, `1`, midpoint, `length-1`, exact) and test
the independent 131072-byte ceiling.

Non-crash adversarial tests cover all three member kinds and both platforms
(with Android `derived` rejected), zero/maximum/33 temporaries, symlink, hard
link, FIFO, wrong mode/device/hash/length, path/parent/final replacement,
`ENOENT` and `EEXIST`. These are bounded table tests, not a combinatorial cross
product. C3 adds no real-concurrency claim; C4 owns same/different publisher
races under `BEGIN IMMEDIATE`.

## Checkpoint gates

C3 GREEN requires:

- focused C1/C2/C3 bundle/store/database suites;
- the exact 18-case child-death matrix;
- S1/S2 command/repository regressions;
- syntax, Oxlint and `git diff --check`;
- source scans proving the internal operation has no facade/live import and no
  raw authority/path/proposal/semantic token input; and
- schema and frozen native-output byte identity.

Freeze one exact staged implementation snapshot only after all gates pass. Two
fresh reviewers must approve that same SHA: (1) action eligibility, path/identity,
crash convergence and zero-mutation rejection; and (2) deep-module boundary,
authority copying, test adequacy and the explicit C3/C4 amendment. Any P1/P2 fix
invalidates both approvals.

Only then create one C3 GREEN commit. The S3 checkpoint rule does not require a
push after C3. Never deploy or mutate a device, store, Cloudflare or R2 resource.

## Explicit exclusions

- No new member publication, payload create/write/fsync or short-write loop.
- No candidate-temporary semantic approval or adoption.
- No signed-build pin, async validator, retry loop or repository transaction.
- No public `readCapture`, `publishObservation` or smoke facade method.
- No observation/checkpoint composition or caller migration; C4 owns them.
- No gateway-smoke composition or caller migration; C5 owns them.
- No schema, SQL row, compatibility path, legacy read/write or dual write.
- No S4+ abandoned bundle, recovery/terminal claim, acknowledgement, final
  evidence, deletion or Task 19 exit claim.
- No network, secret, deployment, device/store action, Cloudflare request, R2
  mutation or learner/spelling/Monster runtime change.
