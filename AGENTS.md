# KS2 Spelling Agent Contract

KS2 Spelling is a local-first Capacitor mobile application. This file is the
small, always-loaded execution kernel. Load deeper material only when the task
needs it. [`docs/agents/ai-sdlc.md`](docs/agents/ai-sdlc.md) is the development-
process single source of truth.

## Communication

- Address the user as James and communicate in Hong Kong Cantonese.
- Keep useful technical terms bilingual where that improves precision.
- Use UK English for code comments, documentation, commit messages and product
  copy.

## Authority and context

Use this precedence for current work:

1. James's direct instruction or the active issue acceptance and non-goals;
2. active product invariants, architecture authorities and compatibility
   contracts for the affected surface;
3. this file and the nearest relevant solution or runbook;
4. the AI-SDLC SSOT and executable CI selectors.

Historical plans, reports, reviews and evidence remain truthful records of their
own time. They are not current default instructions unless the active task binds
them. `docs/superpowers/**` and `docs/records/**` are frozen and never edited.

Start with the smallest sufficient context: inspect the changed surface, search
before opening long documents, and read only matching sections of `CONCEPTS.md`,
ADRs, solutions and runbooks. Keep one task capsule containing the goal,
non-goals, constraints, acceptance, current head/diff/evidence, decisions and
next action. Do not replay the whole repository or conversation.

## AI-SDLC operating rule

Maximise relevant decision quality and delivery speed while minimising wall
time, model context, compute and duplicated work. No compromise means every
material claim receives the cheapest decisive evidence that can falsify it; it
does not mean running every unrelated check.

- **Discovery and research:** define the question, immutable inputs, cheapest
  discriminating experiment, budget, success/stop rule and decision. Keep trials
  outside production truth. Do not create a ticket, branch, PR or CI run for
  every experiment; promote only the selected result.
- **Delivery:** one owner, one independently mergeable outcome, one branch and
  one ordinary PR. Plan acceptance and proof once, implement the smallest
  complete change, batch findings, and avoid unrelated cleanup.
- **Concurrency:** parallelise only independent work with separate branches and
  no shared mutable files or evidence. Never let several agents or machines
  mutate the same branch or worktree.
- **Human position:** James stays above the loop by setting intent, acceptance
  and irreversible decisions. Agents own orienting, implementation, tests,
  review, PR and authorised merge. Ask for human input only for unresolved
  ambiguity, credentials, regulated or irreversible effects, or an explicit
  owner decision.
- **Automation:** use deterministic scripts for discovery, classification,
  mechanical checks and evidence capture. Use model judgement for design,
  trade-offs, review and perceptual decisions.

## Validation and evidence

`scripts/detect-pr-focus-gate.mjs` is the executable ordinary-PR selector. A
strictly allow-listed documentation-only diff receives F0 integrity checks
without a dependency bootstrap. Unknown, malformed, mixed, product, CI,
evidence, legal, native or release input fails closed onto the existing product
lane. The full merge-group, main, scheduled and certification gates remain the
integration authority.

During implementation, run the narrow deterministic check that answers the
current question. On the coherent final candidate, run the complete relevant
local gate once plus only affected specialist checks. Do not rerun an unchanged
check, replace a relevant red gate with an unrelated green one, weaken a test,
or edit evidence merely to pass.

For presentation, animation, audio, input, lifecycle or device behaviour, inspect
the running result at the affected reference shape. Distinguish iOS Simulator
from physical iOS, Android Emulator from physical Android, and unsigned/local
debug from signed release. Configuration, compile, launch, physical-device
behaviour, signing readiness and store readiness are separate claims.

## Product and repository invariants

- Preserve the local-first architecture and no-remote-code boundary. Production
  builds must not use `server.url`, live reload, remote HTML or remote JavaScript.
- Treat learner state, spelling content, SQLite, commerce, downloads, native
  projects, signing, evidence and store release as production-sensitive.
- This repository must build and test without a sibling `ks2-mastery` checkout.
  Imported upstream source is copied from frozen Git authority with hash
  evidence; never use symlinks, workspace links or an unpublished shared
  package.
- Do not claim commerce, downloads, production native plugins, signing, store
  readiness or release beyond the exact closed gate and observed artefact.
- Keep generated outputs, local-machine settings and secrets out of version
  control.

## Credentials and external effects

Never request or accept a secret through a hidden prompt. Do not access the
login keychain, certificates, provisioning profiles, signing keys or store
credentials. Do not accept licence terms or create/mutate signing identities,
store records, deployments or releases without James's explicit authority.
Stop at a visible owner-controlled gate when credentials or an irreversible
external effect becomes necessary.

## Documentation map

- AI-SDLC, focus gates, research promotion, evidence and metrics:
  `docs/agents/ai-sdlc.md`
- Domain vocabulary and ADR discovery: `docs/agents/domain.md`
- Issue ownership and research/delivery tracking:
  `docs/agents/issue-tracker.md`
- Canonical triage labels: `docs/agents/triage-labels.md`
- Solved bugs, conventions and workflow patterns: `docs/solutions/`
- Native and device procedures: `docs/operations/native-development.md`
- Merge-tier source versus live-governance boundary:
  `docs/operations/merge-tier-gate.md`

Stop and report a concrete blocker rather than weakening acceptance when a
relevant gate is unavailable, an active authority contradicts the task, the
work needs credentials or unapproved external mutation, or the requested claim
cannot be proved at the stated environment.
