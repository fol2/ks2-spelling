---
module: operations
tags:
  - ci
  - merge-queue
  - governance
problem_type: operating-procedure
---

# Merge-tier gate: source contract versus live GitHub governance

Dated 2026-08-27. This is the durable maintainer document for the event-to-tier
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

- A safe documentation-only PR enters the Domain and web job but receives only
  F0 change-integrity and documentation/CI contract checks. It performs zero
  project-dependency bootstrap. `scripts/detect-pr-focus-gate.mjs` grants this
  route only when every changed path is an explicitly allow-listed Markdown
  documentation surface. Unknown, mixed or unresolved input fails closed onto
  the product lane.
- `pull_request` runs only the fast Domain and web lane. A product PR runs the
  frozen-authority checks, proof input materialisation, `npm run test:fast`,
  deterministic B3 proof and lint. Native jobs are skipped. This is developer
  feedback, not a merge basis.
- `merge_group`, `push`, `schedule` and `workflow_dispatch` run the full three-job gate:
  Domain and web, Android unsigned debug and release compile, and iOS unsigned Simulator compile.
- `schedule` and `workflow_dispatch` always compile native, even when the path
  filter would otherwise be quiet. Certification (`workflow_call` with
  `certification: true`) does the same.

The F0 selector is not a general dependency graph. Its allow-list is deliberately
small: root/project instructions, the PR template, and Markdown under governed
agent, ADR, architecture, operations and solution directories. Workflows,
scripts, tests, package inputs, product sources, legal/privacy material, frozen
records, reports/evidence, native projects, release surfaces and unknown paths
remain product work. Changing the selector or CI therefore cannot use that same
change to skip the product lane.

A bundled-source or native release input that can change an APK or iOS app
selects both native jobs on full-gate events. The shared detector is
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
`merge_group` and `main`, and also on `pull_request` even for an F0-only PR.
They do not
self-disable with a false-green skip. Ordinary commits still skip the evidence-
only subset contract, but only after that candidate range has been inspected.
The candidate merge-base defines the PR range. The report's
`applicationCheckpoint.commit` must be exactly 40
lowercase hex characters, sit in that range, and be a reachable ancestor of
HEAD. Only `checkpoint..HEAD` is allow-listed as evidence-only, so a source
checkpoint followed by one evidence successor is valid, while code after the
report is not. A symbolic or option-like checkpoint such as `HEAD~1` fails
closed before Git ancestry.

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

- F0-only is valid only for a complete allow-listed documentation diff. A mixed
  change is product work; do not split inseparable code and docs merely to gain
  the cheaper route.
- Pull-request CI alone is not a merge basis for bundled `src/`, `public/`,
  `vite.config.js`, native projects, or any other path the detector selects.
- The candidate merge-base defines the PR range. The named
  `applicationCheckpoint.commit` in `reports/b4/b4-development-report.json`
  must be in that range and a reachable ancestor of HEAD; only
  `checkpoint..HEAD` may contain B4 evidence paths. A buried report still
  applies the contract against the truthful merge-base.
- `npm run test:changed` must fail when it selected tests that fail. An empty
  selection is the only path that prints `no changed tests`.
- Nightly alerting (issue #69) is the post-merge last line of defence. An open
  `ci-nightly-red` issue means the scheduled gate is red now.
