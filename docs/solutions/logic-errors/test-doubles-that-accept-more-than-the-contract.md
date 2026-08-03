---
title: Test doubles that accept more than the contract hide the caller's mistake
date: 2026-08-01
category: logic-errors
module: parent-area
problem_type: logic_error
component: controller
symptoms:
  - "The Parent PIN gate rejects the correct PIN on every entry after the first, while the failed-attempt counter stays at zero"
  - "The parent progress panel reports that progress could not be checked, and keeps reporting it across refresh and relaunch"
  - "Both surfaces are covered by passing unit suites"
root_cause: logic_error
resolution_type: code_fix
severity: high
related_components:
  - "parent_security"
  - "parent_progress"
  - "spelling_engine"
tags:
  - "test-doubles"
  - "contract-validation"
  - "parent-area"
  - "pbkdf2"
  - "backup-import"
  - "e2e"
---

# Test doubles that accept more than the contract hide the caller's mistake

## Problem

Two Parent-area defects reached a device build with full unit coverage green
on both paths. They share one shape: the collaborator's real contract is
stricter than the double used to test the caller, so the caller was free to
pass something the real collaborator would reject.

### The PIN gate rejected its own correct PIN

Setting a PIN worked. Every later entry answered "That did not work" — and
`failedAttempts` stayed at 0, the counter a genuinely wrong PIN would have
moved. The controller passed the whole stored security record to the verifier:

```js
if (await pinCrypto.verify(pin, record)) {   // record has nine keys
```

`requireCredential` in `src/domain/security/parent-pin-contract.js` accepts *exactly* the four
credential keys (`algorithm`, `iterations`, `saltBase64`, `verifierBase64`).
The stored record carries five more — lock state, biometric flag, timestamps —
so every verification threw `parent_pin_credential_invalid` before the PBKDF2
comparison ran. The unit suite's `pinCrypto` fake ignored its second argument,
so it never had an opinion about the shape it was handed.

### The progress panel died on an imported learner

"Progress could not be checked. Saved learning was not changed." — persisting
across refresh and relaunch, immediately after a backup import. The snapshot
validator accepts sparse progress entries (a stage with no counters; an
imported backup may carry them), but the parent projection sums
`attempts`/`correct`/`wrong` raw. One sparse entry folded `NaN` into the totals
and the engine's redaction walk rejected the whole projection with "Parent
projection must contain finite numbers". The controller's tests fed only
fully-populated fixtures, so no entry was ever sparse.

## Diagnosis technique that worked

Neither defect was reasoned out from the screen. Both were reproduced by
booting the real service graph — `createProductAppServices` — in Node against
a **copy of the simulator's own database**, then calling the failing operation
and reading the stack. The stack named the exact guard in each case
(`requireCredential`, then the redaction walk), which turned a vague screen
message into a one-line fix. Copying the device database is cheap and makes
the real data the fixture; no seeding can match it for fidelity. That technique
is now permanent: `tests/post-commit-honesty.test.mjs` boots the same graph over
`node:sqlite` and arms SQL-level failures at each service site.

## Fixes

Project to the contract at the call site, rather than hoping the collaborator
is tolerant:

```js
// The stored record carries lock state beside the credential, and the
// PIN crypto contract accepts exactly the four credential keys.
if (await pinCrypto.verify(pin, Object.freeze({
  algorithm: record.algorithm,
  iterations: record.iterations,
  saltBase64: record.saltBase64,
  verifierBase64: record.verifierBase64,
}))) {
```

Normalise what the validator will accept but the projection cannot use:

```js
// The snapshot validator accepts sparse progress entries (an imported backup
// may carry only a stage), while the parent projection sums attempt counters
// and would carry a NaN into its finite-number guard. Default the counters
// here so every accepted snapshot projects.
```

Both fixes are app-side. No engine table was extended and no validator was
loosened.

## Rules

1. **Exercise the real collaborator at least once per seam.** The PIN suite now
   runs a round trip against `createParentPinCrypto` with the platform
   `crypto` — set a PIN, lock, unlock, and reject a wrong PIN. One real-crypto
   test costs a few hundred milliseconds and covers what every fake in the file
   cannot.
2. **Fixtures must span what the validator accepts, not what the happy path
   produces.** If a validator permits sparse entries, some fixture must be
   sparse. The gap between "valid input" and "input we happened to write" is
   exactly where these defects live. The rule governs any stand-in, not only a
   unit fixture — see
   `docs/solutions/workflow-issues/harness-omitting-a-field-photographs-a-screen-the-product-never-renders.md`
   for the visual-harness dialect, where the fake supplies *less* than the real
   store and nothing can go red.
3. **A stricter contract downstream is a caller obligation, not a hint.**
   Exact-key validation (`Reflect.ownKeys(value).length !== 4`) is deliberate
   in this codebase; pass the projection, never the superset.

## Signals that point here

- A surface fails in a way the failure counters do not corroborate (rejected,
  but nothing recorded a rejection).
- An error message from a *validator* rather than from the operation the user
  asked for.
- Green unit coverage over exactly the path that fails on device.

## Related

- `docs/solutions/workflow-issues/harness-omitting-a-field-photographs-a-screen-the-product-never-renders.md`
  — the harness dialect of the same fixture-breadth rule, with the polarity
  reversed: there the stand-in supplies less than the real store, and the
  instrument has no failing state at all.
- `docs/solutions/logic-errors/committed-import-reported-as-failed-by-auxiliary-refresh.md`
  — the sparse-progress defect recorded here is what made that record's
  auxiliary refresh throw; that doc had filed it as an unresolved caveat.
