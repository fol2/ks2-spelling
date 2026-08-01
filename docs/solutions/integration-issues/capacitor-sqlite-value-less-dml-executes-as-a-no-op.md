---
title: A value-less DELETE reaching the Capacitor statement-batch API does nothing on iOS
date: 2026-08-01
category: integration-issues
module: sqlite-learning-backup-repository
problem_type: platform_behaviour
component: database_adapter
symptoms:
  - "An import that promises to replace every learner leaves the existing learners in place"
  - "Re-importing a backup whose learner id already exists fails with the import's generic failure copy"
  - "sqlite3 inspection shows the old learner rows still present after a reported-successful import"
  - "The same import replayed in a Node harness against node:sqlite passes every time"
root_cause: platform_behaviour
resolution_type: code_fix
severity: high
related_components:
  - "database"
  - "parent_backup"
  - "capacitor_plugin"
tags:
  - "capacitor-sqlite"
  - "ios"
  - "adapter"
  - "dml"
  - "backup-import"
  - "node-cannot-reproduce"
  - "source-text-pin"
---

# A value-less DELETE reaching the Capacitor statement-batch API does nothing on iOS

## Problem

`importBackup` clears the store before writing the backup's learners:

```js
await connection.execute('DELETE FROM learner_profiles');
```

On the device this deleted nothing. Two symptoms followed. A learner who
existed before the import survived it, contradicting the screen's own promise
that "Import replaces every learner and learning snapshot on this device".
And re-importing a backup that contained a learner id already present failed
on the primary key, surfacing as "The backup did not complete" — a true
failure, but with a cause no one could see.

Every Node replay passed. A full `importBackup` run against
`node:sqlite` — same repository, same codec, same transaction runner — deleted
the rows correctly and re-imported cleanly.

## Root cause

`src/platform/database/capacitor-sqlite-connection.js` routes a statement by
whether it was given values:

```js
async execute(sql, values) {
  if (values === undefined) {
    const result = await database.execute(sql, false);   // statement-batch API
    return createWriteResult(normaliseNativeChanges(result));
  }
  const result = await database.run(sql, values, false); // single-statement API
  return createWriteResult(normaliseNativeChanges(result));
}
```

`database.execute(...)` is the plugin's *statement-batch* entry point. On iOS
it executes this DELETE as a no-op and still returns a well-formed
`{changes: {changes: 0}}` payload, so nothing in the adapter, the repository's
result check, or the transaction runner has any reason to complain. Zero rows
deleted is a legitimate outcome for a DELETE — the code cannot distinguish
"nothing to delete" from "did not run".

`database.run(sql, values, false)` — the single-statement path — executes the
same SQL correctly.

Node cannot reproduce this: `node:sqlite` runs both paths properly, so the
divergence exists only on the device. That is why a passing Node harness was
weak evidence here, and why the decisive experiment had to be run offline
against the device's own database: deleting the conflicting learner by hand
with `sqlite3` made the identical import succeed, while a *different*
pre-existing learner still survived it. Only the DELETE was failing.

## Fix

Pass an explicit empty values array so the statement takes the run path:

```js
// The empty values array keeps this on the adapter's single-statement
// run path: the Capacitor plugin's statement-batch API executes this
// DELETE as a no-op on iOS, which left every existing learner in
// place and failed a same-learner re-import on its primary key.
const deleted = await connection.execute('DELETE FROM learner_profiles', []);
```

`tests/backup-import-delete-path.test.mjs` pins the call in the source text —
matching the `[]` form and rejecting the value-less one. A behavioural test is
impossible: the behaviour being guarded belongs to the native plugin, and
under Node both forms pass.

This was the only value-less DML site in `src/`. Reads are unaffected —
`query` has always taken the `database.query` path.

## Rule

**Every DML statement through this adapter passes a values array, even when it
binds nothing.** `execute(sql)` with no values is reserved for genuine
statement batches (schema bootstrap and pragma runs), where the batch API is
what you actually want. When adding a DELETE, UPDATE or INSERT with no
parameters, write `[]`.

## Signals that point here

- A write works in every Node test and fails only on device.
- A `changes: 0` result that the code accepts as "nothing matched".
- An operation that claims to replace state but leaves the old state behind.

When those coincide, check which adapter path the statement took before
suspecting the SQL, the transaction, or a race.
