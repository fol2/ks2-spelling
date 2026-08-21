# AGENTS.md

## Communication

- Address the user as James.
- Communicate with James in Hong Kong Cantonese.
- Keep key technical terms bilingual where helpful.
- Use UK English for code comments, documentation, commit messages and product
  copy.

## Engineering standards

- Keep changes SOLID, DRY and YAGNI.
- Prefer existing repository patterns over new abstractions.
- Treat remote synchronisation, learner state, spelling content, native
  projects, billing, downloads, signing and store release as
  production-sensitive.
- Preserve the local-first architecture and the no-remote-code boundary.
  Production builds must not use `server.url`, live reload, remote HTML or
  remote JavaScript.
- Do not claim SQLite, commerce, downloads, production readiness or production
  native plugins until their later approval and verification gates are closed.

## Credentials and external mutations

- Never request or accept a secret through a hidden terminal prompt.
- Do not access the login keychain, certificates, provisioning profiles,
  signing keys or store credentials. If credential input becomes necessary,
  stop at a visible, user-controlled gate.
- Do not create or mutate a remote repository, signing identity, store record,
  deployment or release without James's explicit authority.
- Do not accept SDK or store licence terms on James's behalf.

## Verification

- Base native verification claims on fresh command output and retain the exact
  target, configuration and device evidence.
- Distinguish an iOS Simulator from a physical iOS device, an Android Emulator
  from a physical Android device, and an unsigned or local-debug build from a
  signed release build.
- Treat project configuration, successful compilation, successful launch,
  signing readiness and store readiness as separate gates.
- Do not describe a native capability or production gate as complete when the
  evidence proves only a narrower state.

## Repository boundaries

- This repository must build and test without a sibling `ks2-mastery` checkout.
- Imported upstream source must be copied from its frozen Git authority with
  hash evidence; do not use symlinks, workspace links or an unpublished shared
  package.
- Keep generated outputs, local machine settings and secrets out of version
  control.

## Documented solutions

- `docs/solutions/` holds solutions to past problems (bugs, conventions,
  workflow patterns), organised by category with YAML frontmatter (`module`,
  `tags`, `problem_type`). Relevant when implementing or debugging in a
  documented area.
- `CONCEPTS.md` holds shared domain vocabulary for the project. Relevant when
  orienting to the codebase or discussing domain concepts.
- `docs/superpowers/**` and `docs/records/**` are frozen: write-once, never
  edited. A correction is a new dated document that names what it corrects.
  Everything else under `docs/` is kept true and must be edited when it goes
  stale. Kind is carried in ce-compound frontmatter, not by the directory.
- New freeze records, gate verdicts, owner GOs, measurement runs, close-outs
  and QA verdicts go in `docs/records/<YYYY-MM-DD>-<slug>.md`. A freeze record
  follows the shape of `docs/records/2026-07-23-c1-starter-pack.md`:
  `Status: <state> at <SHA>`, `## Evidence`, `## Remaining gates`, and an
  explicit closing statement of what authority the record does not grant.
- `docs/superpowers/` is a closed historical archive: nothing new is added to
  it. The name is a 2026-07 tooling residue with no workflow meaning, retained
  because CI evidence pins the path.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `fol2/ks2-spelling`. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical triage roles map 1:1 onto tracker labels (`needs-triage`, `needs-info`,
`ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: glossary in `CONCEPTS.md`, ADRs in `docs/adr/` when they exist.
See `docs/agents/domain.md`. Do not create a parallel `CONTEXT.md`.
