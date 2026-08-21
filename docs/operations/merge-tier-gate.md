---
module: operations
tags:
  - ci
  - merge-queue
  - governance
problem_type: operating-procedure
---

# Merge-tier gate: source contract versus live GitHub governance

Dated 2026-08-21. This is the durable maintainer document for the event-to-tier
mapping in `.github/workflows/ci.yml` and for the source-level merge-blocking
contract. It does not prove live GitHub rulesets, branch protection or merge-queue settings.
Inspect live settings; a source file cannot certify them.

Issue #73 closes only after both halves exist: this source contract, and a
separate live demonstration that the GitHub merge queue / branch protection
actually requires the three full jobs on the exact candidate that will land.
The live half is an external mutation and is not granted by a green PR of this
document.

## What source can prove

The workflow definition maps events to tiers:

- `pull_request` runs only the fast Domain and web lane (`npm run test:fast`
  plus the cheap invariants). Native jobs are skipped. This is developer
  feedback, not a merge basis.
- `merge_group`, `push`, `schedule` and `workflow_dispatch` run the full three-job gate:
  Domain and web, Android unsigned debug and release compile, and iOS unsigned Simulator compile.
- `schedule` and `workflow_dispatch` always compile native, even when the path
  filter would otherwise be quiet. Certification (`workflow_call` with
  `certification: true`) does the same.

A bundled-source or native release input that can change an APK or iOS app
selects both native jobs on those full-gate events. The shared detector is
`scripts/detect-native-ci-changes.mjs`. Unresolved base, empty diff or a
certification run fail closed and compile native. The filter can only ever make
a merge slower; it must not let a changed Vite payload skip the container that
ships. The B4 workflow file `.github/workflows/ci.yml` is itself a native/full-merge input:
it consumes the path filter that decides whether the required Android and iOS jobs compile.
A candidate that changes only that workflow must still select both native jobs.
This source contract does not prove a hosted merge_group executed those jobs.

History-sensitive B4 evidence-successor checks inspect the truthful candidate
range (merge-group base, pull-request base, push `before`, or `HEAD~1` as a
last-resort first parent). They run on every relevant merge path, including
`merge_group` and `main`. They do not self-disable with a false-green skip.
Ordinary commits still skip the evidence-only subset contract, but only after
that candidate range has been inspected.

## What source cannot prove

Repository settings live on GitHub, not in this tree:

- required check names and whether they attach to the merge candidate or to the
  pull-request event;
- `strict` / "branches must be up to date";
- whether administrators are bound (`enforce_admins`);
- whether a merge queue exists and which checks it requires;
- who can bypass protection, push directly to `main`, or merge with only the
  fast PR lane.

A passing Actions run of `ci.yml` proves that *that* event executed *those*
jobs. It does not prove that GitHub will refuse a merge when they are missing.
Record live observations in an issue or PR body; do not paste them here as if
the tree certified them.

The required live checks, when the external gate is correctly configured, are
the three job names above. Configuring them is Codex/planner work after this
source contract has been reviewed and after the scheduled baseline tracked by
issue #229 is green. A green exact-main push run is not a green nightly baseline.

## `verify:b3` is not the complete B3 gate

`npm run verify:b3` is the local deterministic/native audit chain frozen by the
B3 package-transition authority. It ends at
`node scripts/build-b3-exit-report.mjs --check-ci`.
verify:b3 does not run gateway Worker tests, lint, Wrangler dry-run or gateway audit.
Those belong to the Hosted Domain and web merge lane (`npm --prefix gateway test`,
`lint`, `deploy:dry-run`, `scripts/rehearse-b3-deploy-config.mjs`, and
`npm --prefix gateway audit`). Live Cloudflare deploy and store mutation remain
owner-gated and absent from both.

Do not cite `verify:b3` as proof that the gateway Worker was exercised.

## Maintainer consequences

- Pull-request CI alone is not a merge basis for bundled `src/`, `public/`,
  `vite.config.js`, native projects, or any other path the detector selects.
- Evidence commits must remain evidence-only successors of the application
  checkpoint named in `reports/b4/b4-development-report.json` across the whole
  candidate, not only in the final commit.
- `npm run test:changed` must fail when it selected tests that fail. An empty
  selection is the only path that prints `no changed tests`.
- Nightly alerting (issue #69) is the post-merge last line of defence. An open
  `ci-nightly-red` issue means the scheduled gate is red now.
