---
module: operations
tags:
  - ci
  - merge-queue
  - governance
  - ai-sdlc
problem_type: operating-procedure
---

# Focused pull-request gate and full merge-tier gate

Updated 2026-08-27. This is the durable maintainer document for the event-to-tier
mapping in `.github/workflows/ci.yml` and the source-level merge-blocking
contract. It does not prove live GitHub branch protection, rulesets or
merge-queue settings. Inspect live settings; a source file cannot certify them.

The development-process authority is `docs/agents/ai-sdlc.md`. This document
explains how its smallest-relevant-gate rule is implemented without weakening
the existing native integration boundary.

## Event-to-tier map

### Pull request: one focused `Domain and web` job

Every PR checks out the exact head with full history, resolves the exact base and
runs `scripts/detect-pr-focus-gate.mjs`.

- **F0-only safe documentation:** every changed path must be in the explicit
  Markdown allow-list in `scripts/lib/pr-focus-gate.mjs`. The job runs exact
  diff integrity plus the AI-SDLC/classifier contract without installing
  project dependencies.
- **Product route:** source, tests, scripts, workflows, content, native projects,
  legal/privacy authority, frozen records, evidence/reports, mixed diffs and
  unknown paths run F0-F2 through the existing fast product lane. Unresolved
  base/diff and empty candidates fail closed into this route.

A change to the selector, workflow or its tests cannot use that same change to
exempt itself: those paths are product inputs. Feature-branch pushes do not run
a second copy of PR CI. A newer PR head cancels its superseded run.

The PR job is fast feedback and direct-contract proof. It is not a substitute
for the complete merge candidate integration boundary.

### Merge group, `main`, schedule, manual and certification

`merge_group`, push to `main`, schedule, `workflow_dispatch` and certification
run the product route. The maintained integration boundary is:

1. `Domain and web`;
2. `Android unsigned debug and release compile`; and
3. `iOS unsigned Simulator compile`.

Schedule and manual runs always compile native. Certification does the same. On
merge-group and `main` events, the shared native path detector may skip expensive
native compilation only when the resolved candidate contains no native or
bundled-payload input. Unresolved base, unresolved/empty diff and certification
fail closed and compile native. This filter can only make a merge slower; it
must never allow an affected shipping container to escape proof.

## F0-only boundary

The F0-only path is intentionally much smaller than “all docs”. It permits only
the exact permanent AI-SDLC guidance files listed by
`scripts/lib/pr-focus-gate.mjs`: `AGENTS.md`, `README.md`, the PR template and
the four existing `docs/agents/` guidance files. New files are unknown until
explicitly governed and therefore fail closed.

It deliberately excludes `CONCEPTS.md`, ADRs, architecture and operations
contracts, solved conventions, legal/privacy authority, immutable records and
historical plans, reports/evidence, workflows, configuration, scripts, tests,
product source, content, vendor, gateway and native projects. Those surfaces may
have dedicated executable contracts and therefore keep the product route.

A mixed diff takes the product route. Deletion and rename paths are classified
from the complete base-to-head set; the detector disables rename collapsing so
both sides of a rename remain visible. The selector's focused hostile fixtures are
`tests/pr-focus-gate.test.mjs`; the repository contract is additionally pinned
by `tests/ai-sdlc-contract.test.mjs`.

## Native merge selector

A bundled-source or native release input that can change an APK or iOS app
selects both native jobs on full-gate events. The shared detector is
`scripts/detect-native-ci-changes.mjs` and its policy is
`scripts/lib/native-ci-path-filter.mjs`.

Inputs include `src/`, `public/`, `vendor/`, `content/`, `config/`, `ios/`,
`android/`, governed scripts, package/Capacitor/Vite identity, privacy notice and
`.github/workflows/ci.yml`. The workflow file is itself a native/full-merge
input because it consumes the selector that decides whether the required
Android and iOS jobs compile.

The path selector does not prove a hosted `merge_group` executed those jobs. It
only proves the source decision for a resolved candidate.

## History-sensitive evidence

B4 evidence-successor checks inspect the truthful candidate range: merge-group
base, pull-request base, push `before`, or `HEAD~1` only as a last-resort first
parent. They run on the product route and on every integration event. Ordinary
commits skip the evidence-only subset contract only after the candidate range
has been inspected.

The report's `applicationCheckpoint.commit` must be exactly 40 lowercase hex
characters, sit in the candidate range and be a reachable ancestor of `HEAD`.
Only `checkpoint..HEAD` is allow-listed as evidence-only. A symbolic or
option-like checkpoint such as `HEAD~1` fails closed before Git ancestry.

## What source cannot prove

Repository settings live on GitHub, not in this tree:

- required check names and whether they attach to a PR or merge candidate;
- strict/up-to-date behaviour and whether administrators are bound;
- whether a merge queue exists and which checks it requires;
- bypass permissions or direct pushes to `main`; and
- whether an exact hosted candidate completed all required jobs.

A passing Actions run proves only that event and head executed the reported
steps. Record live observations in the PR or issue; do not paste them into this
source document as permanent fact.

The intended live required names are the three job names above. A source or local
pass must not be presented as proof that GitHub will refuse a merge when one is
missing.

## `verify:b3` is not the complete B3 gate

`npm run verify:b3` is the local deterministic/native audit chain frozen by the
B3 package-transition authority. It ends at
`node scripts/build-b3-exit-report.mjs --check-ci`.

It does not run gateway Worker tests, lint, Wrangler dry-run or gateway audit.
Those belong to the hosted Domain and web integration lane. Live Cloudflare
deploy and store mutation remain owner-gated and absent from both. Do not cite
`verify:b3` as proof that the gateway Worker or a live service was exercised.

## Maintainer consequences

- An F0-only green PR proves documentation integrity and the routing contract,
  not product or native behaviour.
- Product PR CI is focused feedback; bundled/native changes still require the
  exact merge/main integration boundary before landing.
- Physical-device, live-service, signing, store and release claims require their
  separate F3/F4 protocol and authority.
- `npm run test:changed` must fail when selected tests fail. An empty selection
  is the only path that prints `no changed tests`.
- Nightly alerting is the post-merge last line of defence. An open
  `ci-nightly-red` issue means the scheduled gate is red now.
- If a production dependency escapes classification, run its relevant gate,
  widen the smallest selector rule that covers it and add a focused fixture.
  Do not respond by restoring unrelated work to every PR.
