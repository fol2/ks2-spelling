# B2 Persistence and Lifecycle Authority

## Proven boundary

B2 proves transactional local persistence on the owned iOS Simulator and
Android Emulator. It does not prove physical-device behaviour or release
readiness.

The application database is `ks2-spelling`; the native plugin file is
`ks2-spellingSQLite.db`; and schema version is `1`. Every opened connection
must prove `foreign_keys=ON`, `journal_mode=WAL`, `synchronous=FULL` and
`busy_timeout=5000`. The application-owned asynchronous SQL adapter contract
is implemented by `src/platform/database/capacitor-sqlite-connection.js` in
native code and `tests/helpers/node-sqlite-connection.mjs` in tests. The only
B2 repository surface is `{ runCommandTransaction }`.

Each changed command reads a fresh learner-scoped snapshot inside one
transaction, samples the repository clock once per conflict attempt, validates
the complete A3 plan, writes every durable target, advances the revision by
compare-and-set and releases transient effects only after commit. The seven
certified rollback checkpoints are:

- `after-subject-state`;
- `after-practice-session`;
- `after-events`;
- `after-monster-state`;
- `after-camp-state`;
- `after-revision`; and
- `before-commit`.

Lifecycle notifications are an optimisation and diagnostic boundary, not a
correctness dependency. Pause drains the command gate, checkpoints WAL and
closes the database idempotently. Resume reopens, migrates, integrity-checks
and reloads before commands are accepted. The virtual-device proof backgrounds
and resumes the app, terminates the process, relaunches with a different PID
and resumes the exact session.

Two deterministic learners prove isolation across subject state, sessions,
events, Monster state, Camp state and revisions. Learner B's canonical digest
must remain unchanged. Starter Camp contains zero rows. Monster state remains
child-owned and spelling-derived; no Parent projection or analytics is stored
in Monster or Camp tables.

## Evidence authority

The strict exit builder is `scripts/build-b2-exit-report.mjs`. It binds the
frozen B1 authority, the exact clean B2 application checkpoint, the application
fingerprint and these committed inputs:

- `reports/b2/ios-simulator-proof.json` and `.png`;
- `reports/b2/android-emulator-proof.json` and `.png`;
- `reports/b2/native-plugin-build.json`;
- `reports/b2/native-plugin-audit.json`;
- `reports/b2/dependency-audit.json`; and
- `reports/b2/b2-exit-report.json`.

It also binds `package-lock.json`, SwiftPM `Package.resolved`, all five Android
dependency lockfiles and Gradle verification metadata. The exit report records
the SHA-256 of every report and screenshot. iOS and Android must have equal
canonical logical snapshot and Learner B digests.

The native reports' `testedApplicationCommit` identifies the clean application
checkpoint before the evidence-only commit. `--write` accepts only that HEAD
with the two lifecycle reports, two screenshots and exit report allowed to be
dirty. The native build, dependency and plugin audit authorities are frozen in
the Task 14 checkpoint. `--check` accepts either that checkpoint while evidence
is being assembled or its immediate, clean, lifecycle-evidence-only successor.
It rejects stale, unrelated, dirty or application-changing histories.

## Deferred boundary

- Production profile CRUD, Parent security, PIN and biometrics, reset/delete,
  database-key management and production backup remain C2.
- Physical devices, accessibility and performance certification remain B4.
- SQLCipher is packaged while B2 explicitly opens `no-encryption`; US
  encryption export classification remains unresolved release work.
- Billing, purchases, entitlements, downloads, production audio, signing and
  store metadata are not implemented or approved.
- The current shell is diagnostic proof UI, not final product visuals.

A dedicated Visual / Theme / Asset Migration Spec follows Gate B `GO` and must
finish before C3 child UI. It will migrate the spelling and Monster visual
language, assets, typography, colour, motion and responsive layouts without
changing the B2 persistence truth.
