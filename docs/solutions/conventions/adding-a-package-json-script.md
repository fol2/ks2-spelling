---
module: package-transition-authority
date: 2026-07-22
problem_type: convention
component: development_workflow
severity: medium
applies_when:
  - "Adding, renaming, or removing any script in package.json"
  - "A test or npm run verify:b2-authority fails with 'Package script is not authorised by the approved plans'"
  - "Renaming a tests/*.test.mjs file that scripts/ or a frozen report references by path"
resolution_type: config_change
related_components:
  - testing_framework
  - tooling
tags:
  - package-json
  - npm-scripts
  - ci
  - provenance
  - frozen-authority
  - b3-package-transition
---

# Adding a package.json script requires registering it in the b3-package-transition authority

## Context

This repo freezes the exact set of `package.json` scripts. Adding a new one —
even a pure developer-convenience alias like `test:fast` — makes the suite fail
with:

```
AssertionError: Package script is not authorised by the approved plans: test:fast
  code: 'b3_package_transition_invalid'
```

The failure surfaces through `tests/b3-package-transition-authority.test.mjs` and
`npm run verify:b2-authority` (which is in the PR/`verify:b3` chain), so it blocks
CI, not just a local run. The guard is intentional certification governance from
the B3 gate, but it means a one-line script addition touches a cryptographically
self-validated provenance file. This came up while adding the seconds-fast daily
test loop (`test:fast` / `test:watch` / `test:changed` / `hooks:install`).

## Guidance

A script that is not in the frozen B2 base `package.json` must be listed in the
approved additions in **two** places, kept byte-identical, plus the contract
test that pins the expected set:

1. **`scripts/lib/b3-package-transition-authority.mjs`** — add the script to one
   of the `*_PLANNED_PACKAGE_SCRIPT_ADDITIONS` buckets (`B3_…` at line 30, `B4_…`
   at line 48), or a new exported bucket, and spread it into the merged
   `PLANNED_PACKAGE_SCRIPT_ADDITIONS` (line 73). The check at line 200 rejects any
   current script that is neither in the frozen base nor in this merged object.

2. **`provenance/b3-package-transition.json`** — add the identical
   `"name": "command"` entry under `allowedPackageScriptAdditions` (line 6). The
   verifier requires `authority.allowedPackageScriptAdditions` to deep-equal the
   module's `PLANNED_PACKAGE_SCRIPT_ADDITIONS` (lines 136–137), so the two files
   must match exactly — same command string, quoting and all.

3. **`tests/b3-package-transition-authority.test.mjs`** — the test asserts
   `authority.allowedPackageScriptAdditions` deep-equals the union of the buckets
   (lines 86–90). Import your new bucket and add it to that expected union (and to
   the per-bucket `Object.keys` name assertion) or the test fails.

The command string in all three places must be identical to what is in
`package.json`. A new bucket was used for the daily-loop scripts (an
`SDLC_DAILY_LOOP_PACKAGE_SCRIPT_ADDITIONS` export) to keep them visually separate
from the B3/B4 certification scripts; B3 and B4 registered their scripts the same
way, so this is the designed extension mechanism, not a workaround.

## Why This Matters

- **The provenance file is self-validated, not externally hash-pinned.** It is not
  in `B4_EVIDENCE_PATHS` and no other authority hashes its bytes, so editing
  `allowedPackageScriptAdditions` does not cascade into a chain of frozen-hash
  updates. The only constraints are the module⇄provenance deep-equal and the
  contract test — both verifiable locally with `npm run test:fast`.
- **Miss any one of the three and CI stays red.** The module change alone fails the
  provenance deep-equal; the provenance change alone fails the module deep-equal;
  either without the test change fails the contract test.
- **This is the "certification tax" made literal.** Development cadence and
  certification cadence are coupled here: you cannot add a shell alias without
  amending signed provenance. The durable fix (not yet done) is to relax the
  authority to allow a dev-tooling namespace (`test:*`, `hooks:*`) without
  per-script registration, while keeping the certification/deploy scripts frozen.

## When to Apply

Any time `git diff` on a branch adds, renames, or removes a `package.json`
`scripts` entry. Also relevant when **renaming a test file**: some
`tests/*.test.mjs` files are referenced by path in `scripts/` and in the frozen
B2 native-plugin report (`scripts/build-b2-native-plugin-report.mjs`), so renaming
one (e.g. to a `*.slow.test.mjs` convention) breaks
`npm run report:b2-native-plugins:check` and `npm run native:sync:check` — grep
`scripts/ tests/helpers/` for the basename before renaming, and exclude referenced
files by name rather than renaming them.

## Examples

Registering `test:fast` — all three edits together:

```js
// scripts/lib/b3-package-transition-authority.mjs
export const SDLC_DAILY_LOOP_PACKAGE_SCRIPT_ADDITIONS = Object.freeze({
  'test:fast': "node --test $(find tests -maxdepth 1 -name '*.test.mjs' ! -name '*.slow.test.mjs' ...)",
  // ...
});
const PLANNED_PACKAGE_SCRIPT_ADDITIONS = Object.freeze({
  ...B3_PLANNED_PACKAGE_SCRIPT_ADDITIONS,
  ...B4_PLANNED_PACKAGE_SCRIPT_ADDITIONS,
  ...SDLC_DAILY_LOOP_PACKAGE_SCRIPT_ADDITIONS, // <- add
});
```

```json
// provenance/b3-package-transition.json  (allowedPackageScriptAdditions)
"test:fast": "node --test $(find tests -maxdepth 1 -name '*.test.mjs' ! -name '*.slow.test.mjs' ...)"
```

```js
// tests/b3-package-transition-authority.test.mjs
import { /* … */ SDLC_DAILY_LOOP_PACKAGE_SCRIPT_ADDITIONS } from '../scripts/lib/b3-package-transition-authority.mjs';
assert.deepEqual(authority.allowedPackageScriptAdditions, {
  ...B3_PLANNED_PACKAGE_SCRIPT_ADDITIONS,
  ...B4_PLANNED_PACKAGE_SCRIPT_ADDITIONS,
  ...SDLC_DAILY_LOOP_PACKAGE_SCRIPT_ADDITIONS, // <- add
});
```

Verify locally with `npm run test:fast` (includes the contract test) and
`npm run verify:b2-authority` — both pass only when all three files agree.
