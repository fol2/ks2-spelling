# KS2 Spelling AI-Native SDLC

**Status:** development-process single source of truth. `AGENTS.md` is the
concise execution kernel; this document owns the complete operating model.

This model adapts Anthropic's
[AI-native SDLC playbook](https://claude.com/blog/the-ai-native-sdlc-playbook)
to KS2 Spelling's local-first web, Capacitor, SQLite, commerce, native-device and
store-gated workload. Its purpose is not less engineering or less testing. It is
maximum relevant evidence and delivery effectiveness with minimum wall time,
model context, compute, duplicated work and feedback latency.

## 1. The four governing rules

1. **AI-SDLC DNA:** intent and acceptance are explicit; agents own the bounded
   execution loop; deterministic automation supplies mechanical truth; context
   is progressively disclosed; review and maintenance are continuous.
2. **Minimise wall time, maximise effectiveness:** put the fastest decisive
   feedback first, parallelise only independent work and move broad integration
   to one truthful boundary.
3. **Minimise token consumption:** load only necessary context, retain one task
   capsule, use repository search and deterministic tools, and stop when the
   decision is supported.
4. **No compromise:** never omit a material affected boundary to save time or
   tokens, and never run irrelevant ceremony merely to appear thorough.

The governing equation is strict:

> **smallest sufficient context + smallest decisive experiment + smallest relevant gate + one integration boundary**

An unrelated green suite is not extra safety. A missing affected boundary is
not efficiency. The target is the least expensive evidence that can genuinely
falsify each claim.

## 2. Human above the loop

James owns product intent, acceptance, priorities, credentials, regulated or
irreversible decisions and the right to intervene. Agents own the normal loop:

`intent -> orient -> implement -> prove -> review -> PR -> authorised merge -> independent health signals`

Routine implementation choices, test execution, review fixes and evidence
collection do not require human approval when the contract is clear. Stop for
human input only when:

- intent or acceptance remains materially ambiguous after inspecting the live
  source of truth;
- credentials, licence acceptance, signing, store mutation, deployment,
  release, deletion or another irreversible external effect is required;
- an active product or architecture authority conflicts with the task; or
- evidence exposes a product decision rather than an engineering choice.

Do not hide a human gate inside a terminal prompt or simulate owner authority.

## 3. Two loops with one promotion boundary

### Discovery and research

Use this loop for uncertain architecture, performance diagnosis, visual or UX
exploration, native-device investigation, probabilistic behaviour and competing
implementation options.

Before work begins, record a compact research contract:

- question and decision to be made;
- falsifiable hypothesis or competing options;
- immutable inputs and owned output location;
- cheapest experiment that separates the options;
- wall-time, run and context budget;
- success, stop and inconclusive criteria.

Run isolated experiments against immutable inputs. Do not modify production
truth merely to try a candidate, create an issue/branch/PR per trial, or trigger
product CI for raw exploration. The output is a compact decision: evidence,
caveats, rejected alternatives and the selected candidate, or an explicit stop.

### Delivery

Promotion starts only when the selected result and acceptance are stable. One
independently mergeable outcome gets one owner, one branch and one ordinary PR.
The delivery contract contains:

- intended outcome and non-goals;
- active architecture, product and release constraints;
- affected surfaces and dependency radius;
- acceptance criteria;
- evidence mapped to each claim;
- concrete stop conditions.

Do not reopen research during implementation unless new evidence invalidates an
assumption. Pause delivery, state the new bounded question and resolve it outside
production truth before continuing.

### Promotion

Carry only the selected decision, required fixture/data and reproducible
acceptance into delivery. Do not transfer every transcript, rejected candidate,
experimental branch or raw run into implementation context.

## 4. Focus Gates F0-F4

Every claim is mapped to the lowest gate that can prove it. Gates compose; a
higher gate does not replace the lower ones.

| Gate | Purpose | Typical KS2 Spelling evidence |
|---|---|---|
| **F0 — change integrity** | Exact diff, syntax, documentation and contract consistency | `git diff --check`, focused contract tests, truthful links and non-effects |
| **F1 — direct behaviour** | Positive, negative and boundary behaviour of the changed unit | direct Node tests, exact defect reproduction, deterministic model/controller tests |
| **F2 — affected contract boundary** | Callers, consumers, persistence, packaging or compatibility touched by the change | fast suite, native-sync checks, gateway contract, SQLite/lifecycle fixture, import/fingerprint authority |
| **F3 — actual runtime or service** | Real environment semantics that local proof cannot establish | bounded Simulator/Emulator launch, physical-device proof, StoreKit sandbox or explicitly authorised service probe |
| **F4 — irreversible or externally visible effect** | Credentials, signing, store, deployment, release, destructive migration or public effect | explicit owner authority, exact candidate identity, fail-closed runbook and retained receipt |

Broaden only after a concrete failure, an unresolved dependency or a newly
observed risk. Do not broaden merely because a larger suite exists.

The executable ordinary-PR router is deliberately conservative:

- `scripts/detect-pr-focus-gate.mjs` grants F0-only CI solely when every changed
  path is one of five process-contract files with direct focused coverage:
  `.github/pull_request_template.md`, `AGENTS.md`,
  `docs/agents/ai-sdlc.md`, `docs/agents/issue-tracker.md`, or
  `docs/operations/merge-tier-gate.md`;
- no directory receives a blanket documentation exemption. README, vocabulary,
  ADR, architecture, other operations and solution documents remain on the
  product lane unless a later change adds both a matching contract test and an
  explicit selector fixture;
- mixed, malformed, empty, unresolved, unknown, product, test, script, workflow,
  legal, evidence, frozen-record, native and release changes select the existing
  product lane;
- changing the router or CI itself therefore cannot use the route it is changing
  to skip product verification;
- merge-group, main, schedule, workflow-dispatch and certification events always
  select the full integration path.

F3 and F4 are never inferred from a path. They are selected by the claimed
outcome and remain owner/evidence gated.

## 5. Agent execution protocol

### Orient once

Create or refresh one task capsule:

1. goal and non-goals;
2. active constraints and authoritative sources;
3. acceptance and evidence map;
4. current branch/head, diff and validation state;
5. decisions made and next action.

Search paths and symbols before opening files. Read targeted sections of
`CONCEPTS.md`, architecture authorities, runbooks and `docs/solutions/`. Stop
loading context when acceptance and affected surfaces are understood.

### Plan once

Choose the smallest complete implementation and the cheapest decisive proof for
each risk. Order checks from fast/diagnostic to slow/integrative. State what
would make the plan wrong. Do not produce repeated plans that merely paraphrase
the same ticket.

### Execute narrowly

Change only owned paths. Prefer existing patterns, SOLID/DRY/YAGNI and
deterministic transformations. Keep research and production outputs separate.
Avoid speculative abstractions, unrelated cleanup and evidence infrastructure
that acceptance does not need.

### Validate progressively

During iteration, run the narrow check that answers the current question. Run a
broader gate only after the change is coherent or when a failure reveals a wider
dependency. Prepare locked dependencies once after checkout or dependency
change, not before every command.

For a normal product delivery, use the direct tests while editing, then the
repository's fast PR lane on the final candidate. Native, gateway, persistence,
visual, audio, input, lifecycle, commerce or release work adds only its affected
specialist proof. The merge-group/main gate owns complete integration and native
compilation once.

For an explicitly allow-listed F0 process-document change, run the lightweight
documentation and CI contract checks without installing project dependencies.
Every other documentation change remains product-lane work until its actual
contract dependencies have an executable focused mapping.

### Review and integrate

Review the feature-complete diff against acceptance, active invariants,
unintended effects and evidence—not stylistic preference alone. Batch concrete
findings, fix them together and rerun only invalidated checks. Another review
loop requires a material follow-up change or unresolved high-risk finding.

Keep the PR body compact: outcome, exact state, selected gates, final-head
commands or CI, perceptual evidence where required, review findings, omissions,
remaining uncertainty and non-effects. Never claim an unobserved hosted run or a
broader environment than the evidence used.

## 6. Context and token discipline

- Root instructions contain permanent first-day rules only. Detailed process,
  domain and runbook material is loaded on demand.
- Search `CONCEPTS.md`; do not read the entire glossary for an unrelated task.
- Read the nearest solution before rediscovering a recorded incident.
- Batch independent reads and tool calls. Do not narrate or resummarise settled
  context already present in the task capsule.
- Prefer a deterministic query, diff, classifier or checker to model-based
  reinspection of mechanical facts.
- Keep one source of task state. Do not maintain competing scratch plans, issue
  comments and PR narratives that drift independently.
- On handoff or context compaction, transfer the capsule, exact head, diff,
  evidence and failing command—not the full transcript.
- Use parallel agents only for independent hypotheses or non-overlapping output.
  Never ask several agents to repeat the same review without distinct questions.
- Stop when evidence is decisive. Additional tokens after the decision boundary
  usually add noise rather than assurance.

Token reduction must come from eliminating duplication and mechanical model
work, not from omitting design reasoning or affected boundaries.

## 7. Evidence matched to the claim

- Pure transformation/state/model behaviour: deterministic unit or property
  tests, including positive, negative and boundary cases.
- Learner persistence/lifecycle: SQLite transaction, recovery and migration
  fixtures at the exact schema/version boundary.
- Bundled web/native packaging: native-sync/fingerprint authority plus compiled
  Android/iOS artefact evidence.
- Input, layout, animation, audio and visual composition: running capture and a
  perceptual decision at the affected device/viewport.
- Physical-device semantics: evidence from the named physical device, never a
  Simulator/Emulator substitute.
- Commerce/download/service semantics: deterministic local contracts first;
  bounded sandbox or actual service only when the local seam cannot prove the
  changed property and authority permits it.
- Signing/store/release: exact candidate identity, explicit owner gate and
  retained external receipt.

A screenshot cannot prove transaction atomicity. A full Node suite cannot prove
software-keyboard appearance on a physical iPhone. A Simulator compile cannot
prove signing or store readiness. Use the correct evidence once.

Tests are not weakened to fit an implementation. Frozen records are never
rewritten. Generated evidence changes only through its owning builder and only
for a deliberate, explained change. If a relevant gate cannot run, report the
blocker instead of substituting an unrelated check.

## 8. CI and event model

The ordinary feedback and integration boundaries are:

- **pull request, explicitly covered process docs only:** F0 route; Node setup,
  exact diff integrity, focused documentation/CI contracts and existing
  history-sensitive topology checks; zero `npm ci` dependency bootstrap;
- **pull request, everything else:** existing product fast lane, with frozen
  authorities, proof inputs, direct/fast tests, deterministic proof and lint;
- **merge group / main push:** full domain/web, gateway and path-selected native
  integration; unresolved native selection fails closed;
- **schedule / workflow dispatch / certification:** complete maintained cold
  gate, with certification artefact derivation only when explicitly invoked.

Superseded runs are cancelled by the workflow concurrency contract. A special
component or device workflow proves only its named component/evidence contract;
it must not become the ordinary repository gate or be copied for every ticket.
Historical branch-specific gates remain historical contracts until a separately
proved cleanup removes their retained tests and references.

A source workflow proves only its event-to-job contract. Live branch protection,
merge queue attachment and hosted results are separate observations, as defined
in `docs/operations/merge-tier-gate.md`.

## 9. Local-first and external-effect boundaries

Production application code remains bundled. Do not introduce `server.url`,
live reload, remote HTML or remote JavaScript. Online access remains limited to
approved commerce verification, pack download/redownload, entitlement refresh,
restore and revocation; spelling practice and installed content are not runtime-
network dependent.

Never request secrets through hidden input or access the login keychain,
certificates, provisioning profiles, signing keys or store credentials. Licence
acceptance, signing, deployment, store mutation, release and destructive data
migration require a visible owner-controlled F4 gate. Research, tests and PR
merge do not grant those effects.

## 10. Concurrency without rework

Parallel work is valid only when tasks are independently mergeable, mutable
files/evidence do not overlap, each has one owner/branch, dependencies are
explicit, and no task assumes unlanded behaviour from another branch. Multiple
machines must not share a branch or worktree.

Research may parallelise across immutable inputs and separate output locations.
Consolidate once before promotion. Delivery integrates current `main` once at
start and again only when necessary to land; repeated rebases across moving
branches are not a planning strategy.

## 11. Scientific maintenance

Review the process over a meaningful sample of merged PRs, by route and changed
surface:

- median and p95 time to first decisive failure;
- runner minutes and dependency bootstraps per merged PR;
- superseded/cancelled runs and unchanged reruns;
- review cycles caused by real defects versus scope drift;
- escaped defects and the missing dependency/check that should have caught them;
- research runs per promoted decision and inconclusive rate;
- context reloads or handoffs before merge.

A faster selector remains accepted only while escaped-defect evidence does not
worsen. When a dependency is missed, run the relevant gate immediately, widen
the rule and add a focused fixture. When a check repeatedly observes no
reachable risk, narrow its trigger with the same discipline.

## 12. Examples

**Allow-listed process-doc correction:** F0; no dependency install, but exact
diff, matching contract tests, links and review must pass.

**README or other documentation:** product lane unless that exact path has been
added with a focused contract test and selector fixture.

**React/controller defect:** F0+F1+F2; exact reproduction, nearest model/UI tests,
fast product lane, then merge integration.

**SQLite lifecycle change:** F0+F1+F2 and the governed persistence/recovery
fixtures; add F3 only when the claim depends on actual lifecycle behaviour not
covered by the virtual-device seam.

**Software keyboard or device layout:** deterministic ownership/layout contracts
first, then F3 on the named Simulator or physical device required by the claim.

**CI selector or workflow change:** product route, because narrowing the
mechanism while using that same change to skip verification would be circular.

**Store release:** F0-F4; exact candidate and all lower evidence first, then one
explicit owner-controlled signing/store action. No earlier green check grants
release authority.
