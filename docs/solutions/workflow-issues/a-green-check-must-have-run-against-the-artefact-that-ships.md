---
module: ci-governance
date: 2026-08-21
problem_type: convention
component: development_workflow
severity: high
applies_when:
  - "Adding or changing a CI if: condition, path filter or history-sensitive git diff"
  - "A merge-tier job reports success without compiling the APK or iOS app that will ship"
  - "A package script is cited as a complete gate while omitting a required surface"
resolution_type: config_change
related_components:
  - tooling
  - testing_framework
tags:
  - ci
  - merge-queue
  - path-filter
  - false-green
  - issue-73
---

# A green check must have run against the artefact that ships

## Context

Issue #73 exists because a production merge path can report success without
examining the artefact that will land. The review question is short: **what
artefact does this check run against, and is it the artefact that ships?** A
check that cannot answer the second half is decoration regardless of how green
it is.

Instances already seen in this repository:

- a native path filter that omitted bundled `src/`, `public/` and `vite.config.js`,
  so `merge_group` native jobs passed without building the container that embeds
  the Vite payload;
- the same filter omitting `.github/workflows/ci.yml`, so a workflow-only
  candidate could resolve a non-empty diff, return `native=false`, and skip both
  required native jobs;
- a B4 evidence-successor gate switched off on `merge_group` and `main`, and
  otherwise diffing `HEAD^` so a buried evidence change took the "does not
  apply" branch;
- `test:changed` or-chaining `node --test` so a failing selected test printed
  `no changed tests` and exited 0;
- `verify:b3` named as if it proved B3, while containing no gateway Worker
  tests, lint, Wrangler dry-run or audit.

## Guidance

- Merge-blocking jobs must fail closed. A skipped native compile is not a
  passed native compile.
- Path filters that decide whether the shipping container is built must include
  every bundled-source and native-release input that can change that container.
  Unresolved base, empty diff and certification default to compiling.
- History-sensitive checks inspect the candidate range or merge-base, not only
  `HEAD^`. They run on every relevant merge path. If they decline, they must
  say why in terms a reviewer can check, after inspecting that range.
- Shell `&&` / `||` is not an empty-selection fallback. Use an `if` or a
  dedicated runner so a failing selected command stays non-zero.
- An aggregate named like a complete gate must either include the surfaces that
  name implies, or the documentation must say which surfaces it omits. Follow
  existing repository intent rather than broadening the frozen command
  arbitrarily.

The event-to-tier mapping and the source-versus-live-settings split are in
`docs/operations/merge-tier-gate.md`. Source and CI proof still do not prove
live GitHub rulesets.

## Why This Matters

GitHub treats a skipped required check as a completed check. Combined with
`strict: false` and no merge queue, the fast pull-request lane can satisfy
branch protection while the native jobs never ran against the candidate. The
nightly then becomes the first detector, which is recovery, not a pre-merge
gate.

## When to Apply

Any change to `.github/workflows/ci.yml` `if:` keys, the native path detector,
evidence-successor range handling, or a package script that maintainers cite as
a gate. Also apply when reviewing a green merge-group job whose steps were
mostly skipped.
