# Issue tracker: GitHub

Issues and specifications live in GitHub Issues for `fol2/ks2-spelling`. Use the
GitHub connector or `gh` CLI against the live repository; do not maintain a
parallel local tracker.

## AI-SDLC work model

A complete direct instruction from James is already an authoritative task
contract and does not need a mirror issue. Create or use an issue when work
needs durable acceptance, dependency tracking, independent ownership, later
handoff or a separately mergeable/rollback boundary.

- One independently mergeable outcome has one owner, one branch and one
  ordinary PR.
- Claim an unassigned delivery issue before the first implementation write.
  Preserve its acceptance and non-goals; stop on a concrete blocker rather than
  weakening them.
- Research does not need an issue, branch or PR per experiment. Keep trials in
  isolated local output, then promote one selected decision or fixture into a
  delivery issue when production work is ready.
- Do not split work merely because several agents or machines are available.
  Parallel tickets must have independent outputs, non-overlapping mutable paths
  and explicit dependencies.
- Keep the issue as intent/acceptance authority, the branch as implementation
  state and the PR as final evidence/review. Avoid duplicate status narratives
  that drift.
- Close an issue only after its accepted result is merged or after an explicit
  not-planned/duplicate decision. Record the concrete blocker when stopping.

Canonical triage roles and labels are defined in
[`docs/agents/triage-labels.md`](triage-labels.md).

## Common `gh` operations

Infer the repository from `git remote -v` when inside a clone, or pass
`--repo fol2/ks2-spelling` explicitly.

```sh
# Read issue, labels and discussion
gh issue view <number> --comments

# Find open work
gh issue list --state open \
  --json number,title,body,labels,assignees,comments

# Claim before implementation
gh issue edit <number> --add-assignee @me

# Comment or update labels
gh issue comment <number> --body '<observed result or blocker>'
gh issue edit <number> --add-label '<label>'
gh issue edit <number> --remove-label '<label>'

# Close after merge/decision
gh issue close <number> --comment '<merged result or explicit disposition>'
```

Use a heredoc for multi-line issue bodies or comments. Never put secrets in
issue or PR text.

## Pull requests

PRs are a delivery/evidence surface, not a feature-request inbox. GitHub shares
one number space across issues and PRs, so resolve an ambiguous `#42` with
`gh pr view 42` and fall back to `gh issue view 42`.

```sh
gh pr view <number> --comments
gh pr diff <number>
gh pr checks <number>
```

The ordinary PR records the one outcome, exact base/head, selected F0-F4 gates,
observed results, review fixes, remaining uncertainty and non-effects. Do not
claim hosted CI before observing the exact head. F3/F4 evidence and external
effects remain fail-closed unless the task and James's authority require them.

## Triage surface

**PRs as a request surface: no.** External requests are triaged as issues using
`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human` or `wontfix`.
An owner/member implementation PR is reviewed as delivery, not relabelled as a
request.

## Wayfinding operations

A Wayfinder map is one issue labelled `wayfinder:map`; independently actionable
children are issues linked as GitHub sub-issues and labelled
`wayfinder:<type>` (`research`, `prototype`, `grilling` or `task`). Do not create
children for every research run.

- **Blocking:** use GitHub native issue dependencies. The blocker value is the
  issue's numeric database ID, not its `#number` or node ID.
- **Frontier:** among the map's ordered open children, exclude assigned tickets
  and tickets with open blockers; the first remaining child is claimable.
- **Claim:** assign the child to the driving agent before implementation.
- **Resolve:** record the compact decision/evidence, close the child when its
  contract is met, and add only the durable decision pointer to the map.

Where native sub-issues/dependencies are unavailable, use a task list and a
`Blocked by: #<n>` line as a visible fallback; do not invent a second tracker.
