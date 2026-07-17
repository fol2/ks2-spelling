# B3 capture authority

Task 19 uses one local SQLite schema-v2 database per platform as the sole
ignored mutable authority for physical capture, command decisions, retained
observation/checkpoint bytes, recovery archives and recovery-fresh lineage.
There is no filesystem bundle, observation journal, checkpoint file, issued
command ledger or abandoned-capture directory beside that database.

The capture store is the public state boundary. Its repository serialises state
changes through SQLite transactions and revalidates canonical command,
observation, checkpoint, distribution and recovery authority when reading.
Pure proof derivation accepts only values or bytes and has no filesystem,
transport, environment or database dependency.

Exact retained `launching` and `reinstall-launching` commands recover by bounded
pull-only observation reads and never replay native launch. Exact retained
`stop-executing` commands never replay force-stop; without a durable
`host-stopped` receipt they enter the command-bound reinstall gate. Android
force-stop resolves only after the SQLite receipt callback has completed.
Process absence is never a native-stop receipt.

## Derived evidence

Final B3 JSON reports and platform PNGs are immutable derived evidence outside
SQL. Their closed publisher accepts only the six frozen `reports/b3` identities,
copies already validated bytes, creates a missing final once and accepts an
existing final only when its exact bytes and non-group/world-writable
regular-file authority are identical. It never receives a database handle or
path and cannot overwrite, delete or repair a final. Conflicting, partial,
linked or non-regular outputs fail closed without changing SQLite.

Task 19 creates no final live report. Task 20 owns the exit-report builder; Task
22 executes that builder while creating the other five live outputs; Task 23
only reviews, fast-forwards and verifies exact main.

## Offline and evidence boundary

Spelling practice, installed packs, learner progress and child-owned Monster
progress remain local and available offline. Cloudflare and R2 are used only at
the commerce/download boundary for verification, entitlement refresh and pack
delivery; they are not runtime authorities for learning state.

Task 19 is a non-mutating local certification gate. It does not deploy a Worker,
write R2, contact or mutate an app-store console, install on a device, sign a
distribution or claim live evidence. Passing Task 19 therefore proves the local
capture architecture and tooling only, not production or store readiness.
