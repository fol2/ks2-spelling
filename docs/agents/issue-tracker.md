# Issue tracker: GitHub

GitHub Issues and pull requests are the repository's live work authority. Use
the authenticated GitHub API or `gh` CLI available in the environment; infer
the repository from the checkout when possible.

## AI-SDLC ownership

- A complete direct instruction from James may be the delivery contract; do not
  create a mirror issue for ceremony.
- An existing issue is authoritative for its acceptance, non-goals,
  dependencies and owner decisions. Read the body, labels and material comments
  before the first write.
- One independently mergeable outcome has one owner, one branch and one ordinary
  PR. A second issue or PR needs a distinct merge, rollback, owner, dependency or
  release boundary—not merely another agent or machine.
- Claim an issue before implementation when the work is issue-backed. Do not let
  multiple sessions or machines mutate the same branch or worktree.
- Pure discovery/research does not need an issue, branch, PR or product-CI run
  per experiment. Promote one selected, reproducible result into delivery.
- The agent owns orientation, implementation, focused evidence, feature-complete
  review, PR maintenance and merge when authority is already granted. Escalate
  only for unresolved product decisions, credentials/licence acceptance,
  regulated or irreversible effects, physical-device operation, signing/store/
  release authority, or an explicit owner gate.
- Keep durable task state in the active issue and PR. Do not create competing
  scratch plans, handoff issues or status comments that drift from them.

See [`ai-sdlc.md`](ai-sdlc.md) for the complete development loop and Focus Gates.

## Common operations

- **Create an issue:** `gh issue create --title "..." --body "..."`; use a
  heredoc for a multi-line contract.
- **Read an issue:** `gh issue view <number> --comments`, including labels and
  dependency state.
- **List issues:** `gh issue list --state open --json
  number,title,body,labels,assignees,comments` with the narrowest useful label
  and state filters.
- **Claim:** `gh issue edit <number> --add-assignee @me` before implementation.
- **Comment:** `gh issue comment <number> --body "..."` only for a material
  decision, blocker, evidence handoff or close-out.
- **Labels:** `gh issue edit <number> --add-label "..."` or `--remove-label
  "..."`.
- **Close:** `gh issue close <number> --comment "..."` after the accepted outcome
  has landed or the recorded decision is complete.

GitHub shares one number space across issues and PRs. Resolve a bare `#42` with
`gh pr view 42` and fall back to `gh issue view 42`.

## Delivery PR

The PR is the one integration artefact for the outcome. Use
`.github/pull_request_template.md` and keep it compact:

- intent and non-goals;
- exact base/head and changed paths;
- selected F0-F4 gates, exact-head results, deliberate omissions and residual
  uncertainty;
- one feature-complete review and fixes; and
- non-effects, especially credentials, service, signing, store, deployment and
  release.

Do not poll remote workflows or rerun unchanged evidence. A further review loop
requires a material follow-up change or unresolved high-risk finding. Merge only
when the exact-head required gate and authority are satisfied, then delete the
branch unless a live dependency explicitly requires retention.

## Pull requests as a triage surface

**PRs as a request surface: no.** External feature or defect requests belong in
issues. Maintainer delivery PRs are integration artefacts, not a parallel
backlog.

## Triage labels

Canonical role labels are `needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human` and `wontfix`. Their meanings and transitions are owned by
[`triage-labels.md`](triage-labels.md). Do not use `ready-for-human` merely
because a task is difficult; it denotes a real human-only boundary.

## Wayfinding operations

Used by `/wayfinder`. A map is one issue labelled `wayfinder:map`; children are
linked sub-issues or, where unavailable, task-list entries with `Part of #<map>`.
Child labels are `wayfinder:research`, `wayfinder:prototype`,
`wayfinder:grilling` or `wayfinder:task`.

- **Blocking:** use GitHub native issue dependencies. With `gh api`, resolve the
  blocker's numeric database `id` and add it to
  `issues/<child>/dependencies/blocked_by`. Where dependencies are unavailable,
  use a `Blocked by: #<n>` line as the explicit fallback.
- **Frontier:** inspect open map children in map order, drop assigned children
  and any with open blockers, then select the first remaining child.
- **Resolve research:** record the compact decision and evidence on the child,
  close it, and add only the decision pointer to the map. Do not paste the full
  experiment transcript.
- **Promote delivery:** create one delivery child only when the selected result
  has stable acceptance and an independent merge boundary.
