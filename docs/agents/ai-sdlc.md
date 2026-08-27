# KS2 Spelling AI-Native SDLC

**Status:** development-process single source of truth. `AGENTS.md` is the
concise execution kernel; this document owns the complete operating model.

This model adapts Anthropic's
[AI-native SDLC playbook](https://claude.com/blog/the-ai-native-sdlc-playbook)
to a local-first React, Phaser, Capacitor, iOS and Android product. It keeps the
playbook's durable chain from intent through implementation, tests, review,
deployment and maintenance, while preserving this repository's existing
native, commerce, content, evidence and release boundaries.

The objective is not less engineering or less testing. It is the highest
product and decision quality with the least irrelevant context, duplicated
work, compute and feedback latency.

## 1. Four governing rules

1. **AI-SDLC DNA:** treat intent, plan, implementation, tests, review, PR,
   release evidence and maintenance findings as one traceable lifecycle. Each
   stage consumes the compact committed output of the preceding stage instead
   of reconstructing the task from chat history.
2. **Minimise wall time / maximise effectiveness:** put fast, diagnostic and
   risk-relevant evidence on the critical path. Parallelise only independent
   work and avoid repeated setup, duplicate CI and ceremonial handoffs.
3. **Minimise token consumption:** load the smallest sufficient context, keep
   one task capsule, use deterministic tools for mechanical facts, and stop
   model work when evidence is decisive.
4. **No compromise:** every affected material boundary remains covered by the
   cheapest evidence that can falsify the claim. Speed and tokens never justify
   an unproved claim; assurance never justifies unrelated work.

The strict optimisation equation is:

> **smallest sufficient context + smallest decisive experiment + smallest
> relevant gate + one integration boundary**

A larger unrelated suite is not automatically safer. A smaller relevant gate is
not automatically weaker. The question is whether the selected evidence can
observe every reachable material failure introduced by the change.

## 2. Humans above the loop

The normal loop is autonomous:

`intent -> task capsule -> implementation and tests -> focused evidence -> one
feature-complete review -> PR -> merge -> independent integration/maintenance`

The agent owns the loop when the intent and authority are already clear. Human
involvement is an exception, not a routine stage. Escalate only for:

- a genuinely unresolved product or commercial decision;
- credentials, signing assets, keychain access or licence acceptance;
- regulated, destructive, irreversible or externally visible effects;
- physical-device action that requires a person to operate or observe the
  device; or
- an explicit owner decision or authority gate named by the active contract.

Do not convert a resolvable engineering question into a human checkpoint. Do
not hide an owner-controlled effect inside automation. “Human above” means the
owner sets intent, constraints and authority; the delivery system performs the
reversible, evidenced work beneath those boundaries.

## 3. Durable artefacts without document theatre

The active GitHub issue or a complete direct owner instruction is the intent
contract. It records outcome, acceptance, non-goals and authority. A direct
instruction does not need a mirror issue merely to satisfy process.

Use the repository's existing artefacts:

- `AGENTS.md`: permanent first-day rules and progressive-disclosure map;
- this document: development-process SSOT;
- `CONCEPTS.md`: domain vocabulary;
- ADRs and architecture documents: durable technical decisions;
- `docs/solutions/`: reusable solved conventions and incidents;
- tests and deterministic scripts: executable behaviour and evidence contracts;
- one PR: integration, review and exact-head evidence;
- `docs/records/`: only when a dated gate, owner GO, measurement or close-out
  must remain immutable.

Do not add a parallel `CLAUDE.md`, duplicated context file, session ledger or
status document containing the same rules. Cross-agent permanent instructions
belong in `AGENTS.md`; task state belongs in one task capsule and the active
issue/PR. Historical records remain historical and are not rewritten into live
instructions.

## 4. One task capsule

Create or refresh one compact task capsule before material work:

1. intended outcome and non-goals;
2. active authorities and constraints;
3. affected surfaces and likely dependency radius;
4. acceptance criteria and evidence mapped to each claim;
5. branch, base/head, current diff and validation state;
6. decisions made, remaining uncertainty and next action.

Search paths, symbols, tests, issues and solved conventions before opening long
files. Stop loading context once acceptance and the affected surfaces are
understood. On handoff or compaction, transfer the capsule, exact head, diff and
failing command—not the transcript.

## 5. Two loops and one promotion boundary

### Discovery or research

Use this loop for uncertain architecture, incident diagnosis, UX comparisons,
performance hypotheses and experimental content or model work.

Before an experiment, state:

- the decision to be made;
- falsifiable hypothesis or competing options;
- immutable inputs and isolated output location;
- the cheapest experiment that distinguishes the options;
- run, wall-time, compute and context budget; and
- success, stop and inconclusive criteria.

Keep experiments out of production truth. Do not alter production content to
try a candidate, create a ticket/branch/PR per run, or trigger product CI for
pure research. Reuse deterministic harnesses and immutable inputs. Research may
fail or remain inconclusive without becoming a delivery failure.

The output is a compact decision: evidence, caveats, rejected alternatives and
the selected candidate—or an explicit stop.

### Delivery

Promotion starts only after acceptance is stable or a bounded implementation
experiment is selected. One independently mergeable outcome gets one owner,
one branch and one ordinary PR.

The delivery contract contains the intended outcome, non-goals, active
invariants, affected surfaces, acceptance, proof for each claim and concrete
stop conditions. Implement the smallest complete change. Avoid speculative
abstractions, opportunistic cleanup and evidence infrastructure not required by
the acceptance.

Do not reopen open-ended research inside the PR. When new evidence invalidates
an assumption, pause delivery, state the new question and run a bounded research
loop. Promote only the resulting decision and reproducible acceptance back into
delivery.

## 6. Focus Gates

Every ordinary PR follows the cheapest sufficient route. The current executable
PR selector is `scripts/lib/pr-focus-gate.mjs`; native merge/main selection is
owned independently by `scripts/lib/native-ci-path-filter.mjs`.

### F0 — change integrity

Prove exact diff identity, whitespace/syntax integrity and consistency of the
repository contract. An F0-only route is permitted only for the explicit safe
Markdown allow-list in the selector. Mixed, malformed, empty, unresolved or
unknown diffs fail closed into the product route.

F0-only does not authorise changes to legal/privacy authority, frozen records,
historical plans, evidence, reports, workflow behaviour, scripts, tests,
product source, content, native projects or release configuration.

### F1 — direct behaviour

Prove the changed behaviour with the smallest positive, negative and boundary
matrix. A defect fix includes the exact reproduction. Pure deterministic logic
uses unit/property tests; UI logic uses component or running behavioural proof;
a parser or policy uses hostile and malformed inputs.

### F2 — affected contract boundary

Prove direct callers and consumers reached by the change. Relevant boundaries
include learner-state persistence, command/replay behaviour, bundled spelling
content and audio, Monster progression, web bundle, native container, offline
behaviour, commerce/entitlement, signed packs, compatibility and migrations.

Do not run Android/iOS because a Markdown sentence changed. Do not omit native
proof when the bundled payload or native release input changed.

### F3 — actual runtime or service effect

Use a bounded real runtime only when deterministic local evidence cannot prove
the changed semantics. Examples include a physical-device keyboard/rendering
claim, StoreKit/billing interaction, Cloudflare/R2 semantics or network timing.
The test must use the actual relevant artefact and configuration. Source
presence, a simulator screenshot or a dry-run cannot be relabelled as physical
or live proof.

F3 is conditional. Ordinary code and documentation do not receive a live
provider, service or physical-device action merely because the capability
exists.

### F4 — irreversible or externally visible effect

Signing, certificates, store mutation, deployment, release, production data
migration, deletion, licence acceptance and activation remain explicit,
owner-controlled and fail closed. F0-F3 evidence does not mint F4 authority.

## 7. CI and integration model

The repository already has the correct high-level topology and it remains the
authority:

- **Pull request:** one `Domain and web` job. Explicit safe documentation-only
  diffs run F0 without installing project dependencies. Product, test, script,
  workflow, evidence, legal/privacy, native and unknown changes run the existing
  fast product lane.
- **Merge group and main push:** the complete maintained integration boundary:
  Domain/web plus Android unsigned debug/release compile and iOS unsigned
  Simulator compile. Native inputs are selected fail closed by the shared
  native path detector.
- **Schedule/manual/certification:** full or protocol-specific assurance as
  already documented; these are not ordinary-PR prerequisites.
- **Physical device, live service, signing and store:** separate evidence and
  authority gates. They are never inferred from hosted compilation.

Feature-branch pushes do not duplicate PR CI. A newer PR head cancels the
superseded run. The full merge/main gate remains independent of the PR
optimisation, so narrowing ordinary feedback never weakens integration.

Changing a selector, workflow, test, script or its contract selects the product
route. This avoids the circular failure mode in which a change to the gate uses
that same change to exempt itself.

## 8. Execution protocol

### Orient once

Read the task contract, inspect current `main`, search the affected surface,
nearest tests and relevant solution notes, then create the capsule. Do not
reconstruct broad project history.

### Plan once

Map each acceptance claim to the cheapest decisive proof. Order checks from
fast/diagnostic to slow/integrative. Identify what would falsify the plan. Do
not repeatedly restate the ticket as new plans.

### Execute narrowly

Change only owned paths. Batch deterministic reads and writes. Use scripts for
mechanical transformations. Keep generated research output outside production
truth. Do not widen scope because unrelated rubbish is visible.

### Validate progressively

During implementation, run the narrow check that answers the current question.
Before first push, run the coherent final relevant local gate once. A product
change normally runs the fast deterministic suite plus only specialist checks
for its affected surface; merge/main owns the complete integration build.

A changed native or physical-device claim requires its native/specialist proof.
A documentation-only change does not inherit npm install, web build or native
compilation. A release task follows its explicit release protocol rather than
ordinary PR defaults.

### Review once, materially

Review the feature-complete diff against acceptance, invariants, path ownership,
unintended effects and evidence. Batch concrete findings and fix them together.
Review again only after a material follow-up change or unresolved high-risk
finding. Reformatting or a generic second opinion is not a reason for another
full cycle.

### Integrate truthfully

The PR records outcome, key decision, selected F0-F4 gates, exact final-head
commands/workflows, deliberate omissions, residual uncertainty and non-effects.
Observe remote state; do not repeatedly poll or rerun unchanged evidence. Merge
only when the required exact-head gate and authority are satisfied. Delete the
branch unless a live dependency explicitly requires retention.

## 9. Token, context and compute discipline

- Root instructions contain only durable rules. Load one relevant domain
  document, not every plan or skill.
- Search `CONCEPTS.md` and `docs/solutions/`; do not read them end to end for an
  unrelated change.
- Prepare dependencies once after checkout or a dependency change, not before
  every command.
- Keep one task-state source. Do not maintain drifting issue comments, scratch
  plans and PR narratives.
- Batch independent reads and tool calls. Do not narrate information already in
  the capsule.
- Use deterministic queries, path classifiers, compilers and tests for
  mechanical facts; reserve model judgement for design, trade-offs and review.
- Parallel agents need distinct hypotheses or independent outputs. Never ask
  several agents to rediscover or review the same surface without separation.
- Stop when evidence is decisive. Additional tokens after the decision boundary
  usually add inconsistency rather than assurance.

Token minimisation is not thought minimisation. It removes duplicate context,
open-ended loops and model work that deterministic tooling can perform more
reliably.

## 10. Evidence mapping

Use evidence that observes the claimed property:

| Claim | Decisive evidence |
|---|---|
| Pure transformation or policy | deterministic unit/property tests, including hostile boundaries |
| Learner-state or replay behaviour | repository/transaction tests and recovery fixtures |
| Bundled web behaviour | targeted behaviour tests plus built bundle where integration is claimed |
| iOS/Android compilation | exact target/configuration build output |
| Simulator/Emulator interaction | launched app on the named virtual device |
| Physical-device interaction | installed exact build and observed behaviour on the named device |
| Visual/composition quality | running capture at affected reference shapes plus visual judgement |
| Performance | measured governed environment and declared budget |
| Commerce/download/service | bounded actual service or official test environment where required |
| Store/release readiness | explicit signing/store protocol and owner authority |

A full JavaScript suite cannot prove a physical keyboard appears. A screenshot
cannot prove transactional recovery. A source-level config check cannot prove
the binary that ships contains it. Use the right evidence once.

Tests are not weakened merely to pass. Frozen evidence and historical records
are not rewritten. Goldens or expected output move only for a deliberate
behaviour change with an explanation. If a relevant gate cannot run, stop with
a blocker rather than replacing it with unrelated proof.

## 11. Concurrency and ownership

Parallel work is safe only when tasks are independently mergeable, files and
mutable evidence do not overlap, each task has one owner/branch, dependencies
are explicit, and no worker assumes unmerged behaviour from another branch.

Multiple machines must not share a branch or worktree. If work depends on an
unmerged authority, either integrate the exact prerequisite once or wait for it
to land. Research may parallelise over immutable inputs and separate output
directories; consolidate once before promotion.

## 12. Scientific maintenance

Improve the SDLC from measured failure and waste, not ritual. Review trends over
a meaningful set of merged PRs:

- median and p95 time to first decisive failure;
- PR and merge/main runner minutes per merged outcome;
- dependency bootstraps and superseded/cancelled runs;
- reruns per unchanged head;
- review cycles caused by real defects versus scope drift;
- escaped defects and which dependency/check should have caught them;
- research experiments per promoted decision and inconclusive rate; and
- handoffs or context reloads before merge.

A faster route is accepted only while escaped-defect evidence does not worsen.
When a dependency is missed, run the relevant gate, widen the smallest path rule
that covers it and add a focused fixture. When a check repeatedly observes no
reachable risk, narrow its trigger with the same discipline.

Maintenance findings re-enter as fresh intent. Do not keep a permanent human
triage loop for work that deterministic detection and bounded autonomous repair
can safely perform.

## 13. Worked routes

**README or agent-guidance correction:** F0 allow-listed documentation contract;
no npm install, web build or native compile on the PR. Full integration remains
available at merge/main.

**A source or unit-test change:** F0-F2 product PR lane, including the direct
behaviour and affected contract tests. Merge/main runs the maintained full
integration boundary.

**A Capacitor configuration or bundled payload change:** F0-F2 product route;
the fail-closed native selector compiles both containers at merge/main.

**A real-iPhone keyboard defect:** deterministic regression and simulator proof
where useful, then F3 exact installed physical-device evidence. Simulator
success alone is not the acceptance claim.

**A TestFlight or store release:** product/native evidence plus the explicit F4
signing, store identity, upload and owner-authority protocol. Ordinary CI does
not authorise release.

**A CI selector or workflow change:** product route and complete contract tests;
it may not classify itself as F0-only. The merge/main gate remains full and
fail closed.
