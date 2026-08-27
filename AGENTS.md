# KS2 Spelling Agent Contract

KS2 Spelling is a local-first Capacitor application for spelling practice,
learner progress and child-owned Monster progression. This is the small
always-loaded execution kernel. Load deeper material only when the task needs
it. `docs/agents/ai-sdlc.md` is the development-process single source of truth.

## Communication and authority

Address James in Hong Kong Cantonese. Use UK English for code comments,
documentation, commits and product copy; keep technical terms bilingual when
helpful.

Use this precedence:

1. James's direct instruction or the active issue's acceptance and non-goals;
2. active product invariants, ADRs, architecture and release contracts for the
   affected surface;
3. this file and the one relevant domain document or solved convention; then
4. `docs/agents/ai-sdlc.md` and the executable selectors in
   `scripts/lib/pr-focus-gate.mjs` and `scripts/lib/native-ci-path-filter.mjs`.

Old plans, handoffs, evidence packets and frozen records are historical truth,
not current default instructions, unless the active task explicitly binds them.
Preserve them instead of rewriting history.

## AI-SDLC development DNA

Every task obeys four non-negotiable rules:

1. use an AI-native SDLC whose intent, implementation, tests, review and
   operational evidence form one traceable chain;
2. minimise wall time by maximising relevant, decisive work;
3. minimise token and context consumption by loading and repeating only what is
   necessary; and
4. never trade assurance for speed or tokens, or add irrelevant ceremony in the
   name of assurance.

Humans are above the loop, not routinely inside it. The agent owns orientation,
planning, implementation, focused validation, feature-complete review, PR
maintenance and merge when authority is already granted. Escalate only for an
unresolved product decision, credentials/licence acceptance, regulated or
irreversible effects, physical-device operation, signing/store/release
authority, or an explicit owner choice.

“No compromise” means every material claim receives the cheapest decisive
evidence that could falsify it. It does not mean running every unrelated suite.

## Smallest sufficient context and delivery

- Treat the direct instruction or active issue as the task contract. Do not
  create a mirror issue when the owner instruction is complete.
- Search the changed surface and nearest tests before opening long documents.
  Read only matching sections of `CONCEPTS.md`, ADRs and `docs/solutions/`.
- Keep one task capsule: outcome, non-goals, constraints, acceptance, affected
  surfaces, current head/diff/evidence, decisions and next action.
- Discovery/research states the uncertainty, immutable inputs, cheapest
  discriminating experiment, budget and stop rule. Do not create an issue,
  branch, PR or product-CI run per experiment; promote only the selected result.
- Delivery uses one independently mergeable outcome, one owner, one branch and
  one ordinary PR. Plan acceptance and proof once, implement the smallest
  complete change, batch review findings and avoid unrelated cleanup.
- Parallelise only independent work with separate branches and no shared mutable
  files or evidence. Never let multiple agents or machines mutate one branch or
  worktree. Handoffs transfer the capsule, exact head, diff and failing command,
  not the transcript.

## Focused validation

Use the narrowest gate that observes the claimed property, then broaden only
after a concrete failure, unresolved dependency or new risk:

- **F0 — change integrity:** exact diff, syntax, documentation and repository
  contract. Only the explicit safe Markdown allow-list may stop here; unknown
  paths fail closed into the product route.
- **F1 — direct behaviour:** the smallest positive, negative and boundary matrix,
  including the exact defect reproduction.
- **F2 — affected contract:** direct callers and consumers, persistence, bundled
  content, native container and compatibility boundaries reached by the change.
- **F3 — actual runtime/service effect:** bounded real-runtime evidence only when
  deterministic local evidence cannot prove the changed semantics.
- **F4 — irreversible/external effect:** credentials, signing, store mutation,
  deployment, release, migration, deletion or activation stay explicit,
  owner-controlled and fail closed.

During iteration run the narrow deterministic check that answers the current
question. Run the coherent final relevant gate once before first push and rerun
only checks invalidated by a material follow-up change. Do not poll workflows,
repeat review without a new finding, weaken a test or substitute an unrelated
green check.

The PR records selected gates, exact final-head evidence, deliberate omissions,
residual uncertainty and non-effects. One feature-complete review is the
default; another requires a material change or unresolved high-risk finding.

## Product and repository invariants

- Keep changes SOLID, DRY and YAGNI; prefer existing patterns over abstractions.
- Preserve local-first and no-remote-code: production builds must not use
  `server.url`, live reload, remote HTML or remote JavaScript.
- Treat learner state, content, native projects, billing, downloads, signing,
  store records and release as production-sensitive. Never claim a capability,
  physical-device behaviour or release state beyond the exact gate proved.
- The repository must build without a sibling `ks2-mastery` checkout. Imported
  upstream source is copied from frozen Git authority with hash evidence; no
  symlinks, workspace links or unpublished shared package.
- Keep generated outputs, local machine settings and secrets out of version
  control.

Never request a secret through a hidden prompt, access the login keychain,
certificates, provisioning profiles, signing keys or store credentials, accept
licence terms, or mutate signing/store/deployment/release state without James's
explicit authority. Stop at a visible owner-controlled gate.

Base native claims on fresh exact-target output. Distinguish Simulator from
physical iOS, Emulator from physical Android, compilation from launch, and
unsigned/local debug from signed release. Source presence is not proof that an
interaction renders or works on a real device.

## Documentation and stop conditions

`CONCEPTS.md` owns vocabulary; `docs/solutions/` owns reusable solved patterns.
`docs/superpowers/**` and `docs/records/**` are write-once; correct them with a
new dated record. `docs/superpowers/` is a closed historical archive. Other
`docs/` content is kept true.

Stop with a concrete blocker instead of weakening acceptance when a relevant
gate is unavailable, an active contract conflicts with the change, credentials
or licence acceptance are needed, a physical-device claim lacks that device, or
an irreversible/external effect lacks authority.

## Progressive-disclosure map

- AI-SDLC, research promotion, Focus Gates, evidence, review and metrics:
  `docs/agents/ai-sdlc.md`
- Issue ownership and tracker operations: `docs/agents/issue-tracker.md`
- Triage labels: `docs/agents/triage-labels.md`
- Domain vocabulary and ADR lookup: `docs/agents/domain.md`, `CONCEPTS.md`
- Native setup: `docs/operations/native-development.md`
- PR versus merge/main assurance: `docs/operations/merge-tier-gate.md`
- Existing solved conventions: `docs/solutions/`
