# Backup import race findings

## Harness

The investigation used `tests/parent-backup-race.test.mjs` with the same
file-backed Node SQLite bootstrap as `tests/post-commit-honesty.test.mjs`.
Its connection factory wraps `tests/helpers/node-sqlite-connection.mjs` and
adds a one-shot `holdNextMatching(pattern)` latch. A matching SQL statement is
recorded, announces that it has been reached, and waits for an explicit
`release()` before reaching SQLite. The final `learner_profiles` comparisons
include all seven stored columns, not only learner identifiers or row counts.

Observed before the service guard with:

```text
node --test tests/parent-backup-race.test.mjs
tests 2, pass 2, fail 0
```

## H1 — two overlapping service imports

**Hypothesis.** Bypassing the UI's `backupBusy` flag allows two complete
`importBackup()` operations to start.

**Interleaving.** Two service calls were started in the same turn against one
captured backup. Both calls reached `files.pickImport()`. The shared database
command gate then ran the repository replacement transactions one after the
other.

**Observed.** `files.pickImport()` was invoked twice and the connection saw two
exact `DELETE FROM learner_profiles` statements, proving that the backup was
applied twice. Both calls resolved with equal results; neither raised a
constraint error. After both post-import callbacks settled, the full
`learner_profiles` table equalled the backup's learner rows exactly.

**Verdict.** Reproduced. The repository gate prevents the two transactions from
overlapping inside SQLite, but it does not deduplicate the service operation or
the native picker. A service-level same-method join is required.

## H2 — a held profile write racing an import

**Hypothesis.** A profile write which starts before an import could resume after
the import commits and resurrect a learner removed by the import's replace-all
transaction.

**Interleaving.** A `controller.createProfile()` transaction was held immediately
before its `INSERT INTO learner_profiles`. While that transaction was active,
`parentBackup.importBackup()` was started and its picker was observed. A second
hold was armed for the import's exact `DELETE FROM learner_profiles`. The
valid import response signalled on its second hash read; JavaScript
run-to-completion then reached the repository's `gate.run()` before the test
continuation resumed. The profile insert was released only after that barrier,
so the import was already queued behind the active write.

The runtime events placed `RELEASE INSERT INTO learner_profiles ...` before
`HOLD DELETE FROM learner_profiles`. The import delete could not reach the SQL
connection while the profile write remained held. This matches the source
path: both repositories use the single FIFO gate created in
`src/app/create-product-app-services.js`; the profile write occupies that gate
for its whole owned transaction, and the backup replacement is queued behind
it. `runOwnedTransaction()` also serialises owned transactions per connection.

**Observed.** The only reachable order was profile write commit, then backup
delete/insert commit. Releasing the profile write after the import commit was
not an available order: the import transaction could not begin until that
release. After both public operations and their refresh work settled, the full
`learner_profiles` table equalled the backup's learners exactly; neither the
pre-import live learner nor the held new learner remained.

**Verdict.** Not reproduced. The existing shared transaction gate preserves the
replace-all invariant for this pre-import write race. The regression test keeps
the deliberately hostile hold/release order and the exact final-table
assertion.

## Step C decision

No post-import count verification is warranted. H2 did not expose an invariant
break, and adding verification would duplicate a guarantee already enforced by
the shared gate without preventing a race. `src/app/create-product-app-services.js`
therefore remains unchanged.
