---
module: operations
tags:
  - process
  - agents
problem_type: operating-procedure
---

# Agent wayfinder: picking up a GitHub issue in this repository

Dated 2026-08-13. This is the standing operating document for ANY engineering
agent (or human) taking an issue from the board. It replaces the per-dispatch
briefing boilerplate: an issue plus this document is a complete work order.
If something here conflicts with an issue body, the issue wins; if it
conflicts with a frozen plan document, the plan document wins.

## Roles

- **Executors** implement one slice, open a PR, and never merge.
- **The planner** (usually a Claude session named `1st-polish`; any session
  acting as planner) independently verifies claims and merges. If you can
  reach a planner session, report via SendMessage when your PR is up (send to
  every session bearing the name if it is ambiguous). If none is live, say
  clearly in the PR body that it awaits planner review.
- Live Cloudflare (deploys, R2 writes), signing-key material and store-console
  actions are **owner-gated** (James, per Task 19H/22). Never attempt them;
  deliver up to the boundary and write the owner runbook step instead.

## Reading order for any slice

1. The issue itself, then its epic issue **including comments** (consequence
   notes from prior slices live there).
2. `docs/superpowers/plans/2026-08-13-commercial-readiness-roadmap.md` — the
   epic tables and governance notes.
3. The runbooks under `docs/operations/` touching your surfaces (authoring:
   `authoring-a-pack.md`; hosting/signing:
   `2026-08-13-full-ks2-shard-signing-and-hosting-runbook.md` including its
   execution-record corrections).
4. Plan documents under `docs/superpowers/plans/` are **frozen**: never edit
   them; new records go in new dated documents.

## Setup

```bash
cd /Users/jamesto/Coding/ks2-spelling
git fetch origin
git worktree add ../ks2-spelling-<slice> -b <epic>/<slice-name> origin/main
cd ../ks2-spelling-<slice> && npm ci        # never symlink node_modules —
                                            # a symlink trips the dependency
                                            # audit fail-closed
(cd gateway && npm ci)                      # only if you touch gateway/
```

## Governance (fail-closed; violations fail CI, not just review)

- **Read-only unless your issue names them as the reviewed subject:**
  `config/*`, `capacitor.config.json` (byte-identical; hash-sealed via a
  protected test), `package.json`/`package-lock.json` (zero new dependencies
  by default), `vendor/*` (fix upstream in ks2-mastery and re-vendor, never
  edit vendored bytes), `tests/fixtures/*` (additive only), `reports/*`.
- The six B3 final-evidence paths must remain **absent** until Task 22.
- **Never run `node scripts/audit-dependencies.mjs --write`.** If the Android
  CI job fails `dependency_evidence_stale` and your diff touches bundled src,
  that is the designed webview-bundle coupling: state it in the PR and the
  planner ships the paired evidence refresh. (Modules not in the vite bundle
  graph — most commerce/gateway code — do not trip it.)
- **Authority families move together, all sites in one commit:**
  - the four Android packaged-permission surface lists;
  - the pack-signing keyring: `config/pack-signing-public-keys.json`, the iOS
    and Android bundled asset copies (byte-identical trio) and
    `EXPECTED_SIGNING_KEY` in `src/domain/commerce/commerce-contracts.js`,
    plus the slow-test pin;
  - registry/catalogue invariant: every packId in `config/store-products.json`
    must be inside an approved key's `allowedPackIds`, and every joined packId
    must resolve to a registry row bound to the same entitlement.
- The catalogue join (`store-products.json` packIds) stays bound to
  `b3-sandbox-proof` until the E2.7 join flip; shard registry rows are inert
  until then by design.
- New native plugins go through the 7-gate path; plugin config goes through
  the runtime API (capacitor.config.json is sealed).

## Verification bar before any PR

- `npm run test:fast` green; `npm run lint` green.
- Touched packs/commerce/proof surfaces ⇒ `npm run prove:b3:deterministic`
  must reproduce `reports/b3/deterministic-proof.json` byte-identically.
- Any change under `ios/` or `android/` ⇒ trigger the full three-job run
  yourself and record the honest result:
  `gh workflow run "B4 continuous integration" --ref <branch>`.
  PR-lane CI alone is NOT a merge basis for native changes.
- Audio `--check` on the legacy Starter/Full lanes only reproduces under
  ffmpeg 8.1.2 (9+ diverges at AAC frame trimming); new lanes are pinned to
  the ffmpeg that authored them. State your ffmpeg version in any audio
  evidence.
- Simulator hygiene: sweep booted simulators before proof runs and shut down
  everything you booted.

## Delivery

- Ordinary PR against `main`, branch `<epic>/<slice-name>`, **do not merge**.
- PR body: what changed, verification evidence (numbers, run links), and a
  "deliberate calls" section arguing every judgement call — the planner
  adjudicates them explicitly.
- Report to the planner before your session ends; never leave the final
  report contingent on a background watch. If a CI run is still in flight,
  give the run URL and its last known state honestly.
- If you hit an owner-level decision (pricing, keys, store accounts, privacy,
  anything destructive), stop and ask via the planner; do not guess.

## Where truth lives

- Board: GitHub issues; epics #90–#96 carry the slice checklists.
- Adopted plans and records: `docs/superpowers/plans/` (frozen) and dated
  records/runbooks in `docs/operations/`.
- The planner's session memory is private context, never an input you need:
  everything load-bearing is in the repo or on the issues. If you find that
  is not true for your slice, that is a bug in this document — say so in
  your PR.
